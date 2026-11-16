import { mockLocalization } from "./helpers/localization.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createContext, runInContext } from "node:vm";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { MockNativeDatabase } from "./helpers/native-database.mjs";
import { treeFixture, treeTables } from "./helpers/tree-integrity.mjs";

const bundle = await build({
  stdin: { contents: `export * from "./src/database/client.ts";
export * from "./src/database/migration-service.ts";
export * from "./src/database/migration-provider.ts";
export * from "./src/database/backup-service.ts";
export * from "./src/database/owner-lease.ts";
export * from "./src/database/zotero-dialect.ts";
export { KnowledgeTrashRepository } from "./src/repositories/knowledge-trash.ts";
export { Kysely, sql } from "kysely";
export { Migrator } from "kysely/migration";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "browser", target: "firefox140", format: "cjs", write: false,
});

function fixture(t, host) {
  const module = { exports: {} };
  const sandbox = createContext({ Localization: mockLocalization(), module, exports: module.exports, Uint8Array,
    Zotero: host || { DBConnection: class extends MockNativeDatabase { constructor() { super(); } } } });
  runInContext(bundle.outputFiles[0].text, sandbox);
  const api = module.exports;
  const native = new MockNativeDatabase();
  // Raw migration tests simulate ownership; on-disk cases below use real leases.
  const db = new api.Kysely({ dialect: new api.ZoteroDialect(native, () => {}) });
  t.after(() => db.destroy());
  return { ...api, native, db };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Database operations did not settle")), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

test("all four confidence columns expose number or null in the public database types", () => {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict",
    "--skipLibCheck", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler",
    "test/fixtures/database-types.ts"]);
});

test("all static migration snapshots match reviewed fixtures and their source checksums", t => {
  execFileSync(process.execPath, ["scripts/promote-database-schema.mjs", "--check"]);
  const { migrations } = fixture(t);
  for (const migration of Object.values(migrations)) {
    assert.equal(createHash("sha256").update(JSON.stringify(migration.statements)).digest("hex"), migration.checksum);
    assert.equal(migration.down, undefined);
    assert.ok(!migration.statements.some(sql => /CREATE TABLE kysely_migration/.test(sql)));
  }
});

test("snapshot checks accept LF and CRLF without rewriting files and still reject content drift", t => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-schema-eol-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = ["docs/development/database-schema.sql", "docs/development/database-search-schema.sql",
    "docs/development/database-mcp-schema.sql", "docs/development/database-tree-integrity-schema.sql",
    "docs/development/database-bibliographic-schema.sql", "src/database/migrations/0005-bibliographic-fields.ts",
    "docs/development/database-sync-folder-exclusions-schema.sql", "src/database/migrations/0008-sync-folder-exclusions.ts",
    "docs/development/database-vector-schema.sql", "src/database/migrations/0009-vector-retrieval.ts",
    "docs/development/database-search-offsets-schema.sql", "src/database/migrations/0010-search-offsets.ts",
    "docs/development/database-reference-backfill-schema.sql", "src/database/migrations/0011-reference-backfill.ts",
    "docs/development/database-visual-links-schema.sql", "src/database/migrations/0012-visual-links.ts",
    "docs/development/database-reference-numbering-schema.sql", "src/database/migrations/0013-reference-numbering.ts",
    "docs/development/database-purge-indexes-schema.sql", "src/database/migrations/0014-purge-indexes.ts",
    "docs/development/database-mcp-revisions-schema.sql", "src/database/migrations/0015-mcp-revisions.ts",
    "docs/development/database-mcp-revision-hotpaths-schema.sql", "src/database/migrations/0016-mcp-revision-hotpaths.ts",
    "docs/development/database-sync-purge-schema.sql", "src/database/migrations/0007-sync-purge.ts",
    "docs/development/database-trash-schema.sql", "src/database/migrations/0006-knowledge-trash.ts",
    "src/database/migrations/0001-local-foundation.ts",
    "src/database/migrations/0002-full-text-index.ts", "src/database/migrations/0003-mcp-storage.ts",
    "src/database/migrations/0004-tree-integrity.ts", "src/database/types.ts"];
  const sources = new Map(files.map(file => [file, readFileSync(file, "utf8").replaceAll("\r\n", "\n")]));
  const check = () => execFileSync(process.execPath,
    [join(process.cwd(), "scripts/promote-database-schema.mjs"), "--check"], { cwd: root, stdio: "pipe" });
  for (const newline of ["\n", "\r\n"]) {
    for (const [file, source] of sources) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source.replaceAll("\n", newline));
    }
    const before = new Map(files.map(file => [file, readFileSync(join(root, file))]));
    check();
    for (const [file, bytes] of before) assert.deepEqual(readFileSync(join(root, file)), bytes);
    const changes = [
      ["src/database/migrations/0001-local-foundation.ts", "CREATE TABLE plugin_state", "CREATE TABLE unexpected_plugin_state"],
      ["src/database/migrations/0004-tree-integrity.ts", "CREATE TRIGGER library_node_cycle_insert", "CREATE TRIGGER unexpected_cycle_insert"],
      ["src/database/migrations/0005-bibliographic-fields.ts", "ADD COLUMN doi TEXT", "ADD COLUMN wrong_doi TEXT"],
      ["src/database/migrations/0006-knowledge-trash.ts", "CREATE TABLE knowledge_trash_entries", "CREATE TABLE unexpected_trash_entries"],
      ["src/database/types.ts", "confidence: number | null", "confidence: string | null"],
    ];
    for (const [file, original, changed] of changes) {
      const path = join(root, file);
      const source = readFileSync(path, "utf8");
      assert.ok(source.includes(original));
      writeFileSync(path, source.replace(original, changed));
      assert.throws(check, error => {
        assert.equal(error.status, 1);
        assert.ok(String(error.stderr).includes(`Schema snapshot differs: ${file}`));
        return true;
      });
      writeFileSync(path, source);
    }
  }
});

test("fresh Kysely migration creates every fixture table, index and trigger", async t => {
  const { db, initializeDatabase, migrations } = fixture(t);
  // Use the real initialization path, including capability rollback.
  await db.destroy();
  const port = new MockNativeDatabase();
  const database = await initializeDatabase(port, "/isolated/test.sqlite");
  t.after(() => database.close());
  const expected = new DatabaseSync(":memory:");
  t.after(() => expected.close());
  for (const name of ["database-schema.sql", "database-search-schema.sql", "database-mcp-schema.sql", "database-tree-integrity-schema.sql", "database-bibliographic-schema.sql", "database-trash-schema.sql", "database-sync-purge-schema.sql", "database-sync-folder-exclusions-schema.sql", "database-vector-schema.sql", "database-search-offsets-schema.sql", "database-visual-links-schema.sql", "database-reference-numbering-schema.sql", "database-purge-indexes-schema.sql", "database-mcp-revisions-schema.sql", "database-mcp-revision-hotpaths-schema.sql"]) {
    expected.exec(readFileSync(`docs/development/${name}`, "utf8"));
  }
  const objects = database => database.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  assert.deepEqual(objects(port.sqlite), objects(expected));
  const definitions = database => database.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('kysely_migration','kysely_migration_lock') ORDER BY type,name").all()
    .map(row => ({ ...row, sql: row.sql?.replace(/\s+/g, " ").trim() }));
  assert.deepEqual(definitions(port.sqlite), definitions(expected));
  assert.equal(port.sqlite.prepare("SELECT count(*) n FROM kysely_migration").get().n, Object.keys(migrations).length);
  const before = port.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all();
  await database.close();
  assert.equal(port.closed, true);
  assert.equal(before.length, Object.keys(migrations).length);
});

test("migration is repeatable, unknown history and changed checksums fail closed", async t => {
  const { db, native, sql, migrateDatabase } = fixture(t);
  await sql`PRAGMA locking_mode = EXCLUSIVE`.execute(db);
  await migrateDatabase(db, async () => assert.fail("Fresh install has no backup"));
  const before = native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all();
  await migrateDatabase(db, async () => assert.fail("No upgrade has no backup"));
  assert.deepEqual(native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all(), before);
  native.sqlite.prepare("UPDATE plugin_state SET value_json='\"modified\"' WHERE key LIKE 'migration-checksum:0001%'").run();
  await assert.rejects(() => migrateDatabase(db, async () => {}), /checksum mismatch/);
  native.sqlite.prepare("INSERT INTO kysely_migration VALUES ('9999-newer', ?)").run(new Date().toISOString());
  await assert.rejects(() => migrateDatabase(db, async () => {}), /Unsupported/);
});

test("visual schema upgrade is atomic and preserves the preceding migration history", async t => {
  const { db, native, sql, Migrator, migrations, migrateDatabase } = fixture(t);
  const baseline = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0012-visual-links"));
  assert.equal((await new Migrator({ db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest()).error, undefined);
  const history = native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all();
  native.options.fail = statement => statement.startsWith("CREATE INDEX ix_visual_link_generation");
  await assert.rejects(migrateDatabase(db, async () => {}));
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'content_visual_%'").get().n, 0);
  assert.deepEqual(native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all(), history);
  native.options.fail = undefined; await migrateDatabase(db, async () => {});
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'content_visual_%'").get().n, 2);
  assert.deepEqual(native.sqlite.prepare(`SELECT * FROM kysely_migration ORDER BY name LIMIT ${history.length}`).all(), history);
  assert.equal(native.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("reference backfill is atomic, preserves prior records and only derives published parser blocks", async t => {
  const { db, native, sql, Migrator, migrations, migrateDatabase } = fixture(t);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
  const baseline = Object.fromEntries(Object.entries(migrations).slice(0, 10));
  assert.equal((await new Migrator({ db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest()).error, undefined);
  const insertBlocks = treeFixture(native.sqlite, "content_blocks"), ids = insertBlocks([null, null, null, null, null], "reference");
  native.sqlite.prepare("UPDATE content_generations SET origin='parse' WHERE id='generation'").run();
  for (const [index, type] of ["reference", "reference", "bibliography", "reference_entry", "footnote"].entries()) {
    native.sqlite.prepare("UPDATE content_blocks SET block_type=?, content_markdown=? WHERE id=?")
      .run(type, `[${index + 1}] Original reference.`, ids[index]);
  }
  native.sqlite.prepare("UPDATE content_generations SET state='ready', published_at=1, content_fingerprint=? WHERE id='generation'").run("a".repeat(64));
  for (const [index, [origin, state]] of [["parse", "staging"], ["parse", "failed"], ["import", "ready"], ["parse", "partial"], ["parse", "superseded"]].entries()) {
    const id = `extra-${index}`, published = ["ready", "partial", "superseded"].includes(state);
    await db.insertInto("content_generations").values({ id, resource_id: "resource", source_id: "source", base_content_version: index + 1,
      content_version: index + 2, source_version: 1, source_fingerprint: "a".repeat(64), origin, normalizer_version: "fixture", created_by_type: "system", created_at: 0 }).execute();
    await db.insertInto("content_blocks").values({ id, generation_id: id, block_type: "reference", canonical_order: 0,
      content_markdown: "Extra reference", content_hash: "a".repeat(64), source_type: "ocr", created_at: 0 }).execute();
    await db.updateTable("content_generations").set({ state: state === "superseded" ? "ready" : state,
      published_at: published ? 1 : null, content_fingerprint: published ? "a".repeat(64) : null }).where("id", "=", id).execute();
    if (state === "superseded") await db.updateTable("content_generations").set({ state }).where("id", "=", id).execute();
  }
  await db.insertInto("resource_references").values([
    { id: "reviewed", resource_id: "resource", source_id: "source", generation_id: "generation", source_block_id: ids[1],
      reference_type: "bibliography", raw_text: "Reviewed reference", parsed_json: '{"title":"Reviewed title"}', match_status: "manual", created_at: 1, updated_at: 2 },
    { id: "removed", resource_id: "resource", source_id: "source", generation_id: "generation", source_block_id: ids[2],
      reference_type: "bibliography", raw_text: "Removed reference", parsed_json: "{}", match_status: "unmatched", created_at: 1, updated_at: 2, deleted_at: 2 },
  ]).execute();
  const records = () => native.sqlite.prepare("SELECT * FROM resource_references ORDER BY id").all();
  const existing = records();
  // Fail after insertion to prove the migration, checksum and history roll back together.
  native.options.fail = statement => statement.startsWith("INSERT INTO plugin_state");
  await assert.rejects(migrateDatabase(db, async () => {}), /Injected/);
  assert.deepEqual(records(), existing);
  assert.equal((await db.selectFrom("kysely_migration").selectAll().execute()).length, 10);
  native.options.fail = undefined; await migrateDatabase(db, async () => {});
  const rows = records();
  assert.deepEqual(rows.filter(row => ["reviewed", "removed"].includes(row.id)).map(row => ({ ...row })), existing.map(row => ({ ...row, reference_number: null, entry_order: null })));
  const derived = rows.filter(row => ids.includes(row.id));
  assert.deepEqual(derived.map(row => row.id), [ids[0], ids[3]]);
  assert.deepEqual(rows.filter(row => row.id.startsWith("extra-")).map(row => row.id), ["extra-3", "extra-4"]);
  for (const row of derived) {
    assert.equal(row.source_block_id, row.id); assert.equal(row.resource_id, "resource");
    assert.equal(row.source_id, "source"); assert.equal(row.generation_id, "generation");
    assert.equal(row.match_status, "unmatched"); assert.equal(row.confidence, null); assert.equal(row.parsed_json, "{}");
  }
  for (const statement of migrations["0011-reference-backfill"].statements) await sql.raw(statement).execute(db);
  assert.deepEqual(records(), rows);
  assert.equal(native.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("reference-numbering schema upgrade rolls back columns and links before a safe retry", async t => {
  const { db, native, sql, Migrator, migrations, migrateDatabase } = fixture(t);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
  const baseline = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0013-reference-numbering"));
  assert.equal((await new Migrator({ db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest()).error, undefined);
  native.options.fail = statement => statement.startsWith("CREATE INDEX ix_reference_source_generation");
  await assert.rejects(migrateDatabase(db, async () => {}), /Injected/);
  assert.equal(native.sqlite.prepare("PRAGMA table_info(resource_references)").all().some(row => row.name === "reference_number"), false);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name IN ('reference_source_blocks','content_reference_projections')").get().n, 0);
  assert.equal((await db.selectFrom("kysely_migration").selectAll().execute()).length, 12);
  native.options.fail = undefined; await migrateDatabase(db, async () => {});
  assert.equal(native.sqlite.prepare("PRAGMA table_info(resource_references)").all().some(row => row.name === "reference_number"), true);
  assert.equal((await db.selectFrom("kysely_migration").selectAll().execute()).length, Object.keys(migrations).length);
  assert.equal(native.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("purge-index upgrade preserves data and history and rolls back all indexes before retry", async t => {
  const { db, native, sql, Migrator, migrations, migrateDatabase } = fixture(t);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
  const name = "0014-purge-indexes";
  const baseline = Object.fromEntries(Object.entries(migrations).filter(([key]) => key < name));
  assert.equal((await new Migrator({ db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest()).error, undefined);
  treeFixture(native.sqlite, "content_blocks")([null, null], "purge-index");
  const history = native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all();
  const tables = native.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'kysely_%' AND name NOT LIKE 'search_fts%' ORDER BY name").all();
  const rows = () => tables.map(({ name: table }) => [table, native.sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()
    .filter(row => table !== "plugin_state" || !row.key.startsWith("migration-checksum:") || row.key < `migration-checksum:${name}`)]);
  const before = rows();
  const indexNames = Array.from(migrations[name].statements, statement => /^CREATE INDEX (\w+)/.exec(statement)[1]);
  const installed = () => native.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all()
    .map(row => row.name).filter(index => indexNames.includes(index)).sort();
  let backups = 0;
  const backup = async () => { backups++; assert.deepEqual(rows(), before); assert.deepEqual(installed(), []); };
  native.options.fail = statement => statement.startsWith("CREATE INDEX ix_artifact_file_owner");
  await assert.rejects(migrateDatabase(db, backup), /Injected/);
  assert.deepEqual(installed(), [], "a late failure rolls back every new index");
  assert.deepEqual(rows(), before);
  assert.deepEqual(native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all(), history);
  assert.equal(native.sqlite.prepare("SELECT value_json FROM plugin_state WHERE key=?").get(`migration-checksum:${name}`), undefined);
  native.options.fail = undefined;
  await migrateDatabase(db, backup);
  assert.equal(backups, 2);
  assert.deepEqual(installed(), indexNames.sort());
  assert.deepEqual(rows(), before, "the upgrade adds indexes and its checksum only");
  assert.deepEqual(native.sqlite.prepare(`SELECT * FROM kysely_migration ORDER BY name LIMIT ${history.length}`).all(), history);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM kysely_migration").get().n, Object.keys(migrations).length);
  await migrateDatabase(db, async () => assert.fail("An unchanged schema must not create another backup"));
  assert.equal(native.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("purge indexes replace full-table foreign-key probes when deleting content blocks", async t => {
  const { db, native, sql, Migrator, migrations, migrateDatabase } = fixture(t);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
  const baseline = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0014-purge-indexes"));
  assert.equal((await new Migrator({ db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest()).error, undefined);
  treeFixture(native.sqlite, "content_blocks")([null], "purge-probe");
  const plan = () => native.sqlite.prepare("EXPLAIN QUERY PLAN DELETE FROM content_blocks WHERE generation_id IN (SELECT id FROM content_generations WHERE resource_id=?)")
    .all("resource").map(row => row.detail);
  const tables = ["content_blocks", "resource_references", "resource_annotations", "search_documents"];
  const scans = details => details.filter(detail => tables.some(table => new RegExp(`^SCAN ${table}(?:\\s|$)`).test(detail)));
  assert.ok(scans(plan()).length >= tables.length, "the preceding schema demonstrates the expensive child probes");
  await migrateDatabase(db, async () => {});
  assert.deepEqual(scans(plan()), [], "foreign-key checks use lookup indexes without disabling constraints");
  assert.equal(native.sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
});

test("MCP revision upgrade seeds existing scopes atomically without rewriting business rows or history", async t => {
  const { db, native, sql, Migrator, migrations, migrateDatabase } = fixture(t);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
  const name = "0015-mcp-revisions", baseline = Object.fromEntries(Object.entries(migrations).filter(([key]) => key < name));
  assert.equal((await new Migrator({ db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest()).error, undefined);
  treeFixture(native.sqlite, "library_nodes")([null], "revision-folder");
  treeFixture(native.sqlite, "content_blocks")([null], "revision-block");
  native.sqlite.prepare("INSERT INTO library_resources(id,library_id,resource_id,added_at) VALUES ('revision-member','library','resource',0)").run();
  const history = native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all();
  const rows = () => ["knowledge_libraries", "knowledge_resources", "resource_sources", "content_generations", "content_blocks", "library_nodes", "library_resources"]
    .map(table => [table, native.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
  const before = rows(); let backups = 0;
  const backup = async () => { backups++; assert.deepEqual(rows(), before); };
  native.options.fail = statement => statement.startsWith("CREATE TRIGGER mcp_revision_content_visual_links_update");
  await assert.rejects(migrateDatabase(db, backup), /Injected/);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'mcp_revision%' OR name='mcp_library_revisions'").get().n, 0);
  assert.deepEqual(rows(), before); assert.deepEqual(native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all(), history);
  native.options.fail = undefined;
  await migrateDatabase(db, backup);
  assert.equal(backups, 2); assert.deepEqual(rows(), before);
  assert.deepEqual(native.sqlite.prepare("SELECT * FROM mcp_library_revisions").all().map(row => ({ library_id: row.library_id, revision: row.revision })), [{ library_id: "library", revision: 1 }]);
  assert.deepEqual(native.sqlite.prepare(`SELECT * FROM kysely_migration ORDER BY name LIMIT ${history.length}`).all(), history);
  await migrateDatabase(db, async () => assert.fail("No backup without another migration"));
  assert.deepEqual(native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("revision hotpath upgrade preserves counters and restores old triggers on late failure", async t => {
  const { db, native, sql, Migrator, migrations, migrateDatabase } = fixture(t);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
  const baseline = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0016-mcp-revision-hotpaths"));
  assert.equal((await new Migrator({ db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest()).error, undefined);
  treeFixture(native.sqlite, "library_nodes")([null], "hotpath-folder");
  treeFixture(native.sqlite, "content_blocks")([null], "hotpath-block");
  native.sqlite.prepare("INSERT INTO library_resources(id,library_id,resource_id,added_at) VALUES ('hotpath-member','library','resource',0)").run();
  const triggers = () => native.sqlite.prepare("SELECT name,sql FROM sqlite_schema WHERE name LIKE 'mcp_revision_%' ORDER BY name").all();
  const history = native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all(), before = triggers();
  const revisions = native.sqlite.prepare("SELECT * FROM mcp_library_revisions").all();
  native.options.fail = statement => statement.startsWith("CREATE TRIGGER mcp_revision_content_blocks_delete");
  await assert.rejects(migrateDatabase(db, async () => {}), /Injected/);
  assert.deepEqual(triggers(), before);
  assert.deepEqual(native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all(), history);
  assert.deepEqual(native.sqlite.prepare("SELECT * FROM mcp_library_revisions").all(), revisions);
  native.options.fail = undefined;
  await migrateDatabase(db, async () => {});
  assert.deepEqual(native.sqlite.prepare("SELECT * FROM mcp_library_revisions").all(), revisions);
  await db.updateTable("knowledge_resources").set({ summary: "Hotpath summary" }).where("id", "=", "resource").execute();
  assert.equal(native.sqlite.prepare("SELECT revision FROM mcp_library_revisions WHERE library_id='library'").get().revision, revisions[0].revision + 1);
  await migrateDatabase(db, async () => assert.fail("No backup for an unchanged schema"));
});

test("search-offset upgrade preserves legacy rows and rolls back an interrupted trigger installation", async t => {
  const { db, native, sql, Migrator, migrations, migrateDatabase } = fixture(t);
  await sql`PRAGMA foreign_keys = ON`.execute(db); await sql`PRAGMA locking_mode = EXCLUSIVE`.execute(db);
  const baseline = Object.fromEntries(Object.entries(migrations).slice(0, 9));
  assert.equal((await new Migrator({ db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest()).error, undefined);
  await db.insertInto("knowledge_resources").values({ id: "legacy-resource", title: "Legacy title", resource_type: "journalArticle", metadata_authority: "local", created_at: 1, updated_at: 1 }).execute();
  await db.insertInto("search_documents").values({ document_kind: "metadata", resource_id: "legacy-resource", tokenizer_profile: "unicode-cjk-bigram-1", indexed_version: 1, updated_at: 1, title: "Legacy title" }).execute();
  native.options.fail = statement => statement.startsWith("CREATE TRIGGER search_projection_revision_update");
  await assert.rejects(migrateDatabase(db, async () => {}), /Injected/);
  assert.equal(native.sqlite.prepare("PRAGMA table_info(search_documents)").all().some(row => row.name === "body_offsets_json"), false);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM kysely_migration").get().n, 9);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM plugin_state WHERE key='fulltext-revision'").get().n, 0);
  native.options.fail = undefined; await migrateDatabase(db, async () => {});
  const row = await db.selectFrom("search_documents").select(["title", "body_offsets_json"]).executeTakeFirstOrThrow();
  assert.equal(row.title, "Legacy title"); assert.equal(row.body_offsets_json, "[]");
  assert.equal((await db.selectFrom("plugin_state").select("value_json").where("key", "=", "fulltext-revision").executeTakeFirstOrThrow()).value_json, "0");
  await db.updateTable("search_documents").set({ title: "Updated title" }).execute();
  assert.equal((await db.selectFrom("plugin_state").select("value_json").where("key", "=", "fulltext-revision").executeTakeFirstOrThrow()).value_json, "1");
});

for (const table of treeTables) {
  test(`tree-integrity upgrade refuses existing ${table} cycles without advancing history`, async t => {
    const { db, native, sql, Migrator, migrations, migrateDatabase } = fixture(t);
    await sql`PRAGMA foreign_keys = ON`.execute(db);
    await sql`PRAGMA locking_mode = EXCLUSIVE`.execute(db);
    const baseline = Object.fromEntries(Object.entries(migrations).slice(0, 3));
    const initial = await new Migrator({ db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest();
    assert.equal(initial.error, undefined);
    const before = native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all();
    const insertTree = treeFixture(native.sqlite, table);
    const valid = insertTree([null, 0], "valid");
    const cycle = insertTree([1, 0], "cycle");
    let backups = 0;
    await assert.rejects(migrateDatabase(db, async () => { backups++; }), /refused existing parent cycles/);
    assert.equal(backups, 1);
    assert.deepEqual(native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all(), before);
    assert.equal(native.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE '%cycle_insert'").get().n, 0);
    assert.equal(native.sqlite.prepare("SELECT count(*) n FROM plugin_state WHERE key='migration-checksum:0004-tree-integrity'").get().n, 0);
    const parent = table === "content_blocks" ? "parent_block_id" : "parent_id";
    native.sqlite.prepare(`UPDATE ${table} SET ${parent} = ? WHERE id = ?`).run(valid[0], cycle[0]);
    await migrateDatabase(db, async () => { backups++; });
    assert.equal(backups, 2);
    assert.equal(native.sqlite.prepare("SELECT count(*) n FROM kysely_migration").get().n, Object.keys(migrations).length);
    assert.equal(native.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n, 4);
    assert.throws(() => insertTree([1, 2, 0], "new-cycle"), /(?:NODE|PARENT)_CYCLE/);
    assert.deepEqual(native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name LIMIT 3").all(), before);
  });
}

test("tree-integrity trigger installation rolls back on failure and retries", async t => {
  const { db, native, sql, Migrator, migrations, migrateDatabase } = fixture(t);
  await sql`PRAGMA locking_mode = EXCLUSIVE`.execute(db);
  const baseline = Object.fromEntries(Object.entries(migrations).slice(0, 3));
  const initial = await new Migrator({ db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest();
  assert.equal(initial.error, undefined);
  const insertTree = treeFixture(native.sqlite, "library_nodes");
  insertTree([null, 0], "valid");
  native.options.fail = statement => statement.startsWith("CREATE TRIGGER block_parent_cycle_insert");
  await assert.rejects(migrateDatabase(db, async () => {}), /Injected/);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE '%cycle_insert'").get().n, 0);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM kysely_migration").get().n, 3);
  native.options.fail = undefined;
  await migrateDatabase(db, async () => {});
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE '%cycle_insert'").get().n, 3);
  assert.throws(() => insertTree([1, 0], "cycle"), /LIBRARY_NODE_CYCLE/);
});

test("nonempty unversioned databases are not adopted; interrupted manager bootstrap can recover", async t => {
  const { db, native, sql, migrateDatabase, migrations } = fixture(t);
  await sql`PRAGMA locking_mode = EXCLUSIVE`.execute(db);
  native.sqlite.exec("CREATE TABLE stray(id INTEGER)");
  await assert.rejects(() => migrateDatabase(db, async () => {}), /unversioned/);
  native.sqlite.exec("DROP TABLE stray; CREATE TABLE kysely_migration(name VARCHAR(255) NOT NULL PRIMARY KEY, timestamp VARCHAR(255) NOT NULL)");
  await migrateDatabase(db, async () => {});
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM kysely_migration").get().n, Object.keys(migrations).length);
});

test("a failing migration rolls back the entire pending set and history, then retries safely", async t => {
  const { db, native, sql, Migrator, migrations } = fixture(t);
  await sql`PRAGMA locking_mode = EXCLUSIVE`.execute(db);
  const provider = { async getMigrations() { return {
    ...migrations, "0007-failure": { async up(tx) {
      await sql`CREATE TABLE rolled_back(id TEXT) STRICT`.execute(tx);
      throw new Error("migration failure");
    } },
  }; } };
  const failed = await new Migrator({ db, provider }).migrateToLatest();
  assert.match(String(failed.error), /migration failure/);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='plugin_state' OR name='rolled_back'").get().n, 0);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM kysely_migration").get().n, 0);
  assert.equal(native.sqlite.prepare("SELECT is_locked FROM kysely_migration_lock").get().is_locked, 0);
  const retry = await new Migrator({ db, provider: { async getMigrations() { return migrations; } } }).migrateToLatest();
  assert.equal(retry.error, undefined);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM kysely_migration").get().n, Object.keys(migrations).length);
});

test("adapter preserves SQL NULL, CTE and RETURNING rows, Float32 bytes, and affected counts", async t => {
  const { db, sql } = fixture(t);
  await sql`CREATE TABLE sample(id INTEGER PRIMARY KEY, value BLOB, note TEXT, confidence REAL) STRICT`.execute(db);
  const vector = new Uint8Array(new Float32Array([0.5, -2]).buffer);
  const insert = await sql`INSERT INTO sample(value,note) VALUES (${vector}, ${null}) RETURNING id, value`.execute(db);
  assert.equal(insert.numAffectedRows, 1n);
  assert.equal(insert.rows[0].id, 1);
  assert.deepEqual([...insert.rows[0].value], [...vector]);
  assert.equal((await sql`SELECT confidence FROM sample`.execute(db)).rows[0].confidence, null);
  await db.updateTable("sample").set({ confidence: 0.95 }).where("id", "=", 1).execute();
  assert.equal((await sql`SELECT confidence FROM sample`.execute(db)).rows[0].confidence, 0.95);
  const rows = await sql`WITH c AS (SELECT * FROM sample) SELECT id FROM c WHERE note = ${null}`.execute(db);
  assert.equal(rows.rows.length, 0);
  const update = await db.updateTable("sample").set({ note: "changed" }).where("id", "=", 1).executeTakeFirst();
  assert.equal(update.numUpdatedRows, 1n);
  await assert.rejects(() => sql`SELECT ${undefined}`.execute(db), /Unsupported SQLite parameter/);
});

test("shutdown drains every queued query and transaction without executing on closed storage", async t => {
  const { db, native, sql } = fixture(t);
  const entered = deferred();
  const gate = deferred();
  const execute = native.queryAsync.bind(native);
  native.queryAsync = async (...args) => {
    assert.equal(native.closed, false, "No query may reopen closed storage");
    if (args[0] === "SELECT 1") { entered.resolve(); await gate.promise; }
    return execute(...args);
  };
  let closeCount = 0;
  const close = native.closeDatabase.bind(native);
  native.closeDatabase = async () => { closeCount++; await close(); };
  const first = sql`SELECT 1`.execute(db);
  await entered.promise;
  const queued = [sql`SELECT 2`.execute(db), sql`SELECT 3`.execute(db),
    db.transaction().execute(() => assert.fail("Queued transaction must not start")),
    sql`SELECT 4`.execute(db)];
  const settled = Promise.allSettled(queued);
  await new Promise(resolve => setImmediate(resolve));
  const closing = db.destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(native.closed, false, "Shutdown must wait for the active query");
  gate.resolve();
  const [, , results] = await bounded(Promise.all([first, closing, settled]));
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.match(String(result.reason), /closing/);
  }
  assert.deepEqual(native.queries, ["SELECT 1"]);
  assert.equal(native.closed, true);
  await assert.rejects(() => sql`SELECT 5`.execute(db), /destroyed/);
  await db.destroy();
  assert.equal(closeCount, 1);
});

for (const rollback of [false, true]) {
  test(`shutdown waits for an active transaction to ${rollback ? "roll back" : "commit"}`, async t => {
    const { db, native, sql } = fixture(t);
    await sql`CREATE TABLE sample(id INTEGER PRIMARY KEY) STRICT`.execute(db);
    const entered = deferred();
    const gate = deferred();
    let storedCount;
    const close = native.closeDatabase.bind(native);
    native.closeDatabase = async () => {
      storedCount = native.sqlite.prepare("SELECT count(*) n FROM sample").get().n;
      await close();
    };
    const transaction = db.transaction().execute(async tx => {
      await sql`INSERT INTO sample VALUES (1)`.execute(tx);
      entered.resolve(); await gate.promise;
      assert.equal(native.closed, false);
      // An existing lease can still execute after shutdown was requested.
      await sql`INSERT INTO sample VALUES (2)`.execute(tx);
      if (rollback) throw new Error("transaction cancelled");
    });
    const active = Promise.allSettled([transaction]);
    await entered.promise;
    const queued = Promise.allSettled([sql`SELECT 9`.execute(db),
      db.transaction().execute(() => assert.fail("Queued transaction must not start")),
      sql`SELECT 10`.execute(db)]);
    await new Promise(resolve => setImmediate(resolve));
    const closing = db.destroy();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(native.closed, false);
    gate.resolve();
    const [results, rejected] = await bounded(Promise.all([active, queued, closing]));
    assert.equal(results[0].status, rollback ? "rejected" : "fulfilled");
    if (rollback) assert.match(String(results[0].reason), /transaction cancelled/);
    for (const result of rejected) {
      assert.equal(result.status, "rejected");
      assert.match(String(result.reason), /closing/);
    }
    assert.equal(storedCount, rollback ? 0 : 2);
    assert.ok(native.queries.includes(rollback ? "ROLLBACK" : "COMMIT"));
    assert.ok(!native.queries.some(query => /SELECT (9|10)/.test(query)));
    assert.equal(native.closed, true);
  });
}

test("queued operations cannot enter a transaction and failed initialization closes native storage", async t => {
  const { db, sql, initializeDatabase } = fixture(t);
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const transaction = db.transaction().execute(async tx => {
    order.push("begin"); entered(); await gate;
    await sql`SELECT 1`.execute(tx); order.push("commit");
  });
  await started;
  const other = sql`SELECT 2`.execute(db).then(() => order.push("other"));
  await Promise.resolve(); assert.deepEqual(order, ["begin"]);
  release(); await Promise.all([transaction, other]);
  assert.deepEqual(order, ["begin", "commit", "other"]);
  const failing = new MockNativeDatabase(":memory:", { fail: sql => sql.includes("CREATE TABLE plugin_state") });
  await assert.rejects(() => initializeDatabase(failing, "/isolated/fail.sqlite"), /Injected/);
  assert.equal(failing.closed, true);
});

test("separate bundles share host ownership, normalize Windows paths, and release only their own token", async t => {
  const host = { DBConnection: class extends MockNativeDatabase { constructor() { super(); } }, isWin: true };
  const first = fixture(t, host);
  const second = fixture(t, host);
  const current = await first.initializeDatabase(new MockNativeDatabase(), "C:/Isolated/knowledge.sqlite");
  const rejected = new MockNativeDatabase();
  await assert.rejects(() => second.initializeDatabase(rejected, "c:\\isolated\\knowledge.sqlite"), /active plugin owner/);
  assert.equal(rejected.closed, true);
  await current.close();
  const replacement = await second.initializeDatabase(new MockNativeDatabase(), "c:\\isolated\\knowledge.sqlite");
  t.after(() => replacement.close());
  await current.close();
  await assert.rejects(() => first.initializeDatabase(new MockNativeDatabase(), "C:/Isolated/knowledge.sqlite"), /active plugin owner/);
});

test("WAL-aware upgrade backup contains committed data and is checked before migration", async t => {
  const { Kysely, ZoteroDialect, Migrator, sql, migrations, migrateDatabase } = fixture(t);
  const root = mkdtempSync(join(tmpdir(), "knowledge-db-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "knowledge.sqlite");
  const port = new MockNativeDatabase(path);
  const db = new Kysely({ dialect: new ZoteroDialect(port, () => {}) });
  try {
    await sql`PRAGMA journal_mode=WAL`.execute(db);
    await sql`PRAGMA locking_mode=EXCLUSIVE`.execute(db);
    const result = await new Migrator({ db, provider: { async getMigrations() {
      return { "0001-local-foundation": migrations["0001-local-foundation"] };
    } } }).migrateToLatest();
    assert.equal(result.error, undefined);
    await db.insertInto("plugin_state").values({key:"wal-data",value_json:'"committed"',updated_at:1}).execute();
    let backupCount = 0;
    await migrateDatabase(db, async () => {
      backupCount++;
      await sql`VACUUM INTO ${join(root, "backup.sqlite")}`.execute(db);
      const copy = new DatabaseSync(join(root, "backup.sqlite"));
      assert.equal(copy.prepare("SELECT value_json FROM plugin_state WHERE key='wal-data'").get().value_json, '"committed"');
      assert.equal(copy.prepare("SELECT count(*) n FROM kysely_migration").get().n, 1);
      copy.close();
    });
    assert.equal(backupCount, 1);
    const contender = new DatabaseSync(path);
    assert.throws(() => contender.exec("BEGIN IMMEDIATE"), /locked/);
    contender.close();
  } finally { await db.destroy(); }
});

test("bibliographic upgrade backfills columns, preserves identity/history and rolls back failed changes", async t => {
  const { db, native, Migrator, migrations, migrateDatabase } = fixture(t);
  const baseline = Object.fromEntries(Object.entries(migrations).slice(0, 4));
  assert.equal((await new Migrator({ db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest()).error, undefined);
  const metadata = { fields: { publicationTitle: "Journal", volume: "S1", issue: "3–4", DOI: "https://doi.org/10.1/AbC", url: "https://example.invalid" }, tags: [{ tag: "original", type: 0 }], local: { reviewed: true } };
  await db.insertInto("knowledge_resources").values({ id: "paper", title: "Original", resource_type: "journalArticle", metadata_authority: "zotero", metadata_json: JSON.stringify(metadata),
    metadata_fingerprint: "a".repeat(64), version: 7, metadata_version: 3, created_at: 1, updated_at: 2 }).execute();
  await db.insertInto("knowledge_resources").values({ id: "empty", title: "Empty", resource_type: "book", metadata_authority: "zotero", metadata_json: '{"fields":{"volume":"","issue":null}}', created_at: 1, updated_at: 1 }).execute();
  const before = native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all();
  native.options.fail = statement => statement.startsWith("UPDATE knowledge_resources");
  await assert.rejects(migrateDatabase(db, async () => {}), /Injected/);
  assert.deepEqual(native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all(), before);
  assert.ok(!native.sqlite.prepare("PRAGMA table_info(knowledge_resources)").all().some(column => column.name === "doi"));
  assert.deepEqual(JSON.parse(native.sqlite.prepare("SELECT metadata_json FROM knowledge_resources WHERE id='paper'").get().metadata_json), metadata);
  native.options.fail = undefined;
  let backups = 0;
  await migrateDatabase(db, async () => { backups++; });
  assert.equal(backups, 1);
  const paper = native.sqlite.prepare("SELECT * FROM knowledge_resources WHERE id='paper'").get();
  assert.equal(paper.publication_title, "Journal"); assert.equal(paper.volume, "S1"); assert.equal(paper.issue, "3–4"); assert.equal(paper.doi, metadata.fields.DOI);
  assert.equal(paper.version, 7); assert.equal(paper.metadata_version, 3); assert.equal(paper.updated_at, 2); assert.equal(paper.metadata_fingerprint, "a".repeat(64));
  assert.equal(paper.metadata_schema_version, 2);
  assert.deepEqual(JSON.parse(paper.metadata_json), { ...metadata, fields: { url: metadata.fields.url } });
  assert.deepEqual({ ...native.sqlite.prepare("SELECT publication_title,volume,issue,doi FROM knowledge_resources WHERE id='empty'").get() }, { publication_title: null, volume: null, issue: null, doi: null });
  assert.deepEqual(native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name LIMIT 4").all(), before);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM resource_revisions").get().n, 0);
});

test("bibliographic migration refuses malformed legacy fields without losing their original JSON", async t => {
  const { db, native, Migrator, migrations, migrateDatabase } = fixture(t);
  const baseline = Object.fromEntries(Object.entries(migrations).slice(0, 4));
  assert.equal((await new Migrator({ db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest()).error, undefined);
  const metadata = '{"fields":{"volume":42}}';
  await db.insertInto("knowledge_resources").values({ id: "malformed", title: "Legacy", resource_type: "book", metadata_authority: "local", metadata_json: metadata, created_at: 1, updated_at: 1 }).execute();
  await assert.rejects(migrateDatabase(db, async () => {}), /refused nontext fields/);
  assert.equal(native.sqlite.prepare("SELECT metadata_json FROM knowledge_resources").get().metadata_json, metadata);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM kysely_migration").get().n, 4);
});

async function legacyTrashFixture(t) {
  const f = fixture(t);
  const baseline = Object.fromEntries(Object.entries(f.migrations).slice(0, 5));
  assert.equal((await new f.Migrator({ db: f.db, provider: { async getMigrations() { return baseline; } } }).migrateToLatest()).error, undefined);
  f.native.sqlite.exec(`
    INSERT INTO knowledge_libraries(id,name,status,created_at,updated_at,deleted_at) VALUES ('lib','Legacy library','deleted',1,2,10);
    INSERT INTO library_nodes(id,library_id,parent_id,node_type,name,sort_order,created_at,updated_at,deleted_at)
      VALUES ('parent','lib',NULL,'folder','Parent',0,1,2,10),('child','lib','parent','folder','Child',0,1,2,10);
    INSERT INTO knowledge_resources(id,title,resource_type,metadata_authority,status,created_at,updated_at,deleted_at)
      VALUES ('paper','Legacy paper','journalArticle','zotero','deleted',1,2,10);
    INSERT INTO library_resources(id,library_id,resource_id,added_at,deleted_at) VALUES ('relation','lib','paper',1,10);
    INSERT INTO library_items(id,library_id,node_id,library_resource_id,sort_order,added_at,deleted_at) VALUES ('placement','lib','child','relation',0,1,10);
    INSERT INTO membership_origins(id,origin_key,library_id,resource_id,library_resource_id,library_item_id,origin_type,created_at,updated_at,deleted_at)
      VALUES ('root-origin','root','lib','paper','relation',NULL,'manual',1,2,10),('folder-origin','folder','lib','paper','relation','placement','manual',1,2,10);
    INSERT INTO plugin_state(key,value_json,updated_at) VALUES ('unrelated-state','{"keep":true}',1);
  `);
  const base = { name: "Legacy paper", target: { libraryID: "lib", nodeID: "child" }, location: "Legacy library / Parent / Child",
    resourceIDs: ["paper"], folderIDs: [], relationIDs: ["relation"], placementIDs: ["placement"], originIDs: ["folder-origin"], deletedResourceIDs: [] };
  const records = [
    { ...base, id: "old-item", kind: "item", deletedAt: 100 },
    { ...base, id: "old-folder", kind: "folder", name: "Parent", target: { libraryID: "lib", nodeID: "parent" }, folderIDs: ["parent", "child"], deletedAt: 200 },
    { ...base, id: "old-library", kind: "library", name: "Legacy library", target: { libraryID: "lib", nodeID: null }, folderIDs: ["parent", "child"], originIDs: ["root-origin", "folder-origin"], deletedResourceIDs: ["paper"], deletedAt: 300 }
  ];
  for (const record of records) f.native.sqlite.prepare("INSERT INTO plugin_state VALUES (?,?,?)").run(`knowledge-trash:${record.id}`, JSON.stringify(record), record.deletedAt);
  return { ...f, records, trash: new f.KnowledgeTrashRepository({ uuid: () => "unused" }) };
}

test("Trash upgrade preserves all legacy recovery links and original model rows, then restores the original hierarchy", async t => {
  const f = await legacyTrashFixture(t);
  const { native, db, records, trash, migrateDatabase } = f;
  const history = native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all();
  const tables = ["knowledge_libraries", "library_nodes", "knowledge_resources", "library_resources", "library_items", "membership_origins"];
  const before = tables.map(table => native.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  let backups = 0;
  await migrateDatabase(db, async () => { backups++; assert.equal(native.sqlite.prepare("SELECT count(*) n FROM plugin_state WHERE key GLOB 'knowledge-trash:*'").get().n, 3); });
  assert.equal(backups, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(await trash.list(db))), [...records].reverse());
  assert.deepEqual(tables.map(table => native.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()), before);
  assert.deepEqual(native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name LIMIT 5").all(), history);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM plugin_state WHERE key GLOB 'knowledge-trash:*'").get().n, 0);
  assert.equal(native.sqlite.prepare("SELECT value_json FROM plugin_state WHERE key='unrelated-state'").get().value_json, '{"keep":true}');
  await migrateDatabase(db, async () => assert.fail("Repeat startup must not remigrate or back up"));
  await db.transaction().execute(tx => trash.restore(tx, ["old-item"], () => assert.fail("The original locations remain recoverable")));
  assert.equal(native.sqlite.prepare("SELECT deleted_at FROM knowledge_libraries WHERE id='lib'").get().deleted_at, null);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM library_nodes WHERE deleted_at IS NULL").get().n, 2);
  assert.equal(native.sqlite.prepare("SELECT parent_id FROM library_nodes WHERE id='child'").get().parent_id, "parent");
  assert.equal(native.sqlite.prepare("SELECT deleted_at FROM library_items WHERE id='placement'").get().deleted_at, null);
  assert.equal(native.sqlite.prepare("SELECT status FROM knowledge_resources WHERE id='paper'").get().status, "active");
  await db.transaction().execute(tx => trash.restore(tx, ["old-folder"], () => assert.fail("No replacement memberships")));
  for (const suffix of ["entries", "resources", "folders", "relations", "placements", "origins"]) assert.equal(native.sqlite.prepare(`SELECT count(*) n FROM knowledge_trash_${suffix}`).get().n, 0);
  assert.deepEqual(native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("Trash upgrade deduplicates legacy recovery lists without changing their first-occurrence order", async t => {
  const { native, db, records, trash, migrateDatabase } = await legacyTrashFixture(t);
  const entry = records[2];
  entry.folderIDs = ["child", "parent", "child"];
  entry.placementIDs = ["placement", "placement"];
  native.sqlite.prepare("UPDATE plugin_state SET value_json=? WHERE key=?").run(JSON.stringify(entry), `knowledge-trash:${entry.id}`);
  await migrateDatabase(db, async () => {});
  const migrated = (await trash.list(db)).find(row => row.id === entry.id);
  assert.deepEqual([...migrated.folderIDs], ["child", "parent"]);
  assert.deepEqual([...migrated.placementIDs], ["placement"]);
});

test("Trash upgrade rejects malformed or dangling legacy records without losing any old recovery data", async t => {
  for (const [name, mutate, expected] of [
    ["missing array", row => { delete row.originIDs; }, /malformed legacy/],
    ["nontext ID", row => { row.folderIDs = [42]; }, /malformed legacy/],
    ["incorrect key identity", row => { row.id = "different"; }, /malformed legacy/],
    ["deleted resource outside entry", row => { row.deletedResourceIDs = ["outside"]; }, /malformed legacy/],
    ["missing model reference", row => { row.resourceIDs = ["missing"]; }, /FOREIGN KEY/]
  ]) await t.test(name, async child => {
    const { native, db, records, migrateDatabase } = await legacyTrashFixture(child);
    const invalid = structuredClone(records[0]); mutate(invalid);
    native.sqlite.prepare("UPDATE plugin_state SET value_json=? WHERE key='knowledge-trash:old-item'").run(JSON.stringify(invalid));
    const original = native.sqlite.prepare("SELECT * FROM plugin_state ORDER BY key").all();
    await assert.rejects(migrateDatabase(db, async () => {}), expected);
    assert.deepEqual(native.sqlite.prepare("SELECT * FROM plugin_state ORDER BY key").all(), original);
    assert.equal(native.sqlite.prepare("SELECT count(*) n FROM kysely_migration").get().n, 5);
    assert.equal(native.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'knowledge_trash_%'").get().n, 0);
    native.sqlite.prepare("UPDATE plugin_state SET value_json=? WHERE key='knowledge-trash:old-item'").run(JSON.stringify(records[0]));
    await migrateDatabase(db, async () => {});
    assert.equal(native.sqlite.prepare("SELECT count(*) n FROM knowledge_trash_entries").get().n, 3);
  });
});

test("Trash import and legacy cleanup roll back together after a late native write failure", async t => {
  const { native, db, migrateDatabase } = await legacyTrashFixture(t);
  const original = native.sqlite.prepare("SELECT * FROM plugin_state ORDER BY key").all();
  native.options.fail = statement => statement.startsWith("DELETE FROM plugin_state WHERE key GLOB");
  await assert.rejects(migrateDatabase(db, async () => {}), /Injected/);
  assert.deepEqual(native.sqlite.prepare("SELECT * FROM plugin_state ORDER BY key").all(), original);
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='knowledge_trash_entries'").get().n, 0);
  native.options.fail = undefined;
  await migrateDatabase(db, async () => {});
  assert.equal(native.sqlite.prepare("SELECT count(*) n FROM knowledge_trash_entries").get().n, 3);
  assert.deepEqual(native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("Trash recovery tables enforce identities, library scopes and cascading recovery cleanup", async t => {
  const { native, db, migrateDatabase } = await legacyTrashFixture(t);
  await migrateDatabase(db, async () => {});
  const sqlite = native.sqlite;
  sqlite.exec(`
    INSERT INTO knowledge_libraries(id,name,created_at,updated_at) VALUES ('other-lib','Other',1,1);
    INSERT INTO library_nodes(id,library_id,node_type,name,sort_order,created_at,updated_at) VALUES ('other-node','other-lib','folder','Other',0,1,1);
    INSERT INTO library_resources(id,library_id,resource_id,added_at) VALUES ('other-relation','other-lib','paper',1);
    INSERT INTO library_items(id,library_id,node_id,library_resource_id,sort_order,added_at) VALUES ('other-placement','other-lib','other-node','other-relation',0,1);
    INSERT INTO membership_origins(id,origin_key,library_id,resource_id,library_resource_id,library_item_id,origin_type,created_at,updated_at)
      VALUES ('other-origin','other','other-lib','paper','other-relation','other-placement','manual',1,1);
  `);
  assert.throws(() => sqlite.prepare("UPDATE knowledge_trash_entries SET kind='unknown' WHERE id='old-item'").run(), /CHECK/);
  assert.throws(() => sqlite.prepare("UPDATE knowledge_trash_entries SET node_id=NULL WHERE id='old-folder'").run(), /CHECK/);
  assert.throws(() => sqlite.prepare("UPDATE knowledge_trash_entries SET node_id='other-node' WHERE id='old-item'").run(), /FOREIGN KEY/);
  assert.throws(() => sqlite.prepare("UPDATE knowledge_trash_resources SET resource_id='missing' WHERE entry_id='old-item'").run(), /FOREIGN KEY/);
  assert.throws(() => sqlite.prepare("UPDATE knowledge_trash_resources SET was_deleted=2 WHERE entry_id='old-item'").run(), /CHECK/);
  for (const [table, column, id] of [["folders", "node_id", "other-node"], ["relations", "library_resource_id", "other-relation"],
    ["placements", "library_item_id", "other-placement"], ["origins", "origin_id", "other-origin"]]) {
    assert.throws(() => sqlite.prepare(`INSERT INTO knowledge_trash_${table}(entry_id,library_id,${column},position) VALUES ('old-item','lib',?,99)`).run(id), /FOREIGN KEY/, `${table} cannot reference another library`);
    assert.throws(() => sqlite.prepare(`INSERT INTO knowledge_trash_${table}(entry_id,library_id,${column},position) VALUES ('old-item','other-lib',?,99)`).run(id), /FOREIGN KEY/, `${table} cannot override the entry's library`);
  }
  assert.throws(() => sqlite.prepare("INSERT INTO knowledge_trash_resources VALUES ('old-item','paper',99,0)").run(), /UNIQUE/);
  assert.throws(() => sqlite.prepare("UPDATE knowledge_trash_resources SET position=-1 WHERE entry_id='old-item'").run(), /CHECK/);
  const modelRows = sqlite.prepare("SELECT count(*) n FROM library_nodes").get().n;
  sqlite.prepare("DELETE FROM knowledge_trash_entries WHERE id='old-library'").run();
  for (const suffix of ["resources", "folders", "relations", "placements", "origins"]) {
    assert.equal(sqlite.prepare(`SELECT count(*) n FROM knowledge_trash_${suffix} WHERE entry_id='old-library'`).get().n, 0);
  }
  assert.equal(sqlite.prepare("SELECT count(*) n FROM library_nodes").get().n, modelRows);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM knowledge_trash_entries").get().n, 2, "other recovery operations remain separate");
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("the optimized unreleased Trash importer accepts only its known identical-schema predecessors", async t => {
  const f = fixture(t);
  await f.migrateDatabase(f.db, async () => {});
  const ddl = f.migrations["0006-knowledge-trash"].statements.filter(statement => statement.startsWith("CREATE "));
  assert.equal(createHash("sha256").update(JSON.stringify(ddl)).digest("hex"), "6cf54f57c2ad48bc3423d9b3b25c33649312dd5161faa6683413a94b004a5112", "the accepted predecessor has exactly the same tables/indexes");
  const key = "migration-checksum:0006-knowledge-trash";
  const predecessors = ["9be1daf18124bce33b286616f2fa08381cc9410330bfba64a00d98f49a6c1c97", "fed21552d1b87c6635b8616cf272083d291c0a4b7d28da38473033d196ebb060"];
  const history = f.native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all();
  for (const previous of predecessors) {
    await f.db.updateTable("plugin_state").set({ value_json: JSON.stringify(previous) }).where("key", "=", key).execute();
    await f.migrateDatabase(f.db, async () => { assert.fail("An already-applied equivalent importer must not rerun"); });
    assert.deepEqual(f.native.sqlite.prepare("SELECT * FROM kysely_migration ORDER BY name").all(), history);
    assert.equal(f.native.sqlite.prepare("SELECT value_json FROM plugin_state WHERE key=?").get(key).value_json, JSON.stringify(previous), "history is not rewritten");
  }
  await f.db.updateTable("plugin_state").set({ value_json: JSON.stringify("0".repeat(64)) }).where("key", "=", key).execute();
  await assert.rejects(f.inspectHistory(f.db), /checksum mismatch/);
  await f.db.updateTable("plugin_state").set({ value_json: JSON.stringify(f.migrations["0006-knowledge-trash"].checksum) }).where("key", "=", key).execute();
  for (const previous of predecessors) {
    await f.db.updateTable("plugin_state").set({ value_json: JSON.stringify(previous) }).where("key", "=", "migration-checksum:0005-bibliographic-fields").execute();
    await assert.rejects(f.inspectHistory(f.db), /0005-bibliographic-fields/);
  }
});

async function bulkTrashFixture(t, count) {
  const f = fixture(t);
  f.native.options.maxParameters = 999;
  await f.migrateDatabase(f.db, async () => {});
  const sequence = `WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n+1<${count})`;
  f.native.sqlite.exec(`
    INSERT INTO knowledge_libraries(id,name,created_at,updated_at) VALUES ('bulk-library','Bulk Trash fixture',1,1);
    ${sequence} INSERT INTO knowledge_resources(id,title,resource_type,metadata_authority,created_at,updated_at)
      SELECT 'resource-'||n,'Synthetic paper '||n,'article','import',1,1 FROM seq;
    ${sequence} INSERT INTO library_nodes(id,library_id,node_type,name,sort_order,created_at,updated_at)
      SELECT 'folder-'||n,'bulk-library','folder','Folder '||n,n,1,1 FROM seq;
    ${sequence} INSERT INTO library_resources(id,library_id,resource_id,added_at)
      SELECT 'relation-'||n,'bulk-library','resource-'||n,1 FROM seq;
    ${sequence} INSERT INTO library_items(id,library_id,node_id,library_resource_id,sort_order,added_at)
      SELECT 'placement-'||n,'bulk-library','folder-'||n,'relation-'||n,n,1 FROM seq;
    ${sequence} INSERT INTO membership_origins(id,origin_key,library_id,resource_id,library_resource_id,library_item_id,origin_type,created_at,updated_at)
      SELECT 'origin-'||n,'origin-'||n,'bulk-library','resource-'||n,'relation-'||n,'placement-'||n,'manual',1,1 FROM seq;
  `);
  let serial = 0;
  const trash = new f.KnowledgeTrashRepository({ uuid: () => `bulk-trash-${++serial}` });
  const target = { libraryID: "bulk-library", nodeID: null };
  const ids = prefix => Array.from({ length: count }, (_, index) => `${prefix}-${count - index - 1}`);
  const resources = ids("resource"), folders = ids("folder"), origins = ids("origin");
  const deleted = resources.filter((_, index) => index % 2 === 0);
  // Duplicate references cross batch boundaries; the first occurrence defines position.
  const duplicate = values => [...values.slice(0, 201), values[0], ...values.slice(201), values[200]];
  const capture = () => f.db.transaction().execute(tx => trash.capture(tx, "library", "Bulk Trash fixture", target,
    duplicate(folders), duplicate(resources), duplicate(origins), deleted));
  const links = ["resources", "folders", "relations", "placements", "origins"];
  const rows = suffix => f.native.sqlite.prepare(`SELECT * FROM knowledge_trash_${suffix} ORDER BY position`).all();
  return { ...f, trash, target, resources, folders, origins, deleted, capture, links, rows };
}

test("large Trash captures and overlapping purge retain ordered links beyond SQLite's variable limit", async t => {
  const count = 32770;
  const f = await bulkTrashFixture(t, count);
  await f.capture();
  const entries = await f.trash.list(f.db);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  for (const [key, expected] of [["resourceIDs", f.resources], ["folderIDs", f.folders], ["originIDs", f.origins], ["deletedResourceIDs", f.deleted]]) {
    assert.deepEqual(Array.from(entry[key]), expected, key);
  }
  for (const suffix of f.links) {
    const rows = f.rows(suffix);
    assert.equal(rows.length, count, suffix);
    assert.deepEqual(rows.map(row => row.position), Array.from({ length: count }, (_, index) => index), suffix);
  }
  assert.equal(new Set(entry.relationIDs).size, count);
  assert.equal(new Set(entry.placementIDs).size, count);
  const deleted = new Set(f.deleted);
  assert.deepEqual(f.rows("resources").map(row => row.was_deleted), f.resources.map(id => deleted.has(id) ? 1 : 0));

  // Purging one item rewrites a still-large library recovery entry through insertLinks.
  await f.db.transaction().execute(tx => f.trash.capture(tx, "item", "Removed paper", f.target, [], [f.resources[0]], [f.origins[0]]));
  const item = (await f.trash.list(f.db)).find(candidate => candidate.kind === "item");
  await f.db.transaction().execute(tx => f.trash.purge(tx, [item.id]));
  const [retained] = await f.trash.list(f.db);
  assert.equal(retained.id, entry.id);
  for (const [key, expected] of [["resourceIDs", f.resources.slice(1)], ["folderIDs", f.folders], ["deletedResourceIDs", f.deleted.slice(1)]]) {
    assert.deepEqual(Array.from(retained[key]), expected, key);
  }
  assert.deepEqual(Array.from(retained.originIDs), f.origins.slice(1));
  for (const suffix of f.links) {
    const rows = f.rows(suffix), expectedCount = suffix === "folders" ? count : count - 1;
    assert.equal(rows.length, expectedCount, suffix);
    assert.deepEqual(rows.map(row => row.position), Array.from({ length: expectedCount }, (_, index) => index), suffix);
  }
  for (const table of ["library_nodes", "library_resources", "library_items", "membership_origins"]) f.native.sqlite.exec(`UPDATE ${table} SET deleted_at=1`);
  f.native.sqlite.exec("UPDATE knowledge_libraries SET status='deleted',is_default=0,deleted_at=1");
  await f.db.transaction().execute(tx => f.trash.restore(tx, [entry.id], () => { throw new Error("Recorded locations should restore without fallback"); }));
  assert.equal((await f.trash.list(f.db)).length, 0);
  for (const table of ["library_nodes", "library_resources", "library_items", "membership_origins"]) {
    assert.equal(f.native.sqlite.prepare(`SELECT count(*) n FROM ${table} WHERE deleted_at IS NULL`).get().n, table === "library_nodes" ? count : count - 1);
  }
  assert.deepEqual(f.native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("failure in a later Trash link batch rolls back every table and permits a complete retry", async t => {
  const f = await bulkTrashFixture(t, 401);
  let originBatches = 0;
  f.native.options.fail = statement => /^insert into "knowledge_trash_origins"/.test(statement) && ++originBatches === 2;
  await assert.rejects(f.capture, /Injected native query failure/);
  assert.equal(originBatches, 2, "failure follows a successfully written origin batch");
  assert.equal(f.native.sqlite.prepare("SELECT count(*) n FROM knowledge_trash_entries").get().n, 0);
  for (const suffix of f.links) assert.equal(f.rows(suffix).length, 0, suffix);
  f.native.options.fail = undefined;
  await f.capture();
  for (const suffix of f.links) assert.equal(f.rows(suffix).length, 401, suffix);
  assert.deepEqual(f.native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("main WAL permits external process readers during writes while the separate owner file excludes plugins", async t => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-owner-"));
  const path = join(root, "knowledge.sqlite");
  const host = { DBConnection: MockNativeDatabase };
  const { initializeDatabase } = fixture(t, host);
  const second = fixture(t, { DBConnection: MockNativeDatabase });
  const native = new MockNativeDatabase(path);
  let database;
  const child = (source, file = path) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `import { DatabaseSync } from 'node:sqlite'; ${source}`, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const ownerBlocked = () => child(`const db = new DatabaseSync(process.argv[1]); try { db.exec('BEGIN EXCLUSIVE'); console.log('false'); } catch(e) { if (!/locked/.test(e.message)) throw e; console.log('true'); } finally { db.close(); }`, `${path}.owner.sqlite`);
  try {
    database = await initializeDatabase(native, path);
    assert.equal(native.sqlite.prepare("PRAGMA locking_mode").get().locking_mode, "normal");
    assert.equal(native.sqlite.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(ownerBlocked(), true);
    const rejected = new MockNativeDatabase(path);
    await assert.rejects(second.initializeDatabase(rejected, path), /Could not acquire.*ownership/);
    assert.equal(rejected.closed, true); assert.deepEqual(rejected.queries, []);
    assert.equal(second.native.closed, false);
    const entered = deferred(); const release = deferred();
    const transaction = database.db.transaction().execute(async tx => {
      await tx.insertInto("plugin_state").values({ key: "concurrent", value_json: '"committed"', updated_at: 1 }).execute();
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    const read = () => child(`const db = new DatabaseSync(process.argv[1], { readOnly: true }); db.exec('PRAGMA query_only=ON'); console.log(JSON.stringify(db.prepare("SELECT count(*) n FROM plugin_state WHERE key='concurrent'").get().n)); db.close();`);
    try { assert.equal(read(), 0); } finally { release.resolve(); }
    await transaction;
    assert.equal(read(), 1);
    await database.close(); database = undefined;
    assert.equal(ownerBlocked(), false);
    const replacement = await second.initializeDatabase(new MockNativeDatabase(path), path);
    await replacement.close();
  } finally { await database?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed initialization releases both connections and process exit leaves no stale ownership lock", async t => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-owner-failure-"));
  const path = join(root, "knowledge.sqlite");
  const instances = [];
  const host = { DBConnection: class extends MockNativeDatabase { constructor(file) { super(file); instances.push(this); } } };
  const { initializeDatabase } = fixture(t, host);
  try {
    const failing = new MockNativeDatabase(path, { fail: statement => statement.startsWith("CREATE TABLE plugin_state") });
    await assert.rejects(initializeDatabase(failing, path), /Injected/);
    assert.equal(failing.closed, true); assert.ok(instances.every(instance => instance.closed));
    assert.equal(host.__knowledgeMCPDatabaseOwners.size, 0);
    // Terminate without explicitly closing SQLite, then reacquire the same file.
    execFileSync(process.execPath, ["--input-type=module", "-e", `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; PRAGMA user_version=1; COMMIT'); process.exit(0);`, `${path}.owner.sqlite`], { stdio: "pipe" });
    const recovered = await initializeDatabase(new MockNativeDatabase(path), path);
    await recovered.close();
    assert.ok(instances.every(instance => instance.closed));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migration adapter rejects callers without an active ownership assertion", async t => {
  const { Kysely, ZoteroDialect, Migrator, migrations } = fixture(t);
  const native = new MockNativeDatabase();
  const db = new Kysely({ dialect: new ZoteroDialect(native) });
  try {
    const result = await new Migrator({ db, provider: { async getMigrations() { return migrations; } } }).migrateToLatest();
    assert.match(String(result.error), /active database ownership lease/);
    assert.equal(native.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='plugin_state'").get().n, 0);
  } finally { await db.destroy(); }
});

for (const failingRole of ["main", "owner"]) {
  test(`${failingRole} close failure retains ownership and permits one shared retry before reopening`, async t => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-close-retry-"));
    const path = join(root, "knowledge.sqlite");
    const gate = deferred();
    const handles = [];
    let fail = true;
    class Native extends MockNativeDatabase {
      constructor(file, role = "owner") { super(file); this.role = role; this.closeCalls = 0; handles.push(this); }
      async closeDatabase() {
        this.closeCalls++;
        if (this.role === failingRole && fail) { await gate.promise; throw new Error(`Transient ${this.role} close failure`); }
        await super.closeDatabase();
      }
    }
    const host = { DBConnection: Native };
    const { initializeDatabase, sql } = fixture(t, host);
    const main = new Native(path, "main");
    let database;
    try {
      database = await initializeDatabase(main, path);
      const owner = handles.find(handle => handle.role === "owner");
      const closing = database.close();
      assert.equal(database.close(), closing);
      const settled = Promise.allSettled([closing, database.close()]);
      gate.resolve();
      assert.ok((await settled).every(result => result.status === "rejected" && result.reason.message === `Transient ${failingRole} close failure`));
      assert.equal(handles.find(handle => handle.role === failingRole).closeCalls, 1);
      assert.equal(host.__knowledgeMCPDatabaseOwners.size, 1);
      const contender = new DatabaseSync(`${path}.owner.sqlite`);
      try { assert.throws(() => contender.exec("BEGIN EXCLUSIVE"), /locked/); } finally { contender.close(); }
      if (failingRole === "main") { assert.equal(main.closed, false); assert.equal(owner.closeCalls, 0); }
      else assert.equal(main.closed, true);
      await assert.rejects(sql`SELECT 1`.execute(database.db));
      fail = false;
      const retry = database.close();
      assert.notEqual(retry, closing); assert.equal(database.close(), retry);
      await retry;
      assert.equal(main.closed, true); assert.equal(owner.closed, true); assert.equal(host.__knowledgeMCPDatabaseOwners.size, 0);
      assert.equal(main.closeCalls, failingRole === "main" ? 2 : 1);
      assert.equal(owner.closeCalls, failingRole === "owner" ? 2 : 1);
      assert.equal(database.close(), retry); await database.close();
      const replacement = await initializeDatabase(new Native(path, "main"), path);
      await database.close(); assert.equal(host.__knowledgeMCPDatabaseOwners.size, 1);
      await replacement.close();
    } finally {
      fail = false; gate.resolve(); await database?.close();
      for (const handle of handles) await MockNativeDatabase.prototype.closeDatabase.call(handle);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`a new bundle retries a failed ${failingRole} close without displacing an active owner`, async t => {
    let fail = true;
    const handles = [];
    class Native extends MockNativeDatabase {
      constructor(role = "owner") { super(); this.role = role; this.closeCalls = 0; handles.push(this); }
      async closeDatabase() {
        this.closeCalls++;
        if (this.role === failingRole && fail) throw new Error(`Transient ${this.role} close failure`);
        await super.closeDatabase();
      }
    }
    const host = { DBConnection: class extends Native { constructor() { super("owner"); } } };
    const first = fixture(t, host); const second = fixture(t, host); const third = fixture(t, host);
    const path = "/isolated/retry-bundle.sqlite";
    const original = await first.initializeDatabase(new Native("main"), path);
    try {
      await assert.rejects(second.initializeDatabase(new MockNativeDatabase(), path), /active plugin owner/);
      await assert.rejects(original.close(), /Transient/);
      // A repeated cleanup failure must not admit a new writer.
      const rejected = new MockNativeDatabase();
      await assert.rejects(second.initializeDatabase(rejected, path), /Transient/);
      assert.equal(rejected.closed, true); assert.equal(host.__knowledgeMCPDatabaseOwners.size, 1);
      fail = false;
      const results = await Promise.allSettled([
        second.initializeDatabase(new Native("main"), path), third.initializeDatabase(new Native("main"), path),
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.filter(result => result.status === "rejected").length, 1);
      const replacement = results.find(result => result.status === "fulfilled").value;
      await original.close(); assert.equal(host.__knowledgeMCPDatabaseOwners.size, 1);
      await replacement.close(); assert.equal(host.__knowledgeMCPDatabaseOwners.size, 0);
    } finally { fail = false; await original.close(); for (const handle of handles) await MockNativeDatabase.prototype.closeDatabase.call(handle); }
  });
}

test("an owner lease cannot authorize new work after a failed close and can retry synchronous close errors", async t => {
  let calls = 0;
  const host = { DBConnection: class extends MockNativeDatabase {
    constructor() { super(); }
    closeDatabase() { calls++; if (calls === 1) throw new Error("Synchronous close failure"); return super.closeDatabase(); }
  } };
  const { createDatabaseOwner } = fixture(t, host);
  const lease = createDatabaseOwner("/isolated/owner-retry.sqlite");
  await lease.acquire();
  lease.assertHeld();
  await assert.rejects(lease.close(), /Synchronous close failure/);
  assert.throws(() => lease.assertHeld(), /not active/);
  const retry = lease.close(); assert.equal(lease.close(), retry); await retry;
  assert.equal(calls, 2); assert.throws(() => lease.assertHeld(), /not active/);
});

for (const commitPhase of ["before", "after"]) {
  test(`owner acquisition COMMIT failure ${commitPhase} execution retains cleanup when close also fails`, async t => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-acquire-cleanup-"));
    const path = join(root, "knowledge.sqlite");
    const owners = [];
    const mains = [];
    let failAcquisition = true;
    let failClose = true;
    class Owner extends MockNativeDatabase {
      constructor(file) { super(file); this.closeCalls = 0; owners.push(this); }
      async queryAsync(statement, ...args) {
        if (statement === "COMMIT" && failAcquisition) {
          if (commitPhase === "after") await super.queryAsync(statement, ...args);
          throw new Error("Owner acquisition COMMIT failed");
        }
        return super.queryAsync(statement, ...args);
      }
      async closeDatabase() {
        this.closeCalls++;
        if (failClose) throw new Error("Owner cleanup close failed");
        return super.closeDatabase();
      }
    }
    const host = { DBConnection: Owner };
    const first = fixture(t, host); const second = fixture(t, host); const third = fixture(t, host);
    const main = () => { const native = new MockNativeDatabase(path); mains.push(native); return native; };
    const physicalLockHeld = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); try { db.exec('BEGIN EXCLUSIVE; COMMIT'); console.log('false'); } catch(error) { if (!/locked/.test(error.message)) throw error; console.log('true'); } finally { db.close(); }`, `${path}.owner.sqlite`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    let replacement;
    try {
      const original = main();
      await assert.rejects(first.initializeDatabase(original, path), error => {
        assert.equal(error.errors.length, 2);
        assert.match(error.errors[0].message, /Could not acquire.*ownership/);
        assert.equal(error.errors[0].cause.message, "Owner acquisition COMMIT failed");
        assert.equal(error.errors[1].message, "Owner cleanup close failed");
        return true;
      });
      const owner = owners[0];
      assert.equal(owner.closed, false); assert.equal(owner.closeCalls, 1);
      assert.equal(original.closed, true); assert.deepEqual(original.queries, []);
      assert.equal(physicalLockHeld(), true);
      assert.equal(host.__knowledgeMCPDatabaseOwners.size, 1);
      assert.equal(typeof host.__knowledgeMCPDatabaseOwners.get(path).retryClose, "function");
      // Still failing cleanup must reuse its retained handle, not open another owner.
      const rejected = main();
      await assert.rejects(second.initializeDatabase(rejected, path), /Owner cleanup close failed/);
      assert.equal(rejected.closed, true); assert.deepEqual(rejected.queries, []);
      assert.equal(owners.length, 1); assert.equal(owner.closeCalls, 2);
      assert.equal(host.__knowledgeMCPDatabaseOwners.size, 1); assert.equal(physicalLockHeld(), true);
      failClose = false; failAcquisition = false;
      const results = await Promise.allSettled([
        second.initializeDatabase(main(), path), third.initializeDatabase(main(), path),
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.filter(result => result.status === "rejected").length, 1);
      replacement = results.find(result => result.status === "fulfilled").value;
      assert.equal(owner.closed, true); assert.equal(owner.closeCalls, 3);
      assert.equal(owners.length, 2); assert.equal(host.__knowledgeMCPDatabaseOwners.size, 1);
      assert.equal((await replacement.db.selectFrom("kysely_migration").selectAll().execute()).length, Object.keys(first.migrations).length);
      await replacement.close(); assert.equal(host.__knowledgeMCPDatabaseOwners.size, 0);
      assert.equal(physicalLockHeld(), false);
    } finally {
      failClose = false; failAcquisition = false; await replacement?.close();
      for (const native of [...mains, ...owners]) await MockNativeDatabase.prototype.closeDatabase.call(native);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const acquisitionFails of [false, true]) {
  test(`owner cleanup exists before SQL and drains pending ${acquisitionFails ? "failed" : "successful"} acquisition`, async t => {
    const entered = deferred(); const release = deferred();
    let native; let closeCalls = 0;
    const host = { DBConnection: class extends MockNativeDatabase {
      constructor() { super(); native = this; }
      async queryAsync(statement, ...args) {
        if (statement === "COMMIT") {
          entered.resolve(); await release.promise;
          if (acquisitionFails) throw new Error("Pending COMMIT failed");
        }
        return super.queryAsync(statement, ...args);
      }
      async closeDatabase() { closeCalls++; return super.closeDatabase(); }
    } };
    const { createDatabaseOwner } = fixture(t, host);
    const lease = createDatabaseOwner("/isolated/pending-acquisition.sqlite");
    assert.deepEqual(native.queries, []); assert.equal(typeof lease.close, "function");
    assert.throws(() => lease.assertHeld(), /not active/);
    const acquiring = lease.acquire(); assert.equal(lease.acquire(), acquiring);
    const outcome = Promise.allSettled([acquiring]);
    await entered.promise;
    const closing = lease.close(); assert.equal(lease.close(), closing);
    try {
      await assert.rejects(lease.acquire(), /closing/);
      assert.equal(closeCalls, 0); assert.equal(native.closed, false);
    } finally { release.resolve(); }
    assert.equal((await outcome)[0].status, acquisitionFails ? "rejected" : "fulfilled");
    await closing;
    assert.equal(closeCalls, 1); assert.equal(native.closed, true);
    assert.throws(() => lease.assertHeld(), /not active/);
  });
}
