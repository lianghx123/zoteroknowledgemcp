import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { api, parsingFixture } from "./fixtures/parsing.mjs";
import factory from "../addon/content/vector/usearch.mjs";

test("provider registry accepts a distinct protocol without changing retrieval orchestration", async () => {
  const registry = new api.ProviderRegistry();
  registry.register({ definition: { id: "test", dimensions: [512], maxBatch: 2, maxInputCharacters: 8000, maxRerankDocuments: 100 },
    embedding: { async embed(context, texts, dimensions) { const r = await context.request("https://test.example/encode", { sentences: texts }); return r.vectors.map(v => api.normalizedVector(v, dimensions)); } },
    rerank: { async rerank(context, query, texts) { const r = await context.request("https://test.example/rank", { question: query, passages: texts }); return r.scores.map((score, index) => ({ index, score })); } } });
  const context = { signal: new AbortController().signal, config: {}, key: "", request: async (url, body) => {
    assert.match(url, /encode/); assert.deepEqual(body, { sentences: ["input"] }); return { vectors: [Array(512).fill(1)] };
  } };
  const [vector] = await registry.get("test").embedding.embed(context, ["input"], 512, false);
  assert.ok(Math.abs(vector.reduce((sum, n) => sum + n * n, 0) - 1) < 1e-6);
  assert.throws(() => registry.register(registry.get("test")), /duplicate-provider/);
});
for (const dimensions of [512, 768, 1024, 2048]) test(`Float32 canonical BLOB round trip and validation at ${dimensions}D`, () => {
  const vector = api.normalizedVector(Array.from({ length: dimensions }, (_, i) => Math.sin(i + 1)), dimensions);
  const result = api.vectorFromBlob(api.vectorBlob(vector), dimensions);
  assert.ok(result.every((value, i) => Math.abs(value - vector[i]) < 1e-7));
  for (const bad of [Array(dimensions).fill(0), Array(dimensions).fill(NaN), Array(dimensions).fill(Infinity), [1]]) assert.throws(() => api.normalizedVector(bad, dimensions));
});
test("segmentation covers Unicode source including the tail and records overlaps", () => {
  const text = ("这是连续正文。😀 It contains scientific evidence.\n\n").repeat(200), segments = api.splitEmbeddingInput(text, 160, 20);
  const covered = new Uint8Array(text.length);
  for (const segment of segments) {
    assert.equal(segment.text, text.slice(segment.start, segment.end)); assert.ok(segment.text.length <= 160);
    assert.ok(!/[\uD800-\uDBFF]$/.test(segment.text)); assert.ok(!/^[\uDC00-\uDFFF]/.test(segment.text));
    covered.fill(1, segment.start, segment.end);
  }
  assert.ok(covered.every(Boolean)); assert.equal(segments.at(-1).end, text.length);
  assert.ok(segments.slice(1).some(segment => segment.overlap > 0));
  assert.ok(api.embeddingAdmission("reference_entry", "Long bibliographic reference with enough content.").includes("reference_entry"));
  assert.deepEqual(api.embeddingAdmission("text", "科学研究通过系统的方法建立可靠的证据并进行知识发现。"), []);
});
test("Bailian batch response is reordered, normalized and rejects duplicate indices", async () => {
  const provider = api.modelProviders.get("bailian"), context = { config: { endpoint: "https://dashscope.aliyuncs.com/native" }, request: async () => ({ output: { embeddings: [
    { text_index: 1, embedding: [0, 2] }, { text_index: 0, embedding: [3, 0] },
  ] } }) };
  const vectors = await provider.embedding.embed(context, ["a", "b"], 2, false);
  assert.deepEqual([...vectors[0]], [1, 0]); assert.deepEqual([...vectors[1]], [0, 1]);
  context.request = async () => ({ output: { embeddings: [{ text_index: 0, embedding: [1, 0] }, { text_index: 0, embedding: [1, 0] }] } });
  await assert.rejects(provider.embedding.embed(context, ["a", "b"], 2, false), /embedding-response/);
});
test("profiles isolate spaces and scalar-only changes preserve the embedding identity", () => {
  const config = structuredClone(api.defaultRetrievalConfig), key = api.spaceKey(config);
  config.indexMode = "i8"; config.embedding.credentialRef = "other"; config.rerank.model = "other";
  assert.equal(api.spaceKey(config), key); config.dimensions = 512; assert.notEqual(api.spaceKey(config), key);
  assert.throws(() => api.validateRetrievalConfig({ ...config, candidates: 10, results: 20 }));
});
test("disabling model services releases the worker and keeps the configured vector space", async t => {
  const f=await parsingFixture(t),service=new api.EmbeddingService(f.db,"file:///fixture/");t.after(()=>service.close());
  service.store.status="ready";await service.tick();assert.equal(service.store.status,"idle");assert.ok(service.profile);
  const original=service.profile;service.config.current={...service.config.current,revision:1,dimensions:512};await service.tick();assert.notEqual(service.profile,original);
});
test("durable embedding publication preserves raw blocks, FTS evidence and cancelled generation suppression", async t => {
  const f = await parsingFixture(t); await f.enqueue(); await f.step(); await f.step();
  const repository = new api.EmbeddingRepository(f.db), config = structuredClone(api.defaultRetrievalConfig); config.enabled = true;
  const profile = await repository.profile(config); await repository.reconcile(profile, config);
  const job = await f.db.selectFrom("processing_jobs").selectAll().where("kind", "=", "embed").executeTakeFirstOrThrow();
  const before = await f.db.selectFrom("content_blocks").selectAll().execute();
  await repository.prepare(job.generation_id, profile, config); const rows = await repository.pending(job.generation_id, profile, 10);
  assert.ok(rows.length); await f.db.updateTable("processing_jobs").set({ state: "running", lease_owner: "test", execution_token: "token", lease_expires_at: Date.now()+600000, started_at: Date.now() }).where("id", "=", job.id).execute();
  const vectors = rows.map(() => api.normalizedVector(Array(768).fill(1), 768));
  await repository.commit(job.id, "token", profile, rows, vectors);
  assert.equal((await repository.activeVectors(profile).execute()).length, rows.length);
  assert.equal(JSON.stringify(await f.db.selectFrom("content_blocks").selectAll().execute()), JSON.stringify(before));
  await f.db.updateTable("processing_jobs").set({ state: "cancelled", finished_at: Date.now(), lease_owner: null, execution_token: null, lease_expires_at: null, cancel_requested_at: Date.now() }).where("id", "=", job.id).execute();
  await assert.rejects(repository.commit(job.id, "token", profile, rows, vectors), /embedding-stale/);
  await repository.reconcile(profile, config); assert.equal((await f.db.selectFrom("processing_jobs").select("id").where("kind", "=", "embed").execute()).length, 1);
  await repository.projectFulltext();
  const service = new api.RetrievalService({ repository, config: { current: config }, profile });
  const result = await service.search("Body", "fulltext", [f.input.resourceID], new AbortController().signal);
  assert.deepEqual(result.channels, ["fulltext"]); assert.ok(result.hits.length); assert.ok(result.hits[0].evidence[0].sourceID);
  assert.equal((await service.search("Body", "fulltext", [], new AbortController().signal)).hits.length, 0);
  const store = new api.VectorStore(repository, "file:///fixture/");
  const fakeRows = new Map(); let builds = 0, restores = 0;
  Object.assign(store.index, { async open() { builds++; fakeRows.clear(); }, async add(rows) { rows.forEach(row => fakeRows.set(row.label, row.vector)); },
    async remove(labels) { labels.forEach(label => fakeRows.delete(label)); }, async query(_vector, labels, limit) { return labels.slice(0,limit).map(label=>({label,score:.8})); },
    async save(path) { await IOUtils.write(path, new Uint8Array([1,2,3])); return { hash: "a".repeat(64), bytes: 3 }; }, async restore() { restores++; }, close() {} });
  await store.sync(profile,config,new AbortController().signal);
  assert.equal((await f.db.selectFrom("vector_snapshot_state").select("mode").executeTakeFirstOrThrow()).mode,"f32");
  assert.ok((await store.search(vectors[0],[f.input.resourceID],20)).length);
  await store.sync(profile,config,new AbortController().signal,true); assert.equal(builds,2);
  const reloaded = new api.VectorStore(repository,"file:///fixture/");Object.assign(reloaded.index,store.index);
  await reloaded.sync(profile,config,new AbortController().signal);assert.equal(restores,1);
  const state=await f.db.selectFrom("vector_snapshot_state").selectAll().where("profile_id","=",profile).executeTakeFirstOrThrow();
  await f.db.updateTable("vector_snapshot_state").set({mutations:17}).where("profile_id","=",profile).execute();
  const recovered=new api.VectorStore(repository,"file:///fixture/");Object.assign(recovered.index,store.index);
  await recovered.sync(profile,config,new AbortController().signal);assert.equal(recovered.removed,17);
  await f.db.insertInto("file_cleanup").values({relative_path:`vectors/${state.snapshot_path.split('/').at(-1)}`,created_at:Date.now()}).execute();
  await api.cleanupFiles(f.db);assert.ok(f.files.has(state.snapshot_path),"cleanup protects an active vector snapshot");
  const abandoned="vectors/00000000-0000-0000-0000-000000000000.usearch";
  const abandonedPath=PathUtils.join(Zotero.DataDirectory.dir,"knowledgemcp",...abandoned.split('/'));
  f.files.set(abandonedPath,new Uint8Array([8]));
  await f.db.insertInto("file_cleanup").values({relative_path:abandoned,created_at:Date.now()}).execute();await api.cleanupFiles(f.db);assert.equal(f.files.has(abandonedPath),false);
  const queryNative=f.native.queryAsync.bind(f.native);let saving=false,loseAcknowledgement=true;
  f.native.queryAsync=async(statement,...args)=>{const value=await queryNative(statement,...args);if(statement.startsWith('insert into "search_index_builds"'))saving=true;
    if(statement==="COMMIT"&&saving&&loseAcknowledgement){loseAcknowledgement=false;throw Error("Lost commit acknowledgement");}return value;};
  await assert.rejects(store.sync(profile,config,new AbortController().signal,true));f.native.queryAsync=queryNative;
  const activated=await f.db.selectFrom("vector_snapshot_state").select("snapshot_path").where("profile_id","=",profile).executeTakeFirstOrThrow();
  assert.ok(f.files.has(activated.snapshot_path),"lost commit acknowledgement preserves the activated snapshot");
  const degraded = new api.RetrievalService({ repository, profile, config:{current:config},store,
    gateway: { async embed() { throw new api.ModelError("network"); }, async rerank() { throw new api.ModelError("credentials"); } } });
  const fallback = await degraded.search("Synthetic", "fusion", [f.input.resourceID], new AbortController().signal);
  assert.ok(fallback.hits.length);assert.deepEqual(fallback.degraded.map(row=>row.channel),["vector","rerank"]);
  assert.ok(fallback.hits[0].metadataMatches.some(row=>row.field==="title"&&row.text.includes("Synthetic")));
  await assert.rejects(degraded.search("Synthetic","semantic",[f.input.resourceID],new AbortController().signal),/network/);
  await repository.clear(config);await repository.reconcile(profile,config);
  assert.equal((await f.db.selectFrom("processing_jobs").select("id").where("kind","=","embed").where("state","=","pending").execute()).length,1);
});

