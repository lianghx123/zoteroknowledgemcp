import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { api, parsingFixture, bytes } from "./fixtures/parsing.mjs";
const settle = () => new Promise(resolve => setImmediate(resolve));

test("parsing settings convert seconds and MB without changing stored values on reopen", async t => {
  const f = await parsingFixture(t); await f.config.start();
  const raw = { pollIntervalMs: 501, requestTimeoutMs: 60001, jobTimeoutMs: 3600001,
    maxFileBytes: 104857601, maxResultBytes: 123456789 };
  await f.config.save({ ...f.config.current, ...raw });
  const dom = new JSDOM('<section id="km-settings"></section>'); t.after(() => dom.window.close());
  const host = dom.window.document.getElementById("km-settings"), dispose = await api.mountSettings(host); t.after(dispose);
  const input = key => host.querySelector(`#km-setting-${key}`);
  const save = async () => { host.querySelector("#km-parsing-settings button").click(); await settle(); await f.config.reload(); };
  assert.equal(input("pollIntervalMs").value, "0.501");
  assert.equal(input("requestTimeoutMs").value, "60.001");
  assert.equal(input("jobTimeoutMs").value, "3600.001");
  assert.equal(input("maxFileBytes").value, String(raw.maxFileBytes / 1048576));
  assert.equal(input("maxResultBytes").value, String(raw.maxResultBytes / 1048576));
  await save();
  for (const [key, value] of Object.entries(raw)) assert.equal(f.config.current[key], value, key);
  input("pollIntervalMs").value = "0.5"; input("requestTimeoutMs").value = "1.001";
  input("jobTimeoutMs").value = "3600"; input("maxFileBytes").value = "12.5"; input("maxResultBytes").value = "0.1";
  // Parser switches collect the draft before rendering the same displayed units.
  const provider = host.querySelector("#km-setting-provider"); provider.value = "mineru"; provider.dispatchEvent(new dom.window.Event("change"));
  assert.equal(input("requestTimeoutMs").value, "1.001"); assert.equal(input("maxFileBytes").value, "12.5");
  await save();
  assert.equal(f.config.current.pollIntervalMs, 500); assert.equal(f.config.current.requestTimeoutMs, 1001);
  assert.equal(f.config.current.jobTimeoutMs, 3600000); assert.equal(f.config.current.maxFileBytes, 13107200);
  assert.equal(f.config.current.maxResultBytes, Math.round(0.1 * 1048576));
  const saved = { ...f.config.current };
  for (const [key, value] of [["pollIntervalMs", "0.499"], ["requestTimeoutMs", "1.0001"],
    ["requestTimeoutMs", ""], ["maxFileBytes", "257"], ["maxResultBytes", "0"]]) {
    const previous = input(key).value; input(key).value = value; await save();
    assert.match(host.querySelector("#km-settings-status").textContent, /Could not save/);
    assert.deepEqual(f.config.current, saved); input(key).value = previous;
  }
});

