import assert from "node:assert/strict";
import { test } from "node:test";
import { api, parsingFixture } from "./fixtures/parsing.mjs";

async function completed(f) {
  const id = await f.enqueue(); await f.step(); await f.step();
  assert.equal((await f.job(id)).state, "succeeded"); return id;
}

test("permanent deletion removes derived rows and files and reimport requires new parsing", async t => {
  const f = await parsingFixture(t); await completed(f);
  f.files.set("/isolated/knowledgemcp/reader-content/1-PDFKEY01.json", new Uint8Array([1]));
  await f.repo.remove(f.input.resourceID, f.target);
  await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  assert.equal((await f.db.selectFrom("change_outbox").select("event_id").where("aggregate_id", "=", f.input.sourceID).execute()).length, 0,
    "source publication events are deleted with their source");
  for (const table of ["knowledge_resources", "resource_sources", "content_generations", "content_blocks", "structure_nodes", "parse_runs", "processing_jobs", "stored_files", "resource_revisions", "membership_origins", "library_resources", "library_items", "mutation_receipts"]) {
    assert.equal((await f.db.selectFrom(table).selectAll().execute()).length, 0, table);
  }
  await api.cleanupFiles(f.db);
  assert.equal(f.files.size, 0);
  const resourceID = await f.repo.save(f.item, f.target);
  assert.notEqual(resourceID, f.input.resourceID);
  assert.equal((await f.db.selectFrom("resource_sources").select("active_generation_id").executeTakeFirstOrThrow()).active_generation_id, null);
  assert.deepEqual(f.native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("purging one ownership physically removes it while preserving shared parsed content", async t => {
  const f = await parsingFixture(t); await completed(f);
  const libraryID = await f.repo.create("Second knowledge library");
  await f.repo.save(f.item, { libraryID, nodeID: null });
  await f.repo.remove(f.input.resourceID, f.target);
  const removed = await f.db.selectFrom("membership_origins").select("id").where("library_id", "=", f.target.libraryID).executeTakeFirstOrThrow();
  await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  assert.equal(await f.db.selectFrom("membership_origins").select("id").where("id", "=", removed.id).executeTakeFirst(), undefined);
  assert.equal((await f.db.selectFrom("content_generations").select("id").execute()).length, 1);
  assert.equal((await f.db.selectFrom("file_cleanup").selectAll().execute()).length, 0);
  assert.equal((await f.db.selectFrom("change_outbox").select("event_id").where("aggregate_id", "=", f.input.sourceID).execute()).length, 1,
    "another membership preserves the source publication event");
});

test("other Trash recovery rights preserve shared data until the last reference is purged", async t => {
  const f = await parsingFixture(t); await completed(f);
  const libraryID = await f.repo.create("Second library"); await f.repo.save(f.item, { libraryID, nodeID: null });
  await f.repo.remove(f.input.resourceID, f.target); await f.repo.remove(f.input.resourceID, { libraryID, nodeID: null });
  const entries = (await f.repo.snapshot()).trash;
  await f.repo.purgeTrash([entries[0].id]);
  assert.equal((await f.db.selectFrom("knowledge_resources").select("id").execute()).length, 1);
  await f.repo.purgeTrash([entries[1].id]);
  assert.equal((await f.db.selectFrom("knowledge_resources").select("id").execute()).length, 0);
});

test("a late worker result cannot recreate a permanently deleted resource", async t => {
  const f = await parsingFixture(t); await f.enqueue();
  const claimed = await f.repository.claim(f.worker.owner);
  await f.repo.remove(f.input.resourceID, f.target);
  await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  await f.worker.execute(claimed, new AbortController());
  assert.equal(f.submissions, 0);
  assert.equal((await f.repository.list()).length, 0);
});

test("failed file removal remains durable and retries without deleting shared artifacts or Zotero originals", async t => {
  const f = await parsingFixture(t); await completed(f);
  const original = "/isolated/storage/PDFKEY01/original.pdf"; f.files.set(original, new Uint8Array([1]));
  await f.repo.remove(f.input.resourceID, f.target); await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  const remove = IOUtils.remove; IOUtils.remove = async () => { throw Error("Disk unavailable"); };
  await api.cleanupFiles(f.db); assert.ok((await f.db.selectFrom("file_cleanup").selectAll().execute()).length);
  IOUtils.remove = remove; await api.cleanupFiles(f.db);
  assert.equal((await f.db.selectFrom("file_cleanup").selectAll().execute()).length, 0);
  assert.ok(f.files.has(original));
});

test("incoming literature references preserve the referenced resource and published content", async t => {
  const f = await parsingFixture(t); await completed(f);
  const other = await f.repo.save({ ...f.item, key: "ARTICLE2", itemID: 20, attachments: [] }, f.target);
  await f.db.insertInto("resource_references").values({ id: "reference", resource_id: other, target_resource_id: f.input.resourceID,
    reference_type: "citation", created_at: Date.now(), updated_at: Date.now() }).execute();
  await f.repo.remove(f.input.resourceID, f.target); await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  assert.equal((await f.db.selectFrom("content_generations").select("id").execute()).length, 1);
  assert.ok(await f.db.selectFrom("knowledge_resources").select("id").where("id", "=", f.input.resourceID).executeTakeFirst());
  await f.repo.remove(other, f.target); await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  assert.equal((await f.db.selectFrom("knowledge_resources").select("id").execute()).length, 0, "deleting the last referencing item also reclaims the previously retained content");
  assert.deepEqual(f.native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("shared stored artifacts survive one resource purge and are removed after the last owner", async t => {
  const f = await parsingFixture(t); await completed(f);
  const shared = await f.db.selectFrom("stored_files").select(["id", "relative_path"]).executeTakeFirstOrThrow();
  const item = { ...f.item, key: "ARTICLE2", itemID: 20, attachments: [{ ...f.item.attachments[0], key: "PDFKEY02", itemID: 21, parentKey: "ARTICLE2" }] };
  const resourceID = await f.repo.save(item, f.target), source = await f.repository.sourceFor(1, "PDFKEY02");
  const id = await f.repository.enqueue({ ...f.input, resourceID, sourceID: source.id, attachmentKey: "PDFKEY02" }, await f.port.hash((await f.port.attachment()).bytes), 3);
  await f.step(); await f.step();
  const run = await f.repository.run(await f.job(id));
  await f.db.insertInto("parse_artifacts").values({ id: "shared-artifact", parse_run_id: run.id, artifact_key: "shared", artifact_type: "raw", stored_file_id: shared.id, created_at: Date.now() }).execute();
  await f.repo.remove(f.input.resourceID, f.target); await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  await api.cleanupFiles(f.db);
  assert.ok(f.files.has(`/isolated/knowledgemcp/${shared.relative_path}`));
  assert.ok(await f.db.selectFrom("stored_files").select("id").where("id", "=", shared.id).executeTakeFirst());
  await f.repo.remove(resourceID, f.target); await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id)); await api.cleanupFiles(f.db);
  assert.equal(f.files.size, 0);
  assert.deepEqual(f.native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a replacement manual cache cancels failed cleanup of both cache and temporary file", async t => {
  const f = await parsingFixture(t), store = new api.ReaderContentStore(() => f.db);
  const content = { formatVersion: 1, attachment: { libraryID: 1, itemKey: "PDFKEY01" }, markdown: "# Old", origin: "import", updatedAt: 1 };
  await store.save(content);
  f.files.set("/isolated/knowledgemcp/reader-content/1-PDFKEY01.json.tmp", new Uint8Array([1]));
  await f.repo.remove(f.input.resourceID, f.target); await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  const remove = IOUtils.remove; IOUtils.remove = async () => { throw Error("Locked old cache"); };
  try { await api.cleanupFiles(f.db); } finally { IOUtils.remove = remove; }
  assert.equal((await f.db.selectFrom("file_cleanup").selectAll().execute()).length, 2);
  await f.repo.save(f.item, f.target);
  await store.save({ ...content, markdown: "# Replacement", updatedAt: 2 });
  await api.cleanupFiles(f.db);
  assert.equal((await store.read(content.attachment)).markdown, "# Replacement");
  assert.equal((await f.db.selectFrom("file_cleanup").selectAll().execute()).length, 0);
  await store.close();
});

test("a cleanup snapshot taken before cache replacement cannot delete the new cache", async t => {
  const f = await parsingFixture(t), store = new api.ReaderContentStore(() => f.db);
  const relative = "reader-content/1-PDFKEY01.json";
  await f.db.insertInto("file_cleanup").values({ relative_path: relative, created_at: 1 }).execute();
  const select = f.db.selectFrom.bind(f.db);
  let snapshotReady, release;
  const captured = new Promise(resolve => { snapshotReady = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let intercept = true;
  f.db.selectFrom = table => {
    const query = select(table);
    if (table !== "file_cleanup" || !intercept) return query;
    intercept = false;
    const originalSelect = query.select.bind(query);
    query.select = columns => {
      const selected = originalSelect(columns), execute = selected.execute.bind(selected);
      selected.execute = async () => { const rows = await execute(); snapshotReady(); await gate; return rows; };
      return selected;
    };
    return query;
  };
  const cleaning = api.cleanupFiles(f.db);
  try {
    await captured;
    await store.save({ formatVersion: 1, attachment: { libraryID: 1, itemKey: "PDFKEY01" }, markdown: "# New cache", origin: "import", updatedAt: 2 });
  } finally { release(); }
  await cleaning; f.db.selectFrom = select;
  assert.equal((await store.read({ libraryID: 1, itemKey: "PDFKEY01" })).markdown, "# New cache");
});

test("failed cleanup finalization preserves the completed replacement for restart recovery", async t => {
  const f = await parsingFixture(t), store = new api.ReaderContentStore(() => f.db);
  const content = { formatVersion: 1, attachment: { libraryID: 1, itemKey: "PDFKEY01" }, markdown: "# Old", origin: "import", updatedAt: 1 };
  await store.save(content);
  await f.db.insertInto("file_cleanup").values({ relative_path: "reader-content/1-PDFKEY01.json", created_at: 1 }).execute();
  f.native.options.fail = sql => /^delete from "file_cleanup"/i.test(sql);
  try { await assert.rejects(store.save({ ...content, markdown: "# Rejected" })); }
  finally { f.native.options.fail = undefined; }
  assert.equal((await store.read(content.attachment)).markdown, "# Rejected");
  assert.equal((await f.db.selectFrom("file_cleanup").selectAll().execute()).length, 1);
  await api.cleanupFiles(f.db);
  assert.equal((await store.read(content.attachment)).markdown, "# Rejected");
  assert.equal((await f.db.selectFrom("file_cleanup").selectAll().execute()).length, 0);
});

for (const method of ["makeDirectory", "writeUTF8"]) test(`${method} failure keeps old cleanup durable and the old cache unreadable`, async t => {
  const f = await parsingFixture(t), store = new api.ReaderContentStore(() => f.db);
  const content = { formatVersion: 1, attachment: { libraryID: 1, itemKey: "PDFKEY01" }, markdown: "# Deleted", origin: "import", updatedAt: 1 };
  await store.save(content);
  await f.repo.remove(f.input.resourceID, f.target); await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  await f.repo.save(f.item, f.target);
  const original = IOUtils[method]; IOUtils[method] = async () => { throw Error("Storage unavailable"); };
  try { await assert.rejects(store.save({ ...content, markdown: "# Replacement", updatedAt: 2 })); }
  finally { IOUtils[method] = original; }
  assert.equal(await store.read(content.attachment), null);
  assert.ok((await f.db.selectFrom("file_cleanup").selectAll().execute()).length);
  await api.cleanupFiles(f.db);
  assert.equal(await store.read(content.attachment), null);
  assert.equal(f.files.size, 0);
  assert.equal((await f.db.selectFrom("plugin_state").select("key").where("key", "like", "reader-cache-replacement:%").execute()).length, 0);
});

test("failure to journal replacement intent prevents any new cache write", async t => {
  const f = await parsingFixture(t), store = new api.ReaderContentStore(() => f.db);
  const content = { formatVersion: 1, attachment: { libraryID: 1, itemKey: "PDFKEY01" }, markdown: "# Deleted", origin: "import", updatedAt: 1 };
  await store.save(content);
  await f.db.insertInto("file_cleanup").values({ relative_path: "reader-content/1-PDFKEY01.json", created_at: 1 }).execute();
  f.native.options.fail = statement => /^insert into "plugin_state"/i.test(statement);
  try { await assert.rejects(store.save({ ...content, markdown: "# Rejected" })); }
  finally { f.native.options.fail = undefined; }
  assert.equal(JSON.parse(new TextDecoder().decode(f.files.get("/isolated/knowledgemcp/reader-content/1-PDFKEY01.json"))).markdown, "# Deleted");
  await api.cleanupFiles(f.db); assert.equal(f.files.size, 0);
});

test("a later permanent deletion invalidates an in-flight replacement token", async t => {
  const f = await parsingFixture(t), store = new api.ReaderContentStore(() => f.db);
  const content = { formatVersion: 1, attachment: { libraryID: 1, itemKey: "PDFKEY01" }, markdown: "# Old", origin: "import", updatedAt: 1 };
  await store.save(content);
  await f.repo.remove(f.input.resourceID, f.target); await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  const resource = await f.repo.save(f.item, f.target), write = IOUtils.writeUTF8;
  IOUtils.writeUTF8 = async (...args) => {
    await f.repo.remove(resource, f.target); await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
    return write(...args);
  };
  try { await store.save({ ...content, markdown: "# Also deleted", updatedAt: 2 }); }
  finally { IOUtils.writeUTF8 = write; }
  assert.equal(await store.read(content.attachment), null);
  await api.cleanupFiles(f.db); assert.equal(f.files.size, 0);
});

test("interrupted atomic writes reclaim their temporary file and retain the old deletion intent", async t => {
  const f = await parsingFixture(t), store = new api.ReaderContentStore(() => f.db);
  const content = { formatVersion: 1, attachment: { libraryID: 1, itemKey: "PDFKEY01" }, markdown: "# Old", origin: "import", updatedAt: 1 };
  await store.save(content);
  await f.repo.remove(f.input.resourceID, f.target); await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  const write = IOUtils.writeUTF8;
  IOUtils.writeUTF8 = async (_path, value, options) => { f.files.set(options.tmpPath, new TextEncoder().encode(value)); throw Error("Interrupted before rename"); };
  try { await assert.rejects(store.save({ ...content, markdown: "# Interrupted", updatedAt: 2 })); }
  finally { IOUtils.writeUTF8 = write; }
  assert.ok([...f.files.keys()].some(path => path.endsWith(".tmp")));
  await api.cleanupFiles(f.db); assert.equal(f.files.size, 0);
});

test("accepted cache saves preserve their original snapshot while waiting for the path lock", async t => {
  const f = await parsingFixture(t), store = new api.ReaderContentStore(() => f.db);
  const content = { formatVersion: 1, attachment: { libraryID: 1, itemKey: "PDFKEY01" }, markdown: "# Accepted", origin: "import", updatedAt: 1 };
  const saving = store.save(content); content.markdown = "# Mutated"; content.attachment.itemKey = "OTHER001";
  await saving;
  assert.equal((await store.read({ libraryID: 1, itemKey: "PDFKEY01" })).markdown, "# Accepted");
  assert.equal(await store.read({ libraryID: 1, itemKey: "OTHER001" }), null);
});

test("cache replacement waits for an already running cleanup removal", async t => {
  const f = await parsingFixture(t), store = new api.ReaderContentStore(() => f.db), relative = "reader-content/1-PDFKEY01.json";
  f.files.set(`/isolated/knowledgemcp/${relative}`, new Uint8Array([1]));
  await f.db.insertInto("file_cleanup").values({ relative_path: relative, created_at: 1 }).execute();
  const remove = IOUtils.remove; let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  IOUtils.remove = async path => { entered(); await gate; await remove(path); };
  const cleaning = api.cleanupFiles(f.db); await started;
  let saved = false;
  const saving = store.save({ formatVersion: 1, attachment: { libraryID: 1, itemKey: "PDFKEY01" }, markdown: "# Survives", origin: "import", updatedAt: 2 }).then(() => { saved = true; });
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(saved, false); }
  finally { release(); }
  await Promise.all([cleaning, saving]); IOUtils.remove = remove;
  assert.equal((await store.read({ libraryID: 1, itemKey: "PDFKEY01" })).markdown, "# Survives");
});

test("permanently deleting the last library stays empty after repeated initialization", async t => {
  const f = await parsingFixture(t);
  await f.repo.deleteLibrary(f.target.libraryID, true);
  await f.repo.purgeTrash((await f.repo.snapshot()).trash.map(row => row.id));
  assert.equal((await f.db.selectFrom("knowledge_libraries").selectAll().execute()).length, 0);
  for (let restart = 0; restart < 2; restart++) {
    const repository = new api.KnowledgeLibraryRepository(f.db, f.port); await repository.initialize();
    assert.equal((await repository.snapshot()).libraries.length, 0);
  }
  assert.deepEqual(f.native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});