test("config changes require the three-way choice and concurrent stale saves are refused", async t => {
  await parsingFixture(t);const first=new api.RetrievalConfigFile(),second=new api.RetrievalConfigFile();
  t.after(()=>first.close());t.after(()=>second.close());
  const draft=structuredClone(first.current);draft.dimensions=512;
  await assert.rejects(first.save(draft),/space-choice-required/);
  assert.equal(await first.save(draft,"cancel"),false);
  await first.save(draft,"keep");assert.equal(first.current.dimensions,512);
  await second.reload();const a=structuredClone(first.current),b=structuredClone(second.current);a.candidates=120;b.candidates=140;
  const results=await Promise.allSettled([first.save(a),second.save(b)]);assert.equal(results.filter(row=>row.status==="fulfilled").length,1);
  await first.reload();const clear=structuredClone(first.current);clear.dimensions=1024;let cleared;
  await first.save(clear,"clear",async old=>{cleared=old.dimensions;});assert.equal(cleared,512);
});

test("foreground model work precedes queued embedding work and cancellation releases the rate queue", async () => {
  const config=structuredClone(api.defaultRetrievalConfig);config.embedding.endpoint="https://dashscope.aliyuncs.com/native";config.requestsPerMinute=3600;config.concurrency=1;
  const gateway=new api.ModelGateway(()=>config,()=>"private"),calls=[];let release;
  const first=new Promise(resolve=>{release=resolve;});
  gateway.transport={async request(_url,init){const text=JSON.parse(init.body).input.texts[0];calls.push(text);if(text==="first")await first;
    return {bytes:new TextEncoder().encode(JSON.stringify({output:{embeddings:[{text_index:0,embedding:Array(768).fill(1)}]}})),headers:new Headers()};}};
  const signal=new AbortController(),a=gateway.embed(["first"],signal.signal);await new Promise(resolve=>setImmediate(resolve));
  const b=gateway.embed(["background"],signal.signal),q=gateway.embed(["foreground"],signal.signal,true);
  release();await Promise.all([a,b,q]);assert.deepEqual(calls,["first","foreground","background"]);
  const cancelled=new AbortController(),work=gateway.embed(["cancelled"],cancelled.signal);cancelled.abort();await assert.rejects(work);assert.ok(!calls.includes("cancelled"));
});

