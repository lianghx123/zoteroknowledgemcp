import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {createContext,runInContext} from "node:vm";
import {api,parsingFixture} from "./fixtures/parsing.mjs";
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test("bootstrap shutdown survives loss of the main window and uses process-lived shared values",async()=>{
  const events=[];let closed=false;
  const window={get Promise(){throw Error("Window Promise must not own plugin lifecycle");},get Map(){throw Error("Window Map must not own shared registries");}};
  const Zotero={getMainWindows:()=>closed?[]:[window]},timer={setTimeout(){}};let sandbox;
  sandbox=createContext({Zotero,Components:{utils:{getGlobalForObject(value){assert.equal(value,timer.setTimeout);return {Promise,Map};}}},ChromeUtils:{importESModule(uri){assert.equal(uri,"resource://gre/modules/Timer.sys.mjs");return timer;}},Ci:{},
    Cc:{"@mozilla.org/addons/addon-manager-startup;1":{getService:()=>({registerChrome:()=>({destruct(){events.push("chrome-closed");}})})}},
    Services:{io:{newURI:uri=>uri,getProtocolHandler:()=>({QueryInterface(){return this;},setSubstitution(){}})},scriptloader:{loadSubScript(){sandbox.ZoteroKnowledgeMCP={async startup(){events.push("started");},async shutdown(){events.push("stopped");}};}}},
  });
  runInContext(readFileSync("addon/bootstrap.js","utf8"),sandbox);await sandbox.startup({rootURI:"file:///fixture/"});closed=true;
  await sandbox.shutdown();assert.deepEqual(events,["started","stopped","chrome-closed"]);assert.equal(Zotero.__knowledgeMCPBootstrapInstances.size,0);
});

test("application cancels every producer before waiting, and closes storage after draining",async t=>{
  await parsingFixture(t);const app=new api.PluginApplication({id:"fixture",version:"fixture",rootURI:"file:///fixture/"}),events=[];
  let release;const gate=new Promise(resolve=>{release=resolve;});
  app.embeddings={async close(){events.push("embedding-stop");await gate;events.push("embedding-drained");}};
  app.parsing={async close(){events.push("parsing-stop");}};app.sync={async close(){events.push("sync-stop");}};
  app.knowledge={async close(){events.push("knowledge-drained");}};app.database={async close(){events.push("database-closed");}};
  const stopping=app.dispose();await settle();assert.deepEqual(events,["embedding-stop","sync-stop","parsing-stop"]);
  release();await stopping;assert.equal(events.at(-1),"database-closed");assert.ok(events.indexOf("knowledge-drained")>events.indexOf("embedding-drained"));
});

test("vector shutdown interrupts pending worker operations before waiting for its queue",async t=>{
  const f=await parsingFixture(t),repository=new api.EmbeddingRepository(f.db),store=new api.VectorStore(repository,"file:///fixture/");
  let release,terminated=false;store.tail=new Promise(resolve=>{release=resolve;});store.index.close=()=>{terminated=true;release();};
  await store.close();assert.equal(terminated,true);assert.equal(store.readable,false);
});

test("embedding shutdown interrupts the index immediately and drains detached task refreshes",async t=>{
  const f=await parsingFixture(t),service=new api.EmbeddingService(f.db,"file:///fixture/");let interrupted=false,refreshed=false,releaseTick,releaseRefresh;
  service.ticking=new Promise(resolve=>{releaseTick=resolve;});service.store.close=async()=>{interrupted=true;releaseTick();};service.config.close=async()=>{};
  service.refreshTasks=()=>new Promise(resolve=>{releaseRefresh=resolve;});const refresh=service.refresh();
  const close=service.close().then(()=>{refreshed=true;});await settle();assert.equal(interrupted,true);assert.equal(refreshed,false,"storage ownership must wait for detached refresh queries");
  releaseRefresh();await Promise.all([refresh,close]);assert.equal(service.refreshes.size,0);
});

test("closing during vector discovery cannot create a worker after shutdown starts", async t => {
  const f = await parsingFixture(t), repository = new api.EmbeddingRepository(f.db);
  const store = new api.VectorStore(repository, "file:///fixture/");
  const config = structuredClone(api.defaultRetrievalConfig), profile = await repository.profile(config);
  let started, finish, opens = 0;
  const waiting = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  const hash = repository.port.hash.bind(repository.port);
  repository.port.hash = async value => { const result = await hash(value); started(); await gate; return result; };
  store.index.open = async () => { opens++; };
  store.index.save = async path => { await IOUtils.write(path, new Uint8Array([1])); return { bytes: 1, hash: "a".repeat(64) }; };
  const syncing = store.sync(profile, config, new AbortController().signal);
  const rejected = assert.rejects(syncing, /index-closed/);
  await waiting;
  const closing = store.close(); finish(); await rejected; await closing;
  assert.equal(opens, 0); assert.equal(store.readable, false);
});

test("closing during failed snapshot restore cannot launch the rebuild fallback", async t => {
  const f = await parsingFixture(t), repository = new api.EmbeddingRepository(f.db);
  const config = structuredClone(api.defaultRetrievalConfig), profile = await repository.profile(config);
  const seed = new api.VectorStore(repository, "file:///fixture/");
  Object.assign(seed.index, { async open() {}, close() {}, async save(path) {
    await IOUtils.write(path, new Uint8Array([1])); return { bytes: 1, hash: "a".repeat(64) };
  } });
  await seed.sync(profile, config, new AbortController().signal); await seed.close();
  const store = new api.VectorStore(repository, "file:///fixture/");
  let started, finish, opens = 0, live = false;
  const waiting = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  Object.assign(store.index, { async open() { opens++; live = true; }, close() { live = false; },
    async restore() { started(); await gate; throw new Error("index-closed"); }, async save(path) {
      await IOUtils.write(path, new Uint8Array([1])); return { bytes: 1, hash: "a".repeat(64) };
    } });
  const syncing = store.sync(profile, config, new AbortController().signal);
  const rejected = assert.rejects(syncing, /index-closed/);
  await waiting;
  const closing = store.close(); finish(); await rejected; await closing;
  assert.equal(opens, 1); assert.equal(live, false); assert.equal(store.readable, false);
});
