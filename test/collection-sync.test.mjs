import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { api, parsingFixture, hash } from "./fixtures/parsing.mjs";

async function fixture(t) {
  const f = await parsingFixture(t), collections = new Map(), items = new Map([[10, f.item]]);
  const root = { id: 100, libraryID: 1, key: "FOLDER01", name: "Fixture collection", deleted: false, items: [10], children: [],
    getChildItems() { return this.items; }, getChildCollections() { return this.children; } };
  collections.set(root.id, root);
  const native = { uuid: randomUUID, hash, capture: async id => { if (!items.has(id)) throw Error("Unavailable item"); return items.get(id); } };
  const library = { libraryID: 1, libraryType: "user", name: "Fixture Library", editable: true, filesEditable: true, getDataLoaded: () => true };
  Zotero.Libraries = { get: () => library }; Zotero.Users = { getCurrentUserID: () => 123 };
  Zotero.Collections = { get: id => collections.get(id) || false, getByLibraryAndKeyAsync: async (_id, key) => [...collections.values()].find(c => c.key === key) || false };
  Zotero.Items.getAsync = async id => {
    const item = items.get(id);
    if (item) return { id, libraryID: item.library.localID, key: item.key, deleted: false, isAttachment: () => false, isRegularItem: () => true,
      getAttachments: () => item.attachments.map(row => row.itemID) };
    for (const input of items.values()) for (const attachment of input.attachments) if (attachment.itemID === id) return { id, libraryID: input.library.localID,
      key: attachment.key, deleted: false, attachmentContentType: "application/pdf", isAttachment: () => true };
    return false;
  };
  const controller = { snapshot: await f.repo.snapshot(), async refresh() { this.snapshot = await f.repo.snapshot(); } };
  const parsing = new api.ParsingService(f.db, controller, f.port, f.parsers); parsing.config.current = f.config.current;
  const repository = new api.CollectionSyncRepository(f.db, native), sync = new api.CollectionSyncService(repository, controller, parsing);
  await sync.start();
  f.beforeClose(async () => { await sync.close(); await parsing.close(); });
  return { ...f, collections, items, root, controller, parsing, sync, syncRepository: repository, library };
}

test("idle synchronization with no enabled binding skips metadata/parse reconciliation and duplicate notifications", async t => {
  const f = await fixture(t); let metadata = 0, parsing = 0, updates = 0;
  f.controller.refresh = async () => { metadata++; }; f.parsing.refresh = async () => { parsing++; };
  f.sync.subscribe(() => { updates++; });
  await f.sync.reconcile(); await f.sync.reconcile();
  assert.deepEqual({ metadata, parsing, updates }, { metadata: 0, parsing: 0, updates: 0 });
});

for (const mode of ["flexible", "append"]) test(`${mode} folder deletion between scan check and mapping stays excluded and restorable`, async t => {
  const f = await fixture(t); await f.sync.link([100], f.target, mode);
  const binding = f.sync.snapshot()[0], target = { libraryID: f.target.libraryID, nodeID: binding.folders[0].nodeID };
  const folder = f.syncRepository.folder.bind(f.syncRepository); let removed = false;
  f.syncRepository.folder = async (...args) => {
    if (!removed) { removed = true; await f.repo.deleteFolders([target]); }
    return folder(...args);
  };
  await f.sync.reconcile(); await f.sync.reconcile();
  const snapshot = await f.repo.snapshot();
  assert.equal(snapshot.folders.length, 0); assert.equal(snapshot.trash.length, 1);
  await f.repo.restoreTrash(snapshot.trash.map(row => row.id)); await f.sync.reconcile();
  assert.equal((await f.repo.snapshot()).folders[0].id, target.nodeID);
  assert.equal((await f.db.selectFrom("sync_collection_exclusions").selectAll().execute()).length, 0);
});

