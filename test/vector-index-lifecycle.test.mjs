import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";

const built = await build({ stdin: { contents: 'export { VectorIndex } from "./src/services/vector-index.ts";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true, format: "iife", globalName: "vectorAPI", platform: "browser", target: "firefox140", write: false });
function fixture(t) {
  const workers = [], timers = new Set(), response = () => ({ ok: true, async arrayBuffer() { return new Uint8Array([0, 97, 115, 109]).buffer; } });
  const runtime = { Promise, AbortController, async fetch() { return response(); } };
  const timerModule = { setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; }, clearTimeout(id) { clearTimeout(id); timers.delete(id); } };
  class Worker {
    constructor() { this.closed = false; this.throwOnPost = false; this.error = undefined; workers.push(this); }
    terminate() { this.closed = true; }
    postMessage(message) {
      if (this.throwOnPost) throw Error("clone-failed");
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, value: message.op === "stats" ? { count: 1 } : true, ...(this.error ? { error: this.error } : {}) } }));
    }
  }
  const context = createContext({ ChromeWorker: Worker, Components: { utils: { getGlobalForObject() { return runtime; } } }, ChromeUtils: { importESModule() { return timerModule; } },
    Zotero: { getMainWindows() { assert.fail("Window lookup during vector operation"); } }, fetch() { assert.fail("Dead window fetch"); }, setTimeout() { assert.fail("Dead window timer"); }, clearTimeout() { assert.fail("Dead window timer"); } });
  runInContext(built.outputFiles[0].text, context);
  const index = new context.vectorAPI.VectorIndex("jar:file:///fixture.xpi!/");
  t.after(() => { index.close(); assert.equal(timers.size, 0); assert.ok(workers.every(worker => worker.closed)); });
  return { index, workers, timers, runtime, response };
}

test("vector worker loading and request deadlines use process primitives without a main window", async t => {
  const f = fixture(t); let fetched;
  f.runtime.fetch = async url => { fetched = url; return f.response(); };
  await f.index.open(768, "f32"); assert.equal(fetched, "jar:file:///fixture.xpi!/content/vector/usearch.wasm");
  assert.equal((await f.index.stats()).count, 1); assert.equal(f.timers.size, 0);
});

test("failed vector asset fetch terminates its worker and a later open can succeed", async t => {
  const f = fixture(t); f.runtime.fetch = async () => { throw Error("index-wasm"); };
  await assert.rejects(f.index.open(768, "f32"), /index-wasm/); assert.equal(f.workers[0].closed, true);
  f.runtime.fetch = async () => f.response(); await f.index.open(768, "f32");
  assert.equal((await f.index.stats()).count, 1); f.workers[0].onerror?.({}); assert.equal(f.workers[1].closed, false);
});

test("worker open errors and synchronous dispatch errors release worker and timers", async t => {
  const f = fixture(t);
  f.runtime.fetch = async () => { f.workers.at(-1).error = "index-profile"; return f.response(); };
  await assert.rejects(f.index.open(768, "f32"), /index-profile/); assert.equal(f.workers[0].closed, true);
  f.runtime.fetch = async () => { f.workers.at(-1).throwOnPost = true; return f.response(); };
  await assert.rejects(f.index.open(768, "f32"), /clone-failed/); assert.equal(f.workers[1].closed, true); assert.equal(f.timers.size, 0);
});

test("closing a vector load fences a late asset response without terminating a replacement worker", async t => {
  const f = fixture(t); let release;
  f.runtime.fetch = () => new Promise(resolve => { release = resolve; });
  const first = assert.rejects(f.index.open(768, "f32"), /abort|index-closed/i);
  f.index.close(); f.runtime.fetch = async () => f.response(); await f.index.open(768, "f32");
  release(f.response()); await first;
  assert.equal(f.workers[0].closed, true); assert.equal(f.workers[1].closed, false); assert.equal((await f.index.stats()).count, 1);
});