test("rerank authorization guards run after rate queuing and again before retries", async () => {
  const config = structuredClone(api.defaultRetrievalConfig); config.concurrency = 1; config.requestsPerMinute = 3600;
  config.embedding.endpoint = "https://dashscope.aliyuncs.com/native";
  const gateway = new api.ModelGateway(() => config, () => "synthetic-secret"), sent = [];
  let release, entered, permitted = true;
  const gate = new Promise(resolve => release = resolve), paused = new Promise(resolve => entered = resolve);
  gateway.transport = { async request(_url, init) {
    const body = JSON.parse(init.body); sent.push(body);
    if (body.input.texts) { entered(); await gate; return { bytes: new TextEncoder().encode(JSON.stringify({ output: { embeddings: [{ text_index: 0, embedding: Array(768).fill(1) }] } })), headers: new Headers() }; }
    throw new api.ModelError("http-429", true, 1);
  } };
  const guard = async () => { if (!permitted) throw Error("Revoked"); };
  const first = gateway.embed(["Occupy queue"], new AbortController().signal); await paused;
  const queued = gateway.rerank("query", ["Protected passage"], new AbortController().signal, guard);
  const rejected = assert.rejects(queued, /Revoked/);
  permitted = false; release(); await first; await rejected; assert.equal(sent.length, 1);
  permitted = true; let checks = 0;
  await assert.rejects(gateway.rerank("query", ["Protected passage"], new AbortController().signal, async () => { checks++; await guard(); if (checks === 1) permitted = false; }), /Revoked/);
  assert.equal(checks, 2); assert.equal(sent.length, 2);
});

