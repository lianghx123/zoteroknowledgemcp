import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { api, parsingFixture } from "./fixtures/parsing.mjs";
const settle = () => new Promise(resolve => setImmediate(resolve));

test("native search keeps its preference, submits only on Enter, fences stale results and restores its filter", async t => {
  await parsingFixture(t);
  const dom = new JSDOM('<html><body><div id="zotero-items-pane"><div id="toolbar"><div id="zotero-tb-search"><input/></div><button id="advanced"/></div><div id="popup"><menuitem id="native"/></div></div></body></html>');
  t.after(() => dom.window.close()); const window = dom.window, doc = window.document, quick = doc.getElementById("zotero-tb-search");
  quick.searchTextbox = quick.querySelector("input"); quick.inputField = quick.searchTextbox; quick.searchModePopup = doc.getElementById("popup"); quick.updateMode = () => {};
  quick.searchTextbox.value = "native filter";
  const prefs = new Map([["search.quicksearch-mode", "fields"]]); Zotero.Prefs = { get: key => prefs.get(key), set: (key,value) => prefs.set(key,value) };
  const items = [1,2].map(id => ({ id, isRegularItem: () => true }));
  const row = { id:"L1", searchText:"native filter", tags:new Set(), advancedSearch:null, isTrash:()=>false, clearCache() {},
    async getSearchResults(asTable) {return asTable ? "tmpSearchResults_native" : [1,2];}, async getItems() {return items;} };
  const originalItems = row.getItems, originalSearch = row.getSearchResults;
  const provider = { _rows:[], _sort() {}, refreshRowMap() {} };
  const tables = new Map();
  Zotero.Search = { async idsToTempTable(ids) { const table=`tmpSearchResults_${tables.size}`;tables.set(table,[...ids]);return table; } };
  let nativeCalls = 0;
  const view = { collectionTreeRows:[row], rowProvider:provider, async setFilter() {}, async sort() {}, _handleColumnSort() {},
    async refreshAndMaintainSelection() { await row.getSearchResults(true);provider._rows=(await row.getItems()).flatMap(item=>[{isObjectRow:true,level:0,ref:item},{isObjectRow:true,level:1,ref:{id:item.id+10}}]);provider._sort(); } };
  window.ZoteroPane = { itemsView:view, async search() {nativeCalls++;row.searchText=quick.searchTextbox.value;}, async onCollectionSelected(){} };
  let sections = 0;
  Zotero.getMainWindows = () => [window]; Zotero.ItemPaneManager = { registerSection() {sections++;return "evidence";},unregisterSection:()=>true };
  const pending = [], controller = {snapshot:{resources:[{id:"r1",itemID:1},{id:"r2",itemID:2}],itemResources:new Map(),sources:[]}};
  const retrieval = {search(query,mode,scope,signal){return new Promise(resolve=>pending.push({query,mode,scope,signal,resolve}));}};
  const ui = new api.RetrievalUI("fixture","file:///fixture/",controller,retrieval,{});ui.start();t.after(()=>ui.dispose());
  assert.equal(doc.getElementById("km-search-status"),null,"no search summary or retry footer is created");
  assert.equal(sections,0,"evidence lives in the central item expansion, not a separate right pane");
  assert.equal(doc.querySelector("#km-search-modes"),null);
  assert.deepEqual([...quick.searchModePopup.querySelectorAll("[data-mode]")].map(menu=>menu.getAttribute("data-mode")),["fulltext","semantic","enhanced","fusion"]);
  assert.equal(quick.nextElementSibling.id,"advanced");
  doc.getElementById("km-search-fulltext").dispatchEvent(new window.Event("command",{bubbles:true}));await settle();
  for (const mode of ["fulltext","semantic","enhanced","fusion"]) {
    doc.querySelector(`[data-mode="${mode}"]`).dispatchEvent(new window.Event("command",{bubbles:true}));await settle();
    assert.equal(doc.getElementById(`km-search-${mode}`).getAttribute("checked"),"true");
    assert.equal(quick.searchModePopup.querySelectorAll('[checked="true"]').length,1);
    assert.deepEqual((await row.getItems()).map(item=>item.id),[1,2],`${mode} selection keeps native items`);
    assert.deepEqual(await row.getSearchResults(false),[1,2]);
    assert.equal(await row.getSearchResults(true),"tmpSearchResults_native");
    assert.equal(row.searchText,"native filter");assert.equal(pending.length,0);
  }
  assert.equal(tables.size,0,"mode selection must not install an empty result filter");
  doc.querySelector('[data-mode="semantic"]').dispatchEvent(new window.Event("command",{bubbles:true}));await settle();
  assert.equal(prefs.get("search.quicksearch-mode"),"fields");
  const enter = extra => quick.searchTextbox.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Enter",bubbles:true,...extra}));
  quick.searchTextbox.value="first";quick.dispatchEvent(new window.Event("compositionstart"));enter({isComposing:true});await settle();assert.equal(pending.length,0);
  quick.dispatchEvent(new window.Event("compositionend"));enter();await settle();assert.equal(pending.length,1);assert.equal(quick.searchTextbox.getAttribute("aria-busy"),"true");
  quick.searchTextbox.value="second";enter();await settle();assert.equal(pending.length,2);assert.equal(pending[0].signal.aborted,true);assert.deepEqual(pending[1].scope,["r1","r2"]);
  const result = id => ({query:"test",mode:"semantic",hits:[{resourceID:id,title:id,evidence:[],score:1,scoreType:"cosine",parsed:true,embedded:true,metadataOnly:false}],channels:["vector"],degraded:[],timings:{embeddingMs:1,localMs:1,rerankMs:0}});
  pending[1].resolve(result("r2"));await settle();pending[0].resolve(result("r1"));await settle();
  assert.equal(doc.getElementById("km-search-status"),null);assert.equal(quick.searchTextbox.hasAttribute("aria-busy"),false);
  assert.deepEqual((await row.getItems()).map(item=>item.id),[2]);assert.deepEqual(provider._rows.filter(row=>row.isObjectRow).map(row=>row.ref.id),[2]);
  assert.equal(provider._rows[0].ref.id,2);
  assert.deepEqual(tables.get(await row.getSearchResults(true)),[2],"completed results replace the pending empty native table");
  doc.getElementById("km-search-fulltext").dispatchEvent(new window.Event("command",{bubbles:true}));await settle();
  assert.equal(pending.length,2);assert.deepEqual((await row.getItems()).map(item=>item.id),[2],"switching modes keeps the last submitted result");
  quick.searchTextbox.value="   ";enter();await settle();
  assert.equal(pending.length,2);assert.deepEqual((await row.getItems()).map(item=>item.id),[1,2],"empty Enter restores the native list without querying");
  quick.searchTextbox.value="nothing";enter();await settle();assert.equal(pending.length,3);assert.equal(pending[2].mode,"fulltext");
  pending[2].resolve({...result("r1"),hits:[]});await settle();
  assert.deepEqual(await row.getItems(),[],"a submitted query with no matches still displays an empty result");
  doc.getElementById("native").dispatchEvent(new window.Event("command",{bubbles:true}));await settle();
  assert.equal(row.searchText,"native filter");assert.equal(quick.searchTextbox.value,"native filter");assert.ok(nativeCalls>0);
  ui.dispose();assert.equal(quick.searchModePopup.querySelector("[data-mode]"),null);assert.ok(doc.getElementById("native"));assert.equal(row.getItems,originalItems);assert.equal(row.getSearchResults,originalSearch);
});