test("settings tabs retain unsaved forms across navigation and parser rerenders without saving", async t => {
  const f = await parsingFixture(t); await f.config.start();
  let mutations = 0;
  Zotero.__knowledgeMCPAccess = {
    listTokens: async () => [], libraries: async () => [],
    snapshot: () => ({ enabled: false, port: 23126, endpoint: "http://127.0.0.1:23126/mcp/knowledge", status: "stopped" }),
    configure: async () => { mutations++; }, createToken: async () => { mutations++; },
  };
  const dom = new JSDOM('<section id="km-settings"></section>'); t.after(() => dom.window.close());
  const host = dom.window.document.getElementById("km-settings"), cleanup = await api.mountSettings(host); t.after(cleanup);
  const tabs = [...host.querySelectorAll('[role="tab"]')], panels = [...host.querySelectorAll('[role="tabpanel"]')];
  const before = [...f.files].map(([path, value]) => [path, new TextDecoder().decode(value)]);
  assert.deepEqual(tabs.map(tab => tab.textContent), ["Document parsing", "Models and retrieval", "MCP connection"]);
  assert.equal(host.firstElementChild.getAttribute("role"), "tablist");
  const checkSelection = selected => {
    for (const [index, tab] of tabs.entries()) {
      assert.equal(tab.getAttribute("aria-selected"), String(index === selected));
      assert.equal(tab.tabIndex, index === selected ? 0 : -1);
      assert.equal(panels[index].hidden, index !== selected);
      assert.equal(tab.getAttribute("aria-controls"), panels[index].id);
      assert.equal(panels[index].getAttribute("aria-labelledby"), tab.id);
    }
  };
  checkSelection(0);
  const parsing = host.querySelector("#km-setting-api"); parsing.value = "https://unsaved.example/jobs";
  tabs[1].click(); checkSelection(1);
  const embedding = host.querySelector("#km-vector-embedding-model"); embedding.value = "unsaved-model";
  embedding.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  tabs[2].click(); checkSelection(2);
  host.querySelector("#km-mcp-new-token").click();
  const token = host.querySelector("#km-mcp-name"); token.value = "Unsaved token";
  tabs[0].click(); checkSelection(0); assert.equal(parsing.value, "https://unsaved.example/jobs");
  // Switching tabs must not collect or validate an incomplete parser draft.
  const options = host.querySelector("#km-setting-options"); options.value = "{";
  tabs[2].click(); checkSelection(2); assert.equal(token.value, "Unsaved token");
  tabs[0].click(); assert.equal(options.value, "{"); options.value = "{}";
  const provider = host.querySelector("#km-setting-provider"); provider.value = "mineru";
  provider.dispatchEvent(new dom.window.Event("change")); checkSelection(0);
  assert.equal(host.querySelector("#km-parsing-settings").parentElement, panels[0]);
  tabs[1].click(); checkSelection(1); assert.equal(host.querySelector("#km-vector-embedding-model"), embedding);
  assert.equal(embedding.value, "unsaved-model");
  tabs[2].click(); assert.equal(host.querySelector("#km-mcp-name"), token);
  assert.equal(mutations, 0);
  assert.deepEqual([...f.files].map(([path, value]) => [path, new TextDecoder().decode(value)]), before);
  cleanup(); assert.equal(host.children.length, 0);
  const reopened = await api.mountSettings(host); t.after(reopened);
  assert.equal(host.querySelectorAll('[role="tablist"]').length, 1);
  assert.equal(host.querySelector('[role="tab"][aria-selected="true"]').id, "km-settings-tab-parsing");
});

test("settings tabs support horizontal keyboard navigation and show unavailable MCP feedback", async t => {
  await parsingFixture(t);
  const dom = new JSDOM('<div style="overflow-y: auto"><section id="km-settings"></section></div>'); t.after(() => dom.window.close());
  const host = dom.window.document.getElementById("km-settings"), cleanup = await api.mountSettings(host); t.after(cleanup);
  const scroller = host.parentElement;
  scroller.scrollTo = ({ top }) => { scroller.scrollTop = top; };
  const tabs = [...host.querySelectorAll('[role="tab"]')]; tabs[0].focus();
  const key = (name, expected) => {
    scroller.scrollTop = 400;
    const event = new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    dom.window.document.activeElement.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(dom.window.document.activeElement, tabs[expected]);
    assert.equal(tabs[expected].getAttribute("aria-selected"), "true");
    assert.equal(scroller.scrollTop, 0);
  };
  key("ArrowLeft", 2); key("ArrowRight", 0); key("End", 2); key("Home", 0); key("ArrowRight", 1);
  host.querySelector('[role="tablist"]').style.direction = "rtl";
  key("ArrowRight", 0); key("ArrowLeft", 1);
  scroller.scrollTop = 400; tabs[2].click();
  assert.equal(scroller.scrollTop, 0);
  scroller.scrollTop = 200; tabs[2].click();
  assert.equal(scroller.scrollTop, 200);
  assert.match(host.querySelector("#km-settings-panel-mcp").textContent, /MCP is currently unavailable/);
});

test("a closed preference window's dead Gecko save registry is replaced before saving", async t => {
  const f = await parsingFixture(t); await f.config.start();
  const dead = new Proxy(new Map(), { get() { throw new TypeError("can't access dead object"); } });
  Zotero.__knowledgeMCPConfigWrites = dead;
  await f.config.save({ ...f.config.current, concurrency: 3 });
  assert.notEqual(Zotero.__knowledgeMCPConfigWrites, dead);
  assert.equal(Zotero.__knowledgeMCPConfigWrites.size, 0);
  assert.equal(JSON.parse(new TextDecoder().decode(f.files.get(f.config.path))).concurrency, 3);
});