test("native transport is independent of the presence of main windows", async t => {
  await parsingFixture(t); const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  Zotero.getMainWindows = () => [];
  globalThis.fetch = async () => new Response("Synthetic native response", { status: 200 });
  const transport = new api.BrowserParseTransport(), response = await transport.request("https://models.example/request", { method: "POST", headers: { Authorization: "Bearer synthetic" } }, 1000, 1000, new AbortController().signal);
  assert.equal(new TextDecoder().decode(response.bytes), "Synthetic native response");
  assert.ok(transport.multipart("synthetic", {}, new Uint8Array([1]), "fixture.pdf") instanceof FormData);
});

test("network deadlines use process timer exports rather than window-global timers", async t => {
  await parsingFixture(t);
  const previousComponents = globalThis.Components, previousChrome = globalThis.ChromeUtils;
  t.after(() => {
    if (previousComponents === undefined) delete globalThis.Components; else globalThis.Components = previousComponents;
    if (previousChrome === undefined) delete globalThis.ChromeUtils; else globalThis.ChromeUtils = previousChrome;
  });
  let scheduled = 0, cleared = 0; const runtime = Object.create(globalThis);
  runtime.fetch = async () => new Response("Process timer response");
  globalThis.Components = { utils: { getGlobalForObject: () => runtime } };
  globalThis.ChromeUtils = { importESModule: () => ({ setTimeout(callback, delay) { scheduled++; return setTimeout(callback, delay); }, clearTimeout(id) { cleared++; clearTimeout(id); } }) };
  const response = await new api.BrowserParseTransport().request("https://models.example/request", { headers: { Authorization: "Bearer synthetic" } }, 1000, 1000, new AbortController().signal);
  assert.equal(new TextDecoder().decode(response.bytes), "Process timer response"); assert.equal(scheduled, 1); assert.equal(cleared, 1);
});