test("failed sync mapping insert rolls back the folder, library version and event", async t => {
  const f = await fixture(t); f.root.items = [];
  const binding = await f.syncRepository.bind(f.root, f.target);
  const library = { ...await f.db.selectFrom("knowledge_libraries").selectAll().where("id", "=", f.target.libraryID).executeTakeFirstOrThrow() };
  const events = (await f.db.selectFrom("change_outbox").selectAll().execute()).map(row => ({ ...row }));
  f.native.options.fail = statement => /^insert into "zotero_collection_links"/i.test(statement);
  try { await assert.rejects(f.syncRepository.folder(binding, f.root, f.target)); }
  finally { f.native.options.fail = undefined; }
  assert.equal((await f.repo.snapshot()).folders.length, 0);
  assert.deepEqual({ ...await f.db.selectFrom("knowledge_libraries").selectAll().where("id", "=", f.target.libraryID).executeTakeFirstOrThrow() }, library);
  assert.deepEqual((await f.db.selectFrom("change_outbox").selectAll().execute()).map(row => ({ ...row })), events);
  assert.ok(await f.syncRepository.folder(binding, f.root, f.target));
});

test("a deleted mapped ancestor prevents a new source child from appearing outside its exclusion", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  const binding = f.sync.snapshot()[0], target = { libraryID: f.target.libraryID, nodeID: binding.folders[0].nodeID };
  const child = { ...f.root, id: 101, key: "CHILD001", name: "Child", children: [], items: [] };
  f.root.children = [101]; f.collections.set(101, child);
  const folder = f.syncRepository.folder.bind(f.syncRepository); let removed = false;
  f.syncRepository.folder = async (id, collection, parent) => {
    if (collection.id === 101 && !removed) { removed = true; await f.repo.deleteFolders([target]); }
    return folder(id, collection, parent);
  };
  await f.sync.reconcile();
  assert.equal((await f.repo.snapshot()).folders.length, 0);
  assert.equal((await f.repo.snapshot()).trash.length, 1);
});

for (const mode of ["flexible", "append"]) test(`${mode} scans show attention instead of pruning into a removed parent destination`, async t => {
  const f = await fixture(t), parent = await f.repo.create("Destination", f.target), target = { libraryID: f.target.libraryID, nodeID: parent };
  await f.sync.link([100], target, mode);
  await f.repo.deleteFolders([target]); await f.sync.reconcile();
  assert.equal(f.sync.snapshot()[0].error, true);
  assert.equal((await f.repo.snapshot()).folders.length, 0);
  assert.equal((await f.repo.snapshot()).trash.length, 1);
  await f.repo.restoreTrash((await f.repo.snapshot()).trash.map(row => row.id)); await f.sync.reconcile();
  assert.equal(f.sync.snapshot()[0].error, false);
});

test("local item deletion between scan exclusion check and admission preserves Trash recovery", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  const binding = f.sync.snapshot()[0], destination = { libraryID: f.target.libraryID, nodeID: binding.folders[0].nodeID };
  const excluded = f.syncRepository.excluded.bind(f.syncRepository); let removed = false;
  f.syncRepository.excluded = async (...args) => {
    const result = await excluded(...args);
    if (!removed) { removed = true; await f.repo.remove(f.input.resourceID, destination); }
    return result;
  };
  await f.sync.reconcile(); await f.sync.reconcile();
  const snapshot = await f.repo.snapshot();
  assert.equal(snapshot.memberships.filter(row => row.nodeID === destination.nodeID).length, 0);
  assert.equal(snapshot.trash.length, 1);
  await f.repo.restoreTrash(snapshot.trash.map(row => row.id));
  assert.equal((await f.repo.snapshot()).memberships.filter(row => row.nodeID === destination.nodeID).length, 1);
});

test("folder deletion after scan checks cannot readmit its members or consume Trash", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  const binding = f.sync.snapshot()[0], destination = { libraryID: f.target.libraryID, nodeID: binding.folders[0].nodeID };
  const save = f.syncRepository.knowledge.save.bind(f.syncRepository.knowledge); let removed = false;
  f.syncRepository.knowledge.save = async (...args) => {
    if (!removed) { removed = true; await f.repo.deleteFolders([destination]); }
    return save(...args);
  };
  await f.sync.reconcile();
  const snapshot = await f.repo.snapshot();
  assert.equal(snapshot.trash.length, 1);
  assert.equal(snapshot.memberships.filter(row => row.nodeID === destination.nodeID).length, 0);
  await f.repo.restoreTrash(snapshot.trash.map(row => row.id));
  assert.equal((await f.repo.snapshot()).folders.length, 1);
});

