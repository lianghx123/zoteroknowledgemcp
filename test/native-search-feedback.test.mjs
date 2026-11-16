import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { submitFulltextSearch } from "../scripts/native-search-feedback.mjs";

function fixture(t, handler) {
  const dom = new JSDOM("<html><body><div><input></div></body></html>");
  t.after(() => dom.window.close());
  const window = dom.window, input = window.document.querySelector("input"), quick = { searchTextbox: input };
  input.parentElement.addEventListener("keydown", event => {
    assert.equal(event.key, "Enter"); assert.equal(event.composed, true);
    handler(input, window);
  });
  return { window, quick, input };
}

test("native verifier observes a complete busy transition even between polling intervals", async t => {
  const f = fixture(t, input => { input.setAttribute("aria-busy", "true"); input.removeAttribute("aria-busy"); });
  assert.deepEqual(await submitFulltextSearch(f.window, f.quick, "query"), { feedback: "" });
  assert.equal(f.input.value, "query");
});

test("native verifier retains failure feedback and detects a subsequent successful empty result", async t => {
  let fail = true;
  const f = fixture(t, (input, window) => {
    input.setAttribute("aria-busy", "true");
    window.setTimeout(() => {
      if (fail) { input.setAttribute("aria-description", "Search failed"); input.setAttribute("aria-busy", "false"); }
      else { input.removeAttribute("aria-description"); input.removeAttribute("aria-busy"); }
    }, 0);
  });
  assert.deepEqual(await submitFulltextSearch(f.window, f.quick, "bad"), { feedback: "Search failed" });
  fail = false;
  assert.deepEqual(await submitFulltextSearch(f.window, f.quick, "no matches"), { feedback: "" });
});

test("native verifier rejects unhandled submissions and an already running search", async t => {
  const f = fixture(t, () => {});
  await assert.rejects(submitFulltextSearch(f.window, f.quick, "query", 10), /search-feedback-timeout/);
  f.input.setAttribute("aria-busy", "true");
  await assert.rejects(submitFulltextSearch(f.window, f.quick, "query"), /search-already-running/);
});

test("closing a native verification window cancels its pending observer and timeout", async t => {
  const f = fixture(t, input => input.setAttribute("aria-busy", "true"));
  const pending = submitFulltextSearch(f.window, f.quick, "query");
  f.window.dispatchEvent(new f.window.Event("unload"));
  await assert.rejects(pending, /search-window-closed/);
});
