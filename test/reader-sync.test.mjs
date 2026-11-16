import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mockLocalization } from "./helpers/localization.mjs";

const compiled = await build({ stdin: { contents: `export * from "./src/ui/reader-sync.ts";
export * from "./src/ui/rendering/structured-content.ts";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "browser", format: "cjs", write: false });
const module = { exports: {} }, context = createContext({ module, exports: module.exports, TextEncoder, Localization: mockLocalization() });
runInContext(compiled.outputFiles[0].text, context);
const api = module.exports;
const settle = () => new Promise(resolve => setImmediate(resolve));
const block = (id, pageStart, markdown = `Paragraph ${id}.`, type = "text", pageEnd = pageStart) => ({ id, type, label: type, markdown, pageStart, pageEnd });
const content = blocks => ({ formatVersion: 1, origin: "parse", attachment: { libraryID: 1, itemKey: "SYNCPDF1" }, updatedAt: 1,
  markdown: blocks.map(block => block.markdown).join("\n\n"), blocks });

function fixture(t, blocks = [block("one", 1), block("two", 2), block("three", 3)]) {
  const dom = new JSDOM('<html><body><article style="padding-top:20px"></article></body></html>'); t.after(() => dom.window.close());
  const article = dom.window.document.querySelector("article"); article.append(api.renderStructuredContent(dom.window.document, content(blocks), () => {}).fragment);
  article.getBoundingClientRect = () => ({ top: 100, bottom: 400, height: 300 });
  const offsets = new Map();
  [...article.querySelectorAll("[data-source-page-start]")].forEach((element, index) => {
    offsets.set(element, 120 + index * 200);
    element.getBoundingClientRect = () => {
      const closed = element.closest("details:not([open])");
      const top = offsets.get(element) - article.scrollTop;
      return { top, bottom: top + (closed ? 0 : 100), height: closed ? 0 : 100 };
    };
  });
  const navigations = [];
  const view = { _viewState: { pageIndex: 0, scale: "page-width", scrollMode: 0 },
    _iframeWindow: { PDFViewerApplication: { pdfDocument: { numPages: 10 } } },
    navigate(location) { navigations.push(location.pageIndex); this._viewState.pageIndex = location.pageIndex; } };
  const reader = { navigate: location => view.navigate(location), _internalReader: { _primaryView: view, _state: { primaryViewStats: view._viewState } } }, sync = new api.ReaderPositionSync(reader, article);
  dom.window.document.body.append(sync.controls, sync.status); sync.load(); t.after(() => sync.dispose());
  return { dom, article, reader, view, sync, navigations, offsets,
    right: sync.controls.querySelector('[data-sync-target="pdf"]'), left: sync.controls.querySelector('[data-sync-target="markdown"]') };
}

test("divider arrows align only their target surface using physical pages, without scroll coupling", async t => {
  const f = fixture(t);
  assert.ok(!f.left.disabled && !f.right.disabled);
  assert.equal(f.right.textContent, "→"); assert.equal(f.left.textContent, "←");
  f.article.scrollTop = 420; f.article.dispatchEvent(new f.dom.window.Event("scroll"));
  assert.deepEqual(f.navigations, []);
  f.right.click(); await settle(); assert.deepEqual(f.navigations, [2]);
  assert.equal(f.article.scrollTop, 420);
  assert.equal(f.view._viewState.scale, "page-width"); assert.equal(f.view._viewState.scrollMode, 0);
  f.view._viewState.pageIndex = 1; f.left.click(); await settle();
  assert.equal(f.article.scrollTop, 200); assert.equal(f.view._viewState.pageIndex, 1);
  assert.deepEqual(f.navigations, [2]); assert.equal(f.sync.status.textContent, "Aligned to source page 2.");
});

test("alignment reads live stats for the last active PDF split rather than initial saved view state", async t => {
  const f = fixture(t), secondary = {};
  f.reader._internalReader._secondaryView = secondary; f.reader._internalReader._lastView = secondary;
  f.reader._internalReader._state.secondaryViewStats = { pageIndex: 2, pagesCount: 3 };
  f.left.click(); await settle(); assert.equal(f.article.scrollTop, 400);
  assert.equal(f.view._viewState.pageIndex, 0);
});

test("missing PDF pages and out-of-range provenance produce feedback without guessing", async t => {
  const f = fixture(t, [block("one", 1), block("three", 3)]);
  f.view._viewState.pageIndex = 1; f.left.click(); await settle();
  assert.equal(f.article.scrollTop, 0); assert.equal(f.sync.status.textContent, "No corresponding source page was found at this position.");
  f.view._iframeWindow.PDFViewerApplication.pdfDocument.numPages = 2;
  f.article.scrollTop = 220; f.right.click(); await settle(); assert.deepEqual(f.navigations, []);
  f.view.navigate = () => { throw new Error("Native API failed"); };
  f.article.scrollTop = 0; f.right.click(); await settle();
  assert.equal(f.sync.status.textContent, "Could not synchronize with the PDF. Try again.");
  assert.ok(!f.right.disabled);
});

test("missing locations and native APIs disable controls and recover when a PDF becomes ready", t => {
  const f = fixture(t, [block("unknown", null)]);
  assert.ok(f.left.disabled && f.right.disabled); assert.match(f.sync.controls.title, /Source page information/);
  const node = f.article.querySelector("p"); node.dataset.sourcePageStart = "1"; node.dataset.sourcePageEnd = "1";
  const navigate = f.reader.navigate; f.reader.navigate = undefined;
  f.reader._internalReader = undefined; f.sync.load(); assert.ok(f.left.disabled && f.right.disabled);
  f.reader.navigate = navigate; f.reader._internalReader = { _primaryView: f.view, _state: { primaryViewStats: f.view._viewState } }; f.sync.controls.dispatchEvent(new f.dom.window.Event("pointerenter"));
  assert.ok(!f.left.disabled && !f.right.disabled);
  f.sync.clear(); assert.ok(f.left.disabled && f.right.disabled);
});

test("native page alignment opens a collapsed source note and handles cross-page blocks", async t => {
  const f = fixture(t, [block("continuation", 1, "Spanning paragraph.", "text", 2), block("note", 3, "> A source note.", "footnote")]);
  f.view._viewState.pageIndex = 1; f.left.click(); await settle(); assert.equal(f.article.scrollTop, 0);
  f.view._viewState.pageIndex = 2; f.left.click(); await settle();
  assert.equal(f.article.querySelector("details").open, true); assert.ok(f.article.scrollTop > 0);
});

test("hidden note descendants with Gecko layout rectangles cannot override visible source pages", async t => {
  const f = fixture(t, [block("note", 1, "> Hidden content.", "footnote"), block("body", 2)]);
  for (const element of f.article.querySelectorAll("[data-source-page-start]")) {
    const hidden = Boolean(element.closest("details"));
    element.getBoundingClientRect = () => ({ top: 110, bottom: hidden ? 140 : 210, height: hidden ? 30 : 100 });
  }
  f.right.click(); await settle(); assert.deepEqual(f.navigations, [1]);
});

test("pending native navigation cannot publish feedback after reload or disposal", async t => {
  for (const dispose of [false, true]) {
    const f = fixture(t); let release;
    f.view.navigate = () => new Promise(resolve => { release = resolve; });
    f.right.click(); assert.ok(f.left.disabled && f.right.disabled);
    if (dispose) f.sync.dispose(); else f.sync.load();
    release(); await settle(); assert.equal(f.sync.status.textContent, "");
    if (dispose) assert.equal(f.dom.window.document.querySelector(".km-reader-sync"), null);
    else assert.ok(!f.right.disabled);
  }
});

test("all typed content keeps source pages without changing canonical Markdown or trusting import comments", t => {
  const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close()); const doc = dom.window.document;
  const blocks = [block("abstract", 1, "Abstract text.", "abstract"), block("image", 2, "![Figure](local.png)", "image"),
    block("caption", 2, "Figure title.", "caption"), block("note", 2, "> Figure note.", "footnote"),
    block("code", 3, "```\ncode\n```", "code"), block("math", 4, "$$x^2$$", "formula"), block("ref", 5, "[7] A source reference.", "reference"),
    block("cross", 6, "Cross-page paragraph.", "text", 7), block("invalid", -1)];
  const input = content(blocks); input.visualLinks = ["caption", "note"].map((id, ordinal) => ({ id, visualBlockId: "image", relatedBlockId: id,
    role: id === "caption" ? "caption" : "note", position: "after", evidence: "provider", ordinal, markdown: null }));
  input.references = [{ id: "reference", number: 7, order: 0, blockIds: ["ref"], markdown: "A source reference." }];
  const original = input.markdown, host = doc.createElement("article"); host.append(api.renderStructuredContent(doc, input, () => {}).fragment);
  for (const [selector, page] of [[".km-abstract", "1"], [".km-visual-caption", "2"], [".km-visual-note", "2"], ["pre", "3"], [".km-math-block", "4"], [".km-reference-entry", "5"]]) {
    assert.equal(host.querySelector(selector).dataset.sourcePageStart, page, selector);
  }
  assert.equal([...host.querySelectorAll("p")].find(node => node.textContent === "Cross-page paragraph.").dataset.sourcePageEnd, "7");
  assert.equal(input.markdown, original);
  const imported = api.renderStructuredContent(doc, { ...input, origin: "import" }, () => {}).fragment;
  assert.equal(imported.querySelector("[data-source-page-start]"), null);
  const fallback = api.renderStructuredContent(doc, { ...input, markdown: "Unmatched projection." }, () => {}).fragment;
  assert.equal(fallback.querySelector("[data-source-page-start]"), null);
});
