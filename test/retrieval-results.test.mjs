import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { api, parsingFixture } from "./fixtures/parsing.mjs";

const hit = (id, score, scoreType = "cosine") => ({ resourceID:id, title:id, score, scoreType, evidence:[], parsed:true, embedded:true, metadataOnly:false });


function inlineFixture(window, result, itemObjects = [1, 2].map(id => ({ id, isAnnotation: () => false }))) {
  const doc = window.document, stats = { fullPaints: 0, rowPaints: [], nativeToggles: 0, heightWrites: 0 };
  let heights = [];
  const createRow = (ref, level = 0) => ({ ref, id: ref.id, level, isOpen: false, isObjectRow: true,
    isContainer: () => true, isContainerEmpty: () => false, getChildItems: () => [{ id: ref.id + 100 }], renderRow() {} });
  const provider = { _rows: [], createRow, refreshRowMap() {},
    _sort() { this._rows = this._rows.filter(row => row.level === 0).sort((a, b) => b.ref.id - a.ref.id); },
    toggleOpenState(index) { stats.nativeToggles++; this._toggleOpenState(index); },
    _toggleOpenState(index) { const row = this._rows[index]; if (row.isOpen) this._rows.splice(index + 1, 1); else this._rows.splice(index + 1, 0, ...row.getChildItems().map(ref => this.createRow(ref, 1))); row.isOpen = !row.isOpen; },
  };
  const inner = doc.createElement("div"); doc.body.append(inner);
  const list = { itemHeight: 28, scrollOffset: 0, innerElem: inner, _renderedRows: new Map(), render() {},
    getItemCount: () => provider._rows.length, getWindowHeight: () => 300,
    getFirstVisibleRow() {
      const preceding = heights.filter(([index, height]) => this._getItemPosition(index) + height <= this.scrollOffset).at(-1);
      const index = preceding ? preceding[0] + 1 : 0, top = this._getItemPosition(index);
      return index + Math.floor((this.scrollOffset - top) / 28);
    },
    getLastVisibleRow() { return Math.ceil((this.scrollOffset + this.getWindowHeight() + 1) / 28) - 1; },
    _getItemPosition(index) { return index * 28 + heights.filter(([row]) => row < index).reduce((sum, [, height]) => sum + height - 28, 0); } };
  const renderNative = (index, _selection, old) => {
    const node = old ?? doc.createElement("div"), row = provider._rows[index]; node.replaceChildren(); node.setAttribute("draggable", "true");
    const cell = doc.createElement("span"); cell.className = "cell title";
    const twisty = doc.createElement("span"); twisty.className = "icon icon-css icon-twisty twisty" + (row.isOpen ? " open" : "");
    twisty.onclick = () => provider.toggleOpenState(index);
    const title = doc.createElement("span"); title.className = "cell-text"; title.textContent = "Native title " + row.ref.id;
    cell.append(twisty, title); node.append(cell); node.style.height = (heights.find(([row]) => row === index)?.[1] ?? 28) + "px"; return node;
  };
  const view = { rowProvider: provider, _renderItem: renderNative, tree: { _jsWindow: list,
    updateCustomRowHeights(value) { stats.heightWrites++; heights = value; },
    invalidate() { stats.fullPaints++; },
    invalidateRow(index) { stats.rowPaints.push(index); list._renderedRows.set(index, view._renderItem(index, {}, list._renderedRows.get(index))); },
    _getWindowedListOptions: () => ({}),
  } };
  window.ZoteroPane = { itemsView: view };
  const controller = { snapshot: { itemResources: new Map([[1, "r1"], [2, "r2"]]), resources: [], sources: [{ id: "s1", title: "source.pdf" }] } };
  const embedding = { repository: { db: { selectFrom() { return { select() { return this; }, where() { return this; }, async executeTakeFirst() { return { local_item_id: 88 }; } }; } } } };
  const adapter = new api.RetrievalResultList(window, controller, embedding, result, () => new Map([[1, 0], [2, 1]]), () => false);
  provider._rows = itemObjects.map(item => provider.createRow(item, 0)); provider._sort();
  const mount = () => { inner.replaceChildren(); list._renderedRows.clear(); provider._rows.forEach((row, index) => { const node = view._renderItem(index, {}); node.style.top = list._getItemPosition(index) + "px"; inner.append(node); list._renderedRows.set(index, node); }); };
  mount(); return { adapter, view, provider, list, stats, mount, itemObjects, createRow, heights: () => heights };
}

