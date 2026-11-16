import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { api, parsingFixture } from "./fixtures/parsing.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async predicate => { for (let i = 0; i < 300 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate()); };
const steps = override => Object.fromEntries(api.recoveryStages.map(stage => [stage, override?.[stage] ?? (async () => {})]));

test("recovery waits for native readiness and publishes separate fulltext and semantic capabilities", async t => {
  await parsingFixture(t); const ui = deferred(), index = deferred(), events = [];
  const recovery = new api.StartupRecovery(Object.fromEntries(api.recoveryStages.map(stage => [stage, async () => { events.push(stage); if (stage === "index") await index.promise; }])));
  t.after(() => recovery.close()); recovery.schedule(ui.promise); await settle(); assert.deepEqual(events, []);
  ui.resolve(); await recovery.waitFor("fulltext"); assert.equal(recovery.isReady("index"), false);
  assert.deepEqual(events.slice(0, 6), api.recoveryStages.slice(0, 6));
  index.resolve(); await recovery.waitFor("index"); await until(() => recovery.snapshot().state === "ready");
});

test("recovery retries only the failed stage and rejects pending actions on failure", async t => {
  await parsingFixture(t); let files = 0, metadata = 0;
  const recovery = new api.StartupRecovery(steps({ metadata: async () => { metadata++; }, files: async () => { if (++files === 1) throw Error("disk"); } }));
  t.after(() => recovery.close()); const action = assert.rejects(recovery.waitFor("parsing"), error => error.code === "recovery-failed" && error.details.stage === "files");
  recovery.retry(); await action; assert.equal(recovery.snapshot().stage, "files");
  recovery.retry(); await recovery.waitFor("index"); assert.equal(metadata, 1); assert.equal(files, 2);
});

test("closing cancels delayed startup and drains an active stage before database disposal", async t => {
  await parsingFixture(t); let executed = false;
  const pending = new api.StartupRecovery(steps({ metadata: async () => { executed = true; } }));
  pending.schedule(); const wait = assert.rejects(pending.waitFor("index"), /service-closed/); await pending.close(); await wait;
  await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(executed, false);
  const gate = deferred(), recovery = new api.StartupRecovery(steps({ metadata: async () => { executed = true; await gate.promise; } }));
  recovery.retry(); await settle(); let closed = false; const stopping = recovery.close().then(() => { closed = true; });
  await settle(); assert.equal(closed, false); gate.resolve(); await stopping;
  assert.equal(recovery.snapshot().state, "closed"); assert.deepEqual(recovery.snapshot().completed, []);
});

test("historical publications do not repeat metadata reconciliation but new publications still refresh", async t => {
  const f = await parsingFixture(t); await f.enqueue(); for (let i = 0; i < 4; i++) await f.step();
  let refreshes = 0;
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot(), async refresh() { refreshes++; } }, f.port, f.parsers);
  f.beforeClose(() => service.close()); service.config.start = async () => {}; service.worker.start = async () => {};
  await service.start(true); assert.equal(refreshes, 0);
  f.setBytes(new TextEncoder().encode("%PDF-1.7 changed fixture")); await f.enqueue(true); for (let i = 0; i < 4; i++) await f.step();
  await service.refresh(); assert.equal(refreshes, 1);
  await service.refresh(); assert.equal(refreshes, 1);
});

test("local index restoration never invokes the model gateway and startup search rejects before network", async t => {
  const f = await parsingFixture(t), service = new api.EmbeddingService(f.db, "file:///fixture/"); f.beforeClose(() => service.close());
  service.config.current = { ...service.config.current, enabled: true }; let syncs = 0;
  service.store.sync = async () => { syncs++; }; service.gateway.embed = async () => { assert.fail("network during restore"); };
  await service.restoreIndex(); assert.equal(syncs, 1); assert.ok(service.profile);
  const retrieval = new api.RetrievalService(service, () => false);
  await assert.rejects(retrieval.search("query", "semantic", [f.input.resourceID], new AbortController().signal), error => error.code === "initializing");
});

