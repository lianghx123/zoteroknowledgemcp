import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";

const compiled = await build({
  stdin: { contents: 'export { readLiveModelSettings } from "./scripts/fixtures/live-model-settings.ts"; export { defaultRetrievalConfig } from "./src/services/retrieval-config.ts";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true, format: "iife", globalName: "LiveProbe", platform: "browser", target: "firefox140", write: false,
});

function fixture({ exists = true, error = false, change = () => {}, missingKey = false } = {}) {
  const context = vm.createContext({ URL, IOUtils: { exists: async () => exists } });
  vm.runInContext(compiled.outputFiles[0].text, context);
  const api = context.LiveProbe, config = JSON.parse(JSON.stringify(api.defaultRetrievalConfig));
  change(config);
  const reads = [], state = { closed: 0, reloads: 0 };
  const file = { path: "isolated/knowledgemcp/retrieval.json", current: config, error,
    reload: async () => { state.reloads++; }, close: async () => { state.closed++; } };
  const credentials = { get(reference) { reads.push(reference); if (missingKey) throw Error("credentials"); return `synthetic-${reference}`; } };
  return { reads, state, config, run: () => api.readLiveModelSettings(file, credentials) };
}

test("live probes resolve shared credentials inside the host and release configuration ownership", async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.embeddingKey, "synthetic-embedding");
  assert.equal(result.rerankKey, "synthetic-embedding");
  assert.deepEqual(f.reads, ["embedding", "embedding"]);
  assert.equal(f.state.closed, 1);
  result.config.embedding.model = "changed";
  assert.notEqual(f.config.embedding.model, "changed");
});

test("live probes preserve separate embedding and rerank credential references", async () => {
  const f = fixture({ change: c => { c.shareCredential = false; } }), result = await f.run();
  assert.equal(result.rerankKey, "synthetic-rerank");
  assert.deepEqual(f.reads, ["embedding", "rerank"]);
});

test("live probes refuse missing or unreadable plugin settings without reading credentials", async () => {
  for (const options of [{ exists: false }, { error: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run(), /configure-plugin-models-first|plugin-model-settings-unreadable/);
    assert.deepEqual(f.reads, []);
    assert.equal(f.state.closed, 1);
  }
});

test("live probes reject incompatible models, dimensions and destinations before reading keys", async () => {
  for (const change of [c => { c.dimensions = 1024; }, c => { c.embedding.model = "other"; },
    c => { c.rerank.provider = "other"; }, c => { c.embedding.endpoint = "https://example.com/embeddings"; },
    c => { c.rerank.endpoint += "?secret=synthetic"; }, c => { c.rerank.endpoint = "http://dashscope.aliyuncs.com/rerank"; }]) {
    const f = fixture({ change });
    await assert.rejects(f.run(), /bailian-default-models-768-required|bailian-only/);
    assert.deepEqual(f.reads, []);
    assert.equal(f.state.closed, 1);
  }
});

test("live probes close settings ownership when the native key store fails", async () => {
  const f = fixture({ missingKey: true });
  await assert.rejects(f.run(), /credentials/);
  assert.equal(f.state.closed, 1);
});

test("all live probe controllers prepare Gecko bundles without a debugger or credentials", () => {
  for (const script of ["verify-model-http.mjs", "verify-vector-live.mjs", "verify-vector-settings.mjs"]) {
    const output = execFileSync(process.execPath, [`scripts/${script}`, "--prepare-only"], { encoding: "utf8" });
    assert.match(output, /Prepared native .* no debugger connection or provider request/);
  }
});