test("ordinary attachment toggles and sorts never change row maps or custom heights outside plugin results", async t => {
  await parsingFixture(t); const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close());
  let maps = 0, sizes = 0;
  const provider = { _rows: [{ ref: { id: 1 }, isObjectRow: true, isOpen: false }], refreshRowMap() { maps++; }, _sort() {}, _toggleOpenState() { this._rows[0].isOpen = !this._rows[0].isOpen; } };
  const rows = provider._rows, view = { rowProvider: provider, tree: { updateCustomRowHeights() { sizes++; }, invalidate() {} } };
  dom.window.ZoteroPane = { itemsView: view };
  const list = new api.RetrievalResultList(dom.window, { snapshot: {} }, {}, () => undefined, () => new Map(), () => false);
  provider._sort(); provider._toggleOpenState(0); list.refresh();
  assert.equal(provider._rows, rows); assert.equal(provider._rows[0].isOpen, true); assert.equal(maps, 0); assert.equal(sizes, 0);
  list.dispose(); assert.equal(provider._rows, rows); assert.equal(maps, 0); assert.equal(sizes, 0);
});

test("inline expansion changes geometry and only redraws the toggled native row", async t => {
  await parsingFixture(t); const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close());
  const result = { query: "body", hits: [hit("r1", .8), hit("r2", .7)] }, f = inlineFixture(dom.window, () => result); t.after(() => f.adapter.dispose());
  const original = f.provider._rows, following = f.list._renderedRows.get(1);
  f.provider.toggleOpenState(0);
  assert.deepEqual(f.heights(), [[0, 252]]); assert.equal(following.style.top, "252px"); assert.equal(f.list.innerElem.style.height, "280px");
  assert.ok(f.list._renderedRows.get(0).querySelector(".km-inline-evidence"));
  f.provider.toggleOpenState(0);
  assert.deepEqual(f.heights(), []); assert.equal(following.style.top, "28px"); assert.equal(f.list.innerElem.style.height, "56px");
  assert.equal(f.provider._rows, original); assert.equal(f.list._renderedRows.get(1), following);
  assert.equal(f.stats.nativeToggles, 0); assert.equal(f.stats.fullPaints, 0); assert.deepEqual(f.stats.rowPaints, [0, 0]);
  assert.equal(f.stats.heightWrites, 2); assert.ok(f.provider._rows.every(row => f.itemObjects.includes(row.ref)));
});

test("unloading cancels deferred expansion updates and releases native adapters", async t => {
  await parsingFixture(t); const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close());
  const result = { query: "body", hits: [hit("r1", .8), hit("r2", .7)] }, f = inlineFixture(dom.window, () => result);
  f.provider._toggleOpenState(0, true);
  Object.defineProperty(dom.window, "closed", { configurable: true, value: true });
  f.view.tree.updateCustomRowHeights = () => { throw new Error("detached tree must not be updated"); };
  f.adapter.dispose(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(f.stats.rowPaints, []); assert.equal(f.stats.fullPaints, 0);
  assert.equal(f.provider.createRow, f.createRow); assert.equal(dom.window.document.querySelector("style"), null);
});

test("scrolling within tall evidence rows retains every intersecting document", async t => {
  await parsingFixture(t); const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close());
  let result = { query: "body", hits: [hit("r1", .8), { ...hit("r2", .2), relevance: { group: "possible" } }] };
  const f = inlineFixture(dom.window, () => result); t.after(() => f.adapter.dispose());
  f.provider.toggleOpenState(0); f.provider.toggleOpenState(1);
  const first = f.list.getFirstVisibleRow, last = f.list.getLastVisibleRow;
  for (const height of [1, 100, 300, 900]) {
    f.list.getWindowHeight = () => height;
    for (let offset = 0; offset < 528; offset++) {
      f.list.scrollOffset = offset;
      const positions = [0, 252];
      assert.equal(first.call(f.list), positions.findLastIndex(top => top <= offset), `first at ${offset}`);
      assert.equal(last.call(f.list), positions.findLastIndex(top => top < offset + height + 1), `last at ${offset}/${height}`);
    }
  }
  f.provider.toggleOpenState(0); f.list.scrollOffset = 120;
  assert.equal(f.list.getFirstVisibleRow(), 1, "collapse updates the boundaries used for scrolling");
  result = undefined; f.adapter.refresh(); f.list.scrollOffset = 56;
  assert.equal(f.list.getFirstVisibleRow(), 2, "ordinary lists delegate to the native method");
  f.adapter.dispose();
  assert.notEqual(f.list.getFirstVisibleRow, first); assert.notEqual(f.list.getLastVisibleRow, last);
});