test("knowledge overview and both Trash views support scoped retrieval, including unavailable knowledge Trash references",async t=>{
  await parsingFixture(t);
  const dom=new JSDOM('<div id="zotero-items-pane"><div><div id="zotero-tb-search"><input/></div></div><div id="popup"></div></div>');t.after(()=>dom.window.close());
  const window=dom.window,doc=window.document,quick=doc.getElementById("zotero-tb-search");quick.searchTextbox=quick.querySelector("input");quick.searchModePopup=doc.getElementById("popup");quick.updateMode=()=>{};
  const rows={active:[{id:1}],trash:[{id:2},{id:"missing-reference",knowledgeTrashResourceID:"missing"},{id:"folder",knowledgeTrashKind:"folder"}]};
  let current=rows.active;const row={id:"Kknowledgemcp:overview",searchText:"",tags:new Set(),advancedSearch:null,isTrash:()=>row.id==="T1",clearCache(){},async getItems(){return current;},async getSearchResults(){return current.filter(row=>typeof row.id==="number").map(row=>row.id);}};
  const provider={_rows:[],_sort(){},refreshRowMap(){}};window.ZoteroPane={itemsView:{collectionTreeRows:[row],rowProvider:provider,async setFilter(){},_handleColumnSort(){},async refreshAndMaintainSelection(){provider._rows=(await row.getItems()).map(ref=>({isObjectRow:true,ref,level:0}));}},async onCollectionSelected(){},async search(){}};
  Zotero.getMainWindows=()=>[window];Zotero.Prefs={get:()=>"",set(){}};Zotero.ItemPaneManager={registerSection:()=>"evidence",unregisterSection:()=>true};
  const snapshot={resources:[{id:"active",itemID:1}],trashedResources:[{id:"trash",itemID:2},{id:"missing",itemID:3}],itemResources:new Map(),sources:[]},calls=[];
  const retrieval={async search(query,mode,scope,signal,scopeKind){calls.push({scope,scopeKind});return {query,mode,hits:scope.map(resourceID=>({resourceID})),channels:["fulltext"],degraded:[]};}};
  const ui=new api.RetrievalUI("fixture","file:///fixture/",{snapshot},retrieval,{});ui.start();t.after(()=>ui.dispose());
  const submit=async()=>{doc.getElementById("km-search-fulltext").dispatchEvent(new window.Event("command",{bubbles:true}));await settle();quick.searchTextbox.value="query";quick.searchTextbox.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Enter",bubbles:true}));await settle();};
  assert.equal(doc.querySelector("[data-mode=semantic]").getAttribute("disabled"),"false");await submit();assert.deepEqual(calls.at(-1),{scope:["active"],scopeKind:"active"});
  row.id="Kknowledgemcp:trash";current=rows.trash;await window.ZoteroPane.onCollectionSelected();assert.equal(doc.querySelector("[data-mode=semantic]").getAttribute("disabled"),"false");await submit();
  assert.deepEqual(calls.at(-1),{scope:["trash","missing"],scopeKind:"trash"});assert.deepEqual((await row.getItems()).map(row=>row.id),[2,"missing-reference"]);
  assert.equal(row.knowledgeRetrieval,true);
  row.id="T1";current=rows.active;await window.ZoteroPane.onCollectionSelected();await submit();assert.deepEqual(calls.at(-1),{scope:["active"],scopeKind:"active"});
  assert.equal(row.knowledgeRetrieval,undefined,"leaving knowledge Trash restores its native scope mode");
  row.id="Kknowledgemcp:import-tasks";await window.ZoteroPane.onCollectionSelected();assert.equal(doc.querySelector("[data-mode=semantic]").getAttribute("disabled"),"true");
});
