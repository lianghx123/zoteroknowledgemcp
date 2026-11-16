import { mockLocalization } from "./helpers/localization.mjs";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join, dirname, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { MockNativeDatabase } from "./helpers/native-database.mjs";

// Compile real modules for focused integration tests without changing the shipped bundle API.
globalThis.Localization = mockLocalization();
const scratchRoot = resolve(".scaffold");
const scratch = mkdtempSync(join(scratchRoot, "knowledge-tests-"));
function compile(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const source = join(folder, entry.name);
    if (entry.isDirectory()) { compile(source); continue; }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
    const output = ts.transpileModule(readFileSync(source, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
      .replace(/import (\w+) from ["']([^"']+\.css)["'];/g, (_match, name, path) => `const ${name} = ${JSON.stringify(readFileSync(resolve(dirname(source), path), "utf8"))};`)
      .replace(/from (["'])(\.[^"']+)\1/g, (_match, quote, specifier) => `from ${quote}${specifier.endsWith(".css") ? specifier : `${specifier}.js`}${quote}`);
    const destination = join(scratch, relative(resolve("src"), source).replace(/\.ts$/, ".js"));
    mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, output);
  }
}
compile(resolve("src"));
after(() => {
  assert.ok(resolve(scratch).startsWith(`${scratchRoot}${sep}`));
  rmSync(scratch, { recursive: true, force: true });
});
const load = name => import(pathToFileURL(join(scratch, name)).href);
const { initializeDatabase } = await load("database/client.js");
const { KnowledgeLibraryService } = await load("services/knowledge-library.js");
const { adaptMethod } = await load("core/method-adapter.js");
const { renderKnowledgeDetails } = await load("ui/knowledge/details.js");
const { KnowledgeDragDrop } = await load("ui/knowledge/drag-drop.js");
const { KnowledgeLibraryTree } = await load("ui/knowledge/library-tree.js");
const { KnowledgeLibraryUI } = await load("ui/knowledge/register.js");
const { KnowledgeTrashList } = await load("ui/knowledge/trash-list.js");
const { KnowledgeUserError, knowledgeErrorMessage } = await load("shared/knowledge-errors.js");
const { searchKnowledgeScope } = await load("ui/knowledge/search-scope.js");
const hash = text => Promise.resolve(createHash("sha256").update(text).digest("hex"));

async function fixture(options = {}) {
  let observer;
  globalThis.Zotero = { isWin: false, debug() {}, DBConnection: class extends MockNativeDatabase { constructor() { super(); } }, Items: { get: () => false }, Notifier: {
    registerObserver(value, types) { assert.ok(types.every(type => ["item", "item-tag", "tag", "group"].includes(type))); observer = value; return "observer"; }, unregisterObserver() { observer = undefined; }
  } };
  const nativeDB = new MockNativeDatabase(":memory:", { maxParameters: 999, ...options });
  const database = await initializeDatabase(nativeDB, `/isolated/${randomUUID()}.sqlite`);
  const inputs = new Map();
  let captures = 0;
  let unavailable = false;
  const port = {
    uuid: randomUUID, hash,
    async capture(id) {
      captures++;
      const input = structuredClone(inputs.get(id));
      if (!input) throw new Error("No fixture");
      input.metadataFingerprint = await hash(JSON.stringify({ title: input.title, fields: input.fields, tags: input.tags, abstract: input.abstract, contributors: input.contributors }));
      input.fingerprint = await hash(JSON.stringify({ metadataFingerprint: input.metadataFingerprint, state: input.state, attachments: input.attachments }));
      return input;
    },
    async lookup(libraryID, key) {
      if (unavailable) return null;
      const input = [...inputs.values()].find(input => input.library.localID === libraryID && input.key === key);
      return input ? { id: input.itemID } : false;
    }
  };
  const service = new KnowledgeLibraryService(database.db, port);
  await service.start();
  const target = { libraryID: service.snapshot.libraries[0].id, nodeID: null };
  const input = {
    library: { localID: 1, type: "user", externalID: "123", name: "My Library", editable: true, filesEditable: true },
    itemID: 10, key: "ARTICLE1", kind: "regular", nativeVersion: 3, modified: "2026-10-20 01:00:00", state: "current",
    title: "A synthetic paper", itemType: "journalArticle", language: "en", abstract: "Original abstract", publicationDate: "Spring 2026",
    contributors: [{ role: "author", firstName: "Ada", lastName: "Example", fieldMode: 0 }],
    fields: { DOI: "https://doi.org/10.1234/EXAMPLE", publicationTitle: "Synthetic Journal", volume: "S1", issue: "3–4", Extra: "Original extra" },
    tags: [{ tag: "methods", type: 0 }],
    attachments: [{ key: "PDFKEY01", itemID: 11, parentKey: "ARTICLE1", title: "Main PDF", mediaType: "application/pdf", linkMode: 0, state: "current" }]
  };
  inputs.set(10, input);
  return { database, db: database.db, service, input, inputs, target, nativeDB, port,
    get observer() { return observer; }, get captures() { return captures; }, set unavailable(value) { unavailable = value; },
    async close() { await service.close(); await database.close(); } };
}

test("admission persists approved metadata, identities and provenance without starting processing", async () => {
  const f = await fixture();
  try {
    const [result] = await f.service.add([10], f.target);
    assert.equal(result.error, undefined);
    const resource = await f.db.selectFrom("knowledge_resources").selectAll().executeTakeFirstOrThrow();
    assert.equal(resource.title, f.input.title);
    assert.equal(resource.publication_date, "Spring 2026");
    assert.equal(resource.publication_title, "Synthetic Journal");
    assert.equal(resource.volume, "S1"); assert.equal(resource.issue, "3–4");
    assert.equal(resource.doi, f.input.fields.DOI); assert.equal(resource.metadata_schema_version, 2);
    assert.deepEqual(JSON.parse(resource.metadata_json).fields, { Extra: "Original extra" });
    assert.equal(resource.metadata_authority, "zotero");
    assert.equal(resource.canonical_source_id, null);
    assert.deepEqual(JSON.parse(resource.metadata_json).tags, f.input.tags);
    assert.deepEqual(JSON.parse(resource.contributors_json), f.input.contributors);
    assert.equal((await f.db.selectFrom("resource_identifiers").selectAll().executeTakeFirstOrThrow()).normalized_value, "10.1234/example");
    const links = await f.db.selectFrom("zotero_item_links").selectAll().execute();
    assert.equal(links.length, 2);
    assert.ok(links.every(link => link.cached_file_path === null));
    assert.equal((await f.db.selectFrom("resource_sources").selectAll().executeTakeFirstOrThrow()).availability, "pending");
    for (const table of ["processing_jobs", "content_generations", "stored_files", "block_embeddings", "search_documents", "mcp_tokens"]) {
      assert.equal((await f.db.selectFrom(table).selectAll().execute()).length, 0, table);
    }
    assert.equal((await f.db.selectFrom("resource_revisions").selectAll().execute()).length, 1);
    assert.equal((await f.db.selectFrom("membership_origins").selectAll().execute()).length, 1);
    assert.equal(f.service.snapshot.itemResources.get(11), result.resourceID);
  } finally { await f.close(); }
});

test("unchanged metadata reconciliation preserves the snapshot and emits no UI update", async () => {
  const f = await fixture();
  try {
    await f.service.add([10], f.target); let updates = 0;
    f.service.subscribe(() => { updates++; }); const snapshot = f.service.snapshot;
    await f.service.refresh(); await f.service.refresh();
    assert.equal(updates, 0); assert.equal(f.service.snapshot, snapshot);
    f.input.title = "Changed paper title"; await f.service.refresh();
    assert.equal(updates, 1); assert.equal(f.service.snapshot.resources[0].title, "Changed paper title");
    await f.service.refresh(); assert.equal(updates, 1);
  } finally { await f.close(); }
});

test("navigation-only task badge refresh does not reload selected knowledge literature", async () => {
  const f = await treeFixture();
  try {
    await f.libraryTree.select("Kknowledgemcp:overview"); let reloads = 0;
    f.pane.itemsView.refreshAndMaintainSelection = async () => { reloads++; };
    await f.libraryTree.refresh(false); assert.equal(reloads, 0);
    await f.libraryTree.refresh(); assert.equal(reloads, 1, "content changes retain the full refresh path");
  } finally { await f.close(); }
});

test("concurrent repeat admission preserves resource/source IDs and avoids duplicate membership or versions", async () => {
  const f = await fixture();
  try {
    await Promise.all([f.service.add([10, 10], f.target), f.service.add([10], f.target)]);
    const resources = await f.db.selectFrom("knowledge_resources").selectAll().execute();
    assert.equal(resources.length, 1); assert.equal(resources[0].version, 1); assert.equal(resources[0].metadata_version, 1);
    for (const table of ["library_resources", "membership_origins", "resource_sources", "resource_revisions"]) assert.equal((await f.db.selectFrom(table).selectAll().execute()).length, 1, table);
  } finally { await f.close(); }
});

test("metadata reconciliation updates source fields, clears removed values and preserves plugin fields and placements", async () => {
  const f = await fixture();
  try {
    const [{ resourceID }] = await f.service.add([10], f.target);
    await f.db.updateTable("knowledge_resources").set({ summary: "Human summary", metadata_json: JSON.stringify({ fields: f.input.fields, tags: f.input.tags, local: { reviewed: true } }) }).where("id", "=", resourceID).execute();
    f.input.title = "Updated native title"; f.input.fields = { publicationTitle: "New journal" }; f.input.tags = []; f.input.abstract = null;
    await f.service.refresh();
    const resource = await f.db.selectFrom("knowledge_resources").selectAll().where("id", "=", resourceID).executeTakeFirstOrThrow();
    assert.equal(resource.title, "Updated native title"); assert.equal(resource.abstract, null);
    assert.equal(resource.publication_title, "New journal");
    assert.equal(resource.volume, null); assert.equal(resource.issue, null); assert.equal(resource.doi, null);
    assert.deepEqual(JSON.parse(resource.metadata_json).fields, {});
    assert.equal(resource.summary, "Human summary"); assert.deepEqual(JSON.parse(resource.metadata_json).local, { reviewed: true });
    assert.deepEqual(JSON.parse(resource.metadata_json).tags, []);
    assert.equal(resource.version, 2); assert.equal(resource.metadata_version, 2);
    assert.equal((await f.db.selectFrom("resource_identifiers").selectAll().execute()).length, 0);
    assert.equal(f.service.snapshot.memberships.length, 1);
    await f.service.refresh();
    assert.equal((await f.db.selectFrom("knowledge_resources").select("version").executeTakeFirstOrThrow()).version, 2);
  } finally { await f.close(); }
});

test("folder removal preserves another folder, another library and stable re-admission identity", async () => {
  const f = await fixture();
  try {
    await f.service.createFolder("Methods", f.target);
    const folder = { libraryID: f.target.libraryID, nodeID: f.service.snapshot.folders[0].id };
    const [{ resourceID }] = await f.service.add([10], folder);
    await f.service.add([10], f.target);
    await f.service.createLibrary("Project B");
    const second = { libraryID: f.service.snapshot.libraries.find(row => row.name === "Project B").id, nodeID: null };
    await f.service.add([10], second);
    await f.service.remove([10], folder);
    assert.equal(f.service.snapshot.memberships.length, 2);
    await f.service.remove([10], f.target);
    assert.equal(f.service.snapshot.memberships.length, 1);
    assert.equal(f.service.snapshot.memberships[0].libraryID, second.libraryID);
    await f.service.add([10], folder);
    assert.equal(f.service.snapshot.resources[0].id, resourceID);
    assert.equal((await f.db.selectFrom("knowledge_resources").selectAll().execute()).length, 1);
    assert.equal((await f.db.selectFrom("library_items").selectAll().execute()).length, 1);
  } finally { await f.close(); }
});

test("an invalid cross-library folder is rejected before any partial admission", async () => {
  const f = await fixture();
  try {
    await f.service.createFolder("Methods", f.target);
    const folder = f.service.snapshot.folders[0];
    await f.service.createLibrary("Other");
    const libraryID = f.service.snapshot.libraries.find(row => row.name === "Other").id;
    const [result] = await f.service.add([10], { libraryID, nodeID: folder.id });
    assert.match(result.error, /target folder/);
    assert.equal((await f.db.selectFrom("knowledge_resources").selectAll().execute()).length, 0);
    assert.equal((await f.db.selectFrom("zotero_item_links").selectAll().execute()).length, 0);
  } finally { await f.close(); }
});

test("snapshot joins preserve root and unavailable placement semantics and hide inactive library folders", async () => {
  const f = await fixture();
  try {
    const folder = { ...f.target, nodeID: await f.service.createFolder("Methods", f.target) };
    const other = { libraryID: await f.service.createLibrary("Inactive"), nodeID: null };
    await f.service.createFolder("Hidden", other);
    const [{ resourceID }] = await f.service.add([10], f.target);
    await f.service.add([10], folder);
    await f.db.updateTable("knowledge_libraries").set({ status: "archived" }).where("id", "=", other.libraryID).execute();
    // An unavailable placement remains a root fallback in the snapshot.
    await f.db.updateTable("library_items").set({ deleted_at: 1 }).where("node_id", "=", folder.nodeID).execute();
    const start = f.nativeDB.queries.length;
    await f.service.refresh();
    assert.deepEqual(f.service.snapshot.folders.map(row => row.id), [folder.nodeID]);
    assert.deepEqual(f.service.snapshot.memberships, [
      { resourceID, libraryID: f.target.libraryID, nodeID: null },
      { resourceID, libraryID: f.target.libraryID, nodeID: null }
    ]);
    assert.equal(f.nativeDB.queries.slice(start).filter(query => /^select .* from "library_items"/.test(query)).length, 0,
      "snapshot resolves placements in the membership query without a second full-table read");
  } finally { await f.close(); }
});

test("a failed receipt write rolls back metadata, sources and memberships atomically", async () => {
  let fail = false;
  const f = await fixture({ fail: sql => fail && /^insert into "mutation_receipts"/.test(sql) });
  try {
    fail = true;
    const [result] = await f.service.add([10], f.target);
    assert.match(result.error, /could not be completed/);
    assert.doesNotMatch(result.error, /Injected|QUERY|PARAMS|insert into/i);
    for (const table of ["knowledge_resources", "zotero_item_links", "resource_sources", "library_resources", "membership_origins", "resource_revisions", "change_outbox"]) {
      assert.equal((await f.db.selectFrom(table).selectAll().execute()).length, 0, table);
    }
    fail = false;
    assert.equal((await f.service.add([10], f.target))[0].error, undefined);
  } finally { await f.close(); }
});

test("standalone attachments have one source anchor and trash/restore retain the resource identity", async () => {
  const f = await fixture();
  try {
    f.input.kind = "attachment"; f.input.attachments = [{ ...f.input.attachments[0], key: f.input.key, itemID: 10, parentKey: null }];
    const [{ resourceID }] = await f.service.add([10], f.target);
    const links = await f.db.selectFrom("zotero_item_links").selectAll().execute();
    assert.equal(links.length, 1); assert.equal(links[0].is_anchor, 1); assert.ok(links[0].source_id);
    f.input.state = "trashed"; f.input.attachments[0].state = "trashed";
    await f.service.refresh(); assert.equal(f.service.snapshot.resources[0].state, "trashed");
    f.input.state = "current"; f.input.attachments[0].state = "current";
    await f.service.refresh(); assert.equal(f.service.snapshot.resources[0].id, resourceID); assert.equal(f.service.snapshot.resources[0].state, "current");
    f.unavailable = true; await f.service.refresh(); assert.equal(f.service.snapshot.resources[0].state, "unavailable");
    f.unavailable = false; await f.service.refresh(); assert.equal(f.service.snapshot.resources[0].state, "current");
  } finally { await f.close(); }
});

test("native notifications coalesce and never admit unrelated items", async () => {
  const f = await fixture();
  try {
    await f.service.add([10], f.target);
    const captures = f.captures;
    f.input.title = "Notified title";
    f.observer.notify("modify", "item", [10]); f.observer.notify("modify", "item", [10]); f.observer.notify("add", "item-tag", ["10-25"]);
    for (let i = 0; i < 100 && f.service.snapshot.resources[0].title !== "Notified title"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.service.snapshot.resources[0].title, "Notified title"); assert.equal(f.captures, captures + 1);
    const queries = f.nativeDB.queries.length;
    const snapshot = f.service.snapshot;
    let publications = 0;
    const unsubscribe = f.service.subscribe(() => { publications++; });
    f.observer.notify("add", "item", [999]);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.captures, captures + 1); assert.equal(f.service.snapshot.resources.length, 1);
    assert.equal(f.nativeDB.queries.length, queries, "unrelated notifications do not read the knowledge database");
    assert.equal(f.service.snapshot, snapshot);
    assert.equal(publications, 0, "unrelated notifications do not rebuild knowledge UI");
    unsubscribe();
  } finally { await f.close(); }
});

test("attachment notifications reconcile their admitted parent once and refresh sources", async () => {
  const f = await fixture();
  try {
    await f.service.add([10], f.target);
    const captures = f.captures;
    f.input.attachments[0].title = "Renamed source";
    f.observer.notify("modify", "item", [11, 10, 11]);
    for (let i = 0; i < 100 && f.service.snapshot.sources[0].title !== "Renamed source"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.service.snapshot.sources[0].title, "Renamed source");
    assert.equal(f.captures, captures + 1);
  } finally { await f.close(); }
});

test("shutdown drains admitted operations and rejects new work", async () => {
  const f = await fixture();
  try {
    const admitted = f.service.add([10], f.target);
    const close = f.service.close();
    await assert.rejects(() => f.service.add([10], f.target), /shutting down/);
    await Promise.all([admitted, close]);
    assert.equal((await f.db.selectFrom("knowledge_resources").selectAll().execute()).length, 1);
    assert.equal(f.observer, undefined);
  } finally { await f.close(); }
});

test("failed metadata refresh preserves the last saved projection and recovers without losing membership", async () => {
  let fail = false;
  const f = await fixture({ fail: sql => fail && /^insert into "mutation_receipts"/.test(sql) });
  try {
    const [{ resourceID }] = await f.service.add([10], f.target);
    f.input.title = "Changed while storage was unavailable";
    fail = true;
    await f.service.refresh();
    assert.equal(f.service.snapshot.resources[0].title, "A synthetic paper");
    assert.equal(f.service.snapshot.resources[0].state, "current");
    assert.match(f.service.snapshot.warnings.get(resourceID), /could not be refreshed/);
    assert.equal(f.service.snapshot.memberships.length, 1);
    assert.equal((await f.db.selectFrom("resource_revisions").selectAll().execute()).length, 1);
    fail = false;
    await f.service.refresh();
    assert.equal(f.service.snapshot.resources[0].title, f.input.title);
    assert.equal(f.service.snapshot.resources[0].version, 2);
    assert.equal(f.service.snapshot.warnings.has(resourceID), false);
    const receipts = (await f.db.selectFrom("mutation_receipts").selectAll().execute()).length;
    await f.service.refresh();
    assert.equal((await f.db.selectFrom("mutation_receipts").selectAll().execute()).length, receipts);
  } finally { await f.close(); }
});

test("changed native library identity becomes unavailable without overwriting saved metadata", async () => {
  const f = await fixture();
  try {
    const [{ resourceID }] = await f.service.add([10], f.target);
    f.input.library.externalID = "different-account";
    f.input.title = "Untrusted replacement";
    await f.service.refresh();
    assert.equal(f.service.snapshot.resources[0].title, "A synthetic paper");
    assert.equal(f.service.snapshot.resources[0].state, "unavailable");
    assert.match(f.service.snapshot.warnings.get(resourceID), /identity changed/);
    f.input.library.externalID = "123";
    await f.service.refresh();
    assert.equal(f.service.snapshot.resources[0].state, "current");
    assert.equal(f.service.snapshot.warnings.has(resourceID), false);
  } finally { await f.close(); }
});

test("folder creation advances the library version used in its outbox event", async () => {
  const f = await fixture();
  try {
    await f.service.createFolder("Methods", f.target);
    await f.service.createFolder("Results", f.target);
    const library = await f.db.selectFrom("knowledge_libraries").selectAll().where("id", "=", f.target.libraryID).executeTakeFirstOrThrow();
    assert.equal(library.version, 3);
    const events = await f.db.selectFrom("change_outbox").select("aggregate_version").where("aggregate_id", "=", library.id).orderBy("aggregate_version").execute();
    assert.deepEqual(events.map(row => row.aggregate_version), [2, 3]);
  } finally { await f.close(); }
});

test("native identifier refresh preserves an existing plugin-owned primary identifier", async () => {
  const f = await fixture();
  try {
    const [{ resourceID }] = await f.service.add([10], f.target);
    await f.db.deleteFrom("resource_identifiers").where("resource_id", "=", resourceID).execute();
    await f.db.insertInto("resource_identifiers").values({ id: randomUUID(), resource_id: resourceID, identifier_type: "doi", identifier_value: "10.1234/manual",
      normalized_value: "10.1234/manual", is_primary: 1, metadata_json: '{"authority":"user"}', created_at: Date.now() }).execute();
    f.input.title = "Refresh identifiers";
    await f.service.refresh();
    const identifiers = await f.db.selectFrom("resource_identifiers").selectAll().where("resource_id", "=", resourceID).execute();
    assert.equal(identifiers.length, 2);
    assert.equal(identifiers.find(row => row.normalized_value === "10.1234/manual").is_primary, 1);
    assert.equal(identifiers.find(row => row.normalized_value === "10.1234/example").is_primary, 0);
    assert.equal(f.service.snapshot.warnings.size, 0);
  } finally { await f.close(); }
});

test("disposing a native method adapter preserves a later plugin wrapper and releases its own handler", () => {
  let ownCalls = 0;
  const target = { value(x) { return x + 1; } };
  const dispose = adaptMethod(target, "value", (receiver, native, args) => { ownCalls++; return Reflect.apply(native, receiver, args) + 10; });
  const saved = target.value;
  const later = function (x) { return saved.call(this, x) * 2; };
  target.value = later;
  assert.equal(target.value(1), 24);
  dispose();
  assert.equal(target.value, later); assert.equal(target.value(1), 4); assert.equal(ownCalls, 1);
});

test("deleting a library without deleting data retains resource metadata and removes its entire folder tree", async () => {
  const f = await fixture();
  try {
    await f.service.createFolder("Parent", f.target);
    const parent = { libraryID: f.target.libraryID, nodeID: f.service.snapshot.folders[0].id };
    await f.service.createFolder("Child", parent);
    const child = { libraryID: f.target.libraryID, nodeID: f.service.snapshot.folders.find(row => row.name === "Child").id };
    const [{ resourceID }] = await f.service.add([10], child);
    await f.service.deleteLibrary(f.target.libraryID, false);
    assert.equal(f.service.snapshot.libraries.length, 0);
    assert.equal(f.service.snapshot.folders.length, 0);
    assert.equal(f.service.snapshot.resources.length, 0);
    const resource = await f.db.selectFrom("knowledge_resources").selectAll().where("id", "=", resourceID).executeTakeFirstOrThrow();
    assert.equal(resource.status, "active"); assert.equal(resource.title, f.input.title);
    for (const table of ["library_nodes", "library_items", "library_resources", "membership_origins"]) {
      assert.ok((await f.db.selectFrom(table).selectAll().execute()).every(row => row.deleted_at !== null), table);
    }
    assert.equal((await f.db.selectFrom("zotero_item_links").selectAll().execute()).length, 2);
  } finally { await f.close(); }
});

test("optional data deletion removes only exclusive resources and readmission recovers their stable identity", async () => {
  const f = await fixture();
  try {
    const [{ resourceID: sharedID }] = await f.service.add([10], f.target);
    f.inputs.set(20, { ...structuredClone(f.input), itemID: 20, key: "EXCLUSIVE", attachments: [] });
    const [{ resourceID: exclusiveID }] = await f.service.add([20], f.target);
    await f.service.createLibrary("Second library");
    const second = { libraryID: f.service.snapshot.libraries.find(row => row.name === "Second library").id, nodeID: null };
    await f.service.add([10], second);
    await f.service.deleteLibrary(f.target.libraryID, true);
    assert.equal(f.service.snapshot.libraries[0].id, second.libraryID);
    assert.equal(f.service.snapshot.libraries[0].isDefault, true);
    assert.deepEqual(f.service.snapshot.resources.map(row => row.id), [sharedID]);
    assert.equal((await f.db.selectFrom("knowledge_resources").select("status").where("id", "=", sharedID).executeTakeFirstOrThrow()).status, "active");
    assert.equal((await f.db.selectFrom("knowledge_resources").select("status").where("id", "=", exclusiveID).executeTakeFirstOrThrow()).status, "deleted");
    await f.service.add([20], second);
    assert.ok(f.service.snapshot.resources.some(row => row.id === exclusiveID));
    assert.equal((await f.db.selectFrom("knowledge_resources").selectAll().execute()).length, 2);
    assert.equal((await f.db.selectFrom("knowledge_resources").select("deleted_at").where("id", "=", exclusiveID).executeTakeFirstOrThrow()).deleted_at, null);
  } finally { await f.close(); }
});

test("deleting the last library remains empty after restart and the next created library becomes default", async () => {
  const f = await fixture();
  let restarted;
  try {
    await f.service.deleteLibrary(f.target.libraryID, false);
    await f.service.close();
    restarted = new KnowledgeLibraryService(f.db, f.port);
    await restarted.start();
    assert.equal(restarted.snapshot.libraries.length, 0);
    await restarted.createLibrary("New default");
    assert.equal(restarted.snapshot.libraries.length, 1);
    assert.equal(restarted.snapshot.libraries[0].isDefault, true);
    await assert.rejects(() => restarted.deleteLibrary(f.target.libraryID, true), /already deleted/);
  } finally { await restarted?.close(); await f.close(); }
});

test("a failed library deletion rolls back resources, memberships and default selection", async () => {
  let fail = false;
  const f = await fixture({ fail: sql => fail && /^insert into "change_outbox"/.test(sql) });
  try {
    const [{ resourceID }] = await f.service.add([10], f.target);
    fail = true;
    await assert.rejects(() => f.service.deleteLibrary(f.target.libraryID, true), /Injected/);
    const library = await f.db.selectFrom("knowledge_libraries").selectAll().where("id", "=", f.target.libraryID).executeTakeFirstOrThrow();
    assert.equal(library.status, "active"); assert.equal(library.is_default, 1);
    assert.equal((await f.db.selectFrom("knowledge_resources").select("status").where("id", "=", resourceID).executeTakeFirstOrThrow()).status, "active");
    assert.equal((await f.db.selectFrom("membership_origins").select("deleted_at").executeTakeFirstOrThrow()).deleted_at, null);
  } finally { await f.close(); }
});

test("knowledge details render labeled fields, nested locations and untrusted attachment titles as text", async () => {
  const f = await fixture();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  try {
    await f.service.createFolder("Parent", f.target);
    const parent = { libraryID: f.target.libraryID, nodeID: f.service.snapshot.folders[0].id };
    await f.service.createFolder("Child", parent);
    const child = { libraryID: f.target.libraryID, nodeID: f.service.snapshot.folders.find(row => row.name === "Child").id };
    f.input.attachments[0].title = '<img src="https://example.invalid/private" onerror="alert(1)">';
    const [{ resourceID }] = await f.service.add([10], child);
    const { content } = renderKnowledgeDetails(dom.window.document, f.service.snapshot, { id: 10, parentItemID: false });
    const values = new Map([...content.querySelectorAll("dt")].map(label => [label.textContent, label.nextElementSibling.textContent]));
    assert.equal(content.querySelectorAll("dt").length, content.querySelectorAll("dd").length);
    assert.equal(values.get("Status"), "Added — not processed");
    assert.match(values.get("Location"), /Parent › Child$/);
    assert.equal(values.get("Record version"), "1");
    assert.match(values.get("Attachments"), /<img/);
    assert.equal(content.querySelector("img, script, a"), null);
    assert.equal(values.get("Content"), "Not parsed");
    assert.equal(values.get("Search index"), "Not created");
    f.service.snapshot.warnings.set(resourceID, "Synthetic refresh error");
    assert.match(renderKnowledgeDetails(dom.window.document, f.service.snapshot, { id: 10 }).content.textContent, /Last saved metadata retained/);
  } finally { dom.window.close(); await f.close(); }
});

test("folder deletion removes its subtree and retains formerly folder-only items at the library root", async () => {
  const f = await fixture();
  try {
    await f.service.createFolder("Parent", f.target);
    const parent = { libraryID: f.target.libraryID, nodeID: f.service.snapshot.folders[0].id };
    await f.service.createFolder("Child", parent);
    const child = { libraryID: f.target.libraryID, nodeID: f.service.snapshot.folders.find(row => row.name === "Child").id };
    const [{ resourceID }] = await f.service.add([10], child);
    await f.service.deleteFolder(parent);
    assert.equal(f.service.snapshot.folders.length, 0);
    assert.deepEqual(f.service.snapshot.memberships, [{ resourceID, ...f.target }]);
    assert.equal(f.service.snapshot.resources[0].id, resourceID);
    assert.equal((await f.db.selectFrom("knowledge_resources").select("status").executeTakeFirstOrThrow()).status, "active");
    assert.ok((await f.db.selectFrom("library_items").selectAll().execute()).every(row => row.deleted_at !== null));
    await assert.rejects(() => f.service.deleteFolder(parent), /target folder/);
    await assert.rejects(() => f.service.deleteFolder(f.target), /Select a knowledge folder/);
  } finally { await f.close(); }
});

test("folder deletion preserves other placements and rolls back completely on event failure", async () => {
  let fail = false;
  const f = await fixture({ fail: sql => fail && /^insert into "change_outbox"/.test(sql) });
  try {
    await f.service.createFolder("First", f.target); await f.service.createFolder("Second", f.target);
    const first = { ...f.target, nodeID: f.service.snapshot.folders[0].id };
    const second = { ...f.target, nodeID: f.service.snapshot.folders[1].id };
    await f.service.add([10], first); await f.service.add([10], second);
    fail = true;
    await assert.rejects(() => f.service.deleteFolder(first), /Injected/);
    assert.equal((await f.db.selectFrom("library_nodes").selectAll().where("deleted_at", "is", null).execute()).length, 2);
    assert.equal((await f.db.selectFrom("membership_origins").selectAll().where("deleted_at", "is", null).execute()).length, 2);
    fail = false;
    await f.service.deleteFolder(first);
    assert.deepEqual(f.service.snapshot.memberships.map(row => row.nodeID), [second.nodeID]);
    assert.equal(f.service.snapshot.resources.length, 1);
  } finally { await f.close(); }
});

async function dragFixture() {
  const f = await fixture();
  f.inputs.set(20, { ...structuredClone(f.input), itemID: 20, key: "SECOND", attachments: [] });
  const nativeItems = new Map([10, 20].map(id => [id, { id, libraryID: 1, parentItemID: false, deleted: false, isRegularItem: () => true, isAttachment: () => false }]));
  nativeItems.set(11, { ...nativeItems.get(10), id: 11, parentItemID: 10 });
  globalThis.Zotero.Items.get = id => nativeItems.get(id) ?? false;
  globalThis.Zotero.Libraries = { get: () => ({ libraryType: "user" }) };
  const row = (id, kind, target) => ({ id, target, editable: true, isCollection: () => kind === "collection", isLibrary: () => kind === "library", isTrash: () => kind === "trash" });
  const nativeRow = row("C1", "collection");
  const knowledgeRow = row(`Kknowledgemcp:library:${f.target.libraryID}`, "knowledge", f.target);
  const nativeMembers = new Set();
  const state = { nativeDrops: 0, nativeChecks: 0, source: nativeRow, selectedRows: [knowledgeRow], nativeMembers, alerts: [] };
  const drag = globalThis.Zotero.DragDrop = { currentOrientation: 0, currentDropEffect: null, currentDragSource: nativeRow,
    getDragSource: () => state.source, getDataFromDataTransfer: transfer => ({ dataType: transfer.type, data: transfer.ids }) };
  const tree = { invalidate() {} };
  const view = { _rows: [nativeRow, knowledgeRow], tree, getRow: index => view._rows[index],
    getSelectedRows: () => state.selectedRows,
    onDragStart(_event, index) { state.source = view.getRow(index); drag.currentDragSource = state.source; },
    onDragEnd() {},
    canDropCheck(index, orientation, transfer) { state.nativeChecks++; return orientation === 0 && view.getRow(index)?.editable && transfer.ids.some(id => !nativeMembers.has(id)); },
    async canDropCheckAsync(index, orientation, transfer) { return view.canDropCheck(index, orientation, transfer); },
    onDragOver(event) { view.setDropEffect(event, "move"); },
    setDropEffect(event, effect) { event.dataTransfer.dropEffect = effect; drag.currentDropEffect = effect; },
    async onDrop(event) { state.nativeDrops++; assert.equal(drag.currentDropEffect, "copy"); for (const id of event.dataTransfer.ids) nativeMembers.add(id); drag.currentDropEffect = null; } };
  const items = { tree, collectionTreeRows: [knowledgeRow], canDropCheck: () => false, onDragOver(event) { view.setDropEffect(event, "move"); },
    setDropEffect: view.setDropEffect, async onDrop() { throw new Error("Knowledge drag must not invoke native reparenting"); } };
  const dom = new JSDOM("<html><body></body></html>");
  const window = { closed: false, document: dom.window.document, ZoteroPane: { collectionsView: view, itemsView: items }, alert: message => state.alerts.push(message) };
  const adapter = new KnowledgeDragDrop(window, f.service, row => row.target, async (ids, target) => {
    const results = await f.service.add(ids, target); assert.ok(results.every(result => !result.error));
  });
  const transfer = ids => {
    const payloads = new Map();
    return { ids, type: "zotero/item", dropEffect: "move", effectAllowed: "copyMove",
      get types() { return [...new Set([this.type, ...payloads.keys()])]; },
      setData(type, value) { payloads.set(type, value); },
      getData(type) { return payloads.get(type) ?? (type === this.type ? ids.join(",") : ""); } };
  };
  const event = dataTransfer => ({ dataTransfer, preventDefault() {}, stopPropagation() {} });
  return { ...f, state, drag, row, nativeRow, knowledgeRow, view, items, adapter, transfer, event, nativeItems,
    window, async close() { adapter.dispose(); dom.window.close(); await f.close(); } };
}

test("multi-item drag admits missing knowledge members only, refuses full duplicates and always copies", async () => {
  const f = await dragFixture();
  try {
    await f.service.add([10], f.target);
    const data = f.transfer([10, 10, 20]);
    assert.equal(f.view.canDropCheck(1, 0, data), true);
    assert.deepEqual(f.adapter.candidates(data, f.target), [20]);
    f.view.onDragOver(f.event(data), 1);
    assert.equal(data.dropEffect, "copy");
    await f.view.onDrop(f.event(data), 1);
    assert.equal(f.service.snapshot.resources.length, 2);
    assert.equal(f.view.canDropCheck(1, 0, data), false);
    assert.equal(await f.view.canDropCheckAsync(1, 0, data), false);
    assert.equal(f.view.canDropCheck(1, 1, data), false);
    assert.equal(f.state.nativeDrops, 0);
    assert.equal(f.service.snapshot.resources.find(row => row.itemID === 10).version, 1);
    assert.equal(f.state.alerts.length, 0);
  } finally { await f.close(); }
});

test("knowledge-to-knowledge drag adds a folder copy and preserves its source memberships", async () => {
  const f = await dragFixture();
  try {
    await f.service.add([10], f.target);
    await f.service.createFolder("Destination", f.target);
    const target = { ...f.target, nodeID: f.service.snapshot.folders[0].id };
    const destination = f.row(`Kknowledgemcp:folder:${target.nodeID}`, "knowledge", target);
    f.view._rows.push(destination); f.state.source = f.knowledgeRow;
    const data = f.transfer([10]);
    assert.equal(f.view.canDropCheck(2, 0, data), true);
    await f.view.onDrop(f.event(data), 2);
    assert.deepEqual(new Set(f.service.snapshot.memberships.map(row => row.nodeID)), new Set([null, target.nodeID]));
    assert.equal(f.view.canDropCheck(2, 0, data), false);
    assert.equal(f.state.nativeDrops, 0);
  } finally { await f.close(); }
});

test("knowledge-to-Zotero copy delegates native deduplication, rejects noncontainers and preserves knowledge", async () => {
  const f = await dragFixture();
  try {
    await f.service.add([10, 20], f.target);
    f.state.source = f.knowledgeRow; f.state.nativeMembers.add(10);
    const before = structuredClone(f.service.snapshot.memberships);
    const data = f.transfer([10, 20]);
    assert.equal(f.view.canDropCheck(0, 0, data), true);
    await f.view.onDrop(f.event(data), 0);
    assert.equal(f.state.nativeDrops, 1); assert.deepEqual([...f.state.nativeMembers], [10, 20]);
    assert.equal(f.view.canDropCheck(0, 0, data), false);
    await f.view.onDrop(f.event(data), 0); assert.equal(f.state.nativeDrops, 1);
    assert.deepEqual(f.service.snapshot.memberships, before);
    f.nativeRow.editable = false;
    assert.equal(f.view.canDropCheck(0, 0, f.transfer([99])), false);
    f.view._rows[0] = f.row("T1", "trash");
    assert.equal(f.view.canDropCheck(0, 0, data), false);
  } finally { await f.close(); }
});

test("item-pane drops use membership copies or native container copies and never reparent originals", async () => {
  const f = await dragFixture();
  try {
    const data = f.transfer([10, 20]);
    assert.equal(f.items.canDropCheck(-1, 1, data), true);
    await f.items.onDrop(f.event(data), -1);
    assert.equal(f.service.snapshot.resources.length, 2);
    f.state.source = f.knowledgeRow; f.items.collectionTreeRows = [f.nativeRow];
    assert.equal(f.items.canDropCheck(0, 0, data), true);
    await f.items.onDrop(f.event(data), 0);
    assert.equal(f.state.nativeDrops, 1);
    assert.equal(f.service.snapshot.memberships.length, 2);
  } finally { await f.close(); }
});

test("knowledge drops reject unsupported payloads, deleted/child items, and stale folder targets", async () => {
  const f = await dragFixture();
  try {
    const data = f.transfer([11, 999]);
    assert.equal(f.view.canDropCheck(1, 0, data), false);
    f.nativeItems.get(10).deleted = true;
    assert.equal(f.view.canDropCheck(1, 0, f.transfer([10])), false);
    const external = f.transfer([20]); external.type = "application/x-moz-file";
    assert.equal(f.view.canDropCheck(1, 0, external), false);
    const stale = f.row("Kknowledgemcp:folder:missing", "knowledge", { ...f.target, nodeID: "missing" });
    f.view._rows.push(stale);
    assert.equal(f.view.canDropCheck(2, 0, f.transfer([20])), false);
    f.state.source = f.row("T1", "trash");
    assert.equal(f.view.canDropCheck(1, 0, f.transfer([20])), false);
    f.adapter.dispose(); assert.equal(f.view.canDropCheck(1, 0, f.transfer([20])), true);
  } finally { await f.close(); }
});

test("disposing knowledge drag support cancels its pending hover expansion and preserves native expansion state", async () => {
  const f = await dragFixture();
  try {
    f.view.onDragOver(f.event(f.transfer([10])), 1);
    let expanded = false;
    f.view._expandRowOnHoverTimer = setTimeout(() => { expanded = true; }, 20);
    f.view._expandedRowsOnDrag = new Set(["C1", f.knowledgeRow.id]);
    f.adapter.dispose();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(expanded, false);
    assert.deepEqual([...f.view._expandedRowsOnDrag], ["C1"]);
  } finally { await f.close(); }
});

test("dragging knowledge items onto Trash removes all source-library placements and preserves other libraries", async () => {
  const f = await dragFixture();
  try {
    const folder = { ...f.target, nodeID: await f.service.createFolder("Source folder", f.target) };
    const other = { libraryID: await f.service.createLibrary("Other"), nodeID: null };
    await f.service.add([10, 20], f.target); await f.service.add([10], folder); await f.service.add([10], other);
    const trash = f.row("Kknowledgemcp:trash", "knowledge"); f.view._rows.push(trash);
    f.state.source = f.knowledgeRow;
    const data = f.transfer([10, 10, 20]);
    assert.equal(f.view.canDropCheck(2, 0, data), true);
    assert.equal(await f.view.canDropCheckAsync(2, 0, data), true);
    assert.equal(f.view.canDropCheck(2, -1, data), false);
    assert.equal(f.view.canDropCheck(2, 1, data), false);
    f.view.onDragOver(f.event(data), 2);
    assert.equal(data.dropEffect, "move"); assert.equal(f.view._dropRow, 2);
    f.items.collectionTreeRows = [trash]; // Drop location changes independently of the captured source.
    await f.view.onDrop(f.event(data), 2);
    assert.deepEqual(f.service.snapshot.memberships.map(row => row.libraryID), [other.libraryID]);
    assert.equal(f.service.snapshot.trash.length, 2);
    assert.equal(f.state.nativeDrops, 0); assert.equal(f.view._dropRow, null);
    assert.ok([...f.nativeItems.values()].every(item => !item.deleted));
    await f.service.restoreTrash(f.service.snapshot.trash.map(entry => entry.id));
    assert.equal(f.service.snapshot.memberships.length, 4);
    assert.equal(f.state.alerts.length, 0);
  } finally { await f.close(); }
});

test("Trash drops honor combined folder scopes and the overview without removing unrelated items", async () => {
  const f = await dragFixture();
  try {
    const first = { ...f.target, nodeID: await f.service.createFolder("First", f.target) };
    const other = { libraryID: await f.service.createLibrary("Other"), nodeID: null };
    const second = { ...other, nodeID: await f.service.createFolder("Second", other) };
    const outside = { libraryID: await f.service.createLibrary("Outside"), nodeID: null };
    await f.service.add([10], first); await f.service.add([10, 20], second); await f.service.add([10], outside);
    const trash = f.row("Kknowledgemcp:trash", "knowledge"); f.items.collectionTreeRows = [trash];
    f.state.source = f.row(`Kknowledgemcp:selection:${JSON.stringify([first, second].map(target => `Kknowledgemcp:folder:${target.nodeID}`))}`, "knowledge");
    const data = f.transfer([10, 20]);
    assert.equal(f.items.canDropCheck(-1, 0, data), true);
    f.items.onDragOver(f.event(data)); assert.equal(data.dropEffect, "move");
    await f.items.onDrop(f.event(data));
    assert.deepEqual(f.service.snapshot.memberships.map(row => row.libraryID), [outside.libraryID]);
    await f.service.restoreTrash(f.service.snapshot.trash.map(entry => entry.id));
    f.state.source = f.row(`Kknowledgemcp:folder:${first.nodeID}`, "knowledge", first);
    assert.equal(f.items.canDropCheck(-1, 0, f.transfer([20])), false, "a mapped item outside the dragged folder is not a valid payload");
    f.state.source = f.row("Kknowledgemcp:overview", "knowledge");
    await f.items.onDrop(f.event(f.transfer([10])));
    assert.deepEqual(f.service.snapshot.memberships.map(row => row.resourceID), [f.service.snapshot.itemResources.get(20)]);
    assert.equal(f.state.nativeDrops, 0);
  } finally { await f.close(); }
});

test("folder drag-start carries plugin identities and a multi-folder Trash drop restores complete deduplicated subtrees", async () => {
  const f = await dragFixture();
  try {
    const parent = { ...f.target, nodeID: await f.service.createFolder("Parent", f.target) };
    const child = { ...f.target, nodeID: await f.service.createFolder("Child", parent) };
    const other = { libraryID: await f.service.createLibrary("Other"), nodeID: null };
    const sibling = { ...other, nodeID: await f.service.createFolder("Sibling", other) };
    await f.service.add([10], child); await f.service.add([20], sibling);
    const folders = [child, parent, sibling].map(target => f.row(`Kknowledgemcp:folder:${target.nodeID}`, "knowledge", target));
    const trash = f.row("Kknowledgemcp:trash", "knowledge"); f.view._rows.push(...folders, trash); f.state.selectedRows = folders;
    const data = f.transfer([]); f.view.onDragStart(f.event(data), 2);
    assert.deepEqual(JSON.parse(data.getData("application/x-zotero-knowledge-folders")), [child.nodeID, parent.nodeID, sibling.nodeID]);
    assert.equal(data.effectAllowed, "move");
    assert.equal(f.view.canDropCheck(5, 0, data), true);
    assert.equal(f.view.canDropCheck(0, 0, data), false, "plugin folder identities cannot reach Zotero collection copying");
    assert.equal(f.view.canDropCheck(3, 0, data), false, "folder moving between knowledge locations is not implied");
    f.items.collectionTreeRows = [trash];
    await f.items.onDrop(f.event(data));
    assert.equal(f.service.snapshot.folders.length, 0);
    assert.deepEqual(new Set(f.service.snapshot.trash.map(entry => entry.target.nodeID)), new Set([parent.nodeID, sibling.nodeID]));
    assert.equal(f.service.snapshot.memberships.length, 2); assert.ok(f.service.snapshot.memberships.every(member => member.nodeID === null));
    assert.equal(f.drag.currentDragSource, null);
    await f.service.restoreTrash(f.service.snapshot.trash.map(entry => entry.id));
    assert.equal(f.service.snapshot.folders.find(folder => folder.id === child.nodeID).parentID, parent.nodeID);
    assert.deepEqual(new Set(f.service.snapshot.memberships.filter(member => member.nodeID).map(member => member.nodeID)), new Set([child.nodeID, sibling.nodeID]));
    assert.deepEqual(f.nativeDB.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(f.state.nativeDrops, 0);
  } finally { await f.close(); }
});

test("Trash rejects native sources, unsupported and stale payloads, and rechecks a folder before dropping", async () => {
  const f = await dragFixture();
  try {
    await f.service.add([10], f.target);
    const folder = { ...f.target, nodeID: await f.service.createFolder("Folder", f.target) };
    const row = f.row(`Kknowledgemcp:folder:${folder.nodeID}`, "knowledge", folder);
    const trash = f.row("Kknowledgemcp:trash", "knowledge"); f.view._rows.push(row, trash);
    assert.equal(f.view.canDropCheck(3, 0, f.transfer([10])), false, "native Zotero library drags never delete knowledge memberships");
    f.state.source = trash; assert.equal(f.view.canDropCheck(3, 0, f.transfer([10])), false);
    f.state.source = f.knowledgeRow;
    const file = f.transfer([10]); file.type = "application/x-moz-file";
    assert.equal(f.view.canDropCheck(3, 0, file), false);
    f.nativeItems.get(10).deleted = true; assert.equal(f.view.canDropCheck(3, 0, f.transfer([10])), false); f.nativeItems.get(10).deleted = false;
    f.state.source = f.row("Kknowledgemcp:selection:invalid", "knowledge");
    assert.equal(f.view.canDropCheck(3, 0, f.transfer([10])), false);
    f.state.selectedRows = [row]; const data = f.transfer([]); f.view.onDragStart(f.event(data), 2);
    data.setData("application/x-zotero-knowledge-folders", "not JSON"); assert.equal(f.view.canDropCheck(3, 0, data), false);
    data.setData("application/x-zotero-knowledge-folders", JSON.stringify([folder.nodeID, "missing"])); assert.equal(f.view.canDropCheck(3, 0, data), false);
    data.setData("application/x-zotero-knowledge-folders", JSON.stringify([folder.nodeID])); assert.equal(f.view.canDropCheck(3, 0, data), true);
    await f.service.deleteFolder(folder);
    await f.view.onDrop(f.event(data), 3);
    assert.equal(f.service.snapshot.trash.length, 1, "a stale drop must not create a second deletion");
    assert.equal(f.state.nativeDrops, 0);
  } finally { await f.close(); }
});

test("a failed multi-folder Trash drop rolls back all deletions and can be retried", async () => {
  const f = await dragFixture();
  try {
    const first = { ...f.target, nodeID: await f.service.createFolder("First", f.target) };
    const second = { ...f.target, nodeID: await f.service.createFolder("Second", f.target) };
    await f.service.add([10], first); await f.service.add([20], second);
    const rows = [first, second].map(target => f.row(`Kknowledgemcp:folder:${target.nodeID}`, "knowledge", target));
    f.view._rows.push(...rows, f.row("Kknowledgemcp:trash", "knowledge")); f.state.selectedRows = rows;
    const data = f.transfer([]); f.view.onDragStart(f.event(data), 2);
    let captures = 0;
    f.nativeDB.options.fail = statement => /^insert into "knowledge_trash_entries"/.test(statement) && ++captures === 2;
    await f.view.onDrop(f.event(data), 4);
    assert.equal(f.state.alerts.length, 1);
    assert.equal(f.nativeDB.sqlite.prepare("SELECT count(*) n FROM knowledge_trash_entries").get().n, 0);
    assert.equal(f.nativeDB.sqlite.prepare("SELECT count(*) n FROM library_nodes WHERE deleted_at IS NULL").get().n, 2);
    assert.equal(f.service.snapshot.memberships.length, 2);
    f.nativeDB.options.fail = undefined;
    f.view.onDragStart(f.event(data), 2); await f.view.onDrop(f.event(data), 4);
    assert.equal(f.service.snapshot.folders.length, 0); assert.equal(f.service.snapshot.trash.length, 2);
    assert.deepEqual(f.nativeDB.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await f.close(); }
});

test("ending or disposing a folder drag clears only its owned drag source and restores native handlers", async () => {
  const f = await dragFixture();
  try {
    const target = { ...f.target, nodeID: await f.service.createFolder("Folder", f.target) };
    const row = f.row(`Kknowledgemcp:folder:${target.nodeID}`, "knowledge", target); f.view._rows.push(row); f.state.selectedRows = [row];
    const first = f.transfer([]); f.view.onDragStart(f.event(first), 2); f.view.onDragEnd(f.event(first));
    assert.equal(f.drag.currentDragSource, null); assert.equal(f.service.snapshot.trash.length, 0);
    f.view.onDragStart(f.event(first), 2);
    f.window.document.dispatchEvent(new f.window.document.defaultView.Event("dragend", { bubbles: true }));
    assert.equal(f.drag.currentDragSource, null, "document cleanup handles rows that retained an old native dragend callback");
    f.view.onDragStart(f.event(first), 2); f.adapter.dispose(); assert.equal(f.drag.currentDragSource, null);
    const second = f.transfer([]); f.view.onDragStart(f.event(second), 2);
    assert.equal(second.types.includes("application/x-zotero-knowledge-folders"), false);
    f.window.document.dispatchEvent(new f.window.document.defaultView.Event("dragend", { bubbles: true }));
    assert.equal(f.drag.currentDragSource, row, "disposed document handlers do not affect later drags");
  } finally { await f.close(); }
});

test("duplicate library and sibling folder names return actionable messages without database details", async () => {
  const f = await fixture();
  try {
    const libraryID = await f.service.createLibrary("Research");
    assert.equal(typeof libraryID, "string");
    await assert.rejects(() => f.service.createLibrary(" Research "), error => {
      assert.ok(error instanceof KnowledgeUserError);
      assert.match(error.message, /knowledge library named “Research” already exists/);
      assert.doesNotMatch(error.message, /UNIQUE|QUERY|PARAMS|constraint|insert into/i);
      return true;
    });
    const first = await f.service.createFolder("Methods", f.target);
    await assert.rejects(() => f.service.createFolder("Methods", f.target), /folder named “Methods” already exists in this location/);
    const childTarget = { ...f.target, nodeID: first };
    await f.service.createFolder("Methods", childTarget);
    await assert.rejects(() => f.service.createFolder(" Methods ", childTarget), /already exists in this location/);
    await f.service.createFolder("Methods", { libraryID, nodeID: null });
    assert.equal(f.service.snapshot.folders.length, 3);
    await f.service.deleteFolder(childTarget);
    await f.service.createFolder("Methods", f.target);
    assert.equal(f.service.snapshot.folders.length, 2);
  } finally { await f.close(); }
});

test("UI error messages hide unknown exceptions across realms while preserving expected validation prompts", () => {
  const sql = 'Error(s) encountered: UNIQUE constraint failed: library_nodes.library_id [QUERY: insert into library_nodes] [PARAMS: {"name":"private"}]';
  assert.equal(knowledgeErrorMessage({ message: sql }), "The knowledge operation could not be completed. Please try again.");
  assert.equal(knowledgeErrorMessage(new Error(sql)), "The knowledge operation could not be completed. Please try again.");
  assert.equal(knowledgeErrorMessage(sql), "The knowledge operation could not be completed. Please try again.");
  assert.equal(knowledgeErrorMessage(new KnowledgeUserError("Choose another name.")), "Choose another name.");
});

async function treeFixture({ deferredCommits = false, seedFolders = false } = {}) {
  const f = await fixture();
  const seeded = [];
  if (seedFolders) {
    seeded.push(await f.service.createFolder("Parent", f.target));
    seeded.push(await f.service.createFolder("Child", { ...f.target, nodeID: seeded[0] }));
  }
  globalThis.Zotero.Libraries = { userLibraryID: 1 };
  globalThis.Zotero.Collection = class {
    isRegularItem() { return false; }
    isAttachment() { return false; }
    isNote() { return false; }
    isAnnotation() { return false; }
  };
  globalThis.Zotero.CollectionTreeRow = class {
    constructor(view, type, ref, level, isOpen) { Object.assign(this, { type, ref, level, isOpen }); }
    getName() { return this.ref.name; }
    isCollection() { return false; }
    isSearch() { return false; }
    isLibrary() { return false; }
    clearCache() {}
  };
  const nativeRow = { id: "L1", level: 0, getName: () => "Native Library" };
  const state = { nativeToggles: 0, selectionChanges: 0, invalidations: 0, selectionNotifications: 0, nativeSelectAll: 0 };
  const pendingCommits = [];
  const arrows = new Map();
  const tree = { props: {}, invalidate() {
    state.invalidations++;
    arrows.clear();
    for (const [index, row] of view._rows.entries()) arrows.set(row.id, !tree.props.isContainerEmpty(index));
  } };
  const items = { tree: { invalidate() {} }, collectionTreeRows: [nativeRow], async refreshAndMaintainSelection() {} };
  const pane = { itemsView: items, getCollectionTreeRows: () => view.getSelectedRows(), async onCollectionSelected() {
    state.selectionChanges++;
    const selected = pane.getCollectionTreeRows();
    // Model ZoteroPane's native rejection of multi-selected unknown special views.
    if (selected.length > 1 && selected.some(row => row.type === "knowledgemcp")) {
      view.selection.select(view.selection.focused);
      return;
    }
    items.collectionTreeRows = selected;
  } };
  let suppressed = false;
  const selection = { selected: new Set([0]), focused: 0, pivot: 0,
    get selectEventsSuppressed() { return suppressed; },
    set selectEventsSuppressed(value) {
      if (!value && value !== suppressed) state.selectionNotifications++;
      suppressed = value;
    },
    select(index) {
      this.selected = new Set([index]); this.focused = index; this.pivot = index;
      if (!suppressed) state.selectionNotifications++;
    }
  };
  const view = { tree, _rows: [nativeRow], selection,
    getSelectedRows: () => [...selection.selected].sort((a, b) => a - b).map(index => view._rows[index]).filter(Boolean), getRow: index => view._rows[index], _refreshRowMap() {},
    getIconName: () => "library", isContainerEmpty: () => true,
    async toggleOpenState() { state.nativeToggles++; }, _closeContainer() { state.nativeToggles++; },
    async _handleSelectAll() { state.nativeSelectAll++; },
    async selectByID(id) { const index = view._rows.findIndex(row => row.id === id); if (index < 0) return false; selection.select(index); await pane.onCollectionSelected(); return true; },
    async selectWait(index) { selection.select(index); await pane.onCollectionSelected(); },
    async refresh() {},
    forceUpdate(callback) {
      const props = { isContainerEmpty: view.isContainerEmpty, onToggleOpenState: view.toggleOpenState };
      const commit = () => { tree.props = props; callback?.(); };
      if (deferredCommits) pendingCommits.push(commit); else commit();
    } };
  pane.collectionsView = view;
  view.forceUpdate();
  const flushCommits = () => { while (pendingCommits.length) pendingCommits.shift()(); };
  flushCommits();
  const originalProps = tree.props;
  const originalPaneRows = pane.getCollectionTreeRows;
  const originalSelectAll = view._handleSelectAll;
  const window = { ZoteroPane: pane, alert() {}, closed: false };
  const libraryTree = new KnowledgeLibraryTree(window, f.service, () => {}, async () => {});
  return { ...f, state, tree, view, pane, window, libraryTree, originalProps, originalPaneRows, originalSelectAll, arrows, seeded, flushCommits,
    index: id => view._rows.findIndex(row => row.id === id),
    async close() { libraryTree.dispose(); flushCommits(); await f.close(); } };
}

test("partial drag and Trash initialization restore adapters before propagating native setup errors", async () => {
  const f = await treeFixture();
  try {
    f.libraryTree.dispose();
    const native = () => {};
    f.view.onDragStart = native;
    Object.defineProperty(f.view, "canDropCheck", { configurable: true, get() { throw Error("Detached drop target"); } });
    assert.throws(() => new KnowledgeDragDrop(f.window, f.service, () => f.target, async () => {}));
    assert.equal(f.view.onDragStart, native); delete f.view.canDropCheck;
    const createRow = () => {};
    f.pane.itemsView.rowProvider = { createRow }; f.pane.itemPane = {};
    assert.throws(() => new KnowledgeTrashList(f.window, f.service));
    assert.equal(f.pane.itemsView.rowProvider.createRow, createRow);
  } finally { await f.close(); }
});

test("tree initialization restores earlier adapters when a required native method is missing", async () => {
  const f = await treeFixture();
  try {
    f.libraryTree.dispose();
    const refresh = f.view.refresh, icon = f.view.getIconName;
    const empty = f.view.isContainerEmpty; delete f.view.isContainerEmpty;
    assert.throws(() => new KnowledgeLibraryTree(f.window, f.service, () => {}, async () => {}));
    f.view.isContainerEmpty = empty;
    assert.equal(f.view.refresh, refresh); assert.equal(f.view.getIconName, icon);
    assert.equal(f.pane.getCollectionTreeRows, f.originalPaneRows);
    assert.equal(f.view._rows.some(row => row.id.startsWith("Kknowledgemcp:")), false);
  } finally { await f.close(); }
});

test("tree cleanup restores every adapter even after native view removal and child cleanup failure", async () => {
  const f = await treeFixture();
  try {
    f.libraryTree.tasksView.dispose = () => { throw Error("Detached task surface"); };
    delete f.pane.collectionsView;
    assert.doesNotThrow(() => f.libraryTree.dispose());
    assert.equal(f.pane.getCollectionTreeRows, f.originalPaneRows);
    assert.equal(f.view._handleSelectAll, f.originalSelectAll);
    assert.equal(f.view._rows.some(row => row.id.startsWith("Kknowledgemcp:")), false);
  } finally { f.pane.collectionsView = f.view; await f.close(); }
});

test("knowledge UI cleanup continues across windows and retains failed registrations for retry", () => {
  const ui = new KnowledgeLibraryUI("test", "file:///test/", {});
  const calls = [], originalZotero = globalThis.Zotero;
  let fail = true;
  const window = { document: {}, closed: false };
  ui.windows.set(window, { sync: { dispose() { calls.push("sync"); throw Error("Subscription failed"); } },
    title: { dispose() { calls.push("title"); } }, tree: { dispose() { calls.push("tree"); } } });
  ui.paneID = "pane"; ui.menus = ["first", "second"];
  globalThis.Zotero = { ItemPaneManager: { unregisterSection() { calls.push("section"); if (fail) throw Error("Pane busy"); } },
    MenuManager: { unregisterMenu(key) { calls.push(key); if (key === "first" && fail) throw Error("Menu busy"); } }, getMainWindows: () => [] };
  try {
    assert.throws(() => ui.dispose(), AggregateError);
    assert.deepEqual(calls, ["sync", "title", "tree", "section", "first", "second"]);
    assert.equal(ui.paneID, "pane"); assert.deepEqual(ui.menus, ["first"]);
    fail = false; assert.doesNotThrow(() => ui.dispose());
    assert.equal(ui.paneID, false); assert.deepEqual(ui.menus, []);
  } finally { globalThis.Zotero = originalZotero; }
});

test("import tasks share the library and Trash level, precede Trash and follow overview expansion", async () => {
  const f = await treeFixture();
  try {
    const taskID = "Kknowledgemcp:import-tasks", trashID = "Kknowledgemcp:trash", rootID = "Kknowledgemcp:overview";
    const task = f.view.getRow(f.index(taskID));
    assert.equal(task.level, 1);
    assert.equal(task.level, f.view.getRow(f.index(trashID)).level);
    assert.equal(task.level, f.view.getRow(f.index(`Kknowledgemcp:library:${f.target.libraryID}`)).level);
    assert.equal(f.index(taskID) + 1, f.index(trashID));
    assert.deepEqual(await task.getItems(), []);
    await f.view.toggleOpenState(f.index(rootID));
    assert.equal(f.index(taskID), -1);
    await f.view.selectByID(taskID);
    assert.ok(f.index(taskID) >= 0);
    assert.equal(f.libraryTree.selectedTarget(), undefined);
    assert.deepEqual(f.libraryTree.selectedLibraryIDs(), []);
  } finally { await f.close(); }
});

test("wide knowledge trees preserve folder order and scope with bounded folder reads", async () => {
  const f = await treeFixture();
  try {
    let reads = 0;
    const folder = (id, parentID, libraryID = f.target.libraryID) => ({ id, parentID, name: id,
      get libraryID() { reads++; return libraryID; } });
    const children = Array.from({ length: 1500 }, (_, i) => folder(`child-${i}`, "parent"));
    f.service.snapshot.folders = [folder("foreign-root", null, "other-library"), ...children, folder("parent", null)];
    await f.libraryTree.select("Kknowledgemcp:folder:child-1499");
    assert.deepEqual(f.view._rows.filter(row => row.id.startsWith("Kknowledgemcp:folder:")).map(row => row.ref.name),
      ["parent", ...children.map(child => child.name)]);
    assert.ok(reads < 15000, `folder reads stay linear in the snapshot size, observed ${reads}`);
    assert.equal(f.view.isContainerEmpty(f.index("Kknowledgemcp:folder:parent")), false);
    assert.equal(f.view.isContainerEmpty(f.index("Kknowledgemcp:folder:child-0")), true);
    const before = reads;
    for (const [index, row] of f.view._rows.entries()) {
      f.view.isContainerEmpty(index);
      row.isContainer?.();
    }
    assert.equal(reads, before, "container callbacks do not rescan snapshot folders");
  } finally { await f.close(); }
});

test("initial disclosure arrows render after the adapted React props commit without row interaction", async () => {
  const f = await treeFixture({ deferredCommits: true, seedFolders: true });
  try {
    // Model a native paint before React has committed the owner's new props.
    f.tree.invalidate();
    assert.equal(f.arrows.get("Kknowledgemcp:overview"), false);
    assert.notEqual(f.tree.props.isContainerEmpty, f.view.isContainerEmpty);
    f.flushCommits();
    assert.equal(f.tree.props.isContainerEmpty, f.view.isContainerEmpty);
    assert.equal(f.arrows.get("Kknowledgemcp:overview"), true);
    assert.equal(f.arrows.get(`Kknowledgemcp:library:${f.target.libraryID}`), true);
    assert.equal(f.arrows.get(`Kknowledgemcp:folder:${f.seeded[0]}`), true);
    assert.equal(f.state.selectionChanges, 0);
    assert.equal(f.state.nativeToggles, 0);
    f.libraryTree.dispose();
    f.flushCommits();
    assert.deepEqual([...f.arrows.keys()], ["L1"]);
    assert.equal(f.tree.props.isContainerEmpty, f.originalProps.isContainerEmpty);
  } finally { await f.close(); }
});

test("pending tree commit callbacks do not redraw a disposed integration or closed window", async () => {
  const f = await treeFixture({ deferredCommits: true });
  try {
    f.libraryTree.dispose();
    f.flushCommits();
    // Only disposal repaints; the pending installation callback is inert.
    assert.equal(f.state.invalidations, 1);
    assert.equal(f.tree.props.isContainerEmpty, f.originalProps.isContainerEmpty);
    assert.deepEqual(f.view._rows.map(row => row.id), ["L1"]);
  } finally { await f.close(); }
  const closed = await treeFixture({ deferredCommits: true });
  try {
    closed.window.closed = true;
    closed.flushCommits();
    assert.equal(closed.state.invalidations, 0);
    closed.libraryTree.dispose();
    closed.flushCommits();
    assert.equal(closed.state.invalidations, 0);
  } finally { await closed.close(); }
});

test("rendered tree callback props expand/collapse folders and remap a hidden child selection to its parent", async () => {
  const f = await treeFixture();
  try {
    const parentID = await f.service.createFolder("Parent", f.target);
    const childID = await f.service.createFolder("Child", { ...f.target, nodeID: parentID });
    const parent = `Kknowledgemcp:folder:${parentID}`;
    const child = `Kknowledgemcp:folder:${childID}`;
    await f.libraryTree.select(child);
    assert.notEqual(f.tree.props.onToggleOpenState, f.originalProps.onToggleOpenState);
    assert.equal(f.tree.props.isContainerEmpty(f.index(parent)), false);
    await f.tree.props.onToggleOpenState(f.index(parent));
    assert.equal(f.index(child), -1);
    assert.equal(f.pane.getCollectionTreeRows()[0].id, parent);
    assert.equal(f.pane.itemsView.collectionTreeRows[0].id, parent);
    await f.libraryTree.refresh(); assert.equal(f.index(child), -1);
    await f.tree.props.onToggleOpenState(f.index(parent));
    assert.ok(f.index(child) > f.index(parent));
    assert.equal(f.state.nativeToggles, 0);
    f.libraryTree.dispose();
    assert.equal(f.tree.props.onToggleOpenState, f.originalProps.onToggleOpenState);
    assert.equal(f.tree.props.isContainerEmpty, f.originalProps.isContainerEmpty);
  } finally { await f.close(); }
});

test("new folder identities can be selected immediately and reveal every collapsed ancestor", async () => {
  const f = await treeFixture();
  try {
    const parentID = await f.service.createFolder("Parent", f.target);
    await f.libraryTree.refresh();
    const library = `Kknowledgemcp:library:${f.target.libraryID}`;
    await f.tree.props.onToggleOpenState(f.index(library));
    const childID = await f.service.createFolder("New child", { ...f.target, nodeID: parentID });
    const child = `Kknowledgemcp:folder:${childID}`;
    assert.equal(await f.libraryTree.select(child), true);
    assert.equal(f.pane.getCollectionTreeRows()[0].id, child);
    assert.equal(f.view.getRow(f.index(library)).isOpen, true);
    assert.equal(f.view.getRow(f.index(`Kknowledgemcp:folder:${parentID}`)).isOpen, true);
  } finally { await f.close(); }
});

test("knowledge refresh preserves native collection multi-selection, focus, pivot and item view without selection notifications", async () => {
  const f = await treeFixture();
  try {
    const rows = [21, 22].map(id => ({ id: `C${id}`, level: 1, getName: () => `Native ${id}` }));
    f.view._rows.splice(1, 0, ...rows);
    f.view.selection.selected = new Set([2, 1]);
    f.view.selection.focused = 2; f.view.selection.pivot = 1;
    f.pane.itemsView.collectionTreeRows = rows;
    const notifications = f.state.selectionNotifications;
    for (let i = 0; i < 2; i++) {
      await f.libraryTree.refresh();
      assert.deepEqual(f.view.getSelectedRows().map(row => row.id), ["C21", "C22"]);
      assert.equal(f.view.getRow(f.view.selection.focused).id, "C22");
      assert.equal(f.view.getRow(f.view.selection.pivot).id, "C21");
      assert.equal(f.view.selection.selectEventsSuppressed, false);
      assert.equal(f.state.selectionNotifications, notifications);
      assert.equal(f.state.selectionChanges, 0);
      assert.equal(f.pane.itemsView.collectionTreeRows, rows);
    }
  } finally { await f.close(); }
});

test("tree row movement remaps all selected identities and keyboard anchors without releasing suppression", async () => {
  const f = await treeFixture({ seedFolders: true });
  try {
    const first = `Kknowledgemcp:folder:${await f.service.createFolder("First", f.target)}`;
    const second = `Kknowledgemcp:folder:${await f.service.createFolder("Second", f.target)}`;
    await f.libraryTree.select(`Kknowledgemcp:folder:${f.seeded[1]}`);
    f.view.selection.selected = new Set([f.index(first), f.index(second)]);
    f.view.selection.focused = f.index(second); f.view.selection.pivot = f.index(first);
    f.view.selection.selectEventsSuppressed = true;
    const previousIndex = f.index(second);
    const notifications = f.state.selectionNotifications;
    const changes = f.state.selectionChanges;
    await f.tree.props.onToggleOpenState(f.index(`Kknowledgemcp:folder:${f.seeded[0]}`));
    assert.deepEqual(f.view.getSelectedRows().map(row => row.id), [first, second]);
    assert.equal(f.index(second), previousIndex - 1);
    assert.equal(f.view.getRow(f.view.selection.focused).id, second);
    assert.equal(f.view.getRow(f.view.selection.pivot).id, first);
    assert.equal(f.view.selection.selectEventsSuppressed, true);
    assert.equal(f.state.selectionNotifications, notifications);
    assert.equal(f.state.selectionChanges, changes);
  } finally { await f.close(); }
});

test("refresh retains surviving selections when one selected knowledge folder is removed", async () => {
  const f = await treeFixture();
  try {
    const removedID = await f.service.createFolder("Removed", f.target);
    const retainedID = await f.service.createFolder("Retained", f.target);
    const removed = `Kknowledgemcp:folder:${removedID}`;
    const retained = `Kknowledgemcp:folder:${retainedID}`;
    await f.libraryTree.refresh();
    f.view.selection.selected = new Set([f.index(removed), f.index(retained)]);
    f.view.selection.focused = f.index(removed); f.view.selection.pivot = f.index(removed);
    await f.pane.onCollectionSelected();
    const changes = f.state.selectionChanges;
    await f.service.deleteFolder({ ...f.target, nodeID: removedID });
    await f.libraryTree.refresh();
    assert.deepEqual(f.view.getSelectedRows().map(row => row.id), [retained]);
    assert.equal(f.view.getRow(f.view.selection.focused).id, retained);
    assert.equal(f.view.getRow(f.view.selection.pivot).id, retained);
    assert.deepEqual(f.pane.itemsView.collectionTreeRows.map(row => row.id), [retained]);
    assert.equal(f.state.selectionChanges, changes + 1);
  } finally { await f.close(); }
});

test("knowledge refresh preserves an empty native selection and its existing focus", async () => {
  const f = await treeFixture();
  try {
    f.view.selection.selected.clear();
    const notifications = f.state.selectionNotifications;
    await f.libraryTree.refresh();
    assert.deepEqual(f.view.getSelectedRows(), []);
    assert.equal(f.view.selection.focused, 0);
    assert.equal(f.view.selection.pivot, 0);
    assert.equal(f.state.selectionNotifications, notifications);
    assert.equal(f.state.selectionChanges, 0);
  } finally { await f.close(); }
});

function installKnowledgeSearch(f) {
  const tables = new Map(); let serial = 0;
  f.searchTables = tables;
  const nativeItems = new Map([...f.inputs].map(([id, input]) => [id, { id, key: input.key, libraryID: input.library.localID, deleted: false }]));
  globalThis.Zotero.Items = { get: id => nativeItems.get(id) ?? false, getAsync: async id => nativeItems.get(id) ?? false };
  globalThis.Zotero.Search = class {
    conditions = [];
    addCondition(name, operator, value) {
      this.conditions.push({ name, value });
      if (this.conditions.length > 200) throw new Error("Native search expression budget exceeded");
    }
    setScope(scope) { this.scope = scope; }
    async search() {
      const table = this.scope.conditions.find(condition => condition.name === "tempTable")?.value;
      if (table) assert.equal(tables.get(table)?.column, "id");
      const ids = tables.get(table)?.ids ?? this.scope.conditions.filter(condition => condition.name === "itemID").map(condition => condition.value);
      const filtered = ids.filter(id => this.conditions.every(({ name, value }) => {
        if (name.startsWith("quicksearch-")) return f.inputs.get(id).title.includes(value);
        if (name === "tag") return f.inputs.get(id).tags.some(tag => tag.tag === value);
        return true;
      }));
      return [...filtered, 999]; // The adapter must reject unexpected results outside its scope.
    }
  };
  globalThis.Zotero.Search.idsToTempTable = async (ids, options = {}) => {
    const name = `tmpSearchResults_test${++serial}`;
    tables.set(name, { ids: [...ids], column: options.idColumn ?? "itemID" });
    return name;
  };
  globalThis.Zotero.DB = { async queryAsync(sql, parameters, options) {
    assert.equal(parameters, false); assert.equal(options.noCache, true);
    assert.match(sql, /^DROP TABLE IF EXISTS temp\.tmpSearchResults_[A-Za-z0-9]+$/);
    tables.delete(sql.slice("DROP TABLE IF EXISTS temp.".length));
  } };
}

test("large native knowledge scopes use one temp-table condition and preserve filters and isolation", async () => {
  const f = await treeFixture();
  try {
    const count = 32770;
    for (let index = 0; index < count; index++) f.inputs.set(100000 + index, { itemID: 100000 + index, key: `SCALE${index}`,
      library: { localID: 1 }, title: index % 2 ? "Other paper" : "Matched paper", tags: index % 2 ? [] : [{ tag: "methods" }] });
    installKnowledgeSearch(f);
    const ids = Array.from({ length: count }, (_, index) => 100000 + index);
    f.service.snapshot = { ...f.service.snapshot, resources: ids.map(id => ({ id: `scale-${id}`, itemID: id, nativeLibraryID: 1, itemKey: `SCALE${id - 100000}`, state: "current" })),
      memberships: ids.map(id => ({ resourceID: `scale-${id}`, libraryID: f.target.libraryID, nodeID: null })) };
    await f.libraryTree.select(`Kknowledgemcp:library:${f.target.libraryID}`);
    const row = f.view.getSelectedRows()[0];
    assert.equal((await row.getItems()).length, count);
    assert.equal(f.searchTables.size, 0);
    row.searchText = "Matched";
    assert.equal((await row.getItems()).length, count / 2);
    row.searchText = ""; row.tags = new Set(["methods"]);
    assert.equal((await row.getItems()).length, count / 2);
    assert.equal((await row.getItems({ unfiltered: true })).length, count);
    assert.equal(f.searchTables.size, 0, "every native scope table is released");
  } finally { await f.close(); }
});

test("native knowledge scope tables clean up on failed queries and disposal during an in-flight search", async () => {
  const f = await treeFixture();
  try {
    await f.service.add([10], f.target); installKnowledgeSearch(f);
    const failed = new Zotero.Search(); failed.libraryID = 1;
    failed.search = async () => { throw new Error("Injected search failure"); };
    await assert.rejects(searchKnowledgeScope(failed, 1, [10]), /Injected search failure/);
    assert.equal(f.searchTables.size, 0);
    const original = Zotero.Search.prototype.search;
    let release, entered;
    const pending = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    Zotero.Search.prototype.search = async function () { entered(); await pending; return original.call(this); };
    await f.libraryTree.select(`Kknowledgemcp:library:${f.target.libraryID}`);
    const result = f.view.getSelectedRows()[0].getItems();
    await started;
    assert.equal(f.searchTables.size, 1);
    f.libraryTree.dispose(); release();
    assert.deepEqual(await result, []);
    assert.equal(f.searchTables.size, 0);
  } finally { await f.close(); }
});

test("knowledge folder multi-selection survives the native pane guard and exposes a scoped deduplicated union", async () => {
  const f = await treeFixture();
  try {
    const first = await f.service.createFolder("First", f.target);
    const otherLibrary = await f.service.createLibrary("Other library");
    const secondTarget = { libraryID: otherLibrary, nodeID: await f.service.createFolder("Second", { libraryID: otherLibrary, nodeID: null }) };
    const firstTarget = { ...f.target, nodeID: first };
    f.inputs.set(20, { ...structuredClone(f.input), itemID: 20, key: "OTHER20", title: "Other paper", attachments: [], tags: [] });
    f.inputs.set(30, { ...structuredClone(f.input), itemID: 30, key: "OUTSIDE30", title: "Outside selection", attachments: [] });
    await f.service.add([10], firstTarget); await f.service.add([10, 20], secondTarget); await f.service.add([30], f.target);
    installKnowledgeSearch(f);
    const ids = [first, secondTarget.nodeID].map(id => `Kknowledgemcp:folder:${id}`);
    await f.libraryTree.select(ids[1]);
    f.view.selection.selected = new Set(ids.map(id => f.index(id)));
    await f.pane.onCollectionSelected();
    assert.deepEqual(f.view.getSelectedRows().map(row => row.id), ids);
    const [scope] = f.pane.itemsView.collectionTreeRows;
    assert.equal(f.pane.itemsView.collectionTreeRows.length, 1);
    assert.equal(scope.type, "knowledgemcp"); assert.equal(scope.isCollection(), false);
    assert.equal(scope.getName(), "2 knowledge folders selected");
    assert.deepEqual((await scope.getItems()).map(item => item.id), [10, 20]);
    assert.equal(f.libraryTree.selectedTarget(), undefined);
    assert.ok(!f.view._rows.some(row => row.id === scope.id), "aggregate is an item-view scope, not a new left-tree node");
    scope.searchText = "Other";
    assert.deepEqual((await scope.getItems()).map(item => item.id), [20]);
    scope.searchText = ""; scope.tags = new Set(["methods"]);
    assert.deepEqual((await scope.getItems()).map(item => item.id), [10]);
    assert.deepEqual((await scope.getItems({ unfiltered: true })).map(item => item.id), [10, 20]);
    await f.libraryTree.refresh();
    assert.equal(f.pane.getCollectionTreeRows()[0], scope, "unchanged selection retains its filter state");
    assert.deepEqual([...scope.tags], ["methods"]);
    scope.tags.clear();
    await f.service.remove([10], firstTarget); await f.service.remove([10], secondTarget);
    await f.libraryTree.refresh();
    assert.deepEqual((await scope.getItems()).map(item => item.id), [20], "aggregate reads current memberships");
  } finally { await f.close(); }
});

test("knowledge library multi-selection combines only the selected libraries", async () => {
  const f = await treeFixture();
  try {
    const other = await f.service.createLibrary("Other");
    const outside = await f.service.createLibrary("Outside");
    f.inputs.set(20, { ...structuredClone(f.input), itemID: 20, key: "OTHER20", attachments: [] });
    await f.service.add([10], f.target); await f.service.add([20], { libraryID: outside, nodeID: null });
    installKnowledgeSearch(f);
    await f.libraryTree.refresh();
    const ids = [f.target.libraryID, other].map(id => `Kknowledgemcp:library:${id}`);
    f.view.selection.selected = new Set(ids.map(id => f.index(id))); f.view.selection.focused = f.index(ids[1]);
    await f.pane.onCollectionSelected();
    assert.deepEqual(f.view.getSelectedRows().map(row => row.id), ids);
    const [scope] = f.pane.getCollectionTreeRows();
    assert.equal(scope.getName(), "2 knowledge libraries selected");
    assert.deepEqual((await scope.getItems()).map(item => item.id), [10]);
  } finally { await f.close(); }
});

test("knowledge select-all follows visible sibling scopes and restores native callbacks on disposal", async () => {
  const f = await treeFixture({ seedFolders: true });
  try {
    const first = await f.service.createFolder("First", f.target);
    const second = await f.service.createFolder("Second", f.target);
    await f.libraryTree.select(`Kknowledgemcp:folder:${first}`);
    await f.view._handleSelectAll();
    await f.pane.onCollectionSelected();
    assert.deepEqual(f.view.getSelectedRows().map(row => row.id), [f.seeded[0], first, second].map(id => `Kknowledgemcp:folder:${id}`));
    assert.equal(f.state.nativeSelectAll, 0);
    assert.equal(f.pane.getCollectionTreeRows()[0].getName(), "3 knowledge folders selected");
    f.view.selection.select(0);
    await f.view._handleSelectAll();
    assert.equal(f.state.nativeSelectAll, 1);
    f.libraryTree.dispose();
    assert.equal(f.view._handleSelectAll, f.originalSelectAll);
    assert.equal(f.pane.getCollectionTreeRows, f.originalPaneRows);
  } finally { await f.close(); }
});

test("native mixed selections and knowledge root/folder mixtures retain native compatibility rules", async () => {
  const f = await treeFixture({ seedFolders: true });
  try {
    const library = `Kknowledgemcp:library:${f.target.libraryID}`;
    const folder = `Kknowledgemcp:folder:${f.seeded[0]}`;
    for (const ids of [["L1", folder], [library, folder], ["Kknowledgemcp:overview", folder]]) {
      f.view.selection.selected = new Set(ids.map(id => f.index(id))); f.view.selection.focused = f.index(folder);
      assert.equal(f.pane.getCollectionTreeRows().length, 2);
      await f.pane.onCollectionSelected();
      assert.deepEqual(f.view.getSelectedRows().map(row => row.id), [folder]);
    }
  } finally { await f.close(); }
});

test("knowledge Trash survives service restart and restores only the removed location with stable identities", async () => {
  const f = await fixture();
  let restarted;
  try {
    const folder = { ...f.target, nodeID: await f.service.createFolder("Methods", f.target) };
    const [{ resourceID }] = await f.service.add([10], folder);
    const other = { libraryID: await f.service.createLibrary("Other"), nodeID: null };
    await f.service.add([10], other);
    await f.service.remove([10], folder);
    const [entry] = f.service.snapshot.trash;
    assert.equal(entry.kind, "item"); assert.equal(entry.location, "Default Knowledge Base › Methods");
    assert.equal(f.service.snapshot.trashedResources[0].id, resourceID);
    assert.deepEqual(f.service.snapshot.memberships.map(row => row.libraryID), [other.libraryID]);
    await f.service.close();
    restarted = new KnowledgeLibraryService(f.db, f.port); await restarted.start();
    assert.equal(restarted.snapshot.trash[0].id, entry.id);
    await restarted.restoreTrash([entry.id, entry.id]);
    assert.equal(restarted.snapshot.trash.length, 0);
    assert.equal(restarted.snapshot.resources[0].id, resourceID);
    assert.deepEqual(new Set(restarted.snapshot.memberships.map(row => row.libraryID)), new Set([folder.libraryID, other.libraryID]));
    const version = restarted.snapshot.resources[0].version;
    await restarted.restoreTrash([entry.id]);
    assert.equal(restarted.snapshot.resources[0].version, version, "retry does not duplicate restoration");
    assert.equal((await f.db.selectFrom("resource_sources").selectAll().execute()).length, 1);
  } finally { await restarted?.close(); await f.close(); }
});

test("folder Trash restores its complete hierarchy and original placements while retaining library items", async () => {
  const f = await fixture();
  try {
    const parent = { ...f.target, nodeID: await f.service.createFolder("Parent", f.target) };
    const child = { ...f.target, nodeID: await f.service.createFolder("Child", parent) };
    await f.service.add([10], child);
    await f.service.deleteFolder(parent);
    assert.equal(f.service.snapshot.folders.length, 0);
    assert.equal(f.service.snapshot.memberships[0].nodeID, null);
    const entry = f.service.snapshot.trash[0];
    assert.equal(entry.kind, "folder");
    await f.service.restoreTrash([entry.id]);
    assert.equal(f.service.snapshot.folders.find(row => row.id === child.nodeID).parentID, parent.nodeID);
    assert.ok(f.service.snapshot.memberships.some(row => row.nodeID === child.nodeID));
    assert.equal(f.service.snapshot.resources.length, 1);
    assert.equal(f.service.snapshot.trash.length, 0);
  } finally { await f.close(); }
});

test("restoring an earlier item removal also restores its subsequently trashed parent and library", async () => {
  const f = await fixture();
  try {
    const folder = { ...f.target, nodeID: await f.service.createFolder("Parent", f.target) };
    await f.service.add([10], folder);
    await f.service.remove([10], f.target);
    const itemEntry = f.service.snapshot.trash[0];
    await f.service.deleteFolder(folder);
    await f.service.deleteLibrary(f.target.libraryID, true);
    await f.service.restoreTrash([itemEntry.id]);
    assert.equal(f.service.snapshot.libraries[0].id, f.target.libraryID);
    assert.equal(f.service.snapshot.libraries[0].isDefault, true);
    assert.equal(f.service.snapshot.folders[0].id, folder.nodeID);
    assert.equal(f.service.snapshot.memberships[0].nodeID, folder.nodeID);
    assert.equal(f.service.snapshot.trash.length, 0);
  } finally { await f.close(); }
});

test("restoring a deleted library recovers exclusive knowledge data and preserves shared resources and the current default", async () => {
  const f = await fixture();
  try {
    const child = { ...f.target, nodeID: await f.service.createFolder("Child", f.target) };
    await f.service.add([10], child);
    f.inputs.set(20, { ...structuredClone(f.input), itemID: 20, key: "SHARED20", attachments: [] });
    await f.service.add([20], f.target);
    const other = { libraryID: await f.service.createLibrary("Other"), nodeID: null };
    await f.service.add([20], other);
    await f.service.deleteLibrary(f.target.libraryID, true);
    assert.equal((await f.db.selectFrom("knowledge_resources").select("id").where("status", "=", "deleted").execute()).length, 1);
    await f.service.restoreTrash(f.service.snapshot.trash.map(entry => entry.id));
    assert.equal(f.service.snapshot.resources.length, 2);
    assert.equal(f.service.snapshot.folders[0].id, child.nodeID);
    assert.equal(f.service.snapshot.libraries.find(row => row.isDefault).id, other.libraryID);
    assert.equal(f.service.snapshot.memberships.length, 3);
  } finally { await f.close(); }
});

test("Trash restore conflicts roll back the complete batch and preserve both current folders and recovery entries", async () => {
  const f = await fixture();
  try {
    const first = { ...f.target, nodeID: await f.service.createFolder("First", f.target) };
    const second = { ...f.target, nodeID: await f.service.createFolder("Second", f.target) };
    await f.service.add([10], first); await f.service.add([10], second);
    await f.service.deleteFolder(first); await f.service.deleteFolder(second);
    const conflict = await f.service.createFolder("Second", f.target);
    const entries = f.service.snapshot.trash;
    await assert.rejects(() => f.service.restoreTrash([entries.find(row => row.name === "First").id, entries.find(row => row.name === "Second").id]), /folder named “Second” already exists/);
    assert.deepEqual(f.service.snapshot.folders.map(row => row.id), [conflict]);
    assert.equal(f.service.snapshot.trash.length, 2);
    assert.equal((await f.db.selectFrom("library_nodes").select("id").where("deleted_at", "is", null).execute()).length, 1);
    await f.service.deleteFolder({ ...f.target, nodeID: conflict });
    await f.service.restoreTrash(entries.map(entry => entry.id));
    assert.equal(f.service.snapshot.folders.length, 2);
  } finally { await f.close(); }
});

test("library name conflicts and native write failures preserve recoverable Trash records atomically", async () => {
  let fail = false;
  const f = await fixture({ fail: sql => fail && /^insert into "change_outbox"/.test(sql) });
  try {
    await f.service.add([10], f.target);
    await f.service.deleteLibrary(f.target.libraryID, true);
    const entry = f.service.snapshot.trash[0];
    const conflict = await f.service.createLibrary("Default Knowledge Base");
    await assert.rejects(() => f.service.restoreTrash([entry.id]), /library named.*already exists/);
    await f.service.deleteLibrary(conflict, false);
    fail = true;
    await assert.rejects(() => f.service.restoreTrash([entry.id]), /Injected/);
    assert.equal((await f.db.selectFrom("knowledge_libraries").select("id").where("deleted_at", "is", null).execute()).length, 0);
    assert.equal(f.service.snapshot.trash.length, 2);
    fail = false;
    await f.service.restoreTrash([entry.id]);
    assert.equal(f.service.snapshot.resources.length, 1);
    assert.equal(f.service.snapshot.libraries[0].id, f.target.libraryID);
  } finally { await f.close(); }
});

test("readmission consumes only the matching item Trash entry and trashed metadata reconciles without re-admission", async () => {
  const f = await fixture();
  try {
    const folder = { ...f.target, nodeID: await f.service.createFolder("Folder", f.target) };
    await f.service.add([10], folder); await f.service.remove([10], folder);
    f.input.title = "Edited while only in knowledge Trash";
    await f.service.refresh();
    assert.equal(f.service.snapshot.resources.length, 0);
    assert.equal(f.service.snapshot.trashedResources[0].title, f.input.title);
    await f.service.add([10], f.target);
    assert.equal(f.service.snapshot.trash.length, 1, "root admission leaves the removed folder location recoverable");
    await f.service.add([10], folder);
    assert.equal(f.service.snapshot.trash.length, 0);
  } finally { await f.close(); }
});

test("the knowledge Trash view scopes and filters removed items, keeps offline entries, and exposes no active admission target", async () => {
  const f = await treeFixture();
  try {
    f.inputs.set(20, { ...structuredClone(f.input), itemID: 20, key: "OTHER20", title: "Other paper", attachments: [] });
    await f.service.add([10, 20], f.target); await f.service.remove([10], f.target);
    installKnowledgeSearch(f);
    await f.libraryTree.select("Kknowledgemcp:trash");
    const row = f.view.getSelectedRows()[0];
    assert.equal(f.view.getIconName(f.index(row.id)), "trash-full");
    assert.equal(f.libraryTree.selectedTarget(), undefined);
    assert.deepEqual((await row.getItems()).map(item => item.id), [10]);
    row.searchText = "No match"; assert.deepEqual(await row.getItems(), []);
    assert.deepEqual((await row.getItems({ unfiltered: true })).map(item => item.id), [10]);
    const entry = f.service.snapshot.trash[0];
    assert.equal(await f.libraryTree.select(`Kknowledgemcp:trash:${entry.id}`), false, "Trash has no left-tree child entries");
    f.pane.itemsView.getSelectedObjects = () => [globalThis.Zotero.Items.get(10)];
    assert.deepEqual(f.libraryTree.selectedTrashIDs(), [entry.id]);
    globalThis.Zotero.Items.get = () => false;
    row.searchText = "";
    const [offline] = await f.view.getSelectedRows()[0].getItems();
    assert.equal(offline.knowledgeTrashResourceID, entry.resourceIDs[0]);
    f.pane.itemsView.getSelectedObjects = () => [offline];
    assert.equal(f.libraryTree.selectedTrashIDs().length, 1, "missing native originals do not hide the restore entry");
    await f.service.restoreTrash([entry.id]); await f.libraryTree.refresh();
    assert.equal(f.view.getIconName(f.index("Kknowledgemcp:trash")), "trash");
  } finally { await f.close(); }
});

test("partial readmission after removal from a library keeps all original folder placements recoverable", async () => {
  const f = await fixture();
  try {
    const first = { ...f.target, nodeID: await f.service.createFolder("First", f.target) };
    const second = { ...f.target, nodeID: await f.service.createFolder("Second", f.target) };
    await f.service.add([10], first); await f.service.add([10], second);
    await f.service.remove([10], f.target);
    const entry = f.service.snapshot.trash[0];
    await f.service.add([10], f.target);
    assert.equal(f.service.snapshot.trash.length, 1, "root readmission must not discard original folder recovery");
    await f.service.add([10], first);
    assert.equal(f.service.snapshot.trash.length, 1, "a partial folder readmission leaves the other recoverable");
    await f.service.restoreTrash([entry.id]);
    assert.equal(f.service.snapshot.trash.length, 0);
    assert.deepEqual(new Set(f.service.snapshot.memberships.map(row => row.nodeID)), new Set([null, first.nodeID, second.nodeID]));
  } finally { await f.close(); }
});

test("large Trash lists render row types without repeated entry scans and preserve filtering and cleanup", () => {
  const previousZotero = globalThis.Zotero;
  const dom = new JSDOM("<html><body></body></html>");
  const entries = Array.from({ length: 2400 }, (_, index) => ({
    id: `trash-${index}`, kind: ["folder", "library", "item"][index % 3], name: `Alpha Beta ${index}`,
    target: { libraryID: "library", nodeID: null }, resourceIDs: [`resource-${index}`], location: "Library", deletedAt: 1
  }));
  const snapshot = { trash: entries, trashedResources: [] };
  const controller = { snapshot };
  const icon = name => { const node = dom.window.document.createElement("span"); node.dataset.icon = name; return node; };
  const createRow = ref => ({ ref, isObjectRow: true, getIcon: () => icon("folder") });
  const provider = { createRow };
  let selected = [];
  const window = Object.assign(dom.window, { ZoteroPane: {
    itemsView: { rowProvider: provider, getSelectedObjects: () => selected }, getCollectionTreeRows: () => []
  }, require: () => ({ getCSSIcon: icon, getCSSItemTypeIcon: icon }) });
  globalThis.Zotero = { Collection: class {}, Items: { get: () => false }, Libraries: { userLibraryID: 1 } };
  const list = new KnowledgeTrashList(window, controller);
  try {
    const row = { searchText: "", tags: new Set() };
    const objects = list.objects(row, [], false);
    assert.equal(objects.length, entries.length);
    const originalFind = entries.find;
    entries.find = () => { throw new Error("A row must not scan the entire Trash snapshot"); };
    for (const object of objects) {
      const native = provider.createRow(object);
      assert.equal(native.getTypeLabel(), object.knowledgeTrashKind === "folder" ? "Folder"
        : object.knowledgeTrashKind === "library" ? "Knowledge Library" : "Document");
      assert.equal(native.getIcon().dataset.icon, object.knowledgeTrashKind === "folder" ? "folder"
        : object.knowledgeTrashKind === "library" ? "km-knowledge" : "document");
    }
    entries.find = originalFind;
    row.searchText = " ALPHA   beta ";
    assert.equal(list.objects(row, [], false).length, entries.length);
    row.searchText = "alpha absent";
    assert.equal(list.objects(row, [], false).length, 0, "every search word must match");
    assert.equal(list.objects(row, [], true).length, entries.length, "unfiltered reads bypass quicksearch");
    row.searchText = ""; row.tags.add("tag");
    assert.equal(list.objects(row, [], false).length, 0, "item-only tag filters still hide synthetic rows");
    row.tags.clear(); row.advancedSearch = {};
    assert.equal(list.objects(row, [], false).length, 0);
    row.advancedSearch = null;
    entries[0].name = "Updated title";
    assert.equal(list.objects(row, [], false)[0], objects[0], "refresh preserves reference identities");
    assert.equal(objects[0].name, "Updated title");
    selected = [objects[0], objects[0]];
    assert.deepEqual(list.selectedEntryIDs(), [entries[0].id]);
    selected = [];
    controller.snapshot = { get trash() { throw new Error("Empty selection must not index Trash"); } };
    assert.deepEqual(list.selectedEntryIDs(), []);
  } finally {
    list.dispose();
    assert.equal(provider.createRow, createRow);
    dom.window.close(); globalThis.Zotero = previousZotero;
  }
});

test("knowledge Trash mixes deleted folders and items in one flat native list and restores the selected objects", async () => {
  const f = await treeFixture({ seedFolders: true });
  try {
    const child = { ...f.target, nodeID: f.seeded[1] };
    await f.service.add([10], child); await f.service.remove([10], f.target);
    await f.service.deleteFolder({ ...f.target, nodeID: f.seeded[0] });
    installKnowledgeSearch(f);
    await f.libraryTree.select("Kknowledgemcp:trash");
    const row = f.view.getSelectedRows()[0];
    assert.equal(row.isContainer(), false);
    assert.equal(f.view.isContainerEmpty(f.index(row.id)), true);
    assert.ok(!f.view._rows.some(row => row.id.startsWith("Kknowledgemcp:trash:")));
    const objects = await row.getItems();
    assert.equal(objects.length, 2, "one native item and one folder row, without duplicating folder contents");
    const folder = objects.find(object => object.knowledgeTrashID);
    assert.ok(folder instanceof globalThis.Zotero.Collection);
    assert.equal(folder.name, "Parent");
    assert.equal(typeof folder.id, "string");
    assert.equal(folder.isEmbeddedImageAttachment(), false, "native item filtering runs before collection rows are normally appended");
    assert.equal(folder.getField("date"), "", "native date sorting accepts a folder row");
    await assert.rejects(() => folder.saveTx(), /knowledge Trash restore action/);
    assert.equal((await row.getItems()).find(object => object.knowledgeTrashID), folder, "references remain stable across refresh");
    row.searchText = "parent";
    assert.deepEqual((await row.getItems()).map(object => object.name), ["Parent"]);
    row.searchText = "synthetic";
    assert.deepEqual((await row.getItems()).map(object => object.id), [10]);
    row.searchText = ""; row.tags = new Set(["methods"]);
    assert.deepEqual((await row.getItems()).map(object => object.id), [10], "item-only filtering hides folders like native Trash");
    row.tags.clear();
    f.pane.itemsView.getSelectedObjects = () => objects;
    const selected = f.libraryTree.selectedTrashIDs();
    assert.equal(selected.length, 2, "mixed selection covers exactly the folder and removed item");
    await f.service.restoreTrash(selected); await f.libraryTree.refresh();
    assert.equal(f.service.snapshot.trash.length, 0);
    assert.ok(f.service.snapshot.memberships.some(member => member.nodeID === child.nodeID));
    assert.equal(f.service.snapshot.folders.find(folder => folder.id === child.nodeID).parentID, f.seeded[0]);
  } finally { await f.close(); }
});

test("expansion preferences preserve nested and nondefault libraries plus a collapsed overview across tree recreation", async () => {
  const f = await treeFixture({ seedFolders: true });
  let current = f.libraryTree;
  try {
    const preferences = new Map();
    globalThis.Zotero.Prefs = { get: name => preferences.get(name), set: (name, value) => preferences.set(name, value) };
    const other = await f.service.createLibrary("Other");
    const otherChild = await f.service.createFolder("Other child", { libraryID: other, nodeID: null });
    await current.select(`Kknowledgemcp:folder:${f.seeded[1]}`);
    await current.select(`Kknowledgemcp:folder:${otherChild}`);
    await f.view.toggleOpenState(f.index(`Kknowledgemcp:library:${f.target.libraryID}`));
    current.dispose();
    current = new KnowledgeLibraryTree(f.window, f.service, () => {}, async () => {});
    assert.equal(f.view.getRow(f.index(`Kknowledgemcp:library:${f.target.libraryID}`)).isOpen, false);
    assert.ok(f.index(`Kknowledgemcp:folder:${otherChild}`) >= 0);
    await f.view.toggleOpenState(f.index(`Kknowledgemcp:library:${f.target.libraryID}`));
    assert.ok(f.index(`Kknowledgemcp:folder:${f.seeded[1]}`) >= 0, "hidden child expansion is retained");
    f.view._closeContainer(f.index("Kknowledgemcp:overview"));
    current.dispose(); current = new KnowledgeLibraryTree(f.window, f.service, () => {}, async () => {});
    assert.equal(f.view.getRow(f.index("Kknowledgemcp:overview")).isOpen, false);
    assert.equal(f.index(`Kknowledgemcp:library:${f.target.libraryID}`), -1);
  } finally { current.dispose(); await f.close(); }
});

test("invalid expansion preferences fall back safely and empty persisted expansion stays collapsed", async () => {
  const f = await treeFixture();
  let current = f.libraryTree;
  try {
    let value = '{"open":[5],"knownLibraries":[]}';
    globalThis.Zotero.Prefs = { get: () => value, set: (_name, saved) => { value = saved; } };
    current.dispose(); current = new KnowledgeLibraryTree(f.window, f.service, () => {}, async () => {});
    assert.equal(f.view.getRow(f.index("Kknowledgemcp:overview")).isOpen, true);
    value = JSON.stringify({ open: [], knownLibraries: [`Kknowledgemcp:library:${f.target.libraryID}`] });
    current.dispose(); current = new KnowledgeLibraryTree(f.window, f.service, () => {}, async () => {});
    assert.equal(f.view.getRow(f.index("Kknowledgemcp:overview")).isOpen, false);
    assert.equal(f.index(`Kknowledgemcp:library:${f.target.libraryID}`), -1);
  } finally { current.dispose(); await f.close(); }
});

test("moving to knowledge Trash removes all folder placements in the selected libraries atomically", async () => {
  const f = await fixture();
  try {
    const first = { ...f.target, nodeID: await f.service.createFolder("First", f.target) };
    const second = { ...f.target, nodeID: await f.service.createFolder("Second", f.target) };
    const other = { libraryID: await f.service.createLibrary("Other"), nodeID: null };
    await f.service.add([10], first); await f.service.add([10], second); await f.service.add([10], other);
    await assert.rejects(() => f.service.moveToTrash([10], [f.target.libraryID, "unavailable"]), /unavailable/);
    assert.equal(f.service.snapshot.memberships.length, 3);
    assert.equal((await f.db.selectFrom("knowledge_trash_entries").select("id").execute()).length, 0);
    await f.service.moveToTrash([10, 10], [f.target.libraryID, f.target.libraryID]);
    assert.deepEqual(f.service.snapshot.memberships.map(row => row.libraryID), [other.libraryID]);
    assert.equal(f.service.snapshot.trash.length, 1);
    await f.service.restoreTrash(f.service.snapshot.trash.map(entry => entry.id));
    assert.equal(f.service.snapshot.memberships.length, 3);
  } finally { await f.close(); }
});

test("permanent Trash deletion survives restart and removes unreferenced resource data", async () => {
  const f = await fixture(); let restarted;
  try {
    const [{ resourceID }] = await f.service.add([10], f.target);
    await f.service.moveToTrash([10], [f.target.libraryID]);
    const [entry] = f.service.snapshot.trash;
    await f.service.purgeTrash([entry.id, entry.id]);
    assert.equal(f.service.snapshot.trash.length, 0);
    assert.equal(await f.db.selectFrom("knowledge_resources").select("id").where("id", "=", resourceID).executeTakeFirst(), undefined);
    assert.equal((await f.db.selectFrom("zotero_item_links").selectAll().execute()).length, 0);
    assert.equal((await f.db.selectFrom("resource_revisions").selectAll().execute()).length, 0);
    assert.deepEqual(f.nativeDB.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    await f.service.close(); restarted = new KnowledgeLibraryService(f.db, f.port); await restarted.start();
    await restarted.restoreTrash([entry.id]);
    assert.equal(restarted.snapshot.trash.length, 0); assert.equal(restarted.snapshot.resources.length, 0);
    const [{ resourceID: readmitted }] = await restarted.add([10], f.target);
    assert.notEqual(readmitted, resourceID, "readmission creates a fresh resource after permanent deletion");
  } finally { await restarted?.close(); await f.close(); }
});

test("permanently deleting a folder preserves library items and restores independently removed items at the root", async () => {
  const f = await fixture();
  try {
    const parent = { ...f.target, nodeID: await f.service.createFolder("Parent", f.target) };
    const child = { ...f.target, nodeID: await f.service.createFolder("Child", parent) };
    await f.service.add([10], child); await f.service.moveToTrash([10], [f.target.libraryID]);
    f.inputs.set(20, { ...structuredClone(f.input), itemID: 20, key: "RETAIN20", attachments: [] });
    const [{ resourceID: retained }] = await f.service.add([20], child);
    const item = f.service.snapshot.trash.find(entry => entry.kind === "item");
    await f.service.deleteFolder(child); await f.service.deleteFolder(parent);
    const folder = f.service.snapshot.trash.find(entry => entry.kind === "folder" && entry.target.nodeID === parent.nodeID);
    await f.service.purgeTrash([folder.id]);
    assert.deepEqual(f.service.snapshot.trash.map(entry => entry.id), [item.id], "deleted descendant folders are included but independent items remain recoverable");
    await f.service.restoreTrash([item.id]);
    assert.equal(f.service.snapshot.folders.length, 0);
    assert.deepEqual(f.service.snapshot.memberships.map(row => row.nodeID), [null, null]);
    assert.equal((await f.db.selectFrom("knowledge_resources").select("status").where("id", "=", retained).executeTakeFirstOrThrow()).status, "active");
    assert.deepEqual(f.nativeDB.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await f.close(); }
});

test("permanently deleting a library clears its older Trash entries while protecting shared active data", async () => {
  const f = await fixture();
  try {
    const [{ resourceID }] = await f.service.add([10], f.target);
    const other = { libraryID: await f.service.createLibrary("Other"), nodeID: null };
    await f.service.add([10], other);
    const folder = { ...f.target, nodeID: await f.service.createFolder("Earlier folder", f.target) };
    await f.service.deleteFolder(folder);
    await f.service.moveToTrash([10], [f.target.libraryID]);
    await f.service.deleteLibrary(f.target.libraryID, true);
    const library = f.service.snapshot.trash.find(entry => entry.kind === "library");
    await f.service.purgeTrash([library.id]);
    assert.equal(f.service.snapshot.trash.length, 0);
    assert.deepEqual(f.service.snapshot.memberships.map(row => row.libraryID), [other.libraryID]);
    assert.equal((await f.db.selectFrom("knowledge_resources").select("status").where("id", "=", resourceID).executeTakeFirstOrThrow()).status, "active");
    assert.deepEqual(f.nativeDB.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await f.close(); }
});

test("permanent item deletion removes overlapping recovery placements without changing active memberships", async () => {
  const f = await fixture();
  try {
    const first = { ...f.target, nodeID: await f.service.createFolder("First", f.target) };
    const second = { ...f.target, nodeID: await f.service.createFolder("Second", f.target) };
    await f.service.add([10], first); await f.service.add([10], second);
    await f.service.moveToTrash([10], [f.target.libraryID]);
    const item = f.service.snapshot.trash.find(entry => entry.kind === "item");
    await f.service.add([10], first); await f.service.deleteFolder(first);
    const folder = f.service.snapshot.trash.find(entry => entry.kind === "folder");
    await f.service.purgeTrash([item.id]);
    assert.equal(f.service.snapshot.trash.find(entry => entry.id === folder.id).resourceIDs.length, 0);
    await f.service.restoreTrash([folder.id]);
    assert.deepEqual(f.service.snapshot.memberships.map(row => row.nodeID), [null]);
    assert.equal(f.service.snapshot.resources.length, 1);
  } finally { await f.close(); }
});

test("purging one library preserves recoverability of a shared resource in another library's Trash", async () => {
  const f = await fixture();
  try {
    const [{ resourceID }] = await f.service.add([10], f.target);
    const other = { libraryID: await f.service.createLibrary("Other"), nodeID: null };
    await f.service.add([10], other); await f.service.moveToTrash([10], [other.libraryID]);
    const item = f.service.snapshot.trash.find(entry => entry.kind === "item");
    await f.service.deleteLibrary(f.target.libraryID, true);
    await f.service.purgeTrash([f.service.snapshot.trash.find(entry => entry.kind === "library").id]);
    assert.deepEqual(f.service.snapshot.trash.map(entry => entry.id), [item.id]);
    await f.service.restoreTrash([item.id]);
    assert.equal(f.service.snapshot.resources[0].id, resourceID);
    assert.equal(f.service.snapshot.memberships[0].libraryID, other.libraryID);
    assert.deepEqual(f.nativeDB.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await f.close(); }
});

test("failed permanent deletion rolls back recovery records and resource state together", async () => {
  let fail = false;
  const f = await fixture({ fail: sql => fail && /^delete from "knowledge_resources"/.test(sql) });
  try {
    const [{ resourceID }] = await f.service.add([10], f.target);
    await f.service.moveToTrash([10], [f.target.libraryID]);
    const [entry] = f.service.snapshot.trash;
    fail = true; await assert.rejects(() => f.service.purgeTrash([entry.id]), /Injected/);
    assert.equal((await f.db.selectFrom("knowledge_trash_entries").select("id").where("id", "=", entry.id).execute()).length, 1);
    assert.equal((await f.db.selectFrom("knowledge_resources").select("status").where("id", "=", resourceID).executeTakeFirstOrThrow()).status, "active");
    fail = false; await f.service.purgeTrash([entry.id]);
    await f.service.purgeTrash([entry.id]);
    assert.equal(await f.db.selectFrom("knowledge_resources").select("id").where("id", "=", resourceID).executeTakeFirst(), undefined);
  } finally { await f.close(); }
});

test("aggregate Trash resources beyond SQLite's variable limit refresh and restart without duplicating anchor items", async () => {
  const f = await fixture(); let restarted;
  try {
    const [{ resourceID }] = await f.service.add([10], f.target);
    const other = { libraryID: await f.service.createLibrary("Other recovery location"), nodeID: null };
    await f.service.add([10], other);
    f.inputs.set(20, { ...structuredClone(f.input), itemID: 20, key: "ARTICLE2", attachments: [] });
    const [{ resourceID: activeID }] = await f.service.add([20], f.target);
    await f.service.moveToTrash([10], [f.target.libraryID, other.libraryID]);
    const libraryIDs = [];
    for (let index = 0; index < 5; index++) libraryIDs.push(await f.service.createLibrary(`Large recovery ${index}`));
    const sqlite = f.nativeDB.sqlite, count = 32770;
    const sequence = `WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n+1<${count})`;
    sqlite.exec(`
      ${sequence} INSERT INTO knowledge_resources(id,title,resource_type,metadata_authority,created_at,updated_at)
        SELECT 'aggregate-resource-'||n,'Synthetic paper '||n,'article','import',1,1 FROM seq;
    `);
    // Five independently deleted libraries stay below the per-operation query limit.
    // Most sources are no longer mapped to Zotero; the two item entries share one live anchor.
    await f.db.transaction().execute(async tx => {
      for (let index = 0; index < libraryIDs.length; index++) {
        const start = index * 8191, end = Math.min(start + 8191, count), entryID = `aggregate-trash-${index}`;
        await tx.updateTable("knowledge_libraries").set({ status: "deleted", deleted_at: 1 }).where("id", "=", libraryIDs[index]).execute();
        await tx.insertInto("knowledge_trash_entries").values({ id: entryID, kind: "library", name: `Large recovery ${index}`,
          library_id: libraryIDs[index], node_id: null, location: `Large recovery ${index}`, deleted_at: 1 }).execute();
        // Seed synthetic bulk references with SQLite, independently of the read query under test.
        sqlite.prepare(`${sequence} INSERT INTO library_resources(id,library_id,resource_id,added_at,deleted_at)
          SELECT 'aggregate-relation-'||n,?,'aggregate-resource-'||n,1,1 FROM seq WHERE n>=? AND n<?`).run(libraryIDs[index], start, end);
        sqlite.prepare(`${sequence} INSERT INTO knowledge_trash_resources(entry_id,resource_id,position,was_deleted)
          SELECT ?,'aggregate-resource-'||n,n-?,0 FROM seq WHERE n>=? AND n<?`).run(entryID, start, start, end);
      }
    });
    f.input.title = "Refreshed paper still in Trash";
    await f.service.refresh();
    const assertSnapshot = service => {
      assert.equal(service.snapshot.trash.length, 7);
      assert.equal(new Set(service.snapshot.trash.flatMap(entry => entry.resourceIDs)).size, count + 1);
      assert.deepEqual(service.snapshot.trashedResources.map(resource => ({ id: resource.id, title: resource.title, itemID: resource.itemID, state: resource.state })),
        [{ id: resourceID, title: f.input.title, itemID: 10, state: "current" }], "shared recovery references return one current anchor and exclude active-only items");
      assert.deepEqual(service.snapshot.resources.map(resource => resource.id), [activeID]);
    };
    assertSnapshot(f.service);
    await f.service.close();
    restarted = new KnowledgeLibraryService(f.db, f.port); await restarted.start();
    assertSnapshot(restarted);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await restarted?.close(); await f.close(); }
});

test("actual knowledge menus expose move-to-Trash and confirmed permanent deletion for the selected view", async () => {
  const f = await treeFixture(); let ui;
  const previousServices = globalThis.Services;
  try {
    await f.service.add([10], f.target);
    const otherLibrary = await f.service.createLibrary("Other menu target");
    const folder = { ...f.target, nodeID: await f.service.createFolder("Folder", f.target) };
    await f.service.add([10], folder);
    installKnowledgeSearch(f);
    const paper = globalThis.Zotero.Items.get(10);
    Object.assign(paper, { isRegularItem: () => true, isAttachment: () => false });
    const dom = new JSDOM('<html><head></head><body><div id="zotero-itemmenu"></div><div id="zotero-collectionmenu"></div></body></html>');
    f.window.document = dom.window.document;
    for (const node of f.window.document.querySelectorAll("[id]")) Object.defineProperty(node, "ownerGlobal", { value: f.window });
    let selected = [paper];
    f.pane.getSelectedItems = () => selected.filter(object => typeof object.id === "number");
    f.pane.itemsView.getSelectedObjects = () => selected;
    f.pane.itemsView._renderCell = () => f.window.document.createElement("span");
    const menus = new Map();
    globalThis.Zotero.ItemPaneManager = { registerSection: () => "section", unregisterSection() {} };
    globalThis.Zotero.MenuManager = { registerMenu(options) { menus.set(options.target, options); return options.target; }, unregisterMenu(id) { menus.delete(id); }, updateMenuPopup() {} };
    globalThis.Zotero.getMainWindows = () => [f.window];
    f.libraryTree.dispose(); ui = new KnowledgeLibraryUI("test", "file:///test/", f.service); ui.start();
    for (const registration of menus.values()) {
      for (const entry of registration.menus.filter(entry => entry.menuType !== "separator")) {
        assert.equal(entry.icon, "file:///test/content/ui/knowledge.svg", `${entry.l10nID} uses the plugin logo`);
      }
    }
    const menu = id => menus.get("main/library/item").menus.find(entry => entry.l10nID === id);
    const context = () => ({ menuElem: f.window.document.getElementById("zotero-itemmenu"), items: f.pane.getSelectedItems(),
      collectionTreeRows: f.pane.getCollectionTreeRows(), setVisible(value) { this.visible = value; } });
    const visible = id => { const ctx = context(); menu(id).onShowing(null, ctx); return ctx.visible; };
    const assertAdmissionVisible = expected => {
      for (const id of ["knowledgemcp-add-default", "knowledgemcp-add-to"]) {
        assert.equal(visible(id), expected, `${id} visibility for ${f.pane.getCollectionTreeRows().map(row => row.id)}`);
      }
    };
    const wait = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail("UI command did not complete"); };
    await f.view.selectByID("Kknowledgemcp:overview");
    assertAdmissionVisible(false);
    assert.equal(visible("knowledgemcp-remove-library"), true, "the overview also has an explicit move-to-Trash action");
    await f.view.selectByID(`Kknowledgemcp:library:${f.target.libraryID}`);
    assertAdmissionVisible(false);
    f.view.selection.selected = new Set([f.target.libraryID, otherLibrary].map(id => f.index(`Kknowledgemcp:library:${id}`)));
    await f.pane.onCollectionSelected();
    assertAdmissionVisible(false);
    await f.view.selectByID(`Kknowledgemcp:folder:${folder.nodeID}`);
    assertAdmissionVisible(false);
    const fallbackContext = context(); delete fallbackContext.collectionTreeRows;
    menu("knowledgemcp-add-to").onShowing(null, fallbackContext);
    assert.equal(fallbackContext.visible, false, "missing menu scope falls back to the current pane scope");
    assert.equal(visible("knowledgemcp-remove-library"), true);
    menu("knowledgemcp-remove-library").onCommand(null, context());
    await wait(() => f.service.snapshot.trash.length === 1);
    assert.equal(f.service.snapshot.memberships.length, 0, "moving from a folder removes root and sibling placements in the same library");
    await f.view.selectByID("L1"); assert.equal(visible("knowledgemcp-remove-library"), false);
    assertAdmissionVisible(true);
    selected = []; assertAdmissionVisible(false); selected = [paper];
    await f.view.selectByID("Kknowledgemcp:trash");
    assertAdmissionVisible(false);
    assert.equal(visible("knowledgemcp-remove-library"), false);
    assert.equal(visible("knowledgemcp-purge-items"), true);
    let decision = 1; let confirmation;
    globalThis.Services = { prompt: { BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_TITLE_IS_STRING: 127, BUTTON_TITLE_CANCEL: 2, BUTTON_POS_1_DEFAULT: 16777216,
      confirmEx(...args) { confirmation = args; return decision; } } };
    menu("knowledgemcp-purge-items").onCommand(null, context());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service.snapshot.trash.length, 1, "cancel keeps the item recoverable");
    assert.match(confirmation[2], /cannot be undone/); assert.match(confirmation[2], /Zotero items and original attachments will be kept/);
    decision = 0; menu("knowledgemcp-purge-items").onCommand(null, context());
    await wait(() => f.service.snapshot.trash.length === 0);
    assert.equal(paper.deleted, false);
    selected = []; assert.equal(visible("knowledgemcp-purge-items"), false);
    await f.service.deleteFolder(folder);
    const [folderObject] = await f.view.getSelectedRows()[0].getItems(); selected = [folderObject];
    assert.equal(visible("knowledgemcp-purge-items"), true, "folder rows have the same permanent-delete menu as literature");
  } finally { ui?.dispose(); globalThis.Services = previousServices; await f.close(); }
});