test("relevance thresholds are inclusive, preserve keyword matches, and retain fusion cosine provenance", () => {
  for (const scoreType of ["cosine","rerank"]) {
    assert.equal(api.classifyRelevance(hit("a",.5,scoreType),.5).group,"matched");
    assert.equal(api.classifyRelevance(hit("a",.4999,scoreType),.5).group,"possible");
  }
  assert.deepEqual(api.classifyRelevance(hit("a",.000001,"fts"),.5),{basis:"keyword",group:"matched"});
  const [fused] = api.reciprocalRankFusion([[{...hit("a",.2),channels:["vector"]}],[{...hit("a",.0001,"metadata"),channels:["metadata"]}]]);
  assert.equal(fused.vectorScore,.2);assert.deepEqual(fused.channels,["vector","metadata"]);
  assert.deepEqual(api.classifyRelevance(fused,.5),{basis:"cosine",score:.2,group:"possible"});
  assert.equal(api.classifyRelevance({...fused,score:.8,scoreType:"rerank"},.5).group,"matched");
  const config=structuredClone(api.defaultRetrievalConfig), key=api.spaceKey(config);delete config.relevanceThreshold;
  assert.equal(api.validateRetrievalConfig(config).relevanceThreshold,.5,"old saved files acquire the default without a profile migration");
  for(const value of [-.1,1.1,NaN,Infinity,null,"0.5"])assert.throws(()=>api.validateRetrievalConfig({...config,relevanceThreshold:value}));
  config.relevanceThreshold=.75;assert.equal(api.spaceKey(config),key,"threshold edits never re-embed content");
});

test("retrieval retains below-threshold candidates after rerank and on degraded fusion", async t => {
  const f=await parsingFixture(t);const config={...structuredClone(api.defaultRetrievalConfig),enabled:true};
  const embedding={repository:{db:f.db},config:{current:config},gateway:{async embed(){return [new Float32Array(768)];},async rerank(){return [{index:1,score:.8},{index:0,score:.2}];}}};
  const service=new api.RetrievalService(embedding),id=f.input.resourceID;
  const other=await f.repo.save({...f.item,key:"ARTICLE2",itemID:2,attachments:[]},f.target);
  service.vector=async()=>[hit(id,.7),hit(other,.3)];
  const run=mode=>service.search("Body",mode,[id,other],new AbortController().signal);
  let result=await run("semantic");assert.equal(result.threshold,.5);assert.deepEqual(result.hits.map(row=>row.relevance.group),["matched","possible"]);
  result=await run("enhanced");assert.deepEqual(result.hits.map(row=>[row.resourceID,row.relevance.group]),[[other,"matched"],[id,"possible"]]);
  service.text=async()=>[{...hit(id,.0001,"fts"),channels:["fulltext"]}];
  embedding.gateway.rerank=async()=>{throw new api.ModelError("network");};
  service.vector=async()=>[{...hit(id,.3),channels:["vector"]}];
  result=await run("fusion");assert.equal(result.hits[0].relevance.group,"possible");assert.equal(result.hits[0].relevance.score,.3);assert.equal(result.degraded[0].channel,"rerank");
  embedding.gateway.embed=async()=>{throw new api.ModelError("network");};service.close();
  result=await run("fusion");assert.equal(result.hits[0].relevance.group,"matched");assert.equal(result.hits[0].relevance.basis,"keyword");assert.equal(result.degraded.length,2);
});

test("metadata evidence identifies matching fields without repeating the title as other metadata",async t=>{
  const f=await parsingFixture(t),repository=new api.EmbeddingRepository(f.db),id=f.input.resourceID;
  await f.db.updateTable("knowledge_resources").set({title:"UniqueKeyword",metadata_json:JSON.stringify({fields:{title:"UniqueKeyword",extra:"Different detail"},tags:[]})}).where("id","=",id).execute();
  await repository.projectFulltext();
  const service=new api.RetrievalService({repository,config:{current:structuredClone(api.defaultRetrievalConfig)}});
  const result=await service.search("UniqueKeyword","fusion",[id],new AbortController().signal);
  assert.deepEqual(result.hits[0].metadataMatches,[{field:"title",text:"UniqueKeyword"}]);assert.equal(result.hits[0].relevance.basis,"keyword");
});