test("preference unregistration failure still drains all application resources and remains retryable", async t => {
  await parsingFixture(t); const calls = []; let fail = true;
  Zotero.PreferencePanes = { unregister: () => { calls.push("preferences"); if (fail) throw Error("Unregister unavailable"); } };
  const application = new api.PluginApplication({ id: "fixture", rootURI: "file:///fixture/", version: "fixture" });
  application.preferencesID = "fixture-pane";
  application.knowledgeUI = { dispose: () => calls.push("knowledge-ui") };
  application.ui.dispose = () => calls.push("reader-ui");
  application.sync = { close: async () => calls.push("sync") };
  application.parsing = { close: async () => calls.push("parsing") };
  application.knowledge = { close: async () => calls.push("knowledge") };
  application.services.dispose = async () => calls.push("cache");
  application.database = { close: async () => calls.push("database") };
  await assert.rejects(application.dispose(), /Unregister unavailable/);
  assert.deepEqual(calls, ["sync", "parsing", "preferences", "knowledge-ui", "reader-ui", "knowledge", "cache", "database"]);
  assert.equal(application.preferencesID, "fixture-pane"); assert.equal(application.database, undefined);
  fail = false; await application.dispose(); assert.equal(application.preferencesID, undefined);
});

test("concurrent preference writers serialize stale checks and reject the second snapshot", async t => {
  const f = await parsingFixture(t); await f.config.start();
  const first = new api.ParsingConfigFile(), second = new api.ParsingConfigFile();
  f.beforeClose(async () => { await first.close(); await second.close(); });
  await first.reload(); await second.reload();
  const write = IOUtils.writeUTF8; let enter, release;
  const started = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  IOUtils.writeUTF8 = async (...args) => { enter(); await gate; return write(...args); };
  const saving = first.save({ ...first.current, concurrency: 3 }); await started;
  const stale = second.save({ ...second.current, concurrency: 4 });
  const results = Promise.allSettled([saving, stale]); release();
  try {
    const outcomes = await results;
    assert.equal(outcomes[0].status, "fulfilled"); assert.equal(outcomes[1].status, "rejected");
    assert.equal(JSON.parse(new TextDecoder().decode(f.files.get(first.path))).concurrency, 3);
    assert.equal(Zotero.__knowledgeMCPConfigWrites.size, 0);
  } finally { IOUtils.writeUTF8 = write; }
});

test("closing configuration drains accepted saves and rejects new writes", async t => {
  const f = await parsingFixture(t); await f.config.start();
  const write = IOUtils.writeUTF8; let enter, release;
  const started = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  IOUtils.writeUTF8 = async (...args) => { enter(); await gate; return write(...args); };
  const saving = f.config.save({ ...f.config.current, concurrency: 3 }); await started;
  let closed = false; const closing = f.config.close().then(() => { closed = true; });
  try {
    await settle(); assert.equal(closed, false);
    await assert.rejects(f.config.save(f.config.current), error => error.code === "config");
  } finally { release(); IOUtils.writeUTF8 = write; }
  await Promise.all([saving, closing]);
  assert.equal(JSON.parse(new TextDecoder().decode(f.files.get(f.config.path))).concurrency, 3);
});

test("settings save all parsing fields, retain profiles and reject invalid or conflicting edits", async t => {
  const f = await parsingFixture(t); await f.config.start();
  f.files.set(f.config.path, bytes(JSON.stringify(f.config.current))); await f.config.reload();
  const dom = new JSDOM('<section id="km-settings"></section>'); t.after(() => dom.window.close());
  const host = dom.window.document.getElementById("km-settings"), cleanup = await api.mountSettings(host); t.after(cleanup);
  assert.equal(host.querySelectorAll("#km-parsing-settings input").length, 11);
  assert.equal(host.querySelector('[type="password"]').getAttribute("autocomplete"), "off");
  assert.equal(host.querySelector("#km-setting-model"), null);
  host.querySelector("#km-setting-api").value = "https://ocr.example/jobs";
  const save = [...host.querySelectorAll("button")].find(node => node.textContent === "Save"); save.click(); await settle();
  assert.match(host.querySelector('[role="status"]').textContent, /Saved/);
  assert.equal(JSON.parse(new TextDecoder().decode(f.files.get(f.config.path))).profiles.paddleocr.model, "PaddleOCR-VL-1.6");
  assert.equal(JSON.parse(new TextDecoder().decode(f.files.get(f.config.path))).profiles.paddleocr.api, "https://ocr.example/jobs");
  host.querySelector("#km-setting-concurrency").value = "0"; save.click(); await settle();
  assert.match(host.querySelector('[role="status"]').textContent, /Could not save/);
  host.querySelector("#km-setting-concurrency").value = "2";
  f.files.set(f.config.path, bytes(JSON.stringify({ ...f.config.current, concurrency: 3 })));
  save.click(); await settle();
  assert.match(host.querySelector('[role="status"]').textContent, /Could not save/);
  assert.equal(JSON.parse(new TextDecoder().decode(f.files.get(f.config.path))).concurrency, 3);
});

