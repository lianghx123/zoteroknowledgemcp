// Benchmark-only native harness. Never install its connection routing in production.
import { CompiledQuery, Kysely, sql } from "kysely";
import { initializeDatabase } from "../src/database/client.ts";
import { ZoteroDialect } from "../src/database/zotero-dialect.ts";
import { ZoteroDriver } from "../src/database/zotero-driver.ts";
import { McpTokens } from "../src/security/mcp-tokens.ts";
import { McpCursor } from "../src/security/mcp-cursor.ts";
import { McpTools } from "../src/mcp/tools/service.ts";
import { canonical } from "../src/mcp/contracts.ts";
import { toolDefinitions, validate } from "../src/mcp/tools/registry.ts";

const library = "90000000-0000-4000-8000-000000000001";
const resourceId = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const toolCases = id => [
  ["list_resources", { libraryId: library, limit: 20 }],
  ["get_resources", { resourceIds: [id], responseMode: "standard" }],
  ["get_resource_content", { resourceId: id, maxChars: 12000 }],
  ["list_content_blocks", { resourceId: id, limit: 20, includePreview: true }],
];
const timer = () => ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const wait = ms => new Promise(resolve => timer().setTimeout(resolve, ms));
let metrics;
let now;

function assert(condition, message) { if (!condition) throw Error(message); }
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}
export function environment() {
  return {
    version: Zotero.version, dataDirectory: Zotero.DataDirectory.dir,
    pid: Services.appinfo.processID, accessibilityEnabled: Services.appinfo.accessibilityEnabled,
    accessibilityForceDisabled: Services.prefs.getIntPref("accessibility.force_disabled", 0),
    accessibilityInstantiators: Services.prefs.getStringPref("accessibility.instantiators", ""),
    startupError: Zotero.startupError || null,
  };
}
class MeasuredDriver extends ZoteroDriver {
  async acquireConnection() {
    const start = now(), connection = await super.acquireConnection();
    if (metrics) metrics.connectionWaits.push(now() - start);
    return connection;
  }
  async beginTransaction(connection, settings) {
    if (settings.accessMode === "read only") {
      await connection.executeQuery(CompiledQuery.raw("BEGIN DEFERRED"));
    } else await super.beginTransaction(connection, settings);
  }
}
class MeasuredDialect extends ZoteroDialect {
  createDriver() { return new MeasuredDriver(this.native); }
}
function instrument(native) {
  const query = native.queryAsync.bind(native);
  native.queryAsync = async (...args) => {
    const start = now();
    try { return await query(...args); }
    finally {
      if (metrics) { metrics.sqlCalls++; metrics.sqlElapsedMs += now() - start; }
    }
  };
  return native;
}
function readFacade(db) {
  return new Proxy(db, { get(target, key) {
    if (key === "transaction") return () => target.transaction().setAccessMode("read only");
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
export async function seed(db, documents, blocksPerDocument) {
  const body = ("Synthetic literature evidence about neuroscience, renewable energy and controlled experiments. 中文阅读测试。 ").repeat(14).slice(0, 1024);
  const hash = "a".repeat(64), time = 1;
  await db.transaction().execute(async tx => {
    await sql.raw(`CREATE TEMP TABLE benchmark_numbers AS WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${documents}) SELECT i FROM n`).execute(tx);
    await tx.insertInto("knowledge_libraries").values({ id: library, name: "Synthetic concurrency benchmark", created_at: time, updated_at: time }).execute();
    await sql.raw(`INSERT INTO knowledge_resources(id,title,resource_type,language,metadata_authority,created_at,updated_at)
      SELECT printf('10000000-0000-4000-8000-%012d',i),'Synthetic experiment '||i,'journalArticle','en','local',1,1 FROM benchmark_numbers`).execute(tx);
    await sql.raw(`INSERT INTO library_resources(id,library_id,resource_id,added_at)
      SELECT printf('80000000-0000-4000-8000-%012d',i),'${library}',printf('10000000-0000-4000-8000-%012d',i),1 FROM benchmark_numbers`).execute(tx);
    await sql.raw(`INSERT INTO library_nodes(id,library_id,parent_id,node_type,name,sort_order,created_at,updated_at)
      SELECT printf('70000000-0000-4000-8000-%012d',i),'${library}',NULL,'folder','Folder '||i,i,1,1 FROM benchmark_numbers WHERE i<=100`).execute(tx);
    await sql.raw(`INSERT INTO resource_sources(id,resource_id,source_type,source_role,availability,text_content,media_type,source_fingerprint,fingerprint_algorithm,created_at,updated_at)
      SELECT printf('20000000-0000-4000-8000-%012d',i),printf('10000000-0000-4000-8000-%012d',i),'manual','primary_document','available','Synthetic source','text/markdown','${hash}','sha256',1,1 FROM benchmark_numbers`).execute(tx);
    await sql.raw(`INSERT INTO content_generations(id,resource_id,source_id,base_content_version,content_version,source_version,source_fingerprint,origin,content_fingerprint,normalizer_version,created_by_type,created_at)
      SELECT printf('30000000-0000-4000-8000-%012d',i),printf('10000000-0000-4000-8000-%012d',i),printf('20000000-0000-4000-8000-%012d',i),0,1,1,'${hash}','manual','${hash}','benchmark-1','system',1 FROM benchmark_numbers`).execute(tx);
    await sql.raw(`INSERT INTO structure_nodes(id,generation_id,node_type,label,path,depth,sort_order,source_type,created_at)
      SELECT printf('40000000-0000-4000-8000-%012d',i),printf('30000000-0000-4000-8000-%012d',i),'root','Synthetic document','/',0,0,'manual',1 FROM benchmark_numbers`).execute(tx);
    // Each source has its own immutable generation and 100 bounded reading blocks.
    for (let start = 1; start <= documents; start += 50) {
      await sql`INSERT INTO content_blocks(id,generation_id,structure_node_id,block_type,canonical_order,local_order,content_markdown,content_normalized,content_hash,source_type,created_at)
        SELECT printf('50000000-0000-4000-8000-%012d',(d.i-1)*${blocksPerDocument}+b.i),
          printf('30000000-0000-4000-8000-%012d',d.i),printf('40000000-0000-4000-8000-%012d',d.i),
          'text',b.i,b.i,${body},${body},${hash},'manual',1
        FROM benchmark_numbers d CROSS JOIN benchmark_numbers b
        WHERE d.i BETWEEN ${start} AND ${Math.min(start + 49, documents)} AND b.i<=${blocksPerDocument}`.execute(tx);
    }
    await sql.raw("UPDATE content_generations SET state='ready',published_at=1").execute(tx);
    await sql.raw("UPDATE resource_sources SET active_generation_id=replace(id,'20000000-','30000000-'),content_version=1").execute(tx);
    await sql.raw("UPDATE knowledge_resources SET canonical_source_id=replace(id,'10000000-','20000000-')").execute(tx);
    await tx.insertInto("plugin_state").values({ key: "benchmark-counter", value_json: "0", updated_at: 0 }).execute();
  });
  await sql.raw("ANALYZE").execute(db);
  await sql.raw("PRAGMA wal_checkpoint(TRUNCATE)").execute(db);
  return { documents, blocksPerDocument, blocks: documents * blocksPerDocument, charactersPerBlock: body.length, textCharacters: documents * blocksPerDocument * body.length };
}
async function openNative(file, readOnly) {
  const native = new Zotero.DBConnection(file);
  // Use the same Zotero row/parameter wrapper for both arms. Private caches are
  // essential: Gecko's default shared cache adds cross-connection table locks.
  native._connection = await native.Sqlite.openConnection({ path: file, readOnly, sharedMemoryCache: !readOnly, openNotExclusive: readOnly || Zotero.isMac });
  native.readOnly = readOnly;
  await native.queryAsync("PRAGMA busy_timeout=5000");
  await native.queryAsync("PRAGMA locking_mode=NORMAL");
  await native.queryAsync("PRAGMA foreign_keys=ON");
  await native.queryAsync("PRAGMA cache_size=-8000");
  if (readOnly) await native.queryAsync("PRAGMA query_only=ON");
  return instrument(native);
}
function leasePool(readers) {
  const free = [...readers], queue = [];
  return async action => {
    const start = now();
    const reader = free.length ? free.shift() : await new Promise(resolve => queue.push(resolve));
    if (metrics) metrics.readerWaits.push(now() - start);
    try { return await action(reader); }
    finally { if (queue.length) queue.shift()(reader); else free.push(reader); }
  };
}
async function runBatch(config, workload, concurrency, count, token, documents) {
  const record = { config: config.name, workload, concurrency, count, latencies: [], readLatencies: [], writeLatencies: [], connectionWaits: [], readerWaits: [], sqlCalls: 0, sqlElapsedMs: 0, responseBytes: 0, checksum: 0, eventLoopDelays: [] };
  metrics = record;
  let index = 0, monitoring = true;
  const tick = () => {
    const start = now();
    return timer().setTimeout(() => { if (monitoring) { record.eventLoopDelays.push(Math.max(0, now() - start - 10)); tick(); } }, 10);
  };
  tick();
  const start = now();
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = index++; if (i >= count) return;
        const began = now(), write = workload === "mixed" && i % 10 === 0;
        if (write) {
          await config.writer.transaction().execute(async tx => {
            const before = await tx.selectFrom("plugin_state").select("value_json").where("key", "=", "benchmark-counter").executeTakeFirstOrThrow();
            await tx.updateTable("plugin_state").set({ value_json: String(Number(before.value_json) + 1), updated_at: i }).where("key", "=", "benchmark-counter").execute();
          });
        } else if (workload === "sql") {
          await config.lease(async reader => {
            const id = resourceId((i * 37) % documents + 1);
            const result = await sql`SELECT id, canonical_order, substr(content_markdown,1,2000) AS body FROM content_blocks
              WHERE generation_id=${id.replace("10000000-", "30000000-")} ORDER BY canonical_order LIMIT 12`.execute(reader.db);
            assert(result.rows.length === 12, "Bounded SQL row count");
            for (const row of result.rows) record.checksum += row.body.length;
          });
        } else {
          // Real HTTP authentication updates last_used_at for every request,
          // including reads; keep that write in both arms.
          const principal = await config.tokens.authenticate(token.secret);
          await config.lease(async reader => {
            const id = resourceId((i * 37) % documents + 1);
            const variants = toolCases(id);
            const [name, args] = variants[i % variants.length];
            const response = await reader.tools.call(name, args, principal, new AbortController().signal);
            assert(!response.isError, `Tool failed: ${JSON.stringify(response.structuredContent)}`);
            // Include the same final JSON serialization as MCP, without HTTP or
            // the transport's concurrency admission limits.
            record.responseBytes += new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: i, result: response })).length;
          });
        }
        const duration = now() - began;
        record.latencies.push(duration); (write ? record.writeLatencies : record.readLatencies).push(duration);
      }
    }));
    record.elapsedMs = now() - start;
  } finally { monitoring = false; metrics = undefined; }
  record.requestsPerSecond = count * 1000 / record.elapsedMs;
  record.p50Ms = percentile(record.latencies, 0.5); record.p95Ms = percentile(record.latencies, 0.95);
  record.readP95Ms = percentile(record.readLatencies, 0.95); record.writeP95Ms = percentile(record.writeLatencies, 0.95);
  record.connectionWaitP95Ms = percentile(record.connectionWaits, 0.95);
  record.readerWaitP95Ms = percentile(record.readerWaits, 0.95);
  record.eventLoopDelayP95Ms = percentile(record.eventLoopDelays, 0.95);
  record.eventLoopDelayMaxMs = Math.max(0, ...record.eventLoopDelays);
  return record;
}
export async function run(options) {
  const { folder, rounds = 5, requests = 48, documents = 1000, blocksPerDocument = 100 } = options;
  assert(Zotero.DataDirectory.dir.replaceAll("\\", "/").includes("/.scaffold/"), "Isolated Zotero required");
  assert(folder.replaceAll("\\", "/").includes("/.scaffold/"), "Scratch output required");
  const performance = Zotero.getMainWindows()[0].performance;
  now = () => performance.now();
  const report = { started: Date.now(), status: "running", environment: environment(), options, samples: [], assertions: [], providerCalls: 0 };
  const persist = () => IOUtils.writeUTF8(PathUtils.join(folder, "native-results.json"), JSON.stringify(report, null, 2));
  let owner;
  const databases = [];
  try {
    assert(!report.environment.startupError, "Zotero startup error");
    assert(!report.environment.accessibilityEnabled, "Accessibility activated; samples would be contaminated");
    await persist();
    const file = PathUtils.join(folder, "synthetic.sqlite");
    assert(!await IOUtils.exists(file), "Refusing to reuse a fixture database");
    owner = await initializeDatabase(new Zotero.DBConnection(file), file);
    report.fixture = await seed(owner.db, documents, blocksPerDocument);
    const tokens = new McpTokens(owner.db), cursor = new McpCursor(owner.db); await cursor.start();
    const token = await tokens.create({ name: "Synthetic benchmark token", libraryIds: [library], scopes: ["knowledge:search", "knowledge:read"] });
    // Release the seeding writer before opening benchmark connections. Retain
    // the owner's OS lease so no second writer can initialize this scratch DB.
    await owner.db.destroy();
    const nativeWriter = await openNative(file, false), writer = new Kysely({ dialect: new MeasuredDialect(nativeWriter) }); databases.push(writer);
    await sql.raw("PRAGMA journal_mode=WAL").execute(writer);
    await sql.raw("PRAGMA synchronous=FULL").execute(writer);
    const writerTokens = new McpTokens(writer), sharedCursor = new McpCursor(writer); await sharedCursor.start();
    const makeReader = db => ({ db, tools: new McpTools(new McpTokens(db), sharedCursor) });
    const fifoReader = makeReader(writer), deferredReader = makeReader(readFacade(writer));
    const readers = [];
    for (let i = 0; i < 8; i++) {
      const native = await openNative(file, true), db = new Kysely({ dialect: new MeasuredDialect(native) }); databases.push(db);
      readers.push(makeReader(readFacade(db)));
    }
    const configs = [
      { name: "fifo", lease: action => action(fifoReader) },
      { name: "fifo-deferred", lease: action => action(deferredReader) },
      { name: "readers-4", lease: leasePool(readers.slice(0, 4)) },
      { name: "readers-8", lease: leasePool(readers) },
    ].map(config => ({ ...config, writer, tokens: writerTokens }));
    // Verify SQLite enforces read-only connections and snapshot isolation.
    let rejected = false;
    try { await readers[0].db.updateTable("plugin_state").set({ value_json: "1" }).where("key", "=", "benchmark-counter").execute(); } catch { rejected = true; }
    assert(rejected, "Read-only write was accepted"); report.assertions.push("Read connections reject writes");
    const before = await readers[0].db.selectFrom("plugin_state").select("value_json").where("key", "=", "benchmark-counter").executeTakeFirstOrThrow();
    await readers[0].db.transaction().setAccessMode("read only").execute(async tx => {
      const a = await tx.selectFrom("plugin_state").select("value_json").where("key", "=", "benchmark-counter").executeTakeFirstOrThrow();
      await writer.updateTable("plugin_state").set({ value_json: String(Number(a.value_json) + 1) }).where("key", "=", "benchmark-counter").execute();
      const b = await tx.selectFrom("plugin_state").select("value_json").where("key", "=", "benchmark-counter").executeTakeFirstOrThrow();
      assert(a.value_json === b.value_json, "Snapshot changed inside read transaction");
    });
    report.assertions.push("Writer commits during an active WAL read snapshot; reader snapshot remains stable");
    let expectedWrites = Number(before.value_json) + 1;
    const principal = await writerTokens.authenticate(token.secret), expected = [];
    for (const config of configs) {
      let index = 0;
      for (const [name, args] of toolCases(resourceId(1))) {
        await config.lease(async reader => {
          const response = await reader.tools.call(name, args, principal, new AbortController().signal);
          assert(!response.isError, `Preflight ${config.name}/${name}: ${JSON.stringify(response.structuredContent)}`);
          validate(toolDefinitions.find(tool => tool.name === name).outputSchema, response.structuredContent, "output");
          // Signed cursor expiries differ across calls; compare presence and all
          // other semantic output, including content, IDs and truncation.
          const normalized = JSON.parse(JSON.stringify(response.structuredContent, (key, value) => key === "nextCursor" ? Boolean(value) : value));
          const result = canonical(normalized);
          if (config.name === "fifo") expected[index] = result;
          else assert(result === expected[index], `Output mismatch: ${config.name}/${name}`);
        });
        index++;
      }
    }
    report.assertions.push("All four tool outputs match across all arms and validate against published schemas");
    report.fixture.databaseBytes = (await IOUtils.stat(file)).size;
    report.connectionConfiguration = { writer: "One native connection with production default shared cache, WAL, synchronous=FULL, 8192000-byte cache, existing FIFO driver", readers: "4 or 8 SQLITE_OPEN_READONLY private-cache native connections, query_only=ON, 8192000-byte cache each", readTransactions: "FIFO uses production BEGIN IMMEDIATE; fifo-deferred and readers use BEGIN DEFERRED; writes always BEGIN IMMEDIATE", admission: "Native tool calls bypass HTTP 429 limits; each request still authenticates and updates last_used_at", poolScheduling: "Each read request leases one reader for its duration; FIFO arms retain per-query scheduling", note: "No production routing changes; eight reader connections remain open for every arm" };
    await persist();
    for (const workload of ["sql", "mcp", "mixed"]) {
      for (const concurrency of [1, 4, 8, 16]) {
        for (let round = -1; round < rounds; round++) {
          // Reverse alternate rounds, so every arm is measured warm and in both
          // earlier/later positions. Warmup has the full request count.
          const order = round % 2 === 0 ? configs : [...configs].reverse();
          for (const config of order) {
            report.progress = { workload, concurrency, round, config: config.name };
            await persist();
            const sample = await runBatch(config, workload, concurrency, workload === "sql" ? requests * 16 : requests, token, documents);
            sample.round = round; sample.warmup = round === -1; report.samples.push(sample);
            if (workload === "mixed") expectedWrites += Math.ceil(requests / 10);
            assert(!Services.appinfo.accessibilityEnabled, "Accessibility activated during measurement");
            await persist(); await wait(50);
          }
        }
      }
    }
    const counter = await writer.selectFrom("plugin_state").select("value_json").where("key", "=", "benchmark-counter").executeTakeFirstOrThrow();
    assert(Number(counter.value_json) === expectedWrites, "Lost write during benchmark");
    report.assertions.push(`All ${expectedWrites} counter increments committed without lost updates`);
    const integrity = await sql.raw("PRAGMA integrity_check").execute(writer);
    assert(integrity.rows[0].integrity_check === "ok", "Integrity check failed");
    assert((await sql.raw("PRAGMA foreign_key_check").execute(writer)).rows.length === 0, "Foreign key violation");
    report.assertions.push("SQLite integrity_check and foreign_key_check passed");
    assert(!Zotero.startupError, "Native startup error occurred");
    report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = String(error); report.stack = error.stack; }
  finally {
    metrics = undefined;
    const closed = await Promise.allSettled(databases.reverse().map(db => db.destroy()));
    const errors = closed.filter(result => result.status === "rejected").map(result => String(result.reason));
    try { await owner?.close(); } catch (error) { errors.push(String(error)); }
    report.cleanup = { databaseConnectionsClosed: errors.length === 0, errors };
    if (errors.length) report.status = "failed";
    report.environmentAfter = environment(); report.finished = Date.now(); await persist();
  }
  return report.status;
}