test("a purged parent destination invalidates the binding until an explicit new link", async t => {
  const f = await fixture(t), parent = await f.repo.create("Chosen destination", f.target), target = { libraryID: f.target.libraryID, nodeID: parent };
  await f.sync.link([100], target); const binding = f.sync.snapshot()[0];
  await f.repo.deleteFolders([target]); await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  for (const mode of ["flexible", "append", "mirror"]) await assert.rejects(f.sync.configure(binding.id, mode, true, true), /folder/i);
  await assert.rejects(f.sync.setEnabled(binding.id, true), /folder/i);
  await f.sync.reconcile(); assert.equal(f.sync.snapshot().length, 0);
  assert.equal((await f.repo.snapshot()).folders.length, 0);
  await f.sync.close();
  const restarted = new api.CollectionSyncService(f.syncRepository, f.controller, f.parsing); await restarted.start(); f.beforeClose(() => restarted.close());
  await restarted.reconcile(); assert.equal(restarted.snapshot().length, 0);
  await restarted.link([100], f.target);
  assert.notEqual(restarted.snapshot()[0].id, binding.id);
  assert.equal(restarted.snapshot()[0].target.nodeID, null);
  assert.equal((await f.repo.snapshot()).folders.length, 1);
  assert.deepEqual(f.native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

for (const failure of ["missing", "size"]) test(`batch retry continues past a ${failure} PDF and refreshes eligible retries`, async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  const item = { ...f.item, itemID: 20, key: "ARTICLE2", attachments: [{ ...f.item.attachments[0], itemID: 21, key: "PDFKEY02", parentKey: "ARTICLE2" }] };
  f.items.set(20, item); f.root.items.push(20); await f.sync.reconcile();
  const jobs = await f.repository.list(); assert.equal(jobs.length, 2);
  await f.db.updateTable("processing_jobs").set({ state: "failed", error_code: "provider", finished_at: Date.now() }).execute();
  const attachment = f.port.attachment;
  f.port.attachment = async (libraryID, key, ...args) => { if (key === "PDFKEY01") throw new api.ParseError(failure); return attachment(libraryID, key, ...args); };
  let wakes = 0; f.parsing.worker.wake = () => { wakes++; };
  await assert.rejects(f.parsing.runAction(`batch-sync-${f.sync.snapshot()[0].id}`, "retry"));
  const after = await f.repository.list(); assert.equal(after.length, 3);
  const retry = after.find(job => !jobs.some(previous => previous.id === job.id));
  assert.equal(JSON.parse(retry.payload_json).attachmentKey, "PDFKEY02"); assert.equal(retry.state, "pending");
  assert.ok(f.parsing.snapshot().some(task => task.id === retry.id)); assert.equal(wakes, 1);
  await assert.rejects(f.parsing.runAction(jobs[0].id, "retry"), error => error.code === failure);
});

test("import task locations include every ancestor and refresh previously abbreviated history", async t => {
  const f = await fixture(t), libraryID = await f.repo.create("测试");
  const parentID = await f.repo.create("子1", { libraryID, nodeID: null });
  const nodeID = await f.repo.create("子111", { libraryID, nodeID: parentID });
  const target = { libraryID, nodeID };
  await f.repo.save(f.item, target); await f.controller.refresh();
  await f.parsing.enqueue([10], target, { title: "Synthetic batch", sourceCollection: "Synthetic source" });
  const job = (await f.parsing.repository.list())[0], input = JSON.parse(job.payload_json);
  assert.equal(input.target, "测试 › 子1 › 子111");
  for (const task of f.parsing.snapshot()) assert.match(task.target, /测试 › 子1 › 子111/);
  input.target = "测试 › 子111";
  await f.db.updateTable("processing_jobs").set({ payload_json: JSON.stringify(input) }).where("id", "=", job.id).execute();
  await f.parsing.refresh();
  for (const task of f.parsing.snapshot()) assert.match(task.target, /测试 › 子1 › 子111/);
  await f.db.updateTable("library_nodes").set({ name: "Renamed ancestor" }).where("id", "=", parentID).execute();
  await f.controller.refresh(); await f.parsing.refresh();
  for (const task of f.parsing.snapshot()) assert.match(task.target, /测试 › Renamed ancestor › 子111/);
  assert.equal(f.submissions, 0, "display repair does not submit a PDF again");
});

test("mirror restrictions cover item admission, removal and ancestor folder deletion", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target, "mirror");
  const destination = { libraryID: f.target.libraryID, nodeID: f.sync.snapshot()[0].folders[0].nodeID };
  await assert.rejects(() => f.repo.save(f.item, destination), /mirror/i);
  await assert.rejects(() => f.repo.remove(f.input.resourceID, destination), /mirror/i);
  await assert.rejects(() => f.repo.moveToTrash([f.input.resourceID], [f.target.libraryID]), /mirror/i);
  await assert.rejects(() => f.repo.create("Forbidden", destination), /mirror/i);
  await assert.rejects(() => f.repo.deleteFolder?.(destination) ?? f.repo.deleteFolders([destination]), /mirror/i);
  f.root.items = []; await f.sync.reconcile();
  assert.equal((await f.db.selectFrom("membership_origins").select("id").where("origin_type", "=", "zotero").where("deleted_at", "is", null).execute()).length, 0);
});

