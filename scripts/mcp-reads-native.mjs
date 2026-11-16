import { seed } from "./database-concurrency-native.mjs";
const library = "90000000-0000-4000-8000-000000000001";
const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const timer = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const wait = ms => new Promise(resolve => timer.setTimeout(resolve, ms));
function assert(value, message) { if (!value) throw Error(message); }
function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0; }
function scenarios() {
  const cases = [];
  for (const responseMode of ["compact", "standard", "full"]) {
    cases.push({ name: `list20-${responseMode}`, tool: "list_resources", args: { libraryId: library, limit: 20, responseMode } });
    cases.push({ name: `get1-${responseMode}`, tool: "get_resources", args: { resourceIds: [id(1)], responseMode } });
  }
  cases.push(
    { name: "list100-full-total", tool: "list_resources", args: { libraryId: library, limit: 100, responseMode: "full", includeTotal: true } },
    { name: "get20-full", tool: "get_resources", args: { resourceIds: Array.from({ length: 20 }, (_, i) => id(i + 1)), responseMode: "full" } },
    { name: "get1-expanded", tool: "get_resources", args: { resourceIds: [id(1)], responseMode: "compact", includeFields: ["sources", "identifiers", "memberships", "metadata", "stats", "contributors"] } },
    { name: "read12k", tool: "get_resource_content", args: { resourceId: id(1), maxChars: 12000 } },
    { name: "read50k", tool: "get_resource_content", args: { resourceId: id(1), maxChars: 50000 } },
    { name: "blocks20-preview", tool: "list_content_blocks", args: { resourceId: id(1), limit: 20, includePreview: true } },
    { name: "blocks20-full", tool: "list_content_blocks", args: { resourceId: id(1), limit: 20, includePreview: false, responseMode: "full" } },
    { name: "metadata-search", tool: "search_content", args: { scopeType: "authorized", query: "synthetic", mode: "metadata", limit: 10 } },
  );
  return cases;
}
export async function run(options) {
  const B = globalThis.McpReadBaseline, C = globalThis.McpReadCandidate;
  const { folder, rounds, requests } = options;
  assert(Zotero.DataDirectory.dir.replaceAll("\\", "/").includes("/.scaffold/"), "Isolated Zotero required");
  const clock = Zotero.getMainWindows()[0].performance;
  const report = { status: "running", started: Date.now(), environment: { version: Zotero.version, dir: Zotero.DataDirectory.dir,
    accessibilityEnabled: Services.appinfo.accessibilityEnabled, forceDisabled: Services.prefs.getIntPref("accessibility.force_disabled", 0),
    instantiators: Services.prefs.getStringPref("accessibility.instantiators", ""), debugLogging: Zotero.Debug.enabled }, options,
    samples: [], batches: [], writes: [], assertions: [], providerCalls: 0 };
  const persist = () => IOUtils.writeUTF8(PathUtils.join(folder, "native-results.json"), JSON.stringify(report, null, 2));
  const owners = [], contexts = [];
  let metrics;
  const normalize = value => B.canonical(JSON.parse(JSON.stringify(value, (key, value) => key === "nextCursor" ? Boolean(value) : value)));
  try {
    assert(!report.environment.accessibilityEnabled && !Zotero.startupError, "Unusable native baseline environment");
    const fixture = options.fixture ?? PathUtils.join(folder, "fixture.sqlite");
    if (!options.fixture) {
      const database = await B.initializeDatabase(new Zotero.DBConnection(fixture), fixture);
      try { report.fixture = await seed(database.db, 1000, 100); } finally { await database.close(); }
    } else report.fixture = { documents: 1000, blocks: 100000, imported: true };
    if (await IOUtils.exists(`${fixture}-wal`)) assert((await IOUtils.stat(`${fixture}-wal`)).size === 0, "Refuse a fixture with uncheckpointed WAL");
    const files = {};
    for (const name of ["read", "write-baseline", "write-candidate"]) {
      const file = PathUtils.join(folder, `${name}.sqlite`); assert(!await IOUtils.exists(file), "Refuse an existing fixture destination");
      await IOUtils.copy(fixture, file); files[name] = file;
    }
    const native = new Zotero.DBConnection(files.read), database = await C.initializeDatabase(native, files.read); owners.push(database);
    const db = database.db, tokens = new C.McpTokens(db), token = await tokens.create({ name: "Native read comparison", libraryIds: [library], scopes: ["knowledge:search", "knowledge:read"] });
    const time = Date.now();
    await db.transaction().execute(async tx => {
      for (let i = 1; i <= 20; i++) {
        await tx.insertInto("resource_identifiers").values({ id: `80000000-0000-4000-9000-${String(i).padStart(12, "0")}`, resource_id: id(i),
          identifier_type: "doi", identifier_value: `10.test/read-${i}`, normalized_value: `10.test/read-${i}`, created_at: time }).execute();
        await tx.insertInto("resource_sources").values({ id: `20000000-0000-4000-9000-${String(i).padStart(12, "0")}`, resource_id: id(i), source_type: "manual",
          source_role: "supplementary", text_content: "Synthetic supplementary metadata", availability: "available", media_type: "text/markdown", created_at: time, updated_at: time }).execute();
      }
      await C.sql.raw(`INSERT INTO search_documents(document_kind,resource_id,title,contributors,body,search_text,tokenizer_profile,indexed_version,updated_at)
        SELECT 'metadata',id,title,'','',lower(title),'unicode-cjk-bigram-2',version,1 FROM knowledge_resources`).execute(tx);
    });
    const query = native.queryAsync.bind(native);
    native.queryAsync = function(sql, parameters, args) {
      const record = metrics; if (!record) return query(sql, parameters, args);
      record.sqlCalls++;
      if (record.collectRows && args?.onRow) return query(sql, parameters, { ...args, onRow: (row, cancel) => { record.rows++; return args.onRow(row, cancel); } });
      return query(sql, parameters, args);
    };
    for (const [name, api] of [["baseline", B], ["candidate", C]]) {
      const tokens = new api.McpTokens(db), cursor = new api.McpCursor(db); await cursor.start();
      const embedding = new api.EmbeddingService(db, "file:///synthetic/");
      for (const key of ["embed", "rerank"]) embedding.gateway[key] = async () => { report.providerCalls++; throw Error("Provider calls are forbidden in this benchmark"); };
      const tools = new api.McpTools(tokens, cursor, new api.RetrievalService(embedding), embedding);
      contexts.push({ name, tokens, tools, embedding });
    }
    async function invoke(context, scenario) {
      const principal = await context.tokens.authenticate(token.secret);
      const result = await context.tools.call(scenario.tool, scenario.args, principal, new AbortController().signal);
      assert(!result.isError, `${context.name}/${scenario.name}: ${JSON.stringify(result.structuredContent)}`);
      const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result })).length;
      return { result: result.structuredContent, bytes };
    }
    report.progress = "read-cases"; await persist();
    for (const scenario of options.writesOnly ? [] : scenarios()) {
      let reference;
      for (let round = -1; round < rounds; round++) for (const context of round % 2 ? [...contexts].reverse() : contexts) {
        const sample = { variant: context.name, scenario: scenario.name, round, warmup: round < 0, sqlCalls: 0, rows: 0, collectRows: round < 0 };
        metrics = sample; const start = clock.now(); let result;
        try { result = await invoke(context, scenario); sample.elapsedMs = clock.now() - start; }
        finally { metrics = undefined; }
        C.validate(C.toolDefinitions.find(tool => tool.name === scenario.tool).outputSchema, result.result, "output");
        const value = normalize(result.result); if (!reference) reference = value; assert(reference === value, `Output mismatch: ${context.name}/${scenario.name}`);
        sample.bytes = result.bytes; report.samples.push(sample);
      }
      await persist();
    }
    if (!options.writesOnly) report.assertions.push("All read projections, totals, identifiers, supplementary sources and metadata search outputs match the baseline");
    report.progress = "concurrency"; await persist();
    const batchCases = [scenarios()[2], scenarios()[3], scenarios().find(s => s.name === "read12k"), scenarios().find(s => s.name === "blocks20-preview")];
    for (const concurrency of options.writesOnly ? [] : [1, 4, 16]) for (let round = -1; round < rounds; round++) for (const context of round % 2 ? [...contexts].reverse() : contexts) {
      const sample = { variant: context.name, concurrency, round, warmup: round < 0, count: requests, sqlCalls: 0, latencies: [], eventLoopDelays: [] };
      let next = 0, alive = true, timerId, failure;
      const tick = () => { const at = clock.now(); timerId = timer.setTimeout(() => { if (alive) { sample.eventLoopDelays.push(Math.max(0, clock.now() - at - 10)); tick(); } }, 10); }; tick();
      metrics = sample; const start = clock.now();
      await Promise.all(Array.from({ length: concurrency }, async () => {
        try { for (;;) { if (failure) return; const index = next++; if (index >= requests) return; const at = clock.now(); await invoke(context, batchCases[index % 4]); sample.latencies.push(clock.now() - at); } }
        catch (error) { failure ??= error; }
      }));
      sample.elapsedMs = clock.now() - start; metrics = undefined; alive = false; timer.clearTimeout(timerId); if (failure) throw failure;
      sample.requestsPerSecond = requests * 1000 / sample.elapsedMs; sample.p95Ms = percentile(sample.latencies, 0.95);
      sample.eventLoopP95Ms = percentile(sample.eventLoopDelays, 0.95); sample.eventLoopMaxMs = Math.max(0, ...sample.eventLoopDelays);
      report.batches.push(sample); assert(!Services.appinfo.accessibilityEnabled, "Accessibility activated"); await persist(); await wait(50);
    }
    report.progress = "write-cost"; await persist();
    const writeContexts = [];
    for (const [variant, api, file] of [["baseline", B, files["write-baseline"]], ["candidate", C, files["write-candidate"]]]) {
      const native = new Zotero.DBConnection(file), owner = await api.initializeDatabase(native, file); owners.push(owner);
      const source = await owner.db.selectFrom("resource_sources").selectAll().where("resource_id", "=", id(1)).executeTakeFirstOrThrow();
      const mutationTokens = new api.McpTokens(owner.db), mutationCursor = new api.McpCursor(owner.db); await mutationCursor.start();
      const mutationToken = await mutationTokens.create({ name: "Native mutation comparison", libraryIds: [library], scopes: ["knowledge:update-summary"] });
      const mutationTools = new api.McpTools(mutationTokens, mutationCursor);
      contexts.push({ name: `${variant}-writes`, tools: mutationTools, embedding: { close: async () => {} } });
      const generation = "60000000-0000-4000-8000-999999999999";
      await owner.db.insertInto("content_generations").values({ id: generation, resource_id: id(1), source_id: source.id, base_content_version: source.content_version,
        content_version: source.content_version + 1, source_version: source.source_version, source_fingerprint: source.source_fingerprint, origin: "manual", normalizer_version: "benchmark", created_by_type: "system", created_at: 1 }).execute();
      writeContexts.push({ variant, db: owner.db, native, generation, mutationTokens, mutationTools, mutationToken });
    }
    for (const workload of ["metadata-100", "staging-1000"]) for (let round = -1; round < rounds; round++) for (const context of round % 2 ? [...writeContexts].reverse() : writeContexts) {
      const w = context.db;
      const revision = async () => context.variant === "candidate" ? (await C.sql`SELECT CAST(revision AS TEXT) AS revision FROM mcp_library_revisions WHERE library_id=${library}`.execute(w)).rows[0].revision : null;
      const before = await revision(), start = clock.now();
      await w.transaction().execute(async tx => {
        if (workload === "metadata-100") {
          for (let i = 1; i <= 100; i++) await tx.updateTable("knowledge_resources").set(eb => ({ summary: `Write sample ${round}`, version: eb("version", "+", 1), updated_at: round + 2 })).where("id", "=", id(i)).execute();
        } else {
          await C.sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
            INSERT INTO content_blocks(id,generation_id,block_type,canonical_order,content_markdown,content_hash,source_type,created_at)
            SELECT '60000000-0000-4000-8000-'||printf('%012d',i),${context.generation},'text',i,${"Synthetic staging body. ".repeat(50)},${"a".repeat(64)},'manual',1 FROM n`.execute(tx);
        }
      });
      report.writes.push({ variant: context.variant, workload, round, warmup: round < 0, elapsedMs: clock.now() - start });
      const after = await revision();
      if (context.variant === "candidate") assert(BigInt(after) - BigInt(before) === (workload === "metadata-100" ? 100n : 0n), "Incorrect write revision propagation");
      if (workload === "staging-1000") await w.deleteFrom("content_blocks").where("generation_id", "=", context.generation).execute();
      await persist();
    }
    for (let round = -1; round < rounds; round++) for (const context of round % 2 ? [...writeContexts].reverse() : writeContexts) {
      const row = await context.db.selectFrom("knowledge_resources").select("version").where("id", "=", id(1)).executeTakeFirstOrThrow();
      const start = clock.now(), principal = await context.mutationTokens.authenticate(context.mutationToken.secret);
      const result = await context.mutationTools.call("update_summary", { resourceId: id(1), summary: `Native MCP summary ${round}`,
        expectedVersion: row.version, operationId: `native-summary-${round}` }, principal, new AbortController().signal);
      assert(!result.isError && result.structuredContent.version === row.version + 1, `Native MCP write failed: ${JSON.stringify(result)}`);
      report.writes.push({ variant: context.variant, workload: "summary-mcp", round, warmup: round < 0, elapsedMs: clock.now() - start });
      await persist();
    }
    report.progress = "native-consistency"; await persist();
    const candidate = contexts.find(context => context.name === "candidate");
    const principal = await candidate.tokens.authenticate(token.secret);
    const state = () => candidate.tools.repository.state(principal).then(C.canonical);
    const initialState = await state();
    await db.updateTable("resource_sources").set({ last_checked_at: Date.now(), error_code: null }).where("resource_id", "=", id(1)).execute();
    assert(await state() === initialState, "Source bookkeeping invalidated native state");
    try {
      await db.transaction().execute(async tx => {
        await tx.updateTable("knowledge_resources").set({ summary: "Rolled back native summary" }).where("id", "=", id(1)).execute();
        throw Error("Expected native rollback");
      });
    } catch (error) { assert(String(error).includes("Expected native rollback"), "Unexpected rollback failure"); }
    assert(await state() === initialState, "Native rollback advanced revisions");
    const pageArgs = { libraryId: library, limit: 1, responseMode: "compact" };
    const page = await candidate.tools.call("list_resources", pageArgs, principal, new AbortController().signal);
    assert(!page.isError && page.structuredContent.nextCursor, "Missing native cursor");
    await db.updateTable("knowledge_resources").set({ summary: "Committed native summary" }).where("id", "=", id(1)).execute();
    assert(await state() !== initialState, "Native commit did not advance revisions");
    const stale = await candidate.tools.call("list_resources", { ...pageArgs, cursor: page.structuredContent.nextCursor }, principal, new AbortController().signal);
    assert(stale.isError && stale.structuredContent.error.code === "CURSOR_STALE", "Native cursor survived a content commit");
    await db.updateTable("library_resources").set({ deleted_at: Date.now() }).where("resource_id", "=", id(1)).execute();
    const hidden = await candidate.tools.call("get_resources", { resourceIds: [id(1)] }, principal, new AbortController().signal);
    assert(!hidden.isError && hidden.structuredContent.missingResourceIds[0] === id(1), "Removed native membership remained readable");
    const aba = "90000000-0000-4000-8000-999999999999";
    const insertLibrary = () => db.insertInto("knowledge_libraries").values({ id: aba, name: "Native revision ABA", created_at: 1, updated_at: 1 }).execute();
    await insertLibrary();
    const abaState = () => candidate.tools.repository.state({ ...principal, libraries: [aba] }).then(C.canonical);
    const first = await abaState();
    await db.deleteFrom("knowledge_libraries").where("id", "=", aba).execute(); await insertLibrary();
    assert(await abaState() !== first, "Native delete/recreate reused its revision");
    report.assertions.push("Native source bookkeeping, rollback, committed cursor invalidation, membership removal and delete/recreate ABA pass");
    for (const entry of [{ native }, ...writeContexts]) {
      const integrity = [], foreignKeys = [];
      await entry.native.queryAsync("PRAGMA integrity_check", [], { noParseParams: true, noCache: true, onRow: row => integrity.push(row.getResultByName("integrity_check")) });
      await entry.native.queryAsync("PRAGMA foreign_key_check", [], { noParseParams: true, noCache: true, onRow: () => foreignKeys.push(true) });
      assert(integrity.length === 1 && integrity[0] === "ok" && !foreignKeys.length, "Fixture integrity failed");
    }
    report.assertions.push("All three native fixtures pass integrity_check and foreign_key_check");
    assert(report.providerCalls === 0 && !Zotero.startupError, "Unexpected native/provider failure"); report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = String(error); report.stack = error.stack; }
  finally {
    metrics = undefined;
    const errors = [];
    for (const context of contexts) { try { context.tools.close(); await context.embedding.close(); } catch (error) { errors.push(String(error)); } }
    for (const owner of owners.reverse()) { try { await owner.close(); } catch (error) { errors.push(String(error)); } }
    report.cleanup = { passed: !errors.length, errors }; if (errors.length) report.status = "failed";
    report.finished = Date.now(); await persist();
  }
}
