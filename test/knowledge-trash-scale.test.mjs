import { mockLocalization } from "./helpers/localization.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { build } from "esbuild";
import { createContext, runInContext } from "node:vm";
import { MockNativeDatabase } from "./helpers/native-database.mjs";
import { seedKnowledgeScale } from "./helpers/knowledge-scale.mjs";

const bundle = await build({ stdin: { contents: `
export { Kysely, sql } from "kysely";
export { Migrator } from "kysely/migration";
export * from "./src/database/zotero-dialect.ts";
export * from "./src/database/migration-service.ts";
export * from "./src/database/migration-provider.ts";
export * from "./src/repositories/knowledge-trash.ts";
export * from "./src/repositories/knowledge-library.ts";
export * from "./src/services/knowledge-library.ts";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "browser", target: "firefox140", format: "cjs", write: false });

async function fixture(t, dimensions, legacy = false) {
  const module = { exports: {} };
  const sandbox = createContext({ Localization: mockLocalization(), module, exports: module.exports, Uint8Array, Zotero: { debug() {} } });
  runInContext(bundle.outputFiles[0].text, sandbox);
  const api = module.exports;
  const native = new MockNativeDatabase(":memory:", { maxParameters: 999 });
  const db = new api.Kysely({ dialect: new api.ZoteroDialect(native, () => {}) });
  let service;
  t.after(async () => { await service?.close(); await db.destroy(); });
  if (legacy) {
    const migrations = Object.fromEntries(Object.entries(api.migrations).slice(0, 5));
    const result = await new api.Migrator({ db, provider: { async getMigrations() { return migrations; } } }).migrateToLatest();
    assert.equal(result.error, undefined);
  } else await api.migrateDatabase(db, async () => {});
  const scale = await seedKnowledgeScale(db, api.sql, dimensions);
  const port = { uuid: randomUUID, lookup: async () => null };
  const repository = new api.KnowledgeLibraryRepository(db, port);
  const trash = new api.KnowledgeTrashRepository(port);
  const count = (table, predicate = "1") => native.sqlite.prepare(`SELECT count(*) n FROM ${table} WHERE ${predicate}`).get().n;
  const validate = () => {
    assert.deepEqual(native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(native.sqlite.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.ok(native.maxObservedParameters <= 999);
  };
  return { ...api, ...scale, db, native, repository, trash, count, validate,
    async restart() { await service?.close(); service = new api.KnowledgeLibraryService(db, port); await service.start(); return service; } };
}

function digest(native) {
  const tables = ["knowledge_libraries", "library_nodes", "knowledge_resources", "library_resources", "library_items", "membership_origins",
    "knowledge_trash_entries", "knowledge_trash_resources", "knowledge_trash_folders", "knowledge_trash_relations", "knowledge_trash_placements", "knowledge_trash_origins",
    "resource_revisions", "change_outbox"];
  return createHash("sha256").update(JSON.stringify(tables.map(table => native.sqlite.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort()))).digest("hex");
}

test("deep reversed folder chains delete together with one parent scan and restore original hierarchy", async t => {
  const f = await fixture(t, { resourceCount: 1, folderCount: 602 });
  const sqlite = f.native.sqlite;
  sqlite.exec(`UPDATE library_nodes SET parent_id = CASE
    WHEN CAST(substr(id, 14) AS INTEGER) % 301 = 300 THEN 'scale-root'
    ELSE 'scale-folder-' || (CAST(substr(id, 14) AS INTEGER) + 1) END
    WHERE id LIKE 'scale-folder-%'`);
  await f.repository.initialize();
  const before = sqlite.prepare("SELECT id,parent_id FROM library_nodes ORDER BY id").all();
  const targets = [300, 601, 0].map(index => ({ ...f.target, nodeID: `scale-folder-${index}` }));
  const start = f.native.queries.length;
  await f.repository.deleteFolders([...targets, targets[0]]);
  const scans = f.native.queries.slice(start).filter(query => /^select "id", "parent_id" from "library_nodes"/.test(query));
  assert.equal(scans.length, 1, "a multi-root batch indexes parents and children once");
  assert.equal(f.count("library_nodes", "deleted_at IS NOT NULL"), 602);
  assert.equal(f.count("knowledge_trash_entries"), 2, "selected descendants and duplicate roots are deleted once");
  assert.equal(f.count("membership_origins", "deleted_at IS NULL AND library_item_id IS NULL"), 1);
  const entries = await f.trash.list(f.db);
  await f.repository.restoreTrash(entries.map(entry => entry.id));
  assert.deepEqual(sqlite.prepare("SELECT id,parent_id FROM library_nodes ORDER BY id").all(), before);
  assert.equal(f.count("membership_origins", "deleted_at IS NULL AND library_item_id IS NOT NULL"), 602);
  await assert.rejects(() => f.repository.deleteFolders([targets[0], { libraryID: "wrong-library", nodeID: targets[0].nodeID }]), /unavailable/);
  assert.equal(f.count("library_nodes", "deleted_at IS NOT NULL"), 0, "invalid duplicate targets still reject the entire batch");
  f.validate();
});

test("bulk Trash moves preserve recovery and purge reads recovery links only once", async t => {
  const f = await fixture(t, { resourceCount: 201, folderCount: 2 });
  await f.repository.initialize();
  const resources = f.native.sqlite.prepare("SELECT id FROM knowledge_resources ORDER BY id").all().map(row => row.id);
  await f.repository.moveToTrash([...resources, resources[0]], [f.target.libraryID, f.target.libraryID]);
  assert.equal(f.count("knowledge_trash_entries"), 201);
  assert.equal(f.count("membership_origins", "deleted_at IS NULL"), 0);
  const entries = await f.trash.list(f.db);
  const start = f.native.queries.length;
  await f.repository.purgeTrash(entries.map(entry => entry.id));
  const linkLoads = f.native.queries.slice(start).filter(query => /^select \* from "knowledge_trash_origins"/.test(query));
  assert.equal(linkLoads.length, 1, "purge must not reload all recovery links after deletion");
  assert.equal(f.count("knowledge_resources"), 0);
  assert.equal(f.count("resource_revisions"), 0);
  assert.equal(f.count("knowledge_trash_entries"), 0);
  f.validate();
});

test("4000 papers in 10 folders delete, restart, restore and empty Trash under a 999-parameter budget", async t => {
  const f = await fixture(t, { resourceCount: 4000, folderCount: 10 });
  f.native.sqlite.exec(`
    INSERT INTO zotero_libraries(id,library_type,local_library_id,display_name,is_editable,files_editable,availability,last_checked_at,created_at,updated_at)
      VALUES ('scale-native','user',1,'Synthetic library',1,1,'available',1,1,1);
    INSERT INTO zotero_item_links(id,zotero_library_id,item_key,local_item_id,item_kind,resource_id,is_anchor,state,last_seen_at,created_at,updated_at)
      SELECT 'anchor-'||id,'scale-native',id,row_number() OVER (ORDER BY id),'regular',id,1,'current',1,1,1 FROM knowledge_resources;
  `);
  const initial = await f.repository.snapshot();
  assert.equal(initial.resources.length, 4000);
  assert.equal(initial.memberships.length, 40000);
  assert.deepEqual(new Set(Array.from(initial.memberships).filter(row => row.resourceID === "scale-resource-0").map(row => row.nodeID)),
    new Set(Array.from({ length: 10 }, (_, index) => `scale-folder-${index}`)));
  let service = await f.restart();
  const originalIDs = f.native.sqlite.prepare("SELECT id FROM library_items ORDER BY id").all().map(row => row.id);
  const beforeDeletion = f.native.queries.length;
  await service.deleteLibrary(f.target.libraryID, false);
  const resourceReads = f.native.queries.slice(beforeDeletion).filter(sql => /^select\b/i.test(sql) && /\bknowledge_resources\b/.test(sql));
  assert.ok(resourceReads.length < 10, `deleting 4000 members must not read resources individually, observed ${resourceReads.length}`);
  assert.equal(f.count("membership_origins", "deleted_at IS NOT NULL"), 40000);
  assert.equal(f.count("knowledge_trash_origins"), 40000);
  const snapshotStart = f.native.queries.length;
  const summary = await f.repository.snapshot();
  const snapshotQueries = f.native.queries.slice(snapshotStart);
  assert.equal(snapshotQueries.length, 9, "a nonempty-Trash snapshot reads summaries in two queries instead of six");
  assert.ok(!snapshotQueries.some(query => /from "knowledge_trash_(?:folders|relations|placements|origins)"/.test(query)),
    "UI refresh must not load the 40000-origin recovery graph");
  assert.equal(summary.trash[0].resourceIDs.length, 4000);
  assert.equal("originIDs" in summary.trash[0], false, "recovery internals remain outside the snapshot contract");
  await service.refresh();
  service = await f.restart();
  assert.equal(service.snapshot.trash.length, 1);
  await service.restoreTrash(service.snapshot.trash.map(entry => entry.id));
  assert.equal(service.snapshot.resources.length, 4000);
  assert.equal(service.snapshot.memberships.length, 40000);
  assert.equal(f.count("membership_origins", "deleted_at IS NULL"), 40000);
  assert.equal(f.count("library_items", "deleted_at IS NULL"), 40000);
  assert.deepEqual(f.native.sqlite.prepare("SELECT id FROM library_items ORDER BY id").all().map(row => row.id), originalIDs);
  assert.equal(service.snapshot.trash.length, 0);
  await service.deleteLibrary(f.target.libraryID, true);
  assert.equal(f.count("knowledge_resources", "status='deleted'"), 4000);
  await service.purgeTrash(service.snapshot.trash.map(entry => entry.id));
  assert.equal(f.count("knowledge_trash_entries"), 0);
  assert.equal(f.count("knowledge_trash_origins"), 0);
  assert.equal(f.count("membership_origins"), 0, "permanent deletion removes unreferenced ownership records");
  f.validate();
});

test("Trash summaries match full entry order and resource order without losing recovery details", async t => {
  const f = await fixture(t, { resourceCount: 3, folderCount: 2 });
  assert.deepEqual(Array.from(await f.trash.listSummary(f.db)), []);
  await f.repository.initialize();
  await f.repository.deleteFolders([f.root]);
  const emptyLibrary = await f.repository.create("Empty library");
  await f.repository.deleteLibrary(emptyLibrary, false);
  await f.repository.moveToTrash(["scale-resource-0"], [f.target.libraryID]);
  f.native.sqlite.exec("UPDATE knowledge_trash_entries SET deleted_at=1");
  const summary = await f.trash.listSummary(f.db);
  const full = await f.trash.list(f.db);
  const publicEntries = full.map(({ folderIDs, relationIDs, placementIDs, originIDs, deletedResourceIDs, ...entry }) => entry);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), JSON.parse(JSON.stringify(publicEntries)));
  assert.deepEqual(Array.from(summary, entry => entry.id), Array.from(summary, entry => entry.id).sort(), "same-time entries retain their ID order");
  assert.equal(full.find(entry => entry.kind === "folder").originIDs.length, 6);
  assert.equal(summary.find(entry => entry.kind === "library").resourceIDs.length, 0);
  await f.repository.restoreTrash(summary.map(entry => entry.id));
  assert.equal(f.count("knowledge_trash_entries"), 0);
  assert.equal(f.count("library_items", "deleted_at IS NULL"), 6);
  f.validate();
});

test("large folder subtrees restore original identities and retain root memberships when permanently discarded", async t => {
  const f = await fixture(t, { resourceCount: 1, folderCount: 1201 });
  const service = await f.restart();
  await service.deleteFolders([f.root, f.root, { ...f.target, nodeID: "scale-folder-0" }]);
  assert.equal(service.snapshot.trash.length, 1, "selected ancestor and descendant delete once");
  assert.equal(f.count("library_nodes", "deleted_at IS NOT NULL"), 1202);
  assert.equal(f.count("membership_origins", "deleted_at IS NULL AND library_item_id IS NULL"), 1);
  await service.restoreTrash(service.snapshot.trash.map(entry => entry.id));
  assert.equal(f.count("library_nodes", "deleted_at IS NULL"), 1202);
  assert.equal(f.count("library_items", "deleted_at IS NULL"), 1201);
  await service.deleteFolder(f.root);
  await service.purgeTrash(service.snapshot.trash.map(entry => entry.id));
  assert.equal(f.count("knowledge_trash_entries"), 0);
  assert.equal(f.count("membership_origins", "deleted_at IS NULL AND library_item_id IS NULL"), 1);
  assert.equal(f.count("knowledge_resources", "status='active'"), 1);
  f.validate();
});

test("large item recovery checks every recorded origin before consuming a readmitted entry", async t => {
  const f = await fixture(t, { resourceCount: 1, folderCount: 1201 });
  await f.repository.initialize();
  await f.repository.moveToTrash(["scale-resource-0"], [f.target.libraryID]);
  const [entry] = await f.trash.list(f.db);
  assert.equal(entry.originIDs.length, 1201);
  const lastID = entry.originIDs.at(-1);
  await f.db.updateTable("membership_origins").set({ deleted_at: null }).execute();
  await f.db.updateTable("library_items").set({ deleted_at: null }).execute();
  await f.db.updateTable("library_resources").set({ deleted_at: null }).execute();
  await f.db.updateTable("membership_origins").set({ deleted_at: 1 }).where("id", "=", lastID).execute();
  await f.db.transaction().execute(tx => f.trash.readmitted(tx, "scale-resource-0", f.target));
  assert.equal(f.count("knowledge_trash_entries"), 1, "a missing origin in the last batch keeps recovery available");
  await f.db.updateTable("membership_origins").set({ deleted_at: null }).where("id", "=", lastID).execute();
  await f.db.transaction().execute(tx => f.trash.readmitted(tx, "scale-resource-0", f.target));
  assert.equal(f.count("knowledge_trash_entries"), 0);
  f.validate();
});

test("late subtree deletion and restoration batch failures roll back model, recovery and audit rows", async t => {
  const f = await fixture(t, { resourceCount: 201, folderCount: 7 });
  const service = await f.restart();
  let before = digest(f.native), batches = 0;
  f.native.options.fail = statement => /^update "membership_origins"/.test(statement) && ++batches === 2;
  await assert.rejects(() => service.deleteFolder(f.root), /Injected native query failure/);
  assert.equal(batches, 2);
  assert.equal(digest(f.native), before);
  f.native.options.fail = undefined;
  await service.deleteLibrary(f.target.libraryID, false);
  before = digest(f.native); batches = 0;
  f.native.options.fail = statement => /^update "library_items"/.test(statement) && ++batches === 2;
  await assert.rejects(() => service.restoreTrash(service.snapshot.trash.map(entry => entry.id)), /Injected native query failure/);
  assert.equal(batches, 2);
  assert.equal(digest(f.native), before);
  f.native.options.fail = undefined;
  await service.restoreTrash(service.snapshot.trash.map(entry => entry.id));
  assert.equal(f.count("library_items", "deleted_at IS NULL"), 1407);
  f.validate();
});

test("selective permanent deletion rewrites large overlap records in order and rolls back a later write failure", async t => {
  const f = await fixture(t, { resourceCount: 401, folderCount: 3 });
  const service = await f.restart();
  const origins = await f.db.selectFrom("membership_origins").select("id").where("resource_id", "=", "scale-resource-0").execute();
  await f.db.transaction().execute(tx => f.trash.capture(tx, "item", "Earlier removal", f.target, [], ["scale-resource-0"], origins.map(row => row.id)));
  const [item] = await f.trash.list(f.db);
  await service.deleteLibrary(f.target.libraryID, false);
  const library = (await f.trash.list(f.db)).find(entry => entry.kind === "library");
  const before = digest(f.native); let batches = 0;
  f.native.options.fail = statement => /^insert into "knowledge_trash_origins"/.test(statement) && ++batches === 2;
  await assert.rejects(() => service.purgeTrash([item.id]), /Injected native query failure/);
  assert.equal(batches, 2);
  assert.equal(digest(f.native), before);
  f.native.options.fail = undefined;
  await service.purgeTrash([item.id]);
  const [retained] = await f.trash.list(f.db);
  assert.equal(retained.originIDs.length, 1200);
  const removedIDs = new Set(origins.map(row => row.id));
  assert.deepEqual(Array.from(retained.originIDs), Array.from(library.originIDs).filter(id => !removedIDs.has(id)));
  await service.restoreTrash([retained.id]);
  assert.equal(f.count("membership_origins", "deleted_at IS NULL"), 1200);
  assert.equal(f.count("library_resources", "resource_id='scale-resource-0' AND deleted_at IS NULL"), 0);
  assert.equal(f.count("knowledge_resources", "id='scale-resource-0'"), 0);
  f.validate();
});

test("legacy JSON with 40000 recovery origins upgrades and restores under the same parameter budget", async t => {
  const f = await fixture(t, { resourceCount: 4000, folderCount: 10 }, true);
  const sqlite = f.native.sqlite;
  const ids = table => sqlite.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => row.id);
  const entry = { id: "legacy-scale", kind: "library", name: "Scale library", target: f.target, location: "Scale library", deletedAt: 1,
    resourceIDs: ids("knowledge_resources"), folderIDs: ids("library_nodes"), relationIDs: ids("library_resources"),
    placementIDs: ids("library_items"), originIDs: ids("membership_origins"), deletedResourceIDs: ids("knowledge_resources") };
  await f.db.insertInto("plugin_state").values({ key: "knowledge-trash:legacy-scale", value_json: JSON.stringify(entry), updated_at: 1 }).execute();
  sqlite.exec("UPDATE knowledge_libraries SET status='deleted',is_default=0,deleted_at=1");
  sqlite.exec("UPDATE knowledge_resources SET status='deleted',deleted_at=1");
  for (const table of ["library_nodes", "library_resources", "library_items", "membership_origins"]) sqlite.exec(`UPDATE ${table} SET deleted_at=1`);
  let backups = 0;
  await f.migrateDatabase(f.db, async () => { backups++; });
  assert.equal(backups, 1);
  assert.equal(f.count("plugin_state", "key='knowledge-trash:legacy-scale'"), 0);
  const service = await f.restart();
  assert.equal(service.snapshot.trash.length, 1);
  assert.equal(f.count("knowledge_trash_origins"), 40000);
  assert.equal(f.count("knowledge_trash_resources", "was_deleted=1"), 4000);
  await service.restoreTrash([entry.id]);
  assert.equal(f.count("membership_origins", "deleted_at IS NULL"), 40000);
  assert.equal(f.count("knowledge_resources", "status='active' AND deleted_at IS NULL"), 4000);
  assert.equal(f.count("knowledge_trash_entries"), 0);
  f.validate();
});