test("flexible local deletion persists across scans, restart and permanent ownership deletion", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target, "flexible");
  const binding = f.sync.snapshot()[0], destination = { libraryID: f.target.libraryID, nodeID: binding.folders[0].nodeID };
  await f.repo.remove(f.input.resourceID, destination);
  await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  await f.sync.reconcile(); await f.sync.reconcile();
  assert.equal(f.controller.snapshot.memberships.filter(row => row.nodeID === destination.nodeID).length, 0);
  assert.equal((await f.db.selectFrom("sync_exclusions").selectAll().execute()).length, 1);
  await f.sync.close();
  const restarted = new api.CollectionSyncService(f.syncRepository, f.controller, f.parsing); await restarted.start(); f.beforeClose(() => restarted.close());
  await restarted.reconcile(); assert.equal(f.controller.snapshot.memberships.filter(row => row.nodeID === destination.nodeID).length, 0);
  await restarted.configure(binding.id, "flexible", true, true);
  assert.equal(f.controller.snapshot.memberships.filter(row => row.nodeID === destination.nodeID).length, 1);
});

test("flexible restore clears local exclusions, and explicit readmission is synchronized again", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  const destination = { libraryID: f.target.libraryID, nodeID: f.sync.snapshot()[0].folders[0].nodeID };
  await f.repo.remove(f.input.resourceID, destination);
  await f.repo.restoreTrash((await f.repo.snapshot()).trash.map(row => row.id));
  assert.equal((await f.db.selectFrom("sync_exclusions").selectAll().execute()).length, 0);
  await f.repo.remove(f.input.resourceID, destination); await f.repo.save(f.item, destination); await f.sync.reconcile();
  assert.equal((await f.db.selectFrom("sync_exclusions").selectAll().execute()).length, 0);
});

test("append sync retains source removals but respects independent local deletion", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target, "append");
  const destination = { libraryID: f.target.libraryID, nodeID: f.sync.snapshot()[0].folders[0].nodeID };
  f.root.items = []; await f.sync.reconcile();
  assert.equal(f.controller.snapshot.memberships.filter(row => row.nodeID === destination.nodeID).length, 1);
  await f.repo.remove(f.input.resourceID, destination); f.root.items = [10]; await f.sync.reconcile();
  assert.equal(f.controller.snapshot.memberships.filter(row => row.nodeID === destination.nodeID).length, 0);
});

test("locally removed flexible folder is excluded without blocking scans of other folders", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  const binding = f.sync.snapshot()[0]; await f.repo.deleteFolders([{ libraryID: f.target.libraryID, nodeID: binding.folders[0].nodeID }]);
  await f.sync.reconcile(); assert.equal(f.sync.snapshot()[0].error, false);
  assert.equal(f.controller.snapshot.folders.length, 0);
  await f.repo.restoreTrash((await f.repo.snapshot()).trash.map(row => row.id));
  await f.sync.reconcile(); assert.equal(f.controller.snapshot.folders.length, 1);
});

