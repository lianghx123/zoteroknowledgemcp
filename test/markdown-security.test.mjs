import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";

const bundle = await build({
  stdin: { contents: 'export { renderMarkdown } from "./src/ui/rendering/markdown.ts";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "browser", target: "firefox140", format: "cjs", write: false,
});

test("unclosed HTML and link references remain inert in the reader within a bounded worker", async t => {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { runInNewContext } = require("node:vm");
    const { JSDOM } = require("jsdom");
    (async () => {
      const { mockLocalization } = await import(workerData.localization);
      const module = { exports: {} };
      runInNewContext(workerData.code, { module, exports: module.exports, TextEncoder, Localization: mockLocalization() });
      const dom = new JSDOM("<!doctype html><body></body>");
      try {
        const inputs = [
          ...["<!--", "<?x", "<!A", "<![CDATA["].map(opener => "x " + opener.repeat(128000)),
          '[' + 'a\\n'.repeat(20000),
          '[a]: /u "' + 'x\\n'.repeat(20000),
        ];
        const results = inputs.map(source => {
          const { fragment } = module.exports.renderMarkdown(dom.window.document, source, () => { throw Error("Unexpected external navigation"); });
          return { literal: fragment.textContent.trimEnd() === source.trimEnd(), activeElements: fragment.querySelectorAll("script,iframe,img,object,a[href]").length };
        });
        parentPort.postMessage(results);
      } finally { dom.window.close(); }
    })().catch(error => { throw error; });
  `, {
    eval: true,
    workerData: { code: bundle.outputFiles[0].text, localization: new URL("./helpers/localization.mjs", import.meta.url).href },
  });
  t.after(() => worker.terminate());
  const results = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Pathological Markdown exceeded the 60-second isolation limit"));
    }, 60000);
    worker.once("message", value => { clearTimeout(timer); resolve(value); });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
    worker.once("exit", code => { clearTimeout(timer); reject(new Error(`Markdown worker exited before reporting: ${code}`)); });
  });
  assert.equal(results.length, 6);
  assert.ok(results.every(result => result.literal), "Incomplete constructs remain literal text");
  assert.ok(results.every(result => result.activeElements === 0), "No active content or external links are created");
});