test("saved plugin mode keeps native rows during recovery and requires Enter again after ready", async t => {
  await parsingFixture(t);
  const dom = new JSDOM('<div id="zotero-items-pane"><div><div id="zotero-tb-search"><input/></div></div><div id="popup"></div></div>');
  t.after(() => dom.window.close()); const window = dom.window, doc = window.document, quick = doc.getElementById("zotero-tb-search");
  quick.searchTextbox = quick.querySelector("input"); quick.searchModePopup = doc.getElementById("popup"); quick.updateMode = () => {};
  const items = [{ id: 1 }], row = { id: "L1", searchText: "", clearCache() {}, async getItems() { return items; }, async getSearchResults() { return [1]; } };
  const provider = { _rows: [], _sort() {}, refreshRowMap() {} };
  window.ZoteroPane = { itemsView: { collectionTreeRows: [row], rowProvider: provider, async setFilter() {}, _handleColumnSort() {}, async refreshAndMaintainSelection() {} }, async onCollectionSelected() {}, async search() {} };
  Zotero.getMainWindows = () => [window]; Zotero.Prefs = { get: () => "semantic", set() {} };
  const index = deferred(), recovery = new api.StartupRecovery(steps({ index: () => index.promise }));
  t.after(() => recovery.close()); let calls = 0;
  const ui = new api.RetrievalUI("fixture", "file:///fixture/", { snapshot: { resources: [{ id: "r1", itemID: 1 }] } }, { async search() { calls++; throw Error("fixture"); } }, {}, recovery);
  ui.start(); t.after(() => ui.dispose()); quick.searchTextbox.value = "query";
  const enter = () => quick.searchTextbox.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  enter(); await settle(); assert.equal(calls, 0); assert.deepEqual(await row.getItems(), items);
  assert.equal(doc.getElementById("km-search-status"), null);
  assert.match(quick.searchTextbox.title, /Restoring plugin data/);
  recovery.retry(); await recovery.waitFor("fulltext"); await settle();
  assert.equal(doc.getElementById("km-search-fulltext").getAttribute("disabled"), "false");
  for (const mode of ["semantic", "enhanced"]) assert.equal(doc.getElementById(`km-search-${mode}`).getAttribute("disabled"), "true");
  assert.equal(doc.getElementById("km-search-fusion").getAttribute("disabled"), "false", "Fulltext-ready fusion can degrade independently of vector startup");
  index.resolve(); await until(() => recovery.snapshot().state === "ready"); assert.equal(calls, 0);
  for (const mode of ["semantic", "enhanced", "fusion"]) assert.equal(doc.getElementById(`km-search-${mode}`).getAttribute("disabled"), "false");
  enter(); await settle(); assert.equal(calls, 1);
});

test("index recovery retains safe failure details and automatically retries local work only", async t => {
  await parsingFixture(t); let attempts = 0, metadata = 0, published = 0;
  const states = [], recovery = new api.StartupRecovery(steps({ metadata: async () => { metadata++; }, index: async () => { if (++attempts === 1) throw Error("index-worker"); } }), () => { published++; }, [1, 2]);
  t.after(() => recovery.close()); recovery.subscribe(() => states.push(recovery.snapshot()));
  recovery.retry(); await until(() => recovery.snapshot().state === "ready");
  assert.equal(attempts, 2); assert.equal(metadata, 1); assert.equal(published, 1);
  const failed = states.find(state => state.state === "failed");
  assert.deepEqual(failed.failure, { code: "index-worker", type: "Error" }); assert.equal(failed.retryScheduled, true);
  assert.equal(recovery.snapshot().failure, undefined); assert.equal(recovery.snapshot().retryScheduled, undefined);
});

test("permanent index failure stops automatic retries, exposes failure instead of initializing, and manual retry resumes", async t => {
  await parsingFixture(t); let attempts = 0, fail = true;
  const recovery = new api.StartupRecovery(steps({ index: async () => { attempts++; if (fail) throw TypeError("private path or credential must not leave the process"); } }), () => {}, [1, 2]);
  t.after(() => recovery.close()); recovery.retry();
  await until(() => recovery.snapshot().state === "failed" && attempts === 3 && !recovery.snapshot().retryScheduled);
  assert.deepEqual(recovery.snapshot().failure, { code: "unexpected-error", type: "TypeError" });
  assert.ok(!JSON.stringify(recovery.snapshot()).includes("private path"));
  assert.equal(recovery.isRetrievalReady("fusion"), true); assert.equal(recovery.isRetrievalReady("semantic"), false);
  const problem = recovery.unavailable("index");
  assert.equal(problem.code, "recovery-failed"); assert.equal(problem.details.failureType, "TypeError");
  await assert.rejects(recovery.waitFor("index"), error => error.code === "recovery-failed");
  fail = false; recovery.retry(); await until(() => recovery.snapshot().state === "ready"); assert.equal(attempts, 4);
});

test("shutdown cancels scheduled index retry without publishing ready", async t => {
  await parsingFixture(t); let attempts = 0, ready = 0;
  const recovery = new api.StartupRecovery(steps({ index: async () => { attempts++; throw Error("index-wasm"); } }), () => { ready++; }, [50]);
  recovery.retry(); await until(() => recovery.snapshot().state === "failed"); await recovery.close();
  await new Promise(resolve => setTimeout(resolve, 70)); assert.equal(attempts, 1); assert.equal(ready, 0); assert.equal(recovery.snapshot().state, "closed");
});
