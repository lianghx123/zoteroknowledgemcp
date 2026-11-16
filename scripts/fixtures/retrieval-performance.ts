// This developer harness is bundled separately; it never runs in the add-on.
declare const Zotero: any, Services: any, ChromeUtils: any, IOUtils: any, PathUtils: any;
declare const Components: any;
const clock = () => performance.now();

export async function run(options: any) {
  const report: any = { started: Date.now(), status: "running", samples: [], checks: [], providerCalls: 0, phases: [] };
  const output = PathUtils.join(options.folder, "results.json"), write = () => IOUtils.writeUTF8(output, JSON.stringify(report, null, 2));
  const runtime = Components.utils.getGlobalForObject(ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout);
  const signal = () => new runtime.AbortController().signal;
  let database: any, index: any, connection: any, originalExecute: any, server: any, token: any;
  const apis: any = {}, services: any = {}, tools: any = {};
  const assert = (condition: boolean, name: string) => { if (!condition) throw Error(name); report.checks.push(name); };
  let current: any;
  try {
    if (!Zotero.DataDirectory.dir.replaceAll("\\", "/").includes("/.scaffold/")) throw Error("Isolated Zotero required");
    for (const entry of options.bundles) { Services.scriptloader.loadSubScript(entry.url); apis[entry.arm] = (globalThis as any)[`RetrievalPerf_${entry.arm}`]; }
    const api = apis.full, live = Zotero.__knowledgeMCPAccess, embeddings = live.tools.search.embeddings;
    report.environment = { version: Zotero.version, dir: Zotero.DataDirectory.dir, accessibility: Services.appinfo.accessibilityEnabled,
      force: Services.prefs.getIntPref("accessibility.force_disabled", 0), instantiator: Services.appinfo.accessibilityInstantiator,
      dimensions: embeddings.config.current.dimensions, scalar: embeddings.config.current.indexMode, debug: Zotero.Debug.enabled };
    const file = PathUtils.join(options.folder, "fixture.sqlite");
    await api.sql`VACUUM INTO ${file}`.execute(live.tokens.db);
    database = await api.initializeDatabase(new Zotero.DBConnection(file), file);
    const db = database.db, config = embeddings.config.current, identity = api.spaceKey(config);
    await db.getExecutor().provideConnection(async (value: any) => { connection = value; });
    originalExecute = connection.executeQuery;
    connection.executeQuery = async function (query: any) {
      const started = clock(), value = await originalExecute.call(this, query);
      if (current) {
        current.sqlCalls++; current.rows += value.rows.length; current.sqlMs += clock() - started;
        if (options.rounds === 1) (current.queries ??= []).push({ sql: query.sql, rows: value.rows.length, ms: clock() - started });
      }
      return value;
    };
    const tokens = new api.McpTokens(db), cursors = new api.McpCursor(db); await cursors.start();
    const tokenRows = await db.selectFrom("mcp_tokens").select("id").where("revoked_at", "is", null).orderBy("created_at", "desc").execute();
    let principal: any;
    for (const row of tokenRows) { try { const p = await tokens.current(row.id); if (p.libraries.length && p.scopes.includes("knowledge:search")) { principal = p; break; } } catch {} }
    if (!principal) throw Error("A scoped read token is required");
    const ids = await live.tools.repository.ids(principal);
    const snapshot = await db.selectFrom("vector_snapshot_state").selectAll().where("profile_id", "=", embeddings.store.profile).executeTakeFirstOrThrow();
    const entries = await db.selectFrom("vector_index_entries").select(["engine_label", "embedding_id"]).where("build_id", "=", snapshot.build_id).execute();
    index = new api.VectorIndex(options.rootURI); await index.open(config.dimensions, config.indexMode);
    await index.restore(snapshot.snapshot_path, snapshot.snapshot_hash, snapshot.snapshot_bytes);
    const originalQuery = index.query.bind(index);
    index.query = async (...args: any[]) => { const start = clock(), value = await originalQuery(...args); if (current) { current.workerMs += clock() - start; current.workerQueries++; } return value; };
    const queries = ["地区产业创新如何权衡本地能力支撑与高复杂性产业的潜在收益？", "地方发展新产业时，如何利用产业邻近性降低能力搜寻成本？", "相对能力复杂性指标如何识别地区产业升级的收益空间？", "跨区域产业能力互补为何能够缓解本地创新能力约束？", "产业共聚和创新主体协同怎样提高高复杂性产业进入的可行性？"];
    const fixed = await db.selectFrom("block_embeddings").select(["id", "vector"]).where("profile_id", "=", snapshot.profile_id).where("state", "=", "active").orderBy("id").limit(5).execute();
    if (fixed.length < 5) throw Error("At least five active stored vectors are required for fixed query probes");
    const vectors = fixed.map((row: any) => api.vectorFromBlob(row.vector, config.dimensions));
    report.fixture = { resources: ids.length, vectors: entries.length, queries, queryVectorSource: "five stored fixture vectors; synthetic semantic probes, no provider requests" };
    for (const arm of options.arms) {
      const module = apis[arm], repository = new module.EmbeddingRepository(db), store = new module.VectorStore(repository, options.rootURI);
      Object.assign(store, { index, labels: new Map(entries.map((row: any) => [row.embedding_id, Number(row.engine_label)])), reverse: new Map(entries.map((row: any) => [Number(row.engine_label), row.embedding_id])), profile: snapshot.profile_id,
        identity, mode: config.indexMode, readable: true, status: "ready" });
      const facade = { repository, config: { current: config }, store, gateway: { embed() { report.providerCalls++; throw Error("Provider forbidden"); }, rerank() { report.providerCalls++; throw Error("Provider forbidden"); } } };
      const retrieval = new module.RetrievalService(facade);
      queries.forEach((q, i) => retrieval.cache.set(`${identity}:${q}`, { vector: vectors[i], expires: Date.now() + 86400000 }));
      services[arm] = retrieval; tools[arm] = new module.McpTools(tokens, cursors, retrieval, facade);
    }
    const normalize = (value: any) => JSON.stringify(value, (key, child) => key === "timings" ? undefined : key === "nextCursor" ? Boolean(child) : child);
    async function measured(label: string, action: () => Promise<any>) {
      const sample: any = { label, sqlCalls: 0, rows: 0, sqlMs: 0, workerMs: 0, workerQueries: 0 };
      current = sample; const started = clock();
      try { const value = await action(); sample.ms = clock() - started; report.samples.push(sample); return value; }
      finally { current = undefined; }
    }
    if (options.syntheticDiversify) {
      for (const size of [18, 100, 250]) {
        const hits = Array.from({ length: size }, (_, i) => ({ resourceID: `synthetic-${i}`, title: `Industrial capability regional innovation study ${i % 11} ${i}`, score: 1 / (i + 1), scoreType: "metadata", channels: ["metadata"], evidence: [], metadataMatches: [] }));
        const repository = { ids: async () => hits.map(row => row.resourceID), state: async () => ({ synthetic: true }), resource: async () => ({ version: 1 }) };
        const retrieval = { search: async () => ({ hits, channels: ["metadata"], degraded: [], coverage: {}, timings: {} }) };
        const searches = Object.fromEntries(options.arms.map((arm: string) => [arm, new apis[arm].McpSearch(tokens, cursors, repository, retrieval, { config: { current: config } })]));
        for (let round = -1; round < (size === 250 ? 3 : 5); round++) {
          let expected: string | undefined;
          for (const arm of round % 2 === 0 ? options.arms : [...options.arms].reverse()) {
            await measured(`diversity/${round}/${size}/${arm}`, () => searches[arm].execute({ scopeType: "authorized", query: "capability", mode: "metadata", limit: 5, diversify: true, diversityLambda: 0.7 }, principal, "synthetic-diversity", signal()));
            const snapshot: any = [...searches[arm].snapshots.values()].at(-1);
            const order = JSON.stringify(snapshot.hits ? snapshot.hits.map((row: any) => row.resourceID) : snapshot.value.map((row: any) => row.resourceId));
            expected ??= order; assert(order === expected, `equal-diversity-${size}-${round}-${arm}`);
          }
          await write();
        }
        for (const search of Object.values(searches) as any[]) search.close();
      }
      report.status = "passed";
      return;
    }
    const retrievalOptions = { candidates: 100, results: 100, evidence: 2, textMaxChars: 7000, rerank: false, excludeQualityFlags: ["running_header", "running_footer", "page_number", "low_information", "boilerplate"] };
    const references: any = {};
    for (let round = -1; round < options.rounds; round++) {
      for (let qi = 0; qi < (options.rounds === 1 ? 1 : queries.length); qi++) {
        const arms = round % 2 === 0 ? options.arms : [...options.arms].reverse();
        for (const arm of arms) {
          const result = await measured(`retrieval/${round}/${qi}/${arm}`, () => services[arm].search(queries[qi], "fusion", ids, signal(), "active", retrievalOptions));
          const key = `retrieval/${qi}`;
          (references[key] ??= {})[arm] = normalize(result);
        }
        assert(options.arms.every((arm: string) => references[`retrieval/${qi}`][arm] === references[`retrieval/${qi}`].baseline), `equal-retrieval-${round}-${qi}`);
      }
      report.phases.push({ phase: "retrieval", round }); await write();
    }
    for (let round = -1; round < options.rounds; round++) {
      for (let qi = 0; qi < (options.rounds === 1 ? 1 : queries.length); qi++) {
        for (const arm of round % 2 === 0 ? options.arms : [...options.arms].reverse()) {
          const args = { scopeType: "authorized", query: queries[qi], mode: "hybrid", limit: 5, snippetMaxChars: 250, includeDiagnostics: true, rerank: false };
          const result = await measured(`tool/${round}/${qi}/${arm}`, () => tools[arm].call("search_content", args, principal, signal()));
          if (result.isError) throw Error(JSON.stringify(result.structuredContent));
          (references[`tool/${qi}`] ??= {})[arm] = normalize(result.structuredContent);
        }
        assert(options.arms.every((arm: string) => references[`tool/${qi}`][arm] === references[`tool/${qi}`].baseline), `equal-tool-${round}-${qi}`);
      }
      report.phases.push({ phase: "tool", round }); await write();
    }
    // Read every page at each supported projection without rerunning retrieval.
    for (const mode of ["metadata", "fulltext", "vector", "hybrid"]) {
      const pages: any = {};
      for (const arm of ["baseline", "full"]) {
        const items = [], args: any = { scopeType: "authorized", query: queries[0], mode, limit: 3, diversify: true, snippetMaxChars: 250, responseMode: "full" };
        let cursor: string | undefined;
        do { const result = await tools[arm].call("search_content", { ...args, ...(cursor ? { cursor } : {}) }, principal, signal()); if (result.isError) throw Error(JSON.stringify(result)); items.push(...result.structuredContent.items); cursor = result.structuredContent.nextCursor; } while (cursor);
        pages[arm] = normalize(items);
      }
      assert(pages.baseline === pages.full, `equal-all-pages-${mode}`);
    }
    if (options.concurrency) {
      report.batches = [];
      for (let round = -1; round < 3; round++) for (const count of round % 2 === 0 ? [1, 4, 2] : [2, 4, 1]) for (const arm of round % 2 === 0 ? ["baseline", "full"] : ["full", "baseline"]) {
        let next = 0; const started = clock(), latencies: number[] = [];
        await Promise.all(Array.from({ length: count }, async () => {
          for (;;) { const i = next++; if (i >= 8) return; const start = clock(), result = await tools[arm].call("search_content", { scopeType: "authorized", query: queries[i % 5], mode: "hybrid", limit: 5, snippetMaxChars: 250, rerank: false }, principal, signal()); if (result.isError) throw Error(JSON.stringify(result)); latencies.push(clock() - start); }
        }));
        report.batches.push({ round, arm, concurrency: count, ms: clock() - started, latencies }); await write();
      }
    }
    if (options.http) {
      token = await tokens.create({ name: "Temporary retrieval verification", libraryIds: principal.libraries, scopes: ["knowledge:search", "knowledge:read"], expiresInDays: 30 });
      server = new api.McpHttp(tokens, tools.full); server.start(options.port);
      Zotero.__retrievalOptimizationHttp = { secret: token.secret, port: options.port, done: false, revoke: () => tokens.revoke(token.id) };
      report.httpReady = true; await write();
      const timer = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
      for (let count = 0; count < 6000 && !Zotero.__retrievalOptimizationHttp.done; count++) await new Promise(resolve => timer.setTimeout(resolve, 100));
      assert(Zotero.__retrievalOptimizationHttp.done, "HTTP-controller-completed");
    }
    report.status = "passed";
  } catch (error: any) { report.status = "failed"; report.error = String(error); report.stack = error.stack; }
  finally {
    report.cleanup = [];
    for (const close of [() => server?.close(), async () => {
      if (token) await database.db.transaction().execute(async (tx: any) => {
        for (const table of ["mcp_token_libraries", "mcp_token_scopes"]) await tx.deleteFrom(table).where("token_id", "=", token.id).execute();
        await tx.deleteFrom("mcp_tokens").where("id", "=", token.id).execute();
      });
      if (options.http) delete Zotero.__retrievalOptimizationHttp;
    }, () => { for (const service of Object.values(services) as any[]) service.close(); for (const tool of Object.values(tools) as any[]) tool.close(); }, () => { if (connection && originalExecute) connection.executeQuery = originalExecute; }, () => index?.close(), () => database?.close()]) {
      try { await close(); report.cleanup.push("passed"); } catch (error) { report.cleanup.push(String(error)); report.status = "failed"; }
    }
    for (const arm of options.arms) (globalThis as any)[`RetrievalPerf_${arm}`] = undefined;
    report.finished = Date.now(); await write();
  }
}