test("startup recovery scheduling and stage yields use process timers", async t => {
  await parsingFixture(t); const previousComponents = globalThis.Components, previousChrome = globalThis.ChromeUtils;
  t.after(() => {
    if (previousComponents === undefined) delete globalThis.Components; else globalThis.Components = previousComponents;
    if (previousChrome === undefined) delete globalThis.ChromeUtils; else globalThis.ChromeUtils = previousChrome;
  });
  let scheduled = 0; const runtime = Object.create(globalThis);
  globalThis.Components = { utils: { getGlobalForObject: () => runtime } };
  globalThis.ChromeUtils = { importESModule: () => ({ setTimeout(callback) { scheduled++; return setTimeout(callback, 0); }, clearTimeout }) };
  const stages = ["metadata", "files", "parsing", "embedding", "sync", "fulltext", "index"], completed = [];
  const recovery = new api.StartupRecovery(Object.fromEntries(stages.map(stage => [stage, async () => completed.push(stage)])));
  let done; const ready = new Promise(resolve => done = resolve);
  recovery.subscribe(() => { if (recovery.snapshot().state === "ready") done(); });
  recovery.schedule(Promise.resolve()); await ready; await recovery.close();
  assert.deepEqual(completed, stages); assert.equal(scheduled, 8);
});

for (const scalar of [1, 4]) test(`USearch scalar ${scalar}: bounded output matches official buffer, scoped exact and JS restore`, async () => {
  const compiled = await WebAssembly.compile(readFileSync("addon/content/vector/usearch.wasm"));
  const library = await factory({ instantiateWasm(imports, ready) { const instance = new WebAssembly.Instance(compiled, imports); ready(instance); return instance.exports; }, print() {}, printErr() {} });
  const check = rc => assert.equal(rc, 0, library.UTF8ToString(library._ul_error()));
  check(library._ul_open(768, scalar, 16, 100, 1)); check(library._ul_reserve(1600));
  const pointer = library._malloc(768 * 4);
  try {
    for (let id = 1; id <= 1600; id++) {
      const vector = api.normalizedVector(Array.from({length:768}, (_, j) => Math.sin(id*(j+1))),768);
      library.HEAPU8.set(new Uint8Array(vector.buffer), pointer); check(library._ul_add(id,pointer));
    }
    const size=library._ul_size(), p=library._malloc(size); let baseline;
    try { check(library._ul_save(p,size)); baseline=library.HEAPU8.slice(p,p+size); } finally {library._free(p);}
    const output=new Uint8Array(size), chunk=library._malloc(4*1024*1024);
    try {for(let offset=0;offset<size;offset+=4*1024*1024){const take=Math.min(size-offset,4*1024*1024);assert.equal(library._ul_save_slice(offset,chunk,take),take);output.set(library.HEAPU8.subarray(chunk,chunk+take),offset);}}
    finally {library._free(chunk);}
    assert.deepEqual(output,baseline);
    library._ul_close();check(library._ul_open(768,scalar,16,100,1));
    library.restoreSource=output;library.restoreOffset=0;check(library._ul_load_js());check(library._ul_validate_identity(768,scalar,1));
    assert.equal(library.restoreOffset,size);library.restoreSource=null;
    const allowed=library._malloc(8);library.HEAPU8.set(new Uint8Array(new Uint32Array([3,77]).buffer),allowed);
    try {const n=library._ul_filtered_search(pointer,20,allowed,2,1);assert.equal(n,2);assert.deepEqual(new Set(Array.from({length:n},(_,i)=>library._ul_key(i))),new Set([3,77]));}
    finally {library._free(allowed);}
    assert.equal(library._ul_arena_cap(),32);
  } finally {library._free(pointer);library._ul_close();}
});