test("clearing folder exclusions creates a fresh mapped folder and retains the original Trash operation", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  const binding = f.sync.snapshot()[0], original = binding.folders[0].nodeID;
  await f.repo.deleteFolders([{ libraryID: f.target.libraryID, nodeID: original }]);
  await f.sync.configure(binding.id, "flexible", true, true);
  assert.equal(f.sync.snapshot()[0].error, false);
  assert.notEqual(f.sync.snapshot()[0].folders[0].nodeID, original);
  assert.equal((await f.repo.snapshot()).trash.length, 1);
});

test("continuous sync mirrors descendants and prunes only its own origins", async t => {
  const f = await fixture(t);
  const child = { ...f.root, id: 101, key: "CHILD001", name: "Child folder", items: [10], children: [] };
  f.root.children = [101]; f.collections.set(child.id, child);
  await f.sync.link([100], f.target);
  assert.equal(f.sync.snapshot().length, 1); assert.equal(f.sync.snapshot()[0].error, false);
  assert.equal(f.controller.snapshot.folders.length, 2);
  const folder = f.controller.snapshot.folders.find(row => row.name === f.root.name);
  await f.repo.save(f.item, { libraryID: f.target.libraryID, nodeID: folder.id });
  f.root.items = []; child.items = [];
  await f.sync.reconcile();
  const origins = await f.db.selectFrom("membership_origins").selectAll().where("deleted_at", "is", null).execute();
  assert.equal(origins.filter(row => row.origin_type === "zotero").length, 0);
  assert.ok(f.controller.snapshot.memberships.some(row => row.nodeID === folder.id));
  assert.equal((await f.repository.list()).length, 1, "same PDF in two source folders is uploaded only once");
});

test("an unavailable source never prunes memberships, while a confirmed removed source does", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  Zotero.Libraries.get = () => false; await f.sync.reconcile();
  assert.equal(f.sync.snapshot()[0].error, true);
  assert.equal((await f.db.selectFrom("membership_origins").select("id").where("origin_type", "=", "zotero").where("deleted_at", "is", null).execute()).length, 1);
  Zotero.Libraries.get = () => f.library; f.collections.clear(); await f.sync.reconcile();
  assert.equal(f.sync.snapshot()[0].enabled, false);
  assert.equal((await f.db.selectFrom("membership_origins").select("id").where("origin_type", "=", "zotero").where("deleted_at", "is", null).execute()).length, 0);
});

test("paused bindings survive restart and unlinking preserves imported items", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  const binding = f.sync.snapshot()[0]; await f.sync.setEnabled(binding.id, false);
  f.root.items = []; await f.sync.reconcile();
  assert.ok(f.controller.snapshot.memberships.some(row => row.nodeID));
  await f.sync.close();
  const restarted = new api.CollectionSyncService(f.syncRepository, f.controller, f.parsing); await restarted.start(); f.beforeClose(() => restarted.close());
  assert.equal(restarted.snapshot()[0].enabled, false);
  await restarted.unlink(binding.id); assert.equal(restarted.snapshot().length, 0);
  assert.ok(f.controller.snapshot.memberships.some(row => row.nodeID));
  assert.equal((await f.db.selectFrom("membership_origins").select("id").where("binding_id", "=", binding.id).where("deleted_at", "is", null).execute()).length, 0);
});

test("unchanged failed parsing jobs are not resubmitted during recurring collection scans", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  const job = (await f.repository.list())[0];
  await f.db.updateTable("processing_jobs").set({ state: "failed", finished_at: Date.now(), error_code: "provider" }).where("id", "=", job.id).execute();
  await f.sync.reconcile(); await f.sync.reconcile();
  assert.equal((await f.repository.list()).length, 1);
  const source = new api.ImportTasksService(f.parsing, f.sync);
  assert.equal(source.snapshot()[0].mode, "sync");
  await source.runAction(`batch-sync-${f.sync.snapshot()[0].id}`, "delete");
  assert.equal(source.snapshot().length, 0); assert.equal(f.sync.snapshot()[0].enabled, true, "clearing history does not disable the link");
});

test("empty source folders are mirrored and a later new item is admitted", async t => {
  const f = await fixture(t); f.root.items = []; await f.sync.link([100], f.target);
  assert.equal(f.controller.snapshot.folders.length, 1); assert.equal((await f.repository.list()).length, 0);
  f.root.name = "Renamed collection"; f.root.items = [10]; await f.sync.reconcile();
  assert.equal(f.controller.snapshot.folders[0].name, "Renamed collection");
  assert.equal((await f.repository.list()).length, 1);
});

