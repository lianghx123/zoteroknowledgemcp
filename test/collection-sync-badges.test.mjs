import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {readFileSync} from "node:fs";
import {api,parsingFixture} from "./fixtures/parsing.mjs";

for (const failure of ["subscription", "invalidation"]) test(`badge initialization rolls back its adapter after ${failure} fails`, async t => {
  await parsingFixture(t);
  const dom = new JSDOM("<div></div>"); t.after(() => dom.window.close());
  const window = dom.window; let subscribed = false;
  const native = () => window.document.createElement("span");
  const view = { _getIcon: native, getRow: () => undefined, tree: { invalidate() { throw Error("Detached tree"); } } };
  window.ZoteroPane = { collectionsView: view };
  assert.throws(() => new api.CollectionSyncBadges(window, { snapshot: () => [], subscribe() {
    if (failure === "subscription") throw Error("Source closed");
    subscribed = true; return () => { subscribed = false; };
  } }));
  assert.equal(view._getIcon, native); assert.equal(subscribed, false);
});

test("title adapter is restored when initialization fails or the item tree is already removed", async t => {
  await parsingFixture(t);
  const dom = new JSDOM("<div></div>"); t.after(() => dom.window.close());
  const window = dom.window, native = () => window.document.createElement("span");
  const view = { _renderCell: native, tree: { invalidate() { throw Error("Detached tree"); } } };
  window.ZoteroPane = { itemsView: view };
  assert.throws(() => new api.KnowledgeTitleStatus(window, { snapshot: {} }));
  assert.equal(view._renderCell, native);
  view.tree.invalidate = () => {};
  const title = new api.KnowledgeTitleStatus(window, { snapshot: {} });
  delete window.ZoteroPane.itemsView;
  assert.doesNotThrow(() => title.dispose()); assert.equal(view._renderCell, native);
});

for (const teardown of ["removed", "invalidated"]) test(`badge cleanup restores its adapter after the native tree is ${teardown}`, async t => {
  await parsingFixture(t);
  const dom = new JSDOM("<div></div>"); t.after(() => dom.window.close());
  const window = dom.window; let subscribed = false;
  const native = () => window.document.createElement("span");
  const view = { _getIcon: native, getRow: () => undefined, tree: { invalidate() {} } };
  window.ZoteroPane = { collectionsView: view };
  const badges = new api.CollectionSyncBadges(window, { snapshot: () => [], subscribe: () => { subscribed = true; return () => { subscribed = false; }; } });
  if (teardown === "removed") delete window.ZoteroPane.collectionsView;
  else view.tree.invalidate = () => { throw Error("Native tree already destroyed"); };
  assert.doesNotThrow(() => badges.dispose());
  assert.equal(view._getIcon, native); assert.equal(subscribed, false);
});

test("collection badges use theme-aware horizontal arrows and preserve the native folder icon",async t=>{
  await parsingFixture(t);
  const dom=new JSDOM("<div></div>");t.after(()=>dom.window.close());
  const w=dom.window;let invalidations=0,listener;
  const native=()=>{const icon=w.document.createElement("span");icon.className="icon icon-collection";return icon;};
  w.ZoteroPane={collectionsView:{_getIcon:native,getRow:()=>({isCollection:()=>true,ref:{libraryID:1,key:"FOLDER01"}}),tree:{invalidate:()=>invalidations++}}};
  const sync={snapshot:()=>[{nativeLibraryID:1,collectionKey:"FOLDER01",location:"Fixture › Folder",enabled:true}],subscribe:fn=>{listener=fn;return()=>{listener=undefined;};}};
  const view=new api.CollectionSyncBadges(w,sync),icon=w.ZoteroPane.collectionsView._getIcon(0);
  assert.ok(icon.querySelector(".icon-collection"));assert.match(icon.title,/Fixture › Folder/);
  assert.equal(icon.querySelector(".km-sync-badge").textContent,"");
  assert.equal(icon.querySelector("svg").getAttribute("viewBox"),"0 0 12 12");
  assert.equal(icon.querySelector("path").getAttribute("stroke"),"currentColor");
  listener();assert.equal(invalidations,2);view.dispose();assert.equal(w.ZoteroPane.collectionsView._getIcon,native);assert.equal(listener,undefined);
  const css=readFileSync("addon/content/ui/knowledge-library.css","utf8");
  assert.match(css,/focus-states-target:focus-within \.row\.selected \.km-sync-badge/);
  assert.match(css,/color: var\(--color-accent-text, white\)/);
});

test("HTTP rejection messages retain the status without exposing server response content",async t=>{
  await parsingFixture(t);assert.match(api.parsingErrorMessage("http-400"),/HTTP 400/);assert.match(api.parsingErrorMessage("http-503"),/HTTP 503/);
});

test("only explicit source and mapped destination roots receive sync badges and settings", async t => {
  await parsingFixture(t);
  const dom = new JSDOM("<div></div>"); t.after(() => dom.window.close());
  const w = dom.window;
  const rows = [
    { id: "Kknowledgemcp:folder:target-root", isCollection: () => false, ref: {} },
    { id: "C100", isCollection: () => true, ref: { libraryID: 1, key: "FOLDER01" } },
    { id: "Kknowledgemcp:folder:target-child", isCollection: () => false, ref: {} },
    { id: "C101", isCollection: () => true, ref: { libraryID: 1, key: "CHILD001" } },
  ];
  w.ZoteroPane = { collectionsView: { _getIcon: () => w.document.createElement("span"), getRow: index => rows[index], tree: { invalidate() {} } } };
  const bindings = [{ nativeLibraryID: 1, collectionKey: "FOLDER01", enabled: true, mode: "flexible", location: "Knowledge › Source",
    folders: [{ nodeID: "target-root", collectionKey: "FOLDER01" }, { nodeID: "target-child", collectionKey: "CHILD001" }] }];
  const sync = { snapshot: () => bindings, subscribe: () => () => {} };
  const badges = new api.CollectionSyncBadges(w, sync);
  for (let index = 0; index < rows.length; index++) {
    const icon = w.ZoteroPane.collectionsView._getIcon(index);
    assert.equal(Boolean(icon.querySelector(".km-sync-badge")), index < 2);
    assert.equal(api.canConfigureCollectionSync(bindings, rows[index]), index < 2);
    if (index < 2) assert.match(icon.title, /Flexible sync/);
  }
  assert.equal(api.canConfigureCollectionSync(bindings, { isCollection: () => true, ref: { libraryID: 1, key: "UNLINKED" } }), true);
  badges.dispose();
});

test("new source descendants inherit the root setting before their first synchronization scan", async t => {
  await parsingFixture(t);
  const collections = new Map([[100, { id: 100, key: "FOLDER01", parentID: false }], [102, { id: 102, key: "NEWCHILD", parentID: 100 }]]);
  Zotero.Collections = { get: id => collections.get(id) || false };
  const bindings = [{ nativeLibraryID: 1, collectionKey: "FOLDER01", folders: [] }];
  const row = { isCollection: () => true, ref: { id: 102, libraryID: 1, key: "NEWCHILD" } };
  assert.equal(api.canConfigureCollectionSync(bindings, row), false);
});
