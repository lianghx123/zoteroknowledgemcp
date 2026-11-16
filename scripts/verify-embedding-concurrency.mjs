// Developer-driven native checks with synthetic content and model responses only.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate, runtimeRootURI } from "./verify-vector-native.mjs";

const folder = path.resolve(".scaffold/embedding-concurrency"), run = `native-${Date.now()}`;
const state = JSON.parse(await evaluate("JSON.stringify({dir: Zotero.DataDirectory.dir, version: Zotero.version})"));
if (!/[\\/]\.scaffold[\\/]/i.test(state.dir)) throw new Error("Isolated development Zotero required");
await fs.mkdir(folder, { recursive: true });
await build({ stdin: { loader: "ts", resolveDir: process.cwd(), contents: `
import { initializeDatabase } from "./src/database/client.ts";
import { KnowledgeLibraryRepository } from "./src/repositories/knowledge-library.ts";
import { ProcessingRepository } from "./src/repositories/processing.ts";
import { ZoteroParsingPort } from "./src/integrations/zotero/parsing-port.ts";
import { EmbeddingService } from "./src/services/embedding.ts";
import { defaultRetrievalConfig, RetrievalConfigFile } from "./src/services/retrieval-config.ts";
import { RetrievalService } from "./src/services/retrieval.ts";
import { normalizedVector } from "./src/providers/models.ts";
import { spaceKey } from "./src/shared/contracts/retrieval.ts";
import { cleanupFiles } from "./src/storage/file-cleanup.ts";
import { VectorStore } from "./src/services/vector-store.ts";
import { ParsingService } from "./src/services/parsing.ts";
import { CollectionSyncService } from "./src/services/collection-sync.ts";
import { ImportTasksService } from "./src/services/import-tasks.ts";
import { ImportTasksView } from "./src/ui/knowledge/import-tasks.ts";

export async function run(options) {
  const report = { runtime: "Zotero native SQLite, ChromeWorker and filesystem", version: Zotero.version,
    checks: [], providerCalls: 0, started: Date.now(), status: "running" };
  const assert = (value, name) => { if (!value) throw new Error(name); report.checks.push(name); };
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const window = Zotero.getMainWindows()[0], pause = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const write = () => IOUtils.writeUTF8(PathUtils.join(options.folder, options.run + ".json"), JSON.stringify(report, null, 2));
  let database, service, settings, configOwner, restoreWrite, restoreRead, parsing, sync, taskView; const releases = [], work = [];
  try {
    if (!/[\\\\/]\\.scaffold[\\\\/]/i.test(Zotero.DataDirectory.dir)) throw new Error("isolated-library-required");
    const file = PathUtils.join(options.folder, options.run + ".sqlite");
    database = await initializeDatabase(new Zotero.DBConnection(file), file);
    const port = new ZoteroParsingPort(), knowledge = new KnowledgeLibraryRepository(database.db, port);
    await knowledge.initialize();
    const target = { libraryID: (await knowledge.snapshot()).libraries[0].id, nodeID: null };
    const resourceID = await knowledge.save({ library: { localID: 1, type: "user", externalID: null, name: "Synthetic concurrency library", editable: true, filesEditable: true },
      itemID: 990001, key: "CONCUR01", kind: "regular", nativeVersion: 1, modified: "2026-10-28", state: "current", title: "Synthetic concurrency paper",
      itemType: "journalArticle", language: "en", abstract: null, publicationDate: null, contributors: [], fields: {}, tags: [],
      metadataFingerprint: await port.hash("metadata"), fingerprint: await port.hash("source"),
      attachments: [{ key: "CONCPDF1", itemID: 990002, parentKey: "CONCUR01", title: "Synthetic source", mediaType: "application/pdf", linkMode: 0, state: "current" }] }, target);
    const processing = new ProcessingRepository(database.db, port), source = await processing.sourceFor(1, "CONCPDF1");
    const parseInput = { sourceID: source.id, resourceID, libraryID: 1, attachmentKey: "CONCPDF1", title: "Synthetic paper", itemType: "journalArticle", fileName: "synthetic.pdf", target: "Synthetic",
      batch: { id: "sync-history", title: "Synthetic collection", sourceCollection: "Synthetic collection" },
      parser: { profile: "acceptance", api: "https://example.invalid", model: "snapshot", options: {}, normalizer: "synthetic-1" } };
    await processing.enqueue(parseInput, await port.hash("synthetic-pdf"), 3);
    const job = await processing.claim("synthetic-concurrency");
    const text = "Synthetic scientific document text for isolated vector concurrency verification.";
    const document = { normalizerVersion: "synthetic-1", pages: [{ number: 1, raw: {} }],
      blocks: [{ type: "text", label: "text", markdown: text, text, page: 1, sourceID: "synthetic-block" }], total: 1, partial: false, warnings: [], markdown: text };
    await processing.publish(job, document, []);
    service = new EmbeddingService(database.db, options.rootURI);
    Object.defineProperty(service.config, "path", { value: PathUtils.join(options.folder, options.run + "-config.json") });
    service.config.current = { ...JSON.parse(JSON.stringify(defaultRetrievalConfig)), enabled: true };
    service.credentials.get = () => "synthetic-no-network";
    const requests = [], originalReconcile = service.repository.reconcile.bind(service.repository);
    let changed = false;
    service.repository.reconcile = async (...args) => {
      await originalReconcile(...args);
      if (!changed) {
        changed = true; const next = JSON.parse(JSON.stringify(service.config.current));
        // Deliberately retain revision to verify direct external-file edits too.
        next.embedding.model = "synthetic-other-model";
        await IOUtils.writeUTF8(service.config.path, JSON.stringify(next)); await service.config.reload();
      }
    };
    service.gateway.embed = async (texts, _signal, _query, snapshot) => {
      requests.push(snapshot.embedding.model); return texts.map(() => normalizedVector(Array(snapshot.dimensions).fill(1), snapshot.dimensions));
    };
    await service.tick();
    assert(requests.length === 0, "same-revision-configuration-change-before-claim-makes-no-provider-request");
    assert((await database.db.selectFrom("block_embeddings").select("id").execute()).length === 0, "previous-profile-receives-no-new-model-vectors");
    await service.tick();
    const committed = await database.db.selectFrom("block_embeddings as e").innerJoin("embedding_profiles as p", "p.id", "e.profile_id").select("p.model").execute();
    assert(committed.length === 1 && committed[0].model === "synthetic-other-model", "retry-publishes-under-matching-profile");
    const signal = new window.AbortController().signal, vector = normalizedVector(Array(768).fill(1), 768);
    assert((await service.store.search(vector, [resourceID], 20, spaceKey(service.config.current))).length === 1, "matching-space-native-worker-query");
    const other = JSON.parse(JSON.stringify(service.config.current)); other.embedding.model = "synthetic-third-model";
    let rejected = false;
    try { await service.store.search(vector, [resourceID], 20, spaceKey(other)); } catch (error) { rejected = error.code === "initializing"; }
    assert(rejected, "same-dimension-different-space-rejected");
    const retrieval = new RetrievalService(service);
    for (const scopeKind of ["active", "trash"]) {
      if (scopeKind === "trash") await knowledge.moveToTrash([resourceID], [target.libraryID]);
      const reranking = deferred(), finishRerank = deferred(); releases.push(finishRerank.resolve);
      service.gateway.rerank = async (_query, texts) => { reranking.resolve(); await finishRerank.promise; return texts.map((_, index) => ({ index, score: 1 })); };
      const searching = retrieval.search("Synthetic", "enhanced", [resourceID], signal, scopeKind);
      work.push(searching); void searching.catch(() => {}); await reranking.promise;
      if (scopeKind === "active") await knowledge.moveToTrash([resourceID], [target.libraryID]);
      else await knowledge.restoreTrash((await knowledge.snapshot()).trash.map(entry => entry.id));
      finishRerank.resolve(); const result = await searching;
      assert(result.hits.length === 0 && result.coverage.resources === 0, scopeKind + "-scope-revalidated-after-native-rerank-wait");
      if (scopeKind === "active") await knowledge.restoreTrash((await knowledge.snapshot()).trash.map(entry => entry.id));
    }
    service.repository.reconcile = originalReconcile;
    const restore = async () => knowledge.restoreTrash((await knowledge.snapshot()).trash.map(entry => entry.id));
    const task = service.snapshot()[0];
    await service.runAction(task.id, "delete");
    await service.repository.reconcile(service.profile, service.config.current); await service.tick();
    assert(service.snapshot().length === 0, "hidden-native-history-survives-automatic-reconciliation");
    const hidden = await database.db.selectFrom("processing_jobs").select("payload_json").where("id", "=", task.id.slice(6)).executeTakeFirstOrThrow();
    assert(JSON.parse(hidden.payload_json).hidden === true, "native-history-retains-persistent-deduplication");
    await service.enqueue([resourceID]); await service.tick();
    assert(service.snapshot().length === 1, "explicit-native-vectorization-can-create-visible-work");
    await service.clear(service.config.current); await service.enqueue([resourceID]);
    let count = requests.length;
    await knowledge.moveToTrash([resourceID], [target.libraryID]); await service.tick();
    assert(requests.length === count, "native-queued-trash-task-makes-no-provider-request");
    await restore(); await service.tick();
    assert(requests.length === count + 1, "native-restored-task-resumes-missing-vectors");
    await service.clear(service.config.current); await service.enqueue([resourceID]);
    const embed = service.gateway.embed;
    service.gateway.embed = async (...args) => {
      const vectors = await embed(...args); await knowledge.moveToTrash([resourceID], [target.libraryID]); return vectors;
    };
    await service.tick();
    assert((await database.db.selectFrom("block_embeddings").select("id").execute()).length === 0, "native-transaction-rejects-vector-response-after-membership-removal");
    const pending = await database.db.selectFrom("processing_jobs").select(["state", "failure_count"]).where("kind", "=", "embed")
      .where("embedding_profile_id", "=", service.profile).where("state", "=", "pending").execute();
    assert(pending.length === 1 && pending[0].failure_count === 0, "native-membership-loss-remains-recoverable-without-failure");
    service.gateway.embed = embed; await restore(); await service.tick();
    service.gateway.rerank = async (_query, texts) => {
      await processing.enqueue(parseInput, await port.hash("replacement-synthetic-pdf"), 3, true);
      const replacement = await processing.claim("synthetic-replacement");
      await processing.publish(replacement, document, []);
      return texts.map((_, index) => ({ index, score: 1 }));
    };
    const replaced = await retrieval.search("Synthetic", "enhanced", [resourceID], signal);
    assert(replaced.hits.length === 0 && replaced.coverage.parsed === 1 && replaced.coverage.embedded === 0, "native-rerank-replacement-drops-old-generation-and-recomputes-coverage");
    await service.tick();
    const fresh = await retrieval.search("Synthetic", "fulltext", [resourceID], signal);
    const currentSource = await database.db.selectFrom("resource_sources").select("active_generation_id").where("id", "=", source.id).executeTakeFirstOrThrow();
    assert(fresh.hits.length === 1 && fresh.hits[0].evidence.every(row => row.generationID === currentSource.active_generation_id), "native-fresh-search-uses-only-current-generation-evidence");
    retrieval.close();
    settings = new RetrievalConfigFile(); Object.defineProperty(settings, "path", { value: service.config.path }); await settings.reload();
    const readUTF8 = IOUtils.readUTF8, pollStarted = deferred(), finishPoll = deferred();
    releases.push(finishPoll.resolve); let heldPoll = false;
    restoreRead = () => { IOUtils.readUTF8 = readUTF8; };
    IOUtils.readUTF8 = async (path, ...args) => {
      const text = await readUTF8(path, ...args);
      if (path === service.config.path && !heldPoll) { heldPoll = true; pollStarted.resolve(); await finishPoll.promise; }
      return text;
    };
    const oldPoll = service.config.reload(); work.push(oldPoll); void oldPoll.catch(() => {}); await pollStarted.promise;
    const writeUTF8 = IOUtils.writeUTF8; restoreWrite = () => { IOUtils.writeUTF8 = writeUTF8; };
    let gapChecked = false; const countBeforeClear = requests.length;
    IOUtils.writeUTF8 = async (path, text, ...args) => {
      if (path === settings.path && JSON.parse(text).dimensions === 512) {
        assert(service.config.current.dimensions === 768, "runtime-retains-old-dimensions-before-publication");
        await service.tick();
        assert(requests.length === countBeforeClear && (await database.db.selectFrom("block_embeddings").select("id").execute()).length === 0, "clear-save-polling-gap-cannot-regenerate-old-vectors");
        gapChecked = true;
      }
      return writeUTF8(path, text, ...args);
    };
    await settings.save({ ...settings.current, dimensions: 512 }, "clear", (old, publish) => service.clear(old, publish));
    restoreWrite(); restoreWrite = undefined;
    assert(gapChecked && service.config.current.dimensions === 512, "runtime-applies-published-dimensions-before-resuming");
    finishPoll.resolve(); await oldPoll; restoreRead(); restoreRead = undefined;
    assert(service.config.current.dimensions === 512 && !service.config.error, "older-native-poll-cannot-undo-applied-clear-and-switch");
    await service.tick();
    const dimensions = await database.db.selectFrom("block_embeddings").select("dimensions").execute();
    assert(dimensions.length > 0 && dimensions.every(row => row.dimensions === 512), "only-new-dimension-vectors-exist-after-switch");
    const saved = deferred(), finishSave = deferred(), save = service.store.index.save.bind(service.store.index);
    releases.push(finishSave.resolve);
    let snapshotPath;
    service.store.index.save = async (path, signal) => { const value = await save(path, signal); snapshotPath = path; saved.resolve(); await finishSave.promise; return value; };
    const syncing = service.store.sync(service.profile, service.config.current, signal, true);
    work.push(syncing); void syncing.catch(() => {});
    await saved.promise;
    let cleaned = false; const cleaning = cleanupFiles(database.db).then(() => { cleaned = true; });
    work.push(cleaning); void cleaning.catch(() => {});
    await pause(30); assert(!cleaned && await IOUtils.exists(snapshotPath), "cleanup-waits-for-real-worker-snapshot-publication");
    finishSave.resolve(); await syncing; await cleaning;
    const active = await database.db.selectFrom("vector_snapshot_state").select("snapshot_path").where("profile_id", "=", service.profile).executeTakeFirstOrThrow();
    assert(active.snapshot_path === snapshotPath && await IOUtils.exists(snapshotPath), "activated-native-snapshot-retained");
    service.store.index.save = save;
    const closingStore = new VectorStore(service.repository, options.rootURI);
    const discovered = deferred(), finishDiscovery = deferred(), hash = service.repository.port.hash.bind(service.repository.port);
    releases.push(finishDiscovery.resolve);
    let openedAfterClose = 0;
    const open = closingStore.index.open.bind(closingStore.index);
    closingStore.index.open = async (...args) => { openedAfterClose++; return open(...args); };
    service.repository.port.hash = async value => { const result = await hash(value); discovered.resolve(); await finishDiscovery.promise; return result; };
    try {
      const syncing = closingStore.sync(service.profile, service.config.current, signal);
      const stopped = syncing.then(() => false, error => error.message === "index-closed");
      work.push(syncing); void syncing.catch(() => {}); await discovered.promise;
      const stopping = closingStore.close(); finishDiscovery.resolve();
      assert(await stopped, "native-close-rejects-sync-paused-during-corpus-discovery"); await stopping;
      assert(openedAfterClose === 0, "native-close-prevents-late-worker-creation");
    } finally { finishDiscovery.resolve(); service.repository.port.hash = hash; await closingStore.close(); }
    const nativeVectors = await service.repository.activeVectors(service.profile).execute(), requestsBeforeRetention = requests.length;
    for (let round = 0; round < 3; round++) {
      await service.store.sync(service.profile, service.config.current, signal, true); await cleanupFiles(database.db);
      const builds = await database.db.selectFrom("search_index_builds").select("id").where("profile_id", "=", service.profile).execute();
      const labels = await database.db.selectFrom("vector_index_entries").select("build_id").where("profile_id", "=", service.profile).execute();
      assert(builds.length === 1 && labels.length === nativeVectors.length && labels.every(row => row.build_id === builds[0].id), "native-rebuild-retains-one-label-set-round-" + round);
    }
    const restoredStore = new VectorStore(service.repository, options.rootURI);
    try {
      await restoredStore.sync(service.profile, service.config.current, signal);
      const queryVector = normalizedVector(Array(service.config.current.dimensions).fill(1), service.config.current.dimensions);
      assert((await restoredStore.search(queryVector, [resourceID], 20)).length === nativeVectors.length, "native-reclaimed-index-restores-and-searches");
    } finally { await restoredStore.close(); }
    const currentBuild = await database.db.selectFrom("search_index_builds").selectAll().where("profile_id", "=", service.profile).executeTakeFirstOrThrow();
    const retiredID = port.uuid();
    await database.db.insertInto("search_index_builds").values({ id: retiredID, kind: "vector", profile_id: service.profile, engine_key: currentBuild.engine_key,
      engine_version: currentBuild.engine_version, configuration_hash: currentBuild.configuration_hash, state: "retired", created_at: Date.now() }).execute();
    const oldLabels = await database.db.selectFrom("vector_index_entries").selectAll().where("build_id", "=", currentBuild.id).execute();
    for (const row of oldLabels) await database.db.insertInto("vector_index_entries").values({ build_id: retiredID, engine_label: row.engine_label,
      embedding_id: row.embedding_id, profile_id: row.profile_id, state: row.state, indexed_at: row.indexed_at }).execute();
    await service.start(false);
    assert(!(await database.db.selectFrom("search_index_builds").select("id").where("id", "=", retiredID).executeTakeFirst()), "native-startup-reclaims-accumulated-retired-builds");
    const controller = { snapshot: await knowledge.snapshot() };
    parsing = new ParsingService(database.db, controller, port); await parsing.refresh();
    const binding = { id: "history", target, enabled: true, mode: "flexible", collectionKey: "SYNTHETIC", nativeLibraryID: 1 };
    sync = new CollectionSyncService({ db: database.db, list: async () => [binding] }, controller, parsing, service);
    sync.state.set("history", { title: "Synthetic collection", added: 0, removedItems: 0, error: false }); await sync.publish();
    const tasks = new ImportTasksService(parsing, sync, service), taskDoc = window.document.implementation.createHTMLDocument("Synthetic task verification");
    for (const id of ["zotero-items-pane-container", "zotero-item-pane"]) { const node = taskDoc.createElement("div"); node.id = id; taskDoc.body.append(node); }
    taskView = new ImportTasksView({ document: taskDoc, ZoteroPane: { async onCollectionSelected() {}, collectionsView: { getSelectedRows: () => [{ id: "Kknowledgemcp:import-tasks" }] } } }, () => {}, tasks);
    const currentTask = service.snapshot().find(row => row.embedding.current), currentID = currentTask.id.slice(6);
    await database.db.updateTable("processing_jobs").set({ state: "pending", finished_at: null, checkpoint_json: "{}" }).where("id", "=", currentID).execute();
    await service.refresh(); await tasks.runAction("batch-sync-history", "delete");
    const retained = tasks.snapshot().find(row => row.kind === "item" && row.embedding);
    assert(retained?.parentID === "batch-sync-history" && retained.processing.parseTaskID, "native-sync-clear-preserves-active-workflow-grouping");
    assert(taskDoc.querySelector('[data-task="' + retained.id + '"]'), "native-task-dom-keeps-active-child");
    await database.db.updateTable("processing_jobs").set({ state: "succeeded", finished_at: Date.now() }).where("id", "=", currentID).execute();
    await service.refresh(); await tasks.runAction("batch-sync-history", "delete");
    report.historyAfterClear = tasks.snapshot().map(row => ({ id: row.id, status: row.status, parentID: row.parentID }));
    report.taskNodesAfterClear = taskDoc.querySelectorAll("[data-task]").length;
    assert(tasks.snapshot().length === 0 && !taskDoc.querySelector("[data-task]"), "native-sync-clear-removes-terminal-workflow-from-dom");
    await service.tick(); await parsing.refresh(); await service.refresh();
    assert(tasks.snapshot().length === 0, "native-sync-clear-survives-background-reconciliation");
    assert((await service.repository.activeVectors(service.profile).execute()).length === nativeVectors.length, "native-sync-clear-retains-canonical-vectors");
    assert(requests.length === requestsBeforeRetention, "native-retention-and-history-checks-make-no-model-requests");
    taskView.dispose(); taskView = undefined; await sync.close(); sync = undefined; await parsing.close(); parsing = undefined;
    configOwner = new RetrievalConfigFile();
    Object.defineProperty(configOwner, "path", { value: PathUtils.join(options.folder, options.run + "-closing-config.json") });
    await configOwner.save(configOwner.current);
    const savingStarted = deferred(), finishSaving = deferred(); releases.push(finishSaving.resolve);
    const configSaving = configOwner.save({ ...configOwner.current, results: 15 }, undefined, undefined, async () => { savingStarted.resolve(); await finishSaving.promise; return async () => {}; });
    work.push(configSaving); void configSaving.catch(() => {}); await savingStarted.promise; await configOwner.reload();
    let configClosed = false; const configClosing = configOwner.close().then(() => { configClosed = true; });
    work.push(configClosing); await pause(30); assert(!configClosed, "native-close-drains-write-after-overlapping-reload");
    finishSaving.resolve(); await configSaving; await configClosing;
    assert(JSON.parse(await IOUtils.readUTF8(configOwner.path)).results === 15, "accepted-native-config-write-completes-before-close");
    const started = deferred(), finish = deferred();
    releases.push(finish.resolve);
    service.repository.reconcile = async (...args) => { started.resolve(); await finish.promise; return originalReconcile(...args); };
    const action = service.enqueue([resourceID]); work.push(action); void action.catch(() => {}); await started.promise;
    let closed = false; const closing = service.close().then(() => { closed = true; });
    await pause(30); assert(!closed, "shutdown-waits-for-accepted-enqueue");
    finish.resolve(); await action; await closing;
    assert(closed && service.operations.size === 0, "accepted-native-database-work-drains-before-close");
    assert(requests.every(model => model === "synthetic-other-model"), "all-synthetic-embeddings-match-recorded-model");
    report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = String(error?.message ?? error); report.stack = error?.stack; }
  finally {
    try {
      for (const release of releases) release();
      restoreWrite?.(); restoreRead?.(); taskView?.dispose(); await sync?.close(); await parsing?.close(); await settings?.close(); await configOwner?.close();
      const stopping = service?.close(); await Promise.allSettled(work); await stopping; await database?.close();
    }
    catch (error) { report.status = "failed"; report.cleanupError = String(error); }
    report.finished = Date.now(); await write();
  }
}
` }, bundle: true, format: "iife", globalName: "EmbeddingConcurrencyProbe", platform: "browser", target: "firefox140", loader: { ".css": "text" },
  outfile: path.join(folder, `${run}.js`) });
const options = { folder, run, rootURI: await runtimeRootURI() };
await evaluate(`Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(path.join(folder, `${run}.js`)).href)}); void EmbeddingConcurrencyProbe.run(${JSON.stringify(options)})`);
const reportPath = path.join(folder, `${run}.json`);
for (let attempt = 0; attempt < 120; attempt++) {
  const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => undefined);
  if (report && report.status !== "running") {
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
    if (report.status !== "passed") process.exitCode = 1;
    break;
  }
  if (attempt === 119) throw new Error(`Native check did not complete; inspect ${reportPath}`);
  await new Promise(resolve => setTimeout(resolve, 250));
}
