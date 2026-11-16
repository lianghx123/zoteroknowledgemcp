import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { api, parsingFixture } from "./fixtures/parsing.mjs";

test("sync settings explains modes and saves the selected relationship without duplicate creation", async t => {
  const f = await parsingFixture(t), dom = new JSDOM('<section id="km-sync-settings"></section>'); t.after(() => dom.window.close());
  const calls = [], binding = { id: "binding", title: "Source", location: "Knowledge › Source", mode: "flexible", enabled: true, target: f.target, folders: [] };
  const sync = { async configure(...args) { calls.push(args); }, async link() { assert.fail("Existing relationship must not be duplicated"); }, async unlink() {} };
  api.mountSyncSettings(dom.window, { sync, snapshot: await f.repo.snapshot(), bindings: [binding], collectionIDs: [100], defaultTarget: f.target });
  const selects = dom.window.document.querySelectorAll("select"), checks = dom.window.document.querySelectorAll('input[type="checkbox"]');
  assert.equal(selects[2].options.length, 3); assert.equal(selects[1].disabled, true);
  selects[2].value = "append"; selects[2].dispatchEvent(new dom.window.Event("change"));
  assert.match(dom.window.document.querySelector("p").textContent, /source removals are retained/);
  checks[0].checked = false; checks[1].checked = true;
  dom.window.document.dispatchEvent(new dom.window.Event("dialogaccept", { cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [["binding", "append", false, true]]);
});

test("new sync settings creates one relationship for the selected source collections", async t => {
  const f = await parsingFixture(t), dom = new JSDOM('<section id="km-sync-settings"></section>'); t.after(() => dom.window.close());
  const calls = [], sync = { async link(...args) { calls.push(args); } };
  api.mountSyncSettings(dom.window, { sync, snapshot: await f.repo.snapshot(), bindings: [], collectionIDs: [100, 101], defaultTarget: f.target });
  dom.window.document.querySelectorAll("select")[2].value = "mirror";
  dom.window.document.dispatchEvent(new dom.window.Event("dialogaccept", { cancelable: true })); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [[[100, 101], f.target, "mirror"]]);
});
