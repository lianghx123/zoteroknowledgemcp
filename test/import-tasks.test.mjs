import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mockLocalization } from "./helpers/localization.mjs";
import { createImportTaskFixtures, createImportTaskSource } from "./fixtures/import-tasks.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));

const compiled = await build({ stdin: { contents: `export * from "./src/ui/knowledge/import-tasks.ts";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, format: "cjs", platform: "browser", target: "firefox140", write: false, loader: { ".css": "text" } });

function fixture(t, locale = "en-US", preferences = new Map(), configureWindow = () => {}, source = createImportTaskSource()) {
  const dom = new JSDOM('<html><head></head><body><div id="zotero-items-pane-container"><div id="native-list"></div></div><div id="zotero-item-pane"><div id="native-details" inert="existing"></div></div></body></html>');
  t.after(() => dom.window.close());
  const window = dom.window;
  let rows = [], refreshes = 0;
  const pane = window.ZoteroPane = { collectionsView: { getSelectedRows: () => rows }, async onCollectionSelected() {} };
  const native = pane.onCollectionSelected;
  const module = { exports: {} };
  runInContext(compiled.outputFiles[0].text, createContext({ module, exports: module.exports, Localization: mockLocalization(locale),
    Zotero: { Prefs: { get: key => preferences.get(key), set: (key, value) => preferences.set(key, value) }, debug() {} } }));
  const { ImportTasksView, IMPORT_TASKS_ROW_ID } = module.exports;
  configureWindow(window);
  const view = new ImportTasksView(window, () => refreshes++, source ?? undefined);
  t.after(() => view.dispose());
  const doc = window.document;
  const click = selector => { const node = doc.querySelector(selector); assert.ok(node, selector); node.click(); };
  return { view, pane, native, doc, window, click, preferences, source, get refreshes() { return refreshes; },
    async select(active) { rows = [{ id: active ? IMPORT_TASKS_ROW_ID : "L1" }]; await pane.onCollectionSelected(); } };
}

test("task details separate the title, keep phase checklists and show one overall completion",async t=>{
  const task={id:"parse-workflow",kind:"item",title:"Paper",fileName:"paper.pdf",target:"KB",itemType:"journalArticle",stage:"index",status:"publishing",
    processing:{sourceID:"source",generationID:"generation",parseTaskID:"parse-workflow"},parser:{provider:"paddleocr",model:"OCR"},
    embedding:{taskID:"embed:work",dimensions:768,active:true,status:"publishing",provider:"bailian",model:"Qwen"}};
  const f=fixture(t,"en-US",new Map(),()=>{},createImportTaskSource([task]));await f.select(true);f.click('[data-task="parse-workflow"] button');
  const steps=[...f.doc.querySelectorAll(".km-task-steps > li")];assert.equal(steps.length,3);
  assert.match(steps[0].textContent,/Add to knowledge base/);assert.match(steps[1].textContent,/Extract document content/);assert.match(steps[2].textContent,/Prepare semantic search/);
  assert.equal(steps.slice(0,2).every(step=>step.classList.contains("done")),true);
  assert.equal(steps.slice(0,2).every(step=>!step.querySelector(".km-task-group-state")),true);
  assert.match(steps[0].querySelector(".km-task-substeps li.done").textContent,/✓Save item and attachment information/);
  assert.equal(steps[2].querySelector(".km-task-stage-title").getAttribute("aria-current"),"step");
  assert.equal(f.doc.querySelectorAll(".km-task-pane-section").length,3);
  assert.equal(f.doc.querySelectorAll("#km-import-task-details details, #km-import-task-details summary").length,0);
  assert.equal(steps[2].querySelector(".km-task-group-state").textContent,"In progress");
  assert.match(steps[2].querySelector(".km-task-substeps .current").textContent,/Build search index/);
  assert.equal(steps[2].querySelector(".km-task-progress"),null);
  const technical=f.doc.querySelector('[data-pane="knowledgemcp-task-processing"]');
  assert.match(technical.textContent,/OCR/);assert.match(technical.textContent,/Qwen/);
  f.source.replace([{...task,status:"completed",embedding:{...task.embedding,status:"completed"}}]);
  assert.equal(f.doc.querySelector(".km-task-note"),null);
  assert.equal(f.doc.querySelectorAll(".km-task-completion").length,1);
  assert.equal(f.doc.querySelector(".km-task-completion").textContent,"✓Completed");
  assert.equal(f.doc.querySelectorAll(".km-task-group-state").length,0);
  assert.doesNotMatch(f.doc.querySelector("#km-import-task-details").textContent,/semantic search is ready/);
});

test("page progress belongs to parsing, while results and publication remain separate actions", async t => {
  const task = { id: "phases", kind: "item", title: "Paper", fileName: "paper.pdf", target: "KB", stage: "parse", status: "parsing", pages: { completed: 30, total: 30 } };
  const source = createImportTaskSource([task]), f = fixture(t, "en-US", new Map(), () => {}, source); await f.select(true);
  assert.match(f.doc.querySelector("#km-import-task-details").textContent, /Parsed 30 \/ 30 pages · 100%/);
  assert.equal(f.doc.querySelectorAll(".km-task-steps > li.done").length, 1, "100% parsing is not saved content");
  for (const [phase, stage, label] of [["downloading", "download", /Retrieving parsing results/], ["organizing", "download", /Organizing content and images/], ["saving", "publish", /Saving content to knowledge base/]]) {
    source.replace([{ ...task, stage, status: phase === "saving" ? "publishing" : "parsing", extraction: { phase } }]);
    assert.equal(f.doc.querySelectorAll("progress").length, 0, phase);
    assert.match(f.doc.querySelector("td:last-child").textContent, label);
    assert.doesNotMatch(f.doc.querySelector("#km-import-task-details").textContent, /Parsed 30 \/ 30 pages · 100%/);
  }
  source.replace([{ ...task, pages: { completed: 12 } }]);
  assert.match(f.doc.querySelector("#km-import-task-details").textContent, /Parsed 12 pages/); assert.equal(f.doc.querySelectorAll("progress").length, 0);
  source.replace([{ ...task, pages: undefined }]);
  assert.match(f.doc.querySelector("td:last-child").textContent, /Extracting content/); assert.equal(f.doc.querySelectorAll("progress").length, 0);
});

test("local and remote waits retain real timing and persistent sections through progress updates", async t => {
  const task = { id: "wait", kind: "item", title: "Paper", fileName: "paper.pdf", target: "KB", stage: "parse", status: "parsing", parser: { provider: "paddleocr", model: "OCR" } };
  const source = createImportTaskSource([task]), f = fixture(t, "en-US", new Map(), () => {}, source); await f.select(true);
  for (const [phase, label] of [["local-queue", /Waiting for processing capacity/], ["remote-queue", /Waiting for parsing service/], ["remote-preparing", /Parsing service is preparing/]]) {
    source.replace([{ ...task, extraction: { phase, startedAt: Date.now() - 125000, updatedAt: Date.now() } }]);
    assert.match(f.doc.querySelector("td:last-child").textContent, label);
    assert.match(f.doc.querySelector("#km-import-task-details").textContent, /Waiting for 2 minutes/);
    assert.match(f.doc.querySelector("td:last-child").textContent, /Waiting for 2 minutes/);
    assert.match(f.doc.querySelector("#km-import-task-details").textContent, /Last progress check:/);
    assert.equal(f.doc.querySelectorAll("progress").length, 0);
  }
  const progressSection = f.doc.querySelector('[data-pane="knowledgemcp-task-progress"]');
  source.replace([{ ...task, pages: { completed: 1, total: 3 } }]);
  assert.equal(f.doc.querySelector('[data-pane="knowledgemcp-task-progress"]'),progressSection);
  assert.equal(f.doc.querySelectorAll("#km-import-task-details details").length,0);
});

test("optional semantic work finishes independently while planned and paused jobs remain explicit", async t => {
  const task = { id: "ready", kind: "item", title: "Paper", fileName: "paper.pdf", target: "KB", stage: "publish", status: "completed" };
  const source = createImportTaskSource([task]), f = fixture(t, "en-US", new Map(), () => {}, source); await f.select(true);
  for (const [semanticPlan, label] of [["disabled", /not enabled/], ["manual", /when you request/], ["automatic", /start automatically/], ["paused", /paused/]]) {
    source.replace([{ ...task, semanticPlan }]);
    assert.match(f.doc.querySelector(".km-task-steps > li:last-child").textContent, label);
    assert.equal(f.doc.querySelectorAll(".km-task-steps > li.done").length, 2);
    assert.equal(f.doc.querySelectorAll(".km-task-completion").length,["disabled","manual"].includes(semanticPlan)?1:0);
  }
  source.replace([{ ...task, semanticPlan: "disabled", stage: "embed", status: "paused", embedding: { dimensions: 768, active: false, status: "paused" } }]);
  assert.match(f.doc.querySelector(".km-task-steps > li:last-child").textContent, /Paused/);
  assert.equal(f.doc.querySelectorAll(".km-task-steps > li.done").length, 2);
});

test("the default panel contains no development tasks, reset controls or simulated actions", async t => {
  const f = fixture(t, "en-US", new Map(), () => {}, null); await f.select(true);
  assert.equal(f.view.activeCount, 0);
  assert.equal(f.doc.querySelectorAll("[data-task]").length, 0);
  assert.equal(f.doc.querySelectorAll(".km-task-actions button").length, 0);
  assert.equal(f.doc.querySelectorAll(".km-tasks-toolbar button").length, 5);
  assert.equal(f.doc.querySelector(".km-tasks-reset"), null);
  assert.match(f.doc.getElementById("km-import-tasks").textContent, /No import tasks yet/);
  for (const count of f.doc.querySelectorAll(".km-task-count")) assert.equal(count.textContent, "0");
  for (const filter of ["active", "syncing", "attention", "completed", "all"]) {
    f.click(`[data-filter="${filter}"]`); assert.equal(f.doc.querySelectorAll("[data-task]").length, 0);
  }
  const bundle = readFileSync(".scaffold/build/addon/content/main.js", "utf8");
  assert.doesNotMatch(bundle, /createExampleImportTasks|example-folder|Attention Is All You Need|tasks-reset/);
});

test("task progress never refreshes the literature list and hidden tasks render only when opened", async t => {
  const task = { id: "live", kind: "item", title: "Paper", status: "parsing", stage: "parse", pages: { completed: 1, total: 10 } };
  const source = createImportTaskSource([task]), f = fixture(t, "en-US", new Map(), () => {}, source);
  assert.equal(f.doc.getElementById("km-import-tasks").childElementCount, 0);
  source.replace([task]); source.replace([{ ...task, pages: { completed: 2, total: 10 } }]);
  assert.equal(f.refreshes, 0, "unchanged active count must not request a tree/list refresh");
  assert.equal(f.doc.getElementById("km-import-tasks").childElementCount, 0);
  await f.select(true);
  const row = f.doc.querySelector('[data-task="live"]'); assert.ok(row); assert.match(f.doc.getElementById("km-import-task-details").textContent, /2.*10/);
  source.replace([{ ...task, pages: { completed: 2, total: 10 } }]);
  assert.equal(f.doc.querySelector('[data-task="live"]'), row, "identical snapshots must preserve existing task DOM");
  source.replace([{ ...task, status: "completed", stage: "publish" }]); assert.equal(f.refreshes, 1, "active-count changes update the navigation badge");
  assert.equal(f.view.activeCount, 0);
});

test("task details display the persisted parser while progress rows stay compact and parser search still works", async t => {
  const records = createImportTaskFixtures().filter(task => task.kind === "item" && !task.parentID).slice(0, 2);
  records[0].parser = { provider: "mineru", model: "vlm" };
  records[1].parser = { provider: "paddleocr", model: "PaddleOCR-VL-1.6" };
  const f = fixture(t, "zh-CN", new Map(), () => {}, createImportTaskSource(records)); await f.select(true);
  assert.equal(f.doc.querySelector(".km-task-parser"), null);
  assert.doesNotMatch(f.doc.querySelector(".km-tasks-table tbody").textContent, /MinerU|PaddleOCR|vlm/);
  assert.match(f.doc.getElementById("km-import-task-details").textContent, /解析器MinerU/);
  const search = f.doc.querySelector(".km-tasks-search"); search.value = "paddleocr"; search.dispatchEvent(new f.window.Event("input"));
  assert.equal(f.doc.querySelectorAll("[data-task]").length, 1);
  assert.equal(f.doc.querySelector("[data-task]").dataset.task, "example-2");
});

test("task navigation owns its surfaces, restores native inert attributes and disposes the selection adapter", async t => {
  const f = fixture(t);
  assert.equal(f.doc.getElementById("km-import-tasks").hidden, true);
  await f.select(true);
  assert.equal(f.doc.querySelectorAll("[data-task]").length, 12);
  assert.equal(f.doc.getElementById("km-import-tasks").hidden, false);
  assert.equal(f.doc.getElementById("native-list").hasAttribute("inert"), true);
  assert.equal(f.doc.querySelectorAll('[aria-current="step"]').length, 1);
  await f.select(false);
  assert.equal(f.doc.getElementById("native-list").hasAttribute("inert"), false);
  assert.equal(f.doc.getElementById("native-details").getAttribute("inert"), "existing");
  await f.select(true);
  f.view.dispose(); f.view.dispose();
  assert.equal(f.doc.querySelectorAll(".km-import-host-active").length, 0);
  assert.equal(f.doc.getElementById("km-import-tasks"), null);
  assert.equal(f.doc.getElementById("native-list").hasAttribute("inert"), false);
  assert.equal(f.pane.onCollectionSelected, f.native);
  await f.select(true);
  assert.equal(f.doc.getElementById("km-import-tasks"), null);
});

test("a failed task-view construction removes owned nodes, styles and selection adapters", async t => {
  let failedWindow, originalSelection;
  assert.throws(() => fixture(t, "en-US", new Map(), window => {
    failedWindow = window; originalSelection = window.ZoteroPane.onCollectionSelected;
    window.ZoteroPane.collectionsView.getSelectedRows = () => [{ id: "Kknowledgemcp:import-tasks" }];
    window.require = () => { throw new Error("Injected icon loading failure"); };
  }), /Injected icon loading failure/);
  assert.equal(failedWindow.document.querySelector("#km-import-tasks"), null);
  assert.equal(failedWindow.document.querySelector("#km-import-task-details"), null);
  assert.equal(failedWindow.document.querySelector("style"), null);
  assert.equal(failedWindow.ZoteroPane.onCollectionSelected, originalSelection);
  await failedWindow.ZoteroPane.onCollectionSelected();
  assert.equal(failedWindow.document.querySelector(".km-import-host-active"), null);
});

test("task snapshots use a compact toolbar and service-owned actions without a reset control", async t => {
  const f = fixture(t);
  await f.select(true);
  assert.equal(f.view.activeCount, 5);
  assert.equal(f.doc.querySelectorAll(".km-tasks-toolbar").length, 1);
  assert.equal(f.doc.querySelector(".km-tasks-toolbar").getAttribute("role"), "toolbar");
  assert.equal(f.doc.querySelectorAll(".km-tasks-table").length, 1);
  assert.equal(f.doc.querySelectorAll(".km-tasks-table th").length, 3);
  assert.equal(f.doc.querySelector("#km-import-tasks h1"), null);
  assert.equal(f.doc.querySelector("[data-batch]"), null);
  assert.equal(f.doc.querySelector('[data-filter="all"] .km-task-count').textContent, "8");
  assert.equal(f.doc.querySelector("th").textContent, "Title");
  assert.equal(f.doc.querySelector(".km-tasks-reset"), null);
  for (const row of f.doc.querySelectorAll('[data-task][data-kind="item"]')) {
    f.click(`[data-task="${row.dataset.task}"] button`);
    assert.match(f.doc.querySelector(".km-task-fields dd").textContent, /\.pdf$/);
  }
  f.click('[data-task="example-4"] button');
  assert.match(f.doc.getElementById("km-import-task-details").textContent, /Processing failed/);
  f.click(".km-task-actions button"); await settle();
  assert.equal(f.view.activeCount, 6);
  assert.match(f.doc.getElementById("km-import-task-details").textContent, /Queued/);
  f.click(".km-task-actions button"); await settle();
  assert.equal(f.view.activeCount, 5);
  assert.match(f.doc.getElementById("km-import-task-details").textContent, /Cancelled/);
  assert.equal(f.refreshes, 2);
  f.click('[data-filter="attention"]');
  assert.equal(f.doc.querySelectorAll("[data-task]").length, 1);
  assert.match(f.doc.getElementById("km-import-task-details").textContent, /Some content could not be processed/);
  f.click('[data-filter="all"]');
  f.click('[data-task="example-4"] button');
  f.doc.querySelector('[data-task="example-4"] button').dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(f.doc.querySelector('[data-task="example-5"] button').getAttribute("aria-pressed"), "true");
  f.source.replace(createImportTaskFixtures());
  assert.equal(f.doc.querySelectorAll("[data-task]").length, 12);
  const search = f.doc.querySelector("input"); search.value = "no matching paper";
  search.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  assert.equal(f.doc.querySelectorAll("[data-task]").length, 0);
  assert.match(f.doc.getElementById("km-import-tasks").textContent, /No matching tasks/);
  assert.equal(f.doc.activeElement, f.doc.querySelector("input"));
  assert.equal(f.doc.querySelectorAll("progress").length, 0);
});

test("folder tasks aggregate child progress, preserve selection on collapse and expose synchronization separately", async t => {
  const f = fixture(t); await f.select(true);
  f.click('[data-task="example-7"] .km-task-select');
  f.click('[data-task="example-folder"] .km-task-toggle');
  assert.equal(f.doc.querySelectorAll("[data-task]").length, 10);
  assert.equal(f.doc.querySelector('[data-task="example-folder"] .km-task-select').getAttribute("aria-pressed"), "true");
  f.doc.querySelector('[data-task="example-folder"] .km-task-select').dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(f.doc.activeElement, f.doc.querySelector('[data-task="example-folder"] .km-task-select'));
  f.doc.activeElement.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  assert.equal(f.doc.activeElement, f.doc.querySelector('[data-task="example-folder"] .km-task-select'));
  assert.match(f.doc.querySelector("#km-import-task-details").textContent, /One-time folder import/);
  f.click(".km-task-actions button"); await settle();
  assert.equal(f.view.activeCount, 4);
  f.click(".km-task-actions button"); await settle();
  assert.equal(f.view.activeCount, 5);
  f.click('[data-task="example-folder"] .km-task-toggle');
  f.click('[data-task="example-7"] .km-task-select');
  assert.match(f.doc.querySelector("#km-import-task-details .km-task-status").textContent, /Queued/);
  f.doc.querySelector('[data-task="example-7"] .km-task-select').dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  assert.equal(f.doc.querySelector('[data-task="example-folder"] .km-task-select').getAttribute("aria-pressed"), "true");
  f.click('[data-filter="syncing"]');
  assert.equal(f.doc.querySelectorAll("[data-task]").length, 3);
  f.click('[data-task="example-sync"] .km-task-select');
  assert.match(f.doc.querySelector("#km-import-task-details").textContent, /Added 2 · Removed 1/);
  assert.match(f.doc.querySelector("#km-import-task-details").textContent, /Original Zotero items are preserved/);
  f.click(".km-task-actions button"); await settle();
  assert.equal(f.doc.querySelectorAll("[data-task]").length, 0);
  assert.equal(f.view.activeCount, 4);
  f.click('[data-filter="all"]');
  f.click('[data-task="example-sync"] .km-task-select');
  assert.match(f.doc.querySelector("#km-import-task-details .km-task-status").textContent, /Paused/);
  f.click(".km-task-actions button"); await settle();
  assert.equal(f.view.activeCount, 5);
  const search = f.doc.querySelector("input"); search.value = "REALM";
  search.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  assert.deepEqual([...f.doc.querySelectorAll("[data-task]")].map(row => row.dataset.task), ["example-sync", "example-10"]);
});

test("a retry chain retains the selected task when the service creates a replacement job", async t => {
  const f = fixture(t); await f.select(true); f.click('[data-task="example-4"] .km-task-select');
  const tasks = createImportTaskFixtures(), task = tasks.find(task => task.id === "example-4");
  task.replacesID = task.id; task.id = "replacement-job"; task.status = "queued";
  f.source.replace(tasks);
  assert.equal(f.doc.querySelector('[data-task="replacement-job"] .km-task-select').getAttribute("aria-pressed"), "true");
  assert.match(f.doc.getElementById("km-import-task-details").textContent, /Lost in the Middle/);
});

test("task selection supports Ctrl, Shift, select-all and one context command per selected task", async t => {
  const f = fixture(t); await f.select(true);
  const select = (id, modifiers = {}) => f.doc.querySelector(`[data-task="${id}"] .km-task-select`).dispatchEvent(new f.window.MouseEvent("click", { bubbles: true, ...modifiers }));
  select("example-4"); select("example-5", { ctrlKey: true });
  assert.equal(f.doc.querySelectorAll('[aria-selected="true"]').length, 2);
  f.doc.querySelector('[data-task="example-4"]').dispatchEvent(new f.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
  assert.equal(f.doc.querySelectorAll('[aria-selected="true"]').length, 2, "right clicking an existing selection preserves it");
  const menu = f.doc.querySelector('[role="menu"]');
  [...menu.querySelectorAll("button")].find(node => node.textContent === "Delete import record").click(); await settle();
  assert.deepEqual(f.source.calls.slice(-2), [{ id: "example-4", action: "delete" }, { id: "example-5", action: "delete" }]);
  select("example-2"); select("example-5", { shiftKey: true });
  assert.equal(f.doc.querySelectorAll('[aria-selected="true"]').length, 4);
  f.doc.querySelector('[data-task="example-5"] button').dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
  assert.equal(f.doc.querySelectorAll('[aria-selected="true"]').length, f.doc.querySelectorAll("[data-task]").length);
});

test("completed rows show only completion and legacy column widths merge without losing the layout", async t => {
  const preferences = new Map([["extensions.zotero.knowledgemcp.importTaskColumns", "[45,25,10,20]"]]);
  const f = fixture(t, "en-US", preferences); await f.select(true);
  assert.deepEqual([...f.doc.querySelectorAll("col")].map(node => parseFloat(node.style.width)), [45,25,30]);
  const completed = f.doc.querySelector('[data-task="example-5"]');
  assert.equal(completed.querySelectorAll("td").length, 3); assert.equal(completed.querySelector("progress"), null);
  assert.equal(completed.querySelector("td:last-child").textContent, "Completed");
  assert.ok(f.doc.querySelector('[data-task="example-1"] progress'));
});

test("column dividers resize adjacent columns, persist widths and clean up cancelled or disposed drags", async t => {
  const f = fixture(t); await f.select(true);
  const preference = "extensions.zotero.knowledgemcp.importTaskColumns";
  const table = () => { const node = f.doc.querySelector("table"); node.getBoundingClientRect = () => ({ width: 1000 }); return node; };
  const widths = () => [...f.doc.querySelectorAll("col")].map(col => parseFloat(col.style.width));
  const pointer = (target, type, x) => target.dispatchEvent(new f.window.MouseEvent(type, { button: 0, clientX: x, bubbles: true }));
  table(); pointer(f.doc.querySelector('[role="separator"]'), "pointerdown", 490);
  pointer(f.doc, "pointermove", 540); pointer(f.doc, "pointerup", 540);
  assert.deepEqual(widths(), [54, 17, 29]);
  assert.deepEqual(JSON.parse(f.preferences.get(preference)), [54, 17, 29]);
  f.click('[data-filter="active"]'); assert.deepEqual(widths(), [54, 17, 29]);
  table(); pointer(f.doc.querySelector('[role="separator"]'), "pointerdown", 0);
  pointer(f.doc, "pointermove", 100); pointer(f.doc, "pointercancel", 100);
  assert.deepEqual(widths(), [54, 17, 29]);
  f.doc.querySelector('[role="separator"]').dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.deepEqual(widths(), [55, 16, 29]);
  const reopened = fixture(t, "en-US", f.preferences); await reopened.select(true);
  assert.equal(reopened.doc.querySelector("col").style.width, "55%");
  table(); pointer(f.doc.querySelector('[role="separator"]'), "pointerdown", 0);
  pointer(f.doc, "pointermove", 10000);
  assert.ok(widths().every(width => width >= 5));
  const oldColumn = f.doc.querySelector("col"); f.view.dispose();
  pointer(f.doc, "pointermove", -10000); pointer(f.doc, "pointerup", -10000);
  assert.equal(oldColumn.style.width, "55%");
  assert.deepEqual(JSON.parse(f.preferences.get(preference)), [55, 16, 29]);
});

test("task actions await authoritative updates, reject duplicates and surface safe failures", async t => {
  const source = createImportTaskSource();
  let complete, failLate, actionCalls = 0;
  source.runAction = () => { actionCalls++; return new Promise(resolve => { complete = resolve; }); };
  const f = fixture(t, "en-US", new Map(), () => {}, source); await f.select(true);
  f.click('[data-task="example-4"] .km-task-select');
  f.click(".km-task-actions button"); f.click(".km-task-actions button");
  assert.equal(actionCalls, 1);
  assert.equal(f.doc.querySelector(".km-task-actions button").disabled, true);
  assert.equal(f.doc.querySelector("#km-import-task-details .km-task-status").textContent, "Failed");
  const updated = createImportTaskFixtures(); updated.find(task => task.id === "example-4").status = "queued";
  source.replace(updated); complete(); await settle();
  assert.equal(f.doc.querySelector("#km-import-task-details .km-task-status").textContent, "Queued");
  assert.equal(f.doc.querySelector(".km-task-actions button").disabled, false);
  source.runAction = async () => { throw new Error("Private SQL and provider details"); };
  f.click(".km-task-actions button"); await settle();
  assert.match(f.doc.querySelector('[role="alert"]').textContent, /The action failed/);
  assert.ok(!f.doc.querySelector("#km-import-task-details").textContent.includes("Private SQL"));
  source.runAction = () => new Promise((_resolve, reject) => { failLate = reject; });
  f.click(".km-task-actions button");
  assert.equal(source.listenerCount, 1); f.view.dispose(); assert.equal(source.listenerCount, 0);
  failLate(new Error("Late provider failure")); source.replace([]); await settle();
  assert.equal(f.doc.querySelector("#km-import-tasks"), null);
});

test("source refreshes preserve search focus, defer during column drags and aggregate only active child work", async t => {
  const f = fixture(t); await f.select(true);
  const tasks = createImportTaskFixtures(); tasks.find(task => task.id === "example-7").status = "cancelled";
  f.source.replace(tasks);
  assert.equal(f.doc.querySelector('[data-task="example-folder"] .km-task-status').textContent, "Queued");
  const input = f.doc.querySelector("input"); input.value = "Reasoning";
  input.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  const focused = f.doc.querySelector("input"); focused.focus(); focused.setSelectionRange(3, 3);
  tasks.find(task => task.id === "example-8").status = "publishing"; f.source.replace(tasks);
  assert.equal(f.doc.querySelector('[data-task="example-folder"] .km-task-status').textContent, "Saving content");
  assert.equal(f.doc.activeElement, f.doc.querySelector("input"));
  assert.equal(f.doc.querySelector("input").selectionStart, 3);
  const table = f.doc.querySelector("table"); table.getBoundingClientRect = () => ({ width: 1000 });
  f.doc.querySelector('[role="separator"]').dispatchEvent(new f.window.MouseEvent("pointerdown", { button: 0, clientX: 490, bubbles: true }));
  tasks.find(task => task.id === "example-folder").title = "Reasoning Methods (updated)"; f.source.replace(tasks);
  assert.ok(!f.doc.querySelector("tbody").textContent.includes("(updated)"));
  f.doc.dispatchEvent(new f.window.MouseEvent("pointermove", { clientX: 520, bubbles: true }));
  f.doc.dispatchEvent(new f.window.MouseEvent("pointerup", { clientX: 520, bubbles: true })); await settle();
  assert.ok(f.doc.querySelector("tbody").textContent.includes("(updated)"));
  assert.equal(f.doc.querySelector("col").style.width, "52%");
  assert.equal(f.doc.activeElement, f.doc.querySelector("input"));
  f.view.dispose(); f.source.replace([]); assert.equal(f.doc.querySelector("#km-import-tasks"), null);
});

for (const [locale, label] of [["zh-CN", "导入任务"], ["zh-TW", "匯入任務"], ["de", "Importaufgaben"], ["fr-FR", "Tâches d’importation"], ["es-ES", "Tareas de importación"], ["ja-JP", "インポートタスク"]]) {
  test(`${locale}: task view translates status, controls, progress and detail text`, async t => {
    const f = fixture(t, locale); await f.select(true);
    assert.equal(f.doc.querySelector('[role="toolbar"]').getAttribute("aria-label"), label);
    assert.ok(!f.doc.getElementById("km-import-tasks").textContent.includes("knowledgemcp-"));
    f.click('[data-task="example-4"] button');
    assert.ok(f.doc.querySelector(".km-task-note.failed").textContent.trim());
    f.click('[data-task="example-6"] button');
    assert.ok(f.doc.querySelector(".km-task-note.partial").textContent.trim());
    f.click('[data-task="example-sync"] .km-task-select');
    assert.ok(f.doc.querySelector(".km-task-note.syncing").textContent.trim());
    assert.ok(!f.doc.querySelector("#km-import-task-details").textContent.includes("knowledgemcp-"));
    const empty = fixture(t, locale, new Map(), () => {}, null); await empty.select(true);
    assert.ok(empty.doc.querySelector(".km-tasks-empty").textContent.trim());
    assert.ok(!empty.doc.querySelector(".km-tasks-empty").textContent.includes("knowledgemcp-"));
  });
}

test("only individual completed items offer explicit reparsing", async t => {
  const tasks = createImportTaskFixtures();
  for (const task of tasks.filter(task => task.parentID === "example-folder")) task.status = "completed";
  const f = fixture(t, "en-US", new Map(), () => {}, createImportTaskSource(tasks)); await f.select(true);
  f.click('[data-task="example-folder"] .km-task-select');
  assert.ok(!f.doc.querySelector(".km-task-actions").textContent.includes("Parse again"));
  f.click('[data-task="example-5"] .km-task-select');
  assert.ok(f.doc.querySelector(".km-task-actions").textContent.includes("Parse again"));
});