test("two bindings preserve each other's memberships when one source removes an item", async t => {
  const f = await fixture(t), second = { ...f.root, id: 102, key: "FOLDER02", name: "Second collection", items: [10], children: [] };
  f.collections.set(second.id, second); await f.sync.link([100,102], f.target);
  assert.equal(f.sync.snapshot().length, 2);
  f.root.items = []; await f.sync.reconcile();
  const origins = await f.db.selectFrom("membership_origins").select("id").where("origin_type", "=", "zotero").where("deleted_at", "is", null).execute();
  assert.equal(origins.length, 1);
  const folder = f.controller.snapshot.folders.find(row => row.name === second.name);
  assert.ok(f.controller.snapshot.memberships.some(row => row.nodeID === folder.id));
});

test("sync adopts a visible failed manual task and explicit group retry queues it without polling reuploads", async t => {
  const f = await fixture(t);
  await f.parsing.enqueue([10]); const original = (await f.repository.list())[0];
  await f.db.updateTable("processing_jobs").set({ state: "failed", finished_at: Date.now(), error_code: "http-400" }).where("id", "=", original.id).execute();
  await f.sync.link([100], f.target);
  const tasks = new api.ImportTasksService(f.parsing, f.sync), root = tasks.snapshot().find(task => task.mode === "sync");
  assert.equal(root.status, "attention");
  assert.equal(tasks.snapshot().find(task => task.id === original.id).parentID, root.id);
  await f.sync.reconcile(); assert.equal((await f.repository.list()).length, 1, "automatic scans retain the definite failure");
  await tasks.runAction(root.id, "pause"); assert.equal(tasks.snapshot()[0].status, "paused");
  await tasks.runAction(root.id, "retry");
  const jobs = await f.repository.list(); assert.equal(jobs.length, 2);
  assert.equal(jobs[1].state, "pending");
  assert.equal(tasks.snapshot().find(task => task.mode === "sync").status, "syncing");
});

test("sync group retry never resubmits an ambiguous remote submission", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  const original = (await f.repository.list())[0];
  await f.db.updateTable("processing_jobs").set({ state: "needs_attention", error_code: "ambiguous" }).where("id", "=", original.id).execute();
  await f.db.updateTable("parse_runs").set({ submission_state: "submitting", stage: "submitting" }).where("job_id", "=", original.id).execute();
  await f.parsing.refresh();
  const tasks = new api.ImportTasksService(f.parsing, f.sync), root = tasks.snapshot()[0];
  assert.equal(root.status, "attention"); await tasks.runAction(root.id, "retry");
  assert.equal((await f.repository.list()).length, 1); assert.equal((await f.job(original.id)).state, "needs_attention");
});

for (const failure of ["missing", "size"]) test(`${failure} PDF preparation does not block descendants or membership pruning`, async t => {
  const f = await fixture(t);
  const old = { ...f.item, itemID: 20, key: "ARTICLE2", attachments: [] };
  f.items.set(20, old); f.root.items.push(20); await f.sync.link([100], f.target);
  const child = { ...f.root, id: 101, key: "CHILD001", name: "New child", items: [10], children: [] };
  f.collections.set(101, child); f.root.children = [101]; f.root.items = [10];
  f.port.attachment = async () => { throw new api.ParseError(failure); };
  await f.sync.reconcile();
  const binding = f.sync.snapshot()[0];
  assert.equal(binding.error, true, "parsing preparation still surfaces as attention");
  assert.ok(f.controller.snapshot.folders.some(folder => folder.name === "New child"));
  const stale = await f.db.selectFrom("membership_origins as o").innerJoin("zotero_item_links as i", "i.id", "o.item_link_id")
    .select("o.id").where("o.binding_id", "=", binding.id).where("i.item_key", "=", "ARTICLE2").where("o.deleted_at", "is", null).execute();
  assert.equal(stale.length, 0, "source removals are pruned after a complete member scan");
  assert.equal((await f.db.selectFrom("membership_origins").select("id").where("binding_id", "=", binding.id).where("deleted_at", "is", null).execute()).length, 2);
  const tasks = new api.ImportTasksService(f.parsing, f.sync); assert.equal(tasks.snapshot()[0].status, "attention");
});