test("clearing a completed task retains its structured generation and prevents accidental active deletion", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(); await f.step(); await f.step();
  const generation = (await f.job(id)).generation_id;
  const controller = { snapshot: await f.repo.snapshot() }, service = new api.ParsingService(f.db, controller, f.port, f.parsers); f.beforeClose(() => service.close());
  await service.runAction(id, "delete"); assert.equal(service.snapshot().length, 0);
  assert.equal((await f.job(id)).generation_id, generation);
  assert.equal((await f.db.selectFrom("content_generations").select("state").where("id", "=", generation).executeTakeFirstOrThrow()).state, "ready");
  const next = await f.enqueue(true);
  await assert.rejects(service.runAction(next, "delete"), error => error.code === "stale");
  assert.equal((await f.job(next)).state, "pending");
});

test("legacy named configurations keep credential references and fixed models across parser switches", async t => {
  const f = await parsingFixture(t); await f.config.start();
  const old = structuredClone(f.config.current);
  delete old.parserProfiles;
  old.profiles.custom = { ...old.profiles.paddleocr, model: "Legacy model", key: "legacy-key" };
  old.activeProfile = "custom";
  f.files.set(f.config.path, bytes(JSON.stringify(old))); await f.config.reload();
  assert.equal(f.config.error, false);
  assert.equal(f.config.current.profiles.custom.model, "PaddleOCR-VL-1.6");
  assert.equal(f.config.credential(api.parserIdentity(old.profiles.custom, "custom")), "legacy-key");
  assert.throws(() => api.validateParsingConfig(old), error => error.code === "config");
  const dom = new JSDOM('<section id="km-settings"></section>'); t.after(() => dom.window.close());
  const host = dom.window.document.getElementById("km-settings"), cleanup = await api.mountSettings(host); t.after(cleanup);
  const provider = host.querySelector("#km-setting-provider"); provider.value = "mineru"; provider.dispatchEvent(new dom.window.Event("change"));
  host.querySelector("#km-setting-key").value = "mineru-key";
  [...host.querySelectorAll("button")].find(button => button.textContent === "Save").click(); await settle();
  await f.config.reload(); assert.equal(f.config.current.parserProfiles.paddleocr, "custom");
  assert.equal(f.config.current.profiles.custom.key, "legacy-key");
  assert.equal(f.config.current.profiles.paddleocr.key, old.profiles.paddleocr.key);
});

test("task settings navigation uses Zotero's native preferences utility", async t => {
  const f = await parsingFixture(t); let pane;
  Zotero.Utilities = { Internal: { openPreferences: id => { pane = id; } } };
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers); f.beforeClose(() => service.close());
  service.openConfig(); assert.equal(pane, "knowledgemcp-settings");
});

test("an invalid configuration file can be repaired through settings without editing the file", async t => {
  const f = await parsingFixture(t); await f.config.start();
  f.files.set(f.config.path, bytes("{ invalid JSON"));
  const dom = new JSDOM('<section id="km-settings"></section>'); t.after(() => dom.window.close());
  const host = dom.window.document.getElementById("km-settings"), cleanup = await api.mountSettings(host); t.after(cleanup);
  assert.match(host.querySelector('[role="status"]').textContent, /Could not save/);
  [...host.querySelectorAll("button")].find(node => node.textContent === "Save").click(); await settle();
  assert.match(host.querySelector('[role="status"]').textContent, /Saved/);
  assert.equal(JSON.parse(new TextDecoder().decode(f.files.get(f.config.path))).version, 1);
});

test("manual parse retries replace old failures instead of leaving a stale failed row",async t=>{
  const f=await parsingFixture(t),first=await f.enqueue();
  await f.db.updateTable("processing_jobs").set({state:"failed",finished_at:Date.now(),error_code:"http-400"}).where("id","=",first).execute();
  const second=await f.enqueue();
  assert.equal(JSON.parse((await f.job(second)).payload_json).replacesJobID,first);
  // Cover pre-fix records which lack an explicit retry link.
  await f.db.updateTable("processing_jobs").set({payload_json:JSON.stringify(f.input)}).where("id","=",second).execute();
  const service=new api.ParsingService(f.db,{snapshot:await f.repo.snapshot()},f.port,f.parsers);f.beforeClose(()=>service.close());
  await service.refresh();assert.deepEqual(service.snapshot().map(task=>task.id),[second]);
});