test("native arrows expand inline evidence and relevance notices stay outside the title cell", async t => {
  await parsingFixture(t); const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close()); const w = dom.window, doc = w.document;
  const evidence = { blockID: "b1", sourceID: "s1", generationID: "g1", section: "Results", page: 2, text: '<img src=x onerror="alert(1)"> liquidity 融资约束 ' + "word ".repeat(200), score: .8, scoreType: "cosine", channel: "vector" };
  let result = { query: "liquidity 融资", hits: [{ ...hit("r1", .8), evidence: [evidence], relevance: { group: "matched" } }, { ...hit("r2", .2), relevance: { group: "possible" } }] };
  const f = inlineFixture(w, () => result); t.after(() => f.adapter.dispose());
  assert.deepEqual(f.provider._rows.map(row => row.ref.id), [1, 2]); assert.deepEqual(f.heights(), [[1, 52]]);
  const possible = f.list._renderedRows.get(1), note = possible.querySelector(".km-relevance-note");
  assert.equal(note.closest(".cell"), null); assert.equal(possible.querySelector(".cell-text").textContent, "Native title 2");
  assert.equal(note.textContent, "The following content may be relevant");
  assert.deepEqual(f.provider._rows.map(row => row.ref.isAnnotation()), [false, false]);
  const row = () => f.list._renderedRows.get(0), arrow = () => row().querySelector(".twisty");
  assert.ok(arrow().classList.contains("icon-twisty")); assert.equal(arrow().textContent, ""); arrow().click();
  assert.ok(arrow().classList.contains("open")); const panel = row().querySelector(".km-retrieval-panel"), card = panel.querySelector("details");
  assert.ok(card.open); assert.equal(panel.querySelector("img"), null); assert.ok(panel.querySelector("mark")); assert.match(panel.textContent, /Results/);
  const writes = f.stats.heightWrites; card.open = false; assert.equal(f.stats.heightWrites, writes, "passage disclosure does not change the outer row height");
  arrow().click(); assert.equal(row().querySelector(".km-inline-evidence"), null); arrow().click();
  assert.equal(row().querySelector(".km-retrieval-panel"), panel); assert.equal(card.open, false, "cached passage state survives collapse");
  card.open = true; panel.querySelector("button").click(); assert.equal(panel.querySelector("blockquote").textContent, evidence.text);
  let opened; Zotero.Reader = { async open(id, location) { opened = { id, location }; } }; panel.querySelector("a.km-evidence-source").click();
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(opened, { id: 88, location: { pageIndex: 1 } });
  result = { ...result, hits: result.hits.map(hit => ({ ...hit, relevance: { group: "possible" } })) }; f.provider._sort(); f.mount();
  assert.equal(doc.querySelectorAll(".km-relevance-note").length, 1); assert.equal(f.list._renderedRows.get(0).querySelector(".km-relevance-note").closest(".cell"), null);
  assert.deepEqual(f.provider._rows.map(row => row.ref.isAnnotation()), [false, false]);
  result = undefined; f.adapter.refresh(); f.provider._sort(); f.mount();
  assert.equal(doc.querySelector(".km-relevance-note"), null); assert.equal(doc.querySelector(".km-inline-evidence"), null); assert.deepEqual(f.heights(), []);
  f.provider.toggleOpenState(1); assert.equal(f.provider._rows[2].ref.id, 101, "native attachment expansion returns when search ends");
  f.adapter.dispose(); assert.equal(f.provider.createRow, f.createRow); assert.equal(doc.querySelector("style"), null);
});

test("highlighting uses text nodes and excerpts preserve surrogate pairs",()=>{
  assert.deepEqual(api.highlightRanges("a+b A+B","a+b"),[[0,1],[2,3],[4,5],[6,7]]);
  const text="prefix ".repeat(200)+"😀 liquidity "+"tail ".repeat(200),excerpt=api.evidenceExcerpt(text,"liquidity",200);
  assert.ok(excerpt.includes("liquidity"));assert.ok(!/^[\uDC00-\uDFFF]/u.test(excerpt));assert.ok(!/[\uD800-\uDBFF]$/u.test(excerpt));
});