test("an incomplete native member scan never prunes previously synchronized origins", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  f.root.items = [999]; await f.sync.reconcile();
  assert.equal(f.sync.snapshot()[0].error, true);
  assert.equal((await f.db.selectFrom("membership_origins").select("id").where("origin_type", "=", "zotero").where("deleted_at", "is", null).execute()).length, 1);
});

test("clearing sync history hides finished records, retains active work and reveals future jobs after restart", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  const binding = f.sync.snapshot()[0], tasks = new api.ImportTasksService(f.parsing, f.sync), first = (await f.repository.list())[0];
  await f.db.updateTable("processing_jobs").set({ state: "failed", finished_at: Date.now() }).where("id", "=", first.id).execute();
  await tasks.runAction(`batch-sync-${binding.id}`, "delete");
  assert.equal(tasks.snapshot().length, 0); assert.equal(f.sync.snapshot()[0].enabled, true);
  const item = { ...f.item, itemID: 20, key: "ARTICLE2", attachments: [{ ...f.item.attachments[0], itemID: 21, key: "PDFKEY02", parentKey: "ARTICLE2" }] };
  f.items.set(20, item); f.root.items.push(20); await f.sync.reconcile();
  const second = (await f.repository.list()).find(job => job.id !== first.id);
  assert.ok(tasks.snapshot().some(task => task.id === second.id)); assert.ok(!tasks.snapshot().some(task => task.id === first.id));
  await tasks.runAction(`batch-sync-${binding.id}`, "delete");
  assert.ok(tasks.snapshot().some(task => task.id === second.id), "history deletion cannot hide a pending task");
  await f.sync.close();
  const restarted = new api.CollectionSyncService(f.syncRepository, f.controller, f.parsing); await restarted.start(); f.beforeClose(() => restarted.close());
  const restored = new api.ImportTasksService(f.parsing, restarted);
  assert.ok(restored.snapshot().some(task => task.id === second.id)); assert.ok(!restored.snapshot().some(task => task.id === first.id));
});

test("legacy hidden bindings migrate once to record-level history without hiding later completed jobs", async t => {
  const f = await fixture(t); await f.sync.link([100], f.target);
  const binding = f.sync.snapshot()[0], first = (await f.repository.list())[0];
  await f.db.updateTable("processing_jobs").set({ state: "failed", finished_at: Date.now() }).where("id", "=", first.id).execute();
  await f.sync.close();
  await f.db.updateTable("plugin_state").set({ value_json: JSON.stringify({ title: binding.title, error: false, hidden: true, added: 0, removedItems: 0 }) }).where("key", "=", `collection-sync:${binding.id}`).execute();
  const restarted = new api.CollectionSyncService(f.syncRepository, f.controller, f.parsing); await restarted.start(); f.beforeClose(() => restarted.close());
  assert.equal(new api.ImportTasksService(f.parsing, restarted).snapshot().length, 0);
  assert.equal(JSON.parse((await f.job(first.id)).payload_json).hidden, true);
  const state = await f.db.selectFrom("plugin_state").select("value_json").where("key", "=", `collection-sync:${binding.id}`).executeTakeFirstOrThrow();
  assert.equal(JSON.parse(state.value_json).historyCleared, true);
  const item = { ...f.item, itemID: 20, key: "ARTICLE2", attachments: [{ ...f.item.attachments[0], itemID: 21, key: "PDFKEY02", parentKey: "ARTICLE2" }] };
  f.items.set(20, item); f.root.items.push(20); await restarted.reconcile();
  const second = (await f.repository.list()).find(job => job.id !== first.id);
  await f.db.updateTable("processing_jobs").set({ state: "failed", finished_at: Date.now() }).where("id", "=", second.id).execute();
  await f.parsing.refresh(); await restarted.close();
  const again = new api.CollectionSyncService(f.syncRepository, f.controller, f.parsing); await again.start(); f.beforeClose(() => again.close());
  assert.ok(new api.ImportTasksService(f.parsing, again).snapshot().some(task => task.id === second.id));
});
