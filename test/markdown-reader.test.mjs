import { mockLocalization } from "./helpers/localization.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { mockNativeFactory } from "./helpers/native-database.mjs";

const bundle = readFileSync(".scaffold/build/addon/content/main.js", "utf8");
const helpers = await build({
  stdin: { contents: `export * from "./src/ui/rendering/markdown.ts";
export * from "./src/services/content-read.ts";
export * from "./src/ui/views/content-reader.ts";
export * from "./src/ui/rendering/reader-text.ts";
export * from "./src/ui/reader-preferences.ts";
export * from "./src/ui/reader-depth-menu.ts";
export * from "./src/ui/reader-search.ts";
export * from "./src/ui/reader-block-editor.ts";
export * from "./src/ui/reader-block-session.ts";
export * from "./src/ui/reader-block-type-menu.ts";
export * from "./src/shared/contracts/reader-edit.ts";
export * from "./src/ui/register.ts";
export * from "./src/app/plugin.ts";
export * from "./src/storage/reader-content-store.ts";
export * from "./src/schemas/knowledge-content.ts";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "browser", target: "firefox140", format: "cjs", write: false, loader: { ".css": "text" },
});
const helperCode = helpers.outputFiles[0].text;
const settle = () => new Promise(resolve => setImmediate(resolve));
const identity = { libraryID: 1, itemKey: "ABCD1234" };

function fixture(t, { ready = true, content = null, prefs = new Map() } = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div class='toolbar'><button id='sidebarToggle'>Sidebar</button><button id='zoomOut'>Zoom out</button></div><div id='split-view'><div id='primary-view'><iframe></iframe></div></div></body></html>", {
    url: "https://reader.test/", virtualConsole: new VirtualConsole(),
  });
  t.after(() => dom.window.close());
  dom.window.document.createXULElement = name => {
    const node = dom.window.document.createElement(name);
    if (name === "menupopup") {
      node.openPopupAtScreen = (x, y, context) => { node.position = { x, y, context }; };
      node.hidePopup = () => node.dispatchEvent(new dom.window.Event("popuphidden"));
    }
    return node;
  };
  const listeners = new Set();
  const files = new Map();
  const path = "/isolated/knowledgemcp/reader-content/1-ABCD1234.json";
  if (content) files.set(path, JSON.stringify(content));
  let resolveReady;
  const reader = { itemID: 4, _type: "pdf", _window: dom.window,
    _iframeWindow: ready ? dom.window : undefined,
    _initPromise: new Promise(resolve => { resolveReady = resolve; }) };
  const sandbox = createContext({ Localization: mockLocalization(),
    URL, TextEncoder, Uint8Array,
    Zotero: {
      debug() {}, DataDirectory: { dir: "/isolated" }, launchURL() {},
      Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
      ...mockNativeFactory(),
      Items: { get: () => ({ id: 4, libraryID: 1, key: "ABCD1234", attachmentReaderType: "pdf" }) },
      Reader: {
        _readers: [reader],
        registerEventListener(type, handler) { assert.equal(type, "renderToolbar"); listeners.add(handler); },
        unregisterEventListener(type, handler) { assert.equal(type, "renderToolbar"); listeners.delete(handler); },
      },
    },
    PathUtils: { join: posix.join, parent: posix.dirname },
    IOUtils: {
      async exists(path) { return files.has(path); },
      async stat(path) { return { size: Buffer.byteLength(files.get(path)) }; },
      async readUTF8(path) { return files.get(path); },
      async makeDirectory() {},
      async writeUTF8(path, text, options) { assert.equal(options.tmpPath, `${path}.tmp`); files.set(path, text); },
    },
  });
  const module = { exports: {} };
  sandbox.module = module; sandbox.exports = module.exports;
  runInContext(helperCode, sandbox);
  runInContext(bundle, sandbox);
  const api = sandbox.ZoteroKnowledgeMCP;
  t.after(() => api.shutdown());
  return { dom, doc: dom.window.document, sandbox, api, helpers: module.exports,
    reader, listeners, files, path, resolveReady, prefs };
}

const imported = markdown => ({ formatVersion: 1, attachment: identity, markdown, origin: "import", updatedAt: 1 });

test("block editing previews canonical Markdown safely and retains only session drafts", async t => {
  const { doc, dom, helpers, reader } = fixture(t);
  const blocks = [
    { id: "title", type: "heading", label: "doc_title", markdown: "# Paper" },
    { id: "first", type: "paragraph", label: "text", markdown: "A **bold** value.", pageStart: 3 },
    { id: "second", type: "paragraph", label: "text", markdown: "Another paragraph." },
  ];
  const content = { ...imported(blocks.map(b => b.markdown).join("\n\n")), origin: "parse", generationID: "g1", blocks };
  const before = JSON.stringify(content);
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return content; } }, () => {});
  t.after(() => view.dispose()); view.toggle(true); await settle();
  const toggle = doc.querySelector(".km-reader-edit-toggle"); let first = doc.querySelector('[data-km-edit-block="first"]');
  assert.equal(toggle.disabled, false); toggle.click(); first.click();
  let input = doc.querySelector(".km-block-editor-input"); assert.equal(input.value, blocks[1].markdown);
  assert.ok(first.classList.contains("km-block-editor-original"));
  input.value = 'Changed **value**.\n\n<script>danger()</script>\n\n<img src="https://remote.invalid/x" onerror="danger()">';
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  doc.querySelectorAll('.km-block-editor [role="tab"]')[1].click();
  const preview = doc.querySelector(".km-block-editor-preview");
  assert.equal(preview.querySelector("strong").textContent, "value"); assert.equal(preview.querySelector("script,img,[onerror]"), null);
  assert.equal(input.hidden, true); assert.equal(preview.hidden, false);
  doc.querySelector(".km-block-editor-expand").click(); assert.ok(doc.querySelector(".km-block-editor-expanded"));
  doc.querySelector(".km-block-editor-expand").click(); assert.equal(doc.querySelector(".km-block-editor-expanded"), null);
  doc.querySelector(".km-block-editor-keep").click(); assert.equal(doc.querySelector(".km-block-editor"), null);
  first = doc.querySelector('[data-km-edit-block="first"]');
  assert.match(first.textContent, /Changed value/); assert.equal(first.hasAttribute("data-km-edit-draft"), false);
  first.click(); input = doc.querySelector("textarea"); assert.match(input.value, /^Changed/);
  doc.querySelector(".km-block-editor-discard").click(); first.click();
  assert.match(doc.querySelector("textarea").value, /^Changed/);
  input = doc.querySelector("textarea"); input.value = "A new draft."; input.dispatchEvent(new dom.window.Event("input"));
  doc.querySelector('[data-km-edit-block="second"]').click(); assert.equal(doc.querySelectorAll(".km-block-editor").length, 1);
  first.click(); assert.equal(doc.querySelector("textarea").value, "A new draft.");
  doc.querySelector("textarea").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(doc.querySelector(".km-block-editor"), null);
  first.click(); doc.querySelector(".km-reader-search-toggle").click();
  assert.equal(doc.querySelector(".km-block-editor"), null); assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.equal(doc.querySelector(".km-block-editor-original"), null);
  view.toggle(false); view.toggle(true); await settle(); toggle.click(); doc.querySelector('[data-km-edit-block="first"]').click();
  assert.equal(doc.querySelector("textarea").value, "A new draft.");
  assert.equal(JSON.stringify(content), before, "no canonical block, content generation or index is mutated");
  view.dispose(); assert.equal(doc.querySelector(".km-block-editor,.km-reader-edit-toggle"), null);
});

test("inline citations keep their preview interaction while block editing is enabled", async t => {
  const { doc, helpers, reader } = fixture(t);
  const blocks = [
    { id: "p", type: "paragraph", label: "text", markdown: "Earlier work (Smith **et al.**, 2020)." },
    { id: "h", type: "heading", label: "section_title", markdown: "## References" },
    { id: "r", type: "reference", label: "reference", markdown: "[1] Smith, A. (2020). A complete reference." },
  ];
  const content = { ...imported(blocks.map(b => b.markdown).join("\n\n")), origin: "parse", generationID: "g", blocks };
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return content; } }, () => {});
  t.after(() => view.dispose()); view.toggle(true); await settle();
  doc.querySelector(".km-reader-edit-toggle").click(); doc.querySelector(".km-citation strong").click();
  assert.equal(doc.querySelector(".km-block-editor"), null);
  assert.equal(doc.querySelector(".km-citation-preview").hidden, false);
  assert.match(doc.querySelector(".km-citation-preview").textContent, /A complete reference/);
});

test("block editing respects text selection, dragging, native textarea menus and stale context commands", async t => {
  const { doc, dom, helpers, reader } = fixture(t);
  const blocks = [{ id: "p", type: "paragraph", label: "text", markdown: "Some **source** text." }];
  const content = { ...imported(blocks[0].markdown), origin: "parse", generationID: "g", blocks };
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return content; } }, () => {});
  t.after(() => view.dispose()); view.toggle(true); await settle();
  const p = doc.querySelector('[data-km-edit-block="p"]'), selection = dom.window.getSelection();
  doc.querySelector(".km-reader-edit-toggle").click();
  const range = doc.createRange(); range.selectNodeContents(p); selection.addRange(range); p.click();
  assert.equal(doc.querySelector("textarea"), null); selection.removeAllRanges();
  p.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
  p.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 60, clientY: 10 }));
  assert.equal(doc.querySelector("textarea"), null);
  p.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  let popup = doc.querySelector('[data-knowledgemcp="reader-copy-menu"]'), command = popup.children[2];
  assert.equal(command.getAttribute("label"), "Edit this block"); assert.equal(command.getAttribute("disabled"), "false");
  command.dispatchEvent(new dom.window.Event("command"));
  const event = new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  doc.querySelector("textarea").dispatchEvent(event); assert.equal(event.defaultPrevented, false);
  assert.equal(doc.querySelector('[data-knowledgemcp="reader-copy-menu"]'), null);
  doc.querySelector("textarea").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  p.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  command = doc.querySelector('[data-knowledgemcp="reader-copy-menu"]').children[2];
  view.toggle(false); command.dispatchEvent(new dom.window.Event("command")); assert.equal(doc.querySelector("textarea"), null);
});

test("block-type popup preserves selection, supports keyboard groups and disposes stale commands", t => {
  const { doc, dom, helpers } = fixture(t), changes = [];
  const control = new helpers.ReaderBlockTypeMenu(doc, "reference", type => changes.push(type));
  t.after(() => control.dispose()); doc.body.append(control.button);
  const menu = doc.querySelector(".km-block-type-menu"), key = value => doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  assert.equal(control.button.textContent, "Reference"); assert.equal(control.button.getAttribute("aria-haspopup"), "menu");
  control.button.click();
  assert.equal(menu.parentElement, doc.body); assert.equal(menu.hidden, false);
  assert.equal(menu.querySelectorAll('[role="separator"]').length, 4);
  assert.equal(menu.querySelectorAll('[aria-checked="true"]').length, 1);
  assert.equal(doc.activeElement.dataset.blockType, "reference");
  key("ArrowUp"); assert.equal(doc.activeElement.dataset.blockType, "footnote");
  key("Home"); assert.equal(doc.activeElement.dataset.blockType, "heading");
  key("ArrowUp"); assert.equal(doc.activeElement.dataset.blockType, "reference");
  key("ArrowDown"); assert.equal(doc.activeElement.dataset.blockType, "heading");
  key("End"); key("Enter"); assert.deepEqual(changes, [], "reselecting the current type does not convert the block");
  assert.equal(menu.hidden, true); assert.equal(doc.activeElement, control.button);
  control.button.click(); menu.querySelector('[data-block-type="formula"]').click();
  assert.deepEqual(changes, ["formula"]); assert.equal(control.button.textContent, "Formula");
  control.button.focus(); key("ArrowDown"); assert.equal(doc.activeElement.dataset.blockType, "formula");
  key("Escape"); assert.equal(menu.hidden, true); assert.equal(doc.activeElement, control.button);
  control.button.click(); menu.dispatchEvent(new dom.window.Event("scroll")); assert.equal(menu.hidden, false, "internal popup scrolling stays open");
  doc.dispatchEvent(new dom.window.Event("scroll")); assert.equal(menu.hidden, true);
  control.button.click(); dom.window.dispatchEvent(new dom.window.Event("resize")); assert.equal(menu.hidden, true);
  control.button.click(); doc.body.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })); assert.equal(menu.hidden, true);
  control.button.click(); const stale = menu.querySelector('[data-block-type="heading"]');
  control.dispose(); stale.click(); assert.deepEqual(changes, ["formula"]);
  assert.equal(doc.querySelector(".km-block-type-menu,.km-block-editor-type"), null);
});

test("block-type popup stays inside viewport edges and opens upward near the bottom", t => {
  const { doc, helpers } = fixture(t), control = new helpers.ReaderBlockTypeMenu(doc, "paragraph", () => {});
  t.after(() => control.dispose()); doc.body.append(control.button);
  control.button.getBoundingClientRect = () => ({ left: 970, right: 1060, top: 700, bottom: 730, width: 90, height: 30 });
  const menu = doc.querySelector(".km-block-type-menu");
  menu.getBoundingClientRect = () => ({ top: 0, bottom: 380, width: 144, height: 380 });
  control.button.click();
  assert.equal(menu.style.left, "872px"); assert.equal(menu.style.top, "314px");
  assert.equal(control.button.style.width, menu.style.width, "the trigger and popup share one content-aware width");
  assert.equal(menu.style.maxHeight, "686px");
  const outside = doc.createElement("button"); doc.body.append(outside); outside.focus();
  assert.equal(menu.hidden, true, "focus leaving the popup dismisses it");
});

test("block editor declines ambiguous, derived and unavailable source mappings", t => {
  const { doc, helpers } = fixture(t), article = doc.createElement("article"); doc.body.append(article);
  const p = doc.createElement("p"); p.textContent = "Merged text"; p.dataset.sourceBlockIds = '["a","b"]'; article.append(p);
  const blocks = ["a", "b"].map(id => ({ id, type: "paragraph", label: "text", markdown: id }));
  const editor = new helpers.ReaderBlockEditor(article, () => {}, () => {}); doc.body.append(editor.button);
  const content = { ...imported("a\n\nb"), origin: "parse", blocks };
  editor.setContent(content); assert.equal(editor.button.disabled, true); assert.equal(editor.target(p), undefined);
  p.dataset.sourceBlockIds = '["a"]'; editor.setContent(content); assert.equal(editor.button.disabled, false);
  editor.edit("a"); editor.dispose(); assert.equal(doc.querySelector(".km-block-editor,.km-block-editor-original"), null);
  assert.equal(p.hasAttribute("data-km-edit-block"), false);
  editor.edit("a"); assert.equal(doc.querySelector("textarea"), null);
});

test("editing a final block scrolls only its Markdown viewport and keeps ancestor positions", t => {
  const { doc, dom, helpers } = fixture(t), article = doc.createElement("article"); doc.body.append(article);
  article.innerHTML = '<p data-source-block-ids="[&quot;last&quot;]">Last content.</p>';
  article.getBoundingClientRect = () => ({ top: 40, bottom: 640, height: 600 });
  let cardTop = 600, cardHeight = 160;
  const bounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function() {
    return this.classList.contains("km-block-editor") ? { top: cardTop, bottom: cardTop + cardHeight, height: cardHeight } : bounds.call(this);
  };
  dom.window.HTMLElement.prototype.scrollIntoView = () => { doc.documentElement.scrollTop = 999; };
  const focus = dom.window.HTMLElement.prototype.focus;
  dom.window.HTMLElement.prototype.focus = function(options) {
    if (!options?.preventScroll) doc.documentElement.scrollTop = 999;
    focus.call(this, options);
  };
  const block = { id: "last", type: "paragraph", label: "text", markdown: "Last content." };
  const editor = new helpers.ReaderBlockEditor(article, () => {}, () => {});
  t.after(() => editor.dispose()); editor.setContent({ ...imported(block.markdown), origin: "parse", blocks: [block] });
  for (const [top, height, expected] of [[600, 160, 632], [200, 160, 500], [50, 160, 446], [600, 1000, 996]]) {
    cardTop = top; cardHeight = height; article.scrollTop = 500; doc.documentElement.scrollTop = 55;
    editor.edit("last");
    assert.equal(article.scrollTop, expected, "only the minimum required Markdown scroll is applied");
    assert.equal(doc.documentElement.scrollTop, 55, "document ancestors never move to align the final block");
    assert.equal(doc.activeElement, article.querySelector("textarea"));
    article.querySelector(".km-block-editor-discard").click();
    assert.equal(doc.documentElement.scrollTop, 55, "returning focus after discard also preserves ancestors");
  }
});

test("installed editor creates observer options in the reader realm before opening a block", async t => {
  const { doc, dom, helpers, reader, prefs, sandbox } = fixture(t);
  const readerRealm = createContext({}), readerPrototype = runInContext("Object.prototype", readerRealm);
  const readerJSON = runInContext("JSON", readerRealm);
  sandbox.Components = { utils: { cloneInto(value, targetScope) {
    assert.equal(targetScope, dom.window); return readerJSON.parse(JSON.stringify(value));
  } } };
  const NativeObserver = dom.window.MutationObserver;
  let observed = 0, disconnected = 0;
  dom.window.MutationObserver = class extends NativeObserver {
    observe(target, options) {
      assert.equal(Object.getPrototypeOf(options), readerPrototype, "Gecko must be able to read the observer's dictionary");
      observed++; super.observe(target, options);
    }
    disconnect() { disconnected++; super.disconnect(); }
  };
  const blocks = [{ id: "p", type: "paragraph", label: "text", markdown: "Editable source." }];
  const content = { ...imported(blocks[0].markdown), origin: "parse", generationID: "g", blocks };
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return content; } }, () => {});
  t.after(() => view.dispose()); view.toggle(true); await settle();
  doc.querySelector(".km-reader-edit-toggle").click(); doc.querySelector('[data-km-edit-block="p"]').click();
  const input = doc.querySelector("textarea");
  assert.ok(input, "clicking a source block opens its editor across the plugin/reader boundary");
  assert.equal(input.value, blocks[0].markdown); assert.equal(observed, 1);
  input.style.height = "260px"; doc.dispatchEvent(new dom.window.Event("pointerup"));
  assert.equal(JSON.parse(prefs.get("extensions.zotero.knowledgemcp.readerPreferences")).editorMaxHeight, 260);
  view.dispose(); assert.equal(disconnected, 1); assert.equal(doc.querySelector(".km-block-editor"), null);
});

test("editor height maximum persists across blocks and PDFs without saving content-driven sizing", async t => {
  const prefs = new Map(), first = fixture(t, { prefs });
  const blocks = ["first", "second"].map(id => ({ id, type: "paragraph", label: "text", markdown: `Text in ${id}.` }));
  const content = { ...imported(blocks.map(block => block.markdown).join("\n\n")), origin: "parse", blocks };
  const make = f => new f.helpers.MarkdownReaderView(f.reader, f.doc, { async readAttachment() { return content; } }, () => {});
  const view = make(first); t.after(() => view.dispose()); view.toggle(true); await settle();
  const writes = [];
  first.sandbox.Zotero.Prefs.set = (key, value) => { writes.push(value); prefs.set(key, value); };
  const select = id => first.doc.querySelector(`[data-km-edit-block="${id}"]`).click();
  first.doc.querySelector(".km-reader-edit-toggle").click(); select("first");
  let input = first.doc.querySelector("textarea"); assert.equal(input.style.height, "64px");
  input.style.height = "330px"; input.style.height = "410px"; await settle();
  assert.equal(writes.length, 0, "resizing does not write on every style change");
  first.doc.dispatchEvent(new first.dom.window.Event("pointerup"));
  assert.equal(first.helpers.readReaderPreferences().editorMaxHeight, 410); assert.equal(writes.length, 1);
  assert.equal(input.style.height, "64px", "short content shrinks after recording the dragged maximum");
  first.doc.querySelectorAll('.km-block-editor [role="tab"]')[1].click();
  assert.equal(first.doc.querySelector(".km-block-editor").style.getPropertyValue("--km-editor-max-height"), "410px");
  assert.equal(first.doc.querySelector(".km-block-editor-preview").style.height, "", "preview height remains content-driven");
  first.doc.querySelectorAll('.km-block-editor [role="tab"]')[0].click();
  first.doc.querySelector(".km-block-editor-expand").click();
  first.doc.querySelector(".km-block-editor-expand").click();
  assert.equal(writes.length, 1, "tab switches and expansion do not overwrite the saved height");
  select("second"); assert.equal(first.doc.querySelector("textarea").style.height, "64px");
  assert.equal(first.doc.querySelector(".km-block-editor").style.getPropertyValue("--km-editor-max-height"), "410px");
  const second = fixture(t, { prefs }); second.reader.itemID = 99;
  const other = make(second); t.after(() => other.dispose()); await settle();
  second.doc.querySelector(".km-reader-edit-toggle").click(); second.doc.querySelector('[data-km-edit-block="first"]').click();
  assert.equal(second.doc.querySelector("textarea").style.height, "64px");
  assert.equal(second.doc.querySelector(".km-block-editor").style.getPropertyValue("--km-editor-max-height"), "410px");
  input = first.doc.querySelector("textarea"); input.style.height = "430px"; await settle();
  first.helpers.updateReaderPreferences({ fontSize: 19 }); view.dispose();
  assert.equal(first.helpers.readReaderPreferences().editorMaxHeight, 430);
  assert.equal(first.helpers.readReaderPreferences().fontSize, 19);
  second.doc.dispatchEvent(new second.dom.window.Event("pointerup")); other.dispose();
  assert.equal(first.helpers.readReaderPreferences().editorMaxHeight, 430, "an unchanged older editor cannot overwrite a newer maximum");
  const after = writes.length; input.style.height = "600px";
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(writes.length, after, "disposed editors disconnect observers and cancel pending writes");
});

test("editor source grows and shrinks within saved and viewport limits without persisting automatic measurements", async t => {
  const prefs = new Map([["extensions.zotero.knowledgemcp.readerPreferences", JSON.stringify({ version: 1, editorMaxHeight: 320 })]]);
  const { doc, dom, helpers, reader, sandbox } = fixture(t, { prefs });
  const blocks = [{ id: "text", type: "paragraph", label: "text", markdown: "Short text." }];
  const content = { ...imported(blocks[0].markdown), origin: "parse", blocks };
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return content; } }, () => {});
  t.after(() => view.dispose()); view.toggle(true); await settle();
  doc.querySelector(".km-reader-edit-toggle").click(); doc.querySelector('[data-km-edit-block="text"]').click();
  const input = doc.querySelector("textarea"); let measured = 52, writes = 0;
  Object.defineProperty(input, "scrollHeight", { get: () => measured });
  sandbox.Zotero.Prefs.set = () => { writes++; };
  const type = () => input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  type(); assert.equal(input.style.height, "64px");
  measured = 210; type(); assert.equal(input.style.height, "210px");
  measured = 900; type(); assert.equal(input.style.height, "320px");
  measured = 52; type(); assert.equal(input.style.height, "64px", "deleting content shrinks the editor again");
  measured = 280; dom.window.dispatchEvent(new dom.window.Event("resize")); assert.equal(input.style.height, "280px");
  Object.defineProperty(dom.window, "innerHeight", { value: 300, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event("resize")); assert.equal(input.style.height, "180px");
  doc.dispatchEvent(new dom.window.Event("pointerup")); view.dispose();
  await new Promise(resolve => setTimeout(resolve, 400)); assert.equal(writes, 0);
});

test("parsed formula and equation blocks open delimited TeX from MathML clicks and context menus", async t => {
  const { doc, dom, helpers, reader } = fixture(t);
  const blocks = [
    { id: "display", type: "formula", label: "display_formula", markdown: String.raw`$$\frac{a}{b}\tag{1}$$` },
    { id: "legacy", type: "equation", label: "", markdown: "$$x^2+y^2=z^2$$" },
    { id: "inline", type: "paragraph", label: "text", markdown: "An inline $x^2$ expression." },
    { id: "broken", type: "formula", label: "display_formula", markdown: String.raw`$$\unknowncommand{x}$$` },
  ];
  const content = { ...imported(blocks.map(block => block.markdown).join("\n\n")), origin: "parse", blocks };
  const original = JSON.stringify(content);
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return content; } }, () => {});
  t.after(() => view.dispose()); view.toggle(true); await settle(); doc.querySelector(".km-reader-edit-toggle").click();
  for (const block of blocks) {
    const target = doc.querySelector(`[data-km-edit-block="${block.id}"]`); assert.ok(target, block.id);
    const math = target.querySelector("math mi,math mn,math") ?? target;
    math.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.equal(doc.querySelector("textarea").value, block.markdown);
    doc.querySelector(".km-block-editor-keep").click();
    math.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const command = doc.querySelector('[data-knowledgemcp="reader-copy-menu"]').children[2];
    assert.equal(command.getAttribute("disabled"), "false"); command.dispatchEvent(new dom.window.Event("command"));
    assert.equal(doc.querySelector("textarea").value, block.markdown);
    doc.querySelectorAll('.km-block-editor [role="tab"]')[1].click();
    assert.ok(doc.querySelector(block.id === "broken" ? ".km-block-editor-preview .km-math-fallback" : ".km-block-editor-preview math"));
    doc.querySelector(".km-block-editor-keep").click();
  }
  assert.equal(JSON.stringify(content), original);
});

test("block types, insertion and confirmed deletion update only the current preview and its directory", async t => {
  const { doc, dom, helpers, reader } = fixture(t);
  const blocks = [
    { id: "title", type: "heading", label: "doc_title", markdown: "# Paper", pageStart: 1 },
    { id: "section", type: "heading", label: "paragraph_title", markdown: "## Methods", pageStart: 2 },
    { id: "paragraph", type: "paragraph", label: "text", markdown: "A revised section", pageStart: 2 },
    { id: "formula", type: "formula", label: "display_formula", markdown: "$$x^2$$", pageStart: 3 },
  ];
  const content = { ...imported(blocks.map(block => block.markdown).join("\n\n")), origin: "parse", generationID: "original-generation", blocks };
  const original = JSON.stringify(content); let providerCalls = 0;
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return content; } }, () => {}, async () => { providerCalls++; return { hits: [], degraded: [], truncated: false }; });
  t.after(() => view.dispose()); view.toggle(true); await settle();
  doc.querySelector(".km-reader-edit-toggle").click(); doc.querySelector('[data-km-edit-block="paragraph"]').click();
  const changeType = value => { doc.querySelector(".km-block-editor-type").click(); doc.querySelector(`.km-block-type-menu [data-block-type="${value}"]`).click(); };
  assert.deepEqual([...doc.querySelectorAll(".km-block-type-menu [data-block-type]")].map(option => option.dataset.blockType), [...helpers.readerBlockTypes]);
  changeType("footnote"); doc.querySelectorAll('.km-block-editor [role="tab"]')[1].click();
  assert.ok(doc.querySelector(".km-block-editor-preview details.km-reader-note"));
  changeType("heading"); assert.equal(doc.querySelector("textarea").value, "## A revised section");
  doc.querySelectorAll('.km-block-editor [role="tab"]')[1].click();
  assert.equal(doc.querySelector(".km-block-editor-preview h2").textContent, "A revised section");
  doc.querySelector(".km-block-editor-keep").click();
  assert.ok([...doc.querySelectorAll(".km-contents nav button")].some(button => button.textContent === "A revised section"));
  assert.equal(view.editor.session.snapshot().generationID, undefined);
  doc.querySelector('[data-km-edit-block="paragraph"]').click(); doc.querySelector(".km-block-editor-insert").click();
  assert.equal(doc.querySelector("textarea").value, "");
  let snapshot = view.editor.session.snapshot(), inserted = snapshot.blocks[3];
  assert.deepEqual(Array.from(snapshot.blocks, block => block.id), ["title", "section", "paragraph", inserted.id, "formula"]);
  assert.equal(inserted.pageStart, undefined); assert.equal(inserted.pageEnd, undefined);
  const input = doc.querySelector("textarea"); input.value = "New searchable evidence."; input.dispatchEvent(new dom.window.Event("input"));
  changeType("abstract"); doc.querySelector(".km-block-editor-keep").click();
  assert.equal(doc.querySelector(".km-abstract").textContent, "New searchable evidence.");
  doc.querySelector(".km-reader-search-toggle").click();
  const search = view.search; search.modeButtons.get("semantic").click(); search.input.value = "evidence"; await search.submit();
  assert.equal(providerCalls, 0, "a session draft must not query an old generation's vectors");
  search.modeButtons.get("fulltext").click(); await search.submit();
  assert.equal(doc.querySelectorAll(".km-reader-search-result").length, 1); search.close();
  view.editor.requestDelete(inserted.id); assert.equal(doc.querySelector(".km-block-delete-confirm").hidden, false);
  doc.querySelector("textarea").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(doc.querySelector(".km-block-delete-confirm").hidden, true); assert.ok(view.editor.session.get(inserted.id));
  view.editor.requestDelete(inserted.id); doc.querySelector(".km-block-confirm-delete").click();
  assert.equal(view.editor.session.get(inserted.id), undefined); assert.equal(doc.querySelector(".km-abstract"), null);
  view.editor.insertAfter("paragraph"); const abandoned = view.editor.session.snapshot().blocks[3].id;
  doc.querySelector(".km-block-editor-discard").click(); assert.equal(view.editor.session.get(abandoned), undefined);
  for (const block of [...view.editor.session.snapshot().blocks]) { view.editor.requestDelete(block.id); doc.querySelector(".km-block-confirm-delete").click(); }
  assert.ok(doc.querySelector(".km-block-add-first")); doc.querySelector(".km-block-add-first").click();
  assert.ok(doc.querySelector("textarea")); assert.equal(view.editor.session.snapshot().blocks.length, 1);
  assert.equal(JSON.stringify(content), original);
  view.dispose();
  const reopened = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return content; } }, () => {});
  t.after(() => reopened.dispose()); await settle(); assert.equal(doc.querySelector(".km-block-add-first"), null);
  assert.equal(doc.querySelector('[data-km-edit-block="paragraph"]').textContent, "A revised section");
});

test("session block changes preserve payload, invalidate affected projections and reject stale editor actions", async t => {
  const { doc, dom, helpers, reader } = fixture(t);
  const block = { id: "p", type: "paragraph", label: "text", markdown: "payload", pageStart: 3 };
  const original = { ...imported("payload"), origin: "parse", generationID: "g", blocks: [block],
    references: [{ id: "r", number: 1, order: 1, markdown: "old projection", blockIds: ["p"] }], visualLinks: [{ visualBlockId: "p", relatedBlockId: null }] };
  for (const type of ["heading", "formula", "code", "list", "footnote"]) {
    const converted = helpers.convertReaderBlock(block, type), restored = helpers.convertReaderBlock(converted, "paragraph");
    assert.equal(restored.markdown, block.markdown, type);
  }
  const session = new helpers.ReaderBlockSession(original);
  assert.equal(session.insertAfter("missing"), undefined); assert.equal(session.remove("missing"), false);
  assert.equal(session.replace("p", { ...block, markdown: "revised", type: "abstract", id: "forged", pageStart: 99 }), true);
  const snapshot = session.snapshot(); assert.equal(snapshot.blocks[0].id, "p"); assert.equal(snapshot.blocks[0].pageStart, 3);
  assert.equal(snapshot.generationID, undefined); assert.equal(snapshot.references.length, 0); assert.equal(snapshot.visualLinks.length, 0);
  assert.equal(original.blocks[0].markdown, "payload");
  assert.throws(() => session.replace("p", { ...block, markdown: "x".repeat(2 * 1024 * 1024 + 1) }));
  assert.equal(session.snapshot().blocks[0].markdown, "revised");
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return { ...original, references: [], visualLinks: [] }; } }, () => {});
  t.after(() => view.dispose()); view.toggle(true); await settle(); view.editor.edit("p");
  const staleKeep = doc.querySelector(".km-block-editor-keep"), staleInsert = doc.querySelector(".km-block-editor-insert"), staleType = doc.querySelector(".km-block-editor-type");
  staleType.click(); const staleOption = doc.querySelector('.km-block-type-menu [data-block-type="heading"]');
  view.toggle(false); view.toggle(true); await settle();
  staleKeep.click(); staleInsert.click(); staleType.click(); staleOption.click();
  assert.equal(view.editor.session.snapshot().blocks.length, 1); assert.equal(view.editor.session.get("p").type, "paragraph");
});

test("runtime history reverses block changes, restores original projections and bounds retained payloads", t => {
  const { helpers } = fixture(t);
  const content = { ...imported("Original"), origin: "parse", generationID: "g", blocks: [{ id: "p", type: "paragraph", label: "text", markdown: "Original" }],
    references: [{ id: "ref", markdown: "Original", blockIds: ["p"] }] };
  const session = new helpers.ReaderBlockSession(content);
  session.replace("p", { ...session.get("p"), markdown: "Revised" }); const inserted = session.insertAfter("p"); session.remove("p");
  assert.equal(session.undo(), "p"); assert.equal(session.snapshot().blocks.length, 2);
  assert.equal(session.undo(), inserted); assert.equal(session.undo(), "p");
  assert.equal(session.dirty, false); assert.equal(session.snapshot().generationID, "g"); assert.equal(session.snapshot().references.length, 1);
  assert.equal(session.redo(), "p"); assert.equal(session.get("p").markdown, "Revised");
  session.replace("p", { ...session.get("p"), markdown: "Different branch" }); assert.equal(session.canRedo, false);
  const abandoned = session.insertAfter("p"); session.cancelInsertion(abandoned); assert.equal(session.get(abandoned), undefined);
  assert.notEqual(session.undo(), abandoned, "discarding a blank insertion does not leave a phantom undo step");
  for (let n = 0; n < 250; n++) session.replace("p", { ...session.get("p"), markdown: "x".repeat(60000) + n });
  const stats = session.historyStats; assert.ok(stats.undo <= stats.maxEntries); assert.ok(stats.bytes <= stats.maxBytes);
  session.replace("p", { ...session.get("p"), markdown: "\u0001".repeat(2 * 1024 * 1024) });
  assert.ok(session.historyStats.bytes <= stats.maxBytes, "one oversized encoded change cannot exceed the history budget");
  assert.equal(content.blocks[0].markdown, "Original");
});

test("undo/redo stay in memory and explicit document save retains history on failure then resets the saved baseline", async t => {
  const { doc, dom, helpers, reader } = fixture(t);
  let content = { ...imported("Original text."), origin: "parse", generationID: "g1", blocks: [{ id: "p", type: "paragraph", label: "text", markdown: "Original text." }] };
  const requests = []; let rejectSave, resolveSave;
  const save = request => { requests.push(request); return new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; }); };
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return content; } }, () => {}, undefined, save);
  t.after(() => view.dispose()); view.toggle(true); await settle(); view.editor.edit("p");
  let input = doc.querySelector("textarea"); input.value = "Revised text."; input.dispatchEvent(new dom.window.Event("input"));
  const localUndo = new dom.window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
  input.dispatchEvent(localUndo); assert.equal(localUndo.defaultPrevented, false, "typing keeps native textarea undo");
  view.editor.undo(); assert.equal(view.editor.session.get("p").markdown, "Original text.");
  view.editor.redo(); assert.equal(view.editor.session.get("p").markdown, "Revised text."); assert.equal(requests.length, 0);
  view.toggle(false); view.toggle(true); await settle(); assert.equal(view.editor.session.get("p").markdown, "Revised text.");
  let pending = view.editor.saveDocument(); assert.equal(requests.length, 1); assert.equal(doc.querySelector(".km-reader-undo").disabled, true);
  rejectSave(new helpers.ReaderSaveError("conflict")); await pending;
  assert.equal(view.editor.hasChanges, true); assert.equal(view.editor.session.canUndo, true);
  assert.match(doc.querySelector(".km-reader-document-status").textContent, /newer version/);
  pending = view.editor.saveDocument();
  content = { ...content, generationID: "g2", updatedAt: 2, blocks: [{ id: "saved-p", type: "paragraph", label: "text", markdown: "Revised text." }], markdown: "Revised text." };
  resolveSave(content); await pending;
  assert.equal(view.editor.hasChanges, false); assert.equal(view.editor.session.baseGenerationID, "g2"); assert.equal(view.editor.session.canUndo, false);
  assert.equal(doc.querySelector(".km-reader-save-document").disabled, true); assert.equal(doc.querySelector(".km-reader-document-status").textContent, "Document saved");
  assert.equal(requests[1].baseGenerationID, "g1"); assert.equal(requests[1].blocks[0].markdown, "Revised text.");
});

test("reader shutdown drains accepted document writes and blocks late save requests", async t => {
  const { doc, dom, helpers } = fixture(t); let resolve, calls = 0;
  const content = { ...imported("Text."), origin: "parse", generationID: "g", blocks: [{ id: "p", type: "paragraph", label: "text", markdown: "Text." }] };
  const ui = new helpers.ReaderUI("save-lifecycle", { async readAttachment() { return content; } }, undefined, () => { calls++; return new Promise(done => { resolve = done; }); });
  ui.start(); const pending = ui.save({ attachment: identity, baseGenerationID: "g", blocks: content.blocks });
  ui.dispose(); let drained = false; const stopping = ui.drain().then(() => { drained = true; }); await settle();
  assert.equal(drained, false); await assert.rejects(ui.save({ attachment: identity, baseGenerationID: "g", blocks: content.blocks }));
  assert.equal(calls, 1); resolve(content); await pending; await stopping;
  assert.equal(drained, true); assert.equal(doc.querySelector(".km-markdown-panel"), null);
});

test("reader search header switches modes through a dismissible keyboard menu without idle hints", t => {
  const { doc, dom, helpers, prefs } = fixture(t), body = doc.createElement("div"), directory = doc.createElement("aside"), article = doc.createElement("article");
  article.innerHTML = "<p>Needle evidence.</p>"; body.append(directory, article); doc.body.append(body);
  let calls = 0;
  const search = new helpers.ReaderSearch(article, directory, body, () => {}, async () => { calls++; return { hits: [], degraded: [], truncated: false }; });
  t.after(() => search.dispose()); search.setContent(imported("Needle evidence.")); search.open();
  const trigger = search.element.querySelector(".km-reader-search-mode"), menu = doc.querySelector(".km-reader-search-mode-menu");
  assert.equal(trigger.textContent, "Text search");
  assert.equal(search.element.querySelector(".km-reader-search-scope,.km-reader-search-modes"), null);
  assert.equal(search.element.querySelector(".km-reader-search-feedback").textContent, "");
  const submit = search.element.querySelector(".km-reader-search-query button");
  assert.ok(submit.querySelector('svg[aria-hidden="true"]')); assert.equal(submit.textContent, "");
  const input = search.element.querySelector("input"); input.value = "needle"; submit.click();
  assert.equal(search.element.querySelectorAll(".km-reader-search-result").length, 1);
  trigger.click(); assert.equal(menu.hidden, false); assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(doc.activeElement.dataset.mode, "fulltext");
  doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement.dataset.mode, "semantic"); assert.equal(trigger.textContent, "Text search");
  doc.activeElement.click(); assert.equal(trigger.textContent, "Semantic search"); assert.equal(menu.hidden, true);
  assert.equal(prefs.get("extensions.zotero.knowledgemcp.readerSearchMode"), "semantic"); assert.equal(calls, 0);
  assert.equal(input.value, "needle"); assert.equal(doc.activeElement, input);
  trigger.click(); doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(menu.hidden, true); assert.equal(doc.activeElement, trigger); assert.equal(search.isOpen, true);
  trigger.click(); doc.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); assert.equal(menu.hidden, true);
  trigger.click(); dom.window.dispatchEvent(new dom.window.Event("resize")); assert.equal(menu.hidden, true);
  trigger.click(); search.close(); assert.equal(menu.hidden, true);
  search.open(); trigger.click(); search.dispose(); assert.equal(doc.querySelector(".km-reader-search-mode-menu"), null);
  trigger.click(); assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("reader text search replaces and restores Contents, safely previews matches and reveals a hidden note", t => {
  const { doc, dom, helpers } = fixture(t), body = doc.createElement("div"), directory = doc.createElement("aside"), article = doc.createElement("article");
  article.innerHTML = '<h1>Paper</h1><h2>Methods</h2><p>Needle &lt;img src=x&gt; evidence.</p><details><summary>Note</summary><p>A hidden needle.</p></details>';
  body.append(directory, article); doc.body.append(body); directory.scrollTop = 25;
  const search = new helpers.ReaderSearch(article, directory, body, () => {}); t.after(() => search.dispose());
  doc.body.append(search.button); search.setContent(imported("# Paper\n\nNeedle")); search.button.click();
  assert.equal(directory.hidden, true); assert.equal(search.element.hidden, false);
  const input = search.element.querySelector("input"); input.value = "needle";
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const hits = search.element.querySelectorAll(".km-reader-search-result"); assert.equal(hits.length, 2);
  assert.equal(search.element.querySelector("img"), null); assert.match(hits[0].textContent, /<img src=x>/);
  assert.equal(hits[0].querySelector("mark").textContent, "Needle");
  let jumped = false; article.querySelector("details p").scrollIntoView = () => { jumped = true; };
  hits[1].click(); assert.equal(jumped, true); assert.equal(article.querySelector("details").open, true);
  assert.ok(article.querySelector(".km-reader-search-target"));
  search.close(); assert.equal(directory.hidden, false); assert.equal(directory.scrollTop, 25);
  assert.equal(article.querySelector(".km-reader-search-target"), null);
  body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(search.isOpen, true); search.close();
  directory.hidden = true; search.open(); search.close(); assert.equal(directory.hidden, true);
  search.dispose(); assert.equal(body.querySelector(".km-reader-search"), null);
});

test("reader semantic modes bind attachment/generation, cancel late results and never navigate a missing block", async t => {
  const { doc, dom, helpers } = fixture(t), body = doc.createElement("div"), directory = doc.createElement("aside"), article = doc.createElement("article");
  article.innerHTML = '<p data-source-block-ids=\'["block-1"]\'>A relevant passage.</p>';
  body.append(directory, article); doc.body.append(body);
  const calls = []; let release;
  const provider = (...args) => { calls.push(args); return new Promise(resolve => { release = resolve; }); };
  const search = new helpers.ReaderSearch(article, directory, body, () => {}, provider); t.after(() => search.dispose());
  search.setContent({ ...imported("A relevant passage."), origin: "parse", generationID: "generation-1" }); search.open();
  const input = search.element.querySelector("input"), send = () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  doc.querySelector('[data-mode="semantic"]').click(); input.value = "related question"; send();
  assert.equal(calls.length, 1); assert.equal(calls[0][0].itemKey, identity.itemKey); assert.equal(calls[0][1], "generation-1");
  assert.equal(calls[0][3], "semantic"); search.close(); assert.equal(calls[0][4].aborted, true);
  assert.equal(search.element.querySelector(".km-reader-search-feedback").textContent, "");
  release({ hits: [{ blockID: "block-1", text: "A relevant passage.", section: "Methods", page: 3 }], degraded: [], truncated: false }); await settle();
  assert.equal(search.element.querySelectorAll(".km-reader-search-result").length, 0);
  search.open(); send(); release({ hits: [{ blockID: "block-1", text: "A relevant passage.", section: "Methods", page: 3 }], degraded: ["credentials"], truncated: false }); await settle();
  assert.equal(search.element.querySelectorAll(".km-reader-search-result").length, 1);
  const staleButton = search.element.querySelector(".km-reader-search-result");
  let staleJumped = false; article.querySelector("p").scrollIntoView = () => { staleJumped = true; };
  assert.ok(search.element.querySelector(".km-reader-search-warning")); assert.match(search.element.textContent, /Page 3/);
  send(); release({ hits: [{ blockID: "other-pdf-block", text: "Wrong source", section: null, page: null }], degraded: [], truncated: false }); await settle();
  assert.equal(search.element.querySelectorAll(".km-reader-search-result").length, 0);
  assert.match(search.element.textContent, /Content changed/);
  staleButton.click(); assert.equal(staleJumped, false, "a removed result cannot navigate an outdated target");
  article.innerHTML = '<details data-source-block-ids=\'["note-1"]\'><summary>Note</summary><p>Note text.</p></details>';
  search.setContent({ ...imported("Note text."), origin: "parse", generationID: "generation-2" });
  send(); release({ hits: [{ blockID: "note-1", text: "Note text.", section: null, page: null }], degraded: [], truncated: false }); await settle();
  article.querySelector("details").scrollIntoView = () => {};
  search.element.querySelector(".km-reader-search-result").click(); assert.equal(article.querySelector("details").open, true);
  send(); const signal = calls.at(-1)[4]; search.dispose(); assert.equal(signal.aborted, true);
  release({ hits: [], degraded: [], truncated: false }); await settle(); assert.equal(body.querySelector(".km-reader-search"), null);
});

test("reader UI aborts requests and drains even a provider that returns after disposal", async t => {
  const { doc, helpers } = fixture(t); let release, signal;
  const ui = new helpers.ReaderUI("reader-search-fixture", { async readAttachment() { return { ...imported("# Paper\n\nA passage."), generationID: "generation" }; } },
    (...args) => { signal = args[4]; return new Promise(resolve => { release = resolve; }); });
  t.after(() => ui.dispose()); ui.start(); doc.getElementById("knowledgemcp-markdown-toggle").click(); await settle();
  doc.querySelector(".km-reader-search-toggle").click(); doc.querySelector('[data-mode="semantic"]').click();
  const input = doc.querySelector(".km-reader-search input"); input.value = "query";
  input.dispatchEvent(new input.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  ui.dispose(); assert.equal(signal.aborted, true);
  let drained = false; const pending = ui.drain().then(() => { drained = true; }); await settle(); assert.equal(drained, false);
  release({ hits: [], degraded: [], truncated: false }); await pending;
  assert.equal(drained, true); assert.equal(doc.querySelector(".km-markdown-panel"), null);
});

test("reader search handles IME, mode changes, unindexed content and persisted mode without automatic provider calls", async t => {
  const { doc, dom, helpers, prefs } = fixture(t), body = doc.createElement("div"), directory = doc.createElement("aside"), article = doc.createElement("article");
  article.innerHTML = "<p>Needle evidence.</p>"; body.append(directory, article); doc.body.append(body);
  let calls = 0; const search = new helpers.ReaderSearch(article, directory, body, () => {}, async () => { calls++; return { hits: [], degraded: [], truncated: false }; });
  t.after(() => search.dispose()); search.setContent(imported("Needle evidence.")); search.open();
  const input = search.element.querySelector("input"); input.value = "needle";
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
  assert.equal(search.element.querySelectorAll(".km-reader-search-result").length, 0);
  doc.querySelector('[data-mode="enhanced"]').click(); assert.equal(calls, 0);
  assert.equal(prefs.get("extensions.zotero.knowledgemcp.readerSearchMode"), "enhanced");
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await settle();
  assert.match(search.element.textContent, /no usable semantic index/); assert.equal(calls, 0);
  doc.querySelector('[data-mode="fusion"]').click();
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await settle();
  assert.equal(search.element.querySelectorAll(".km-reader-search-result").length, 1); assert.ok(search.element.querySelector(".km-reader-search-warning"));
  input.value = ""; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); assert.equal(search.element.querySelectorAll(".km-reader-search-result").length, 0);
});

test("depth menu supports keyboard navigation, radio selection, dismissal and disposal", t => {
  const { doc, dom, helpers } = fixture(t), values = [];
  const menu = new helpers.ReaderDepthMenu(doc, value => values.push(value));
  t.after(() => menu.dispose()); doc.body.append(menu.button); menu.setOptions(3, 2);
  const popup = doc.querySelector(".km-depth-menu");
  menu.button.click();
  assert.equal(menu.button.getAttribute("aria-expanded"), "true");
  assert.equal(doc.activeElement.dataset.depth, "2");
  const key = value => doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  key("ArrowDown"); assert.equal(doc.activeElement.dataset.depth, "3");
  key("End"); assert.equal(doc.activeElement.dataset.depth, "0");
  key("Home"); assert.equal(doc.activeElement.dataset.depth, "1");
  doc.activeElement.click();
  assert.deepEqual(values, [1]); assert.equal(popup.hidden, true); assert.equal(doc.activeElement, menu.button);
  menu.button.click(); key("Escape"); assert.equal(popup.hidden, true); assert.equal(doc.activeElement, menu.button);
  menu.button.click(); doc.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  assert.equal(popup.hidden, true);
  menu.button.click(); doc.getElementById("zoomOut").focus(); assert.equal(popup.hidden, true);
  menu.button.click(); doc.dispatchEvent(new dom.window.Event("scroll")); assert.equal(popup.hidden, true);
  menu.button.click(); dom.window.dispatchEvent(new dom.window.Event("resize")); assert.equal(popup.hidden, true);
  menu.button.click(); menu.dispose(); menu.dispose(); assert.equal(doc.querySelector(".km-depth-menu"), null);
  menu.button.click(); assert.equal(menu.button.getAttribute("aria-expanded"), "false");
});

test("directory depth lists existing structural levels, preserves body content and restores across PDFs", async t => {
  const prefs = new Map(), first = fixture(t, { prefs });
  const make = (f, markdown) => new f.helpers.MarkdownReaderView(f.reader, f.doc,
    { async readAttachment() { return imported(markdown); } }, () => {});
  const view = make(first, "# Paper\n\n## Chapter\n\n#### Section\n\n###### Detail\n\n## Next chapter");
  t.after(() => view.dispose()); view.toggle(true); await settle();
  const select = first.doc.querySelector(".km-contents-depth");
  assert.deepEqual([...first.doc.querySelectorAll(".km-depth-menu [data-depth]")].map(o => o.dataset.depth), ["1", "2", "3", "0"]);
  assert.equal(first.doc.querySelector('.km-depth-menu [aria-checked="true"]').dataset.depth, "0"); assert.equal(select.disabled, false);
  const body = first.doc.querySelector("article").textContent;
  select.click(); first.doc.querySelector('.km-depth-menu [data-depth="1"]').click();
  assert.equal(first.doc.querySelector("article").textContent, body);
  assert.deepEqual([...first.doc.querySelectorAll(".km-contents nav button")].filter(b => !b.hidden).map(b => b.textContent), ["Chapter", "Next chapter"]);
  const second = fixture(t, { prefs });
  const restored = make(second, "# Another paper\n\n## First\n\n### Child"); t.after(() => restored.dispose()); await settle();
  assert.equal(second.doc.querySelector('.km-depth-menu [aria-checked="true"]').dataset.depth, "1");
  assert.equal(second.doc.querySelectorAll(".km-contents nav button")[1].hidden, true);
  select.click(); first.doc.querySelector('.km-depth-menu [data-depth="3"]').click();
  const third = fixture(t, { prefs });
  const shallow = make(third, "# Short paper\n\n## Only chapter"); t.after(() => shallow.dispose()); await settle();
  assert.equal(third.doc.querySelector('.km-depth-menu [aria-checked="true"]').dataset.depth, "1");
  assert.equal(third.doc.querySelector(".km-contents-depth").disabled, true);
  assert.equal(third.helpers.readReaderPreferences().contentsDepth, 3, "a shallow document does not overwrite the saved depth");
});

test("reading preferences survive view disposal and restore in a different PDF without initialization writes", async t => {
  const prefs = new Map(), first = fixture(t, { prefs });
  const view = new first.helpers.MarkdownReaderView(first.reader, first.doc,
    { async readAttachment() { return imported("# First paper\n\n## Section\n\nText."); } }, () => {});
  view.toggle(true); await settle();
  const buttons = first.doc.querySelectorAll(".km-reader-toolbar button:not(.km-reader-search-toggle,.km-reader-edit-toggle,.km-reader-undo,.km-reader-redo,.km-reader-save-document)");
  buttons[0].click(); buttons[3].click(); buttons[3].click();
  const divider = first.doc.querySelector(".km-reader-divider");
  divider.dispatchEvent(new first.dom.window.KeyboardEvent("keydown", { key: "ArrowRight" }));
  const saved = prefs.get("extensions.zotero.knowledgemcp.readerPreferences");
  view.dispose();
  assert.equal(prefs.get("extensions.zotero.knowledgemcp.readerPreferences"), saved);
  const second = fixture(t, { prefs }); second.reader.itemID = 99;
  const restored = new second.helpers.MarkdownReaderView(second.reader, second.doc,
    { async readAttachment() { return imported("# Different paper\n\nNew text."); } }, () => {});
  t.after(() => restored.dispose()); await settle();
  assert.equal(second.doc.querySelector(".km-markdown-panel").hidden, false);
  assert.match(second.doc.querySelector("article").textContent, /Different paper/);
  assert.equal(second.doc.querySelector(".km-contents").hidden, true);
  assert.equal(second.doc.querySelector(".km-reader-toolbar button").getAttribute("aria-expanded"), "false");
  assert.equal(second.doc.querySelector("article").style.getPropertyValue("--km-reader-font-size"), "17px");
  assert.equal(second.doc.body.style.getPropertyValue("--km-markdown-ratio"), "0.55");
  assert.equal(second.doc.querySelector(".km-reader-divider").getAttribute("aria-valuenow"), "55");
  assert.equal(prefs.get("extensions.zotero.knowledgemcp.readerPreferences"), saved);
  restored.toggle(false); restored.dispose();
  assert.equal(second.helpers.readReaderPreferences().open, false);
});

test("reading preferences merge independent windows and commit a dragged split only when the gesture ends", t => {
  const prefs = new Map(), first = fixture(t, { prefs }), second = fixture(t, { prefs });
  const make = f => new f.helpers.MarkdownReaderView(f.reader, f.doc, { async readAttachment() { return null; } }, () => {});
  const a = make(first), b = make(second); t.after(() => { a.dispose(); b.dispose(); });
  a.toggle(true);
  second.doc.querySelectorAll(".km-reader-toolbar button:not(.km-reader-search-toggle,.km-reader-edit-toggle,.km-reader-undo,.km-reader-redo,.km-reader-save-document)")[3].click();
  first.doc.querySelector(".km-reader-toolbar button").click();
  assert.equal(first.helpers.readReaderPreferences().fontSize, 16);
  assert.equal(first.helpers.readReaderPreferences().contentsVisible, false);
  assert.equal(first.helpers.readReaderPreferences().open, true);
  const divider = first.doc.querySelector(".km-reader-divider");
  first.doc.querySelector(".km-markdown-panel").getBoundingClientRect = () => ({ left: 0 });
  first.doc.getElementById("split-view").getBoundingClientRect = () => ({ right: 1000 });
  divider.dispatchEvent(new first.dom.window.MouseEvent("pointerdown", { button: 0 }));
  first.doc.dispatchEvent(new first.dom.window.MouseEvent("pointermove", { clientX: 620 }));
  assert.equal(first.helpers.readReaderPreferences().ratio, 0.5);
  first.doc.dispatchEvent(new first.dom.window.MouseEvent("pointerup"));
  assert.equal(first.helpers.readReaderPreferences().ratio, 0.62);
  b.dispose();
  assert.equal(first.helpers.readReaderPreferences().open, true, "closing a window does not save its stale closed state");
  assert.equal(first.helpers.readReaderPreferences().ratio, 0.62);
});

test("invalid reading preferences default field by field and unavailable preferences never break reading", t => {
  const { prefs, helpers, sandbox } = fixture(t), key = "extensions.zotero.knowledgemcp.readerPreferences";
  const plain = () => JSON.parse(JSON.stringify(helpers.readReaderPreferences()));
  const defaults = { open: false, ratio: 0.5, contentsVisible: true, fontSize: 15, contentsDepth: 0, editorMaxHeight: null };
  for (const value of ["not json", "null", "[]", '{"version":2,"open":true}', '{"version":1,"open":"true","ratio":2,"contentsVisible":0,"fontSize":12.5}']) {
    prefs.set(key, value); assert.deepEqual(plain(), defaults);
  }
  prefs.set(key, JSON.stringify({ version: 1, open: true, ratio: -1, contentsVisible: false, fontSize: 23 }));
  assert.deepEqual(plain(), { ...defaults, open: true, contentsVisible: false, fontSize: 23 });
  for (const editorMaxHeight of [0, 63, 2401, 200.5, "400"]) {
    prefs.set(key, JSON.stringify({ version: 1, editorMaxHeight })); assert.equal(plain().editorMaxHeight, null);
  }
  prefs.set(key, JSON.stringify({ version: 1, editorHeight: 640 })); assert.equal(plain().editorMaxHeight, 640);
  prefs.set(key, JSON.stringify({ version: 1, editorHeight: 640, editorMaxHeight: null })); assert.equal(plain().editorMaxHeight, null);
  sandbox.Zotero.Prefs.get = () => { throw Error("read unavailable"); };
  sandbox.Zotero.Prefs.set = () => { throw Error("write unavailable"); };
  assert.deepEqual(plain(), defaults);
  assert.doesNotThrow(() => helpers.updateReaderPreferences({ open: true }));
});

test("plain reader copy separates display equations and retains code indentation", t => {
  const { doc, helpers } = fixture(t), article = doc.createElement("article");
  article.append(helpers.renderMarkdown(doc, "Before.\n\n$$x^2$$\n\nAfter.\n\n```\n  indented code\n    nested\n```\n\nTail.", () => {}).fragment);
  assert.equal(helpers.readerText(article), "Before.\n\nx^2\n\nAfter.\n\n  indented code\n    nested\n\nTail.");
});

test("selected Markdown preserves partial inline formatting and selected block structure without surrounding text", t => {
  const { doc, dom, helpers } = fixture(t), article = doc.createElement("article"); doc.body.append(article);
  article.append(helpers.renderMarkdown(doc, "## Heading\n\nBefore **bold** [link](https://example.org). After.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- First\n- Second\n\n```\n  code `literal`\n```\n\nExcluded tail.", () => {}).fragment);
  const selection = dom.window.getSelection(), range = doc.createRange();
  const select = (start, startOffset, end = start, endOffset = startOffset) => {
    range.setStart(start, startOffset); range.setEnd(end, endOffset); selection.removeAllRanges(); selection.addRange(range);
    return helpers.readerSelection(article);
  };
  const bold = article.querySelector("strong").firstChild;
  assert.equal(select(bold, 1, bold, 3).markdown, "**ol**");
  const link = article.querySelector("a").firstChild;
  assert.equal(select(link, 0, link, 4).markdown, "[link](<https://example.org>)");
  range.setStartBefore(article.querySelector("h2")); range.setEndAfter(article.querySelector("pre")); selection.removeAllRanges(); selection.addRange(range);
  const copied = helpers.readerSelection(article);
  assert.ok(copied.markdown.startsWith("## Heading\n\n"));
  assert.match(copied.markdown, /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  assert.match(copied.markdown, /- First\n- Second/);
  assert.match(copied.markdown, /```\n  code `literal`\n```/);
  assert.ok(!copied.text.includes("Excluded tail") && !copied.markdown.includes("Excluded tail"));
  assert.equal(select(bold, 1), null);
  const space = article.querySelector("p").firstChild;
  assert.equal(select(space, 6, space, 7), null);
});

test("selection copy excludes collapsed notes between selected paragraphs until they are expanded", t => {
  const { doc, dom, helpers } = fixture(t), article = doc.createElement("article"); doc.body.append(article);
  article.append(helpers.renderMarkdown(doc, "Before.\n\n> Hidden note.\n\nAfter.", () => {}).fragment);
  const range = doc.createRange(); range.selectNodeContents(article); dom.window.getSelection().addRange(range);
  assert.equal(helpers.readerSelection(article).text, "Before.\n\nAfter.");
  assert.equal(helpers.readerSelection(article).markdown, "Before.\n\nAfter.");
  article.querySelector("details").open = true;
  assert.equal(helpers.readerSelection(article).text, "Before.\n\nHidden note.\n\nAfter.");
  assert.match(helpers.readerSelection(article).markdown, /> Hidden note\./);
});

test("native reader context menu copies only a selection, disables empty selections and permits clipboard retry", async t => {
  const { doc, dom, helpers, reader } = fixture(t);
  const markdown = "# Paper\n\nA **bold** result $x^2$ [1].\n\nElsewhere.\n\n## References\n\n[1] Smith. A reference.";
  let content = imported(markdown), fail = false;
  const copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { async writeText(value) {
    if (fail) throw new Error("Clipboard denied"); copied.push(value);
  } } });
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return content; } }, () => {});
  t.after(() => view.dispose());
  const status = doc.querySelector(".km-reader-copy-status");
  const menu = () => {
    doc.querySelector(".km-markdown-content").dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, screenX: 123, screenY: 234 }));
    return doc.querySelector('[data-knowledgemcp="reader-copy-menu"]');
  };
  const command = (popup, index) => popup.children[index].dispatchEvent(new dom.window.Event("command"));
  assert.equal(doc.querySelector(".km-reader-copy-actions"), null);
  view.toggle(true); await settle();
  let popup = menu();
  assert.deepEqual(popup.position, { x: 123, y: 234, context: true });
  assert.deepEqual([...popup.children].map(item => item.getAttribute("label")), ["Copy as text", "Copy as Markdown", "Edit this block", "Insert block below", "Delete this content"]);
  assert.ok([...popup.children].every(item => item.getAttribute("disabled") === "true"));
  command(popup, 0); await settle(); assert.equal(copied.length, 0);
  const selection = dom.window.getSelection(), range = doc.createRange();
  const p = doc.querySelector(".km-markdown-content p"); range.selectNodeContents(p); selection.addRange(range);
  popup = menu(); assert.ok([...popup.children].slice(0, 2).every(item => item.getAttribute("disabled") === "false"));
  selection.removeAllRanges(); command(popup, 0); await settle();
  assert.equal(copied[0], "A bold result x^2 [1].");
  assert.equal(doc.querySelector('[data-knowledgemcp="reader-copy-menu"]'), null);
  assert.equal(status.textContent, "Copied");
  selection.addRange(range); command(menu(), 1); await settle();
  assert.equal(copied[1], "A **bold** result $x^2$ \\[1\\].");
  fail = true; command(menu(), 0); await settle();
  assert.equal(status.textContent, "Could not copy. Try again.");
  assert.ok(status.classList.contains("km-reader-warning"));
  fail = false; command(menu(), 0); await settle(); assert.equal(copied.length, 3);

  // Model the native window handler that suppresses selection outside its allowlist.
  const cancelSelection = event => event.preventDefault();
  dom.window.addEventListener("pointerdown", cancelSelection);
  const event = new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
  doc.querySelector(".km-markdown-content p").dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  doc.querySelector(".km-citation").focus();
  const popupEvent = new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
  doc.querySelector(".km-citation-preview").dispatchEvent(popupEvent); assert.equal(popupEvent.defaultPrevented, false);
  const nativeEvent = new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
  doc.querySelector("#split-view").dispatchEvent(nativeEvent); assert.equal(nativeEvent.defaultPrevented, true);
  dom.window.removeEventListener("pointerdown", cancelSelection);
  selection.removeAllRanges(); range.selectNodeContents(doc.querySelector("#sidebarToggle")); selection.addRange(range);
  assert.ok([...menu().children].every(item => item.getAttribute("disabled") === "true"));
  content = null; view.toggle(false); view.toggle(true); await settle();
  assert.ok([...menu().children].every(item => item.getAttribute("disabled") === "true")); assert.equal(status.textContent, "");
  view.dispose(); assert.equal(doc.querySelector('[data-knowledgemcp="reader-copy-menu"]'), null);
});

test("closing or reloading removes native menus and invalidates their captured commands", async t => {
  const { doc, dom, helpers, reader } = fixture(t), copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { async writeText(value) { copied.push(value); } } });
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return imported("Selection."); } }, () => {});
  t.after(() => view.dispose());
  view.toggle(true); await settle();
  const article = doc.querySelector(".km-markdown-content"), range = doc.createRange(); range.selectNodeContents(article);
  dom.window.getSelection().addRange(range); article.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
  const stale = doc.querySelector('[data-knowledgemcp="reader-copy-menu"] menuitem');
  view.toggle(false); assert.equal(doc.querySelector('[data-knowledgemcp="reader-copy-menu"]'), null);
  view.toggle(true); await settle(); stale.dispatchEvent(new dom.window.Event("command")); await settle();
  assert.equal(copied.length, 0);
});

test("late clipboard completion cannot update a closed, reloaded or disposed reader", async t => {
  const { doc, dom, helpers, reader } = fixture(t);
  let release;
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: () => new Promise(resolve => { release = resolve; }) } });
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return imported("# Content"); } }, () => {});
  t.after(() => view.dispose());
  for (const action of [() => view.toggle(false), () => { view.toggle(false); view.toggle(true); }, () => view.dispose()]) {
    view.toggle(true); await settle();
    const article = doc.querySelector(".km-markdown-content"), status = doc.querySelector(".km-reader-copy-status");
    const range = doc.createRange(); range.selectNodeContents(article); dom.window.getSelection().removeAllRanges(); dom.window.getSelection().addRange(range);
    article.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const item = doc.querySelector('[data-knowledgemcp="reader-copy-menu"] menuitem');
    item.dispatchEvent(new dom.window.Event("command")); action(); release(); await settle();
    assert.equal(status.textContent, "");
  }
  assert.equal(doc.querySelector('[data-knowledgemcp="reader-copy-menu"]'), null);
});

test("plain HTML prose is classified for common spacing independently of its language", t => {
  const { doc, helpers } = fixture(t);
  const source = `<div>An English paragraph with <em>inline formatting</em>.</div>
<div>Un paragraphe français.</div>
<div>فقرة باللغة العربية.</div>
<div>中文正文。</div>
<div style="text-align:center">Figure caption.</div>
<div><p>A nested paragraph.</p></div>
<div><img src="image.png"></div>
<blockquote><div>A quoted note.</div></blockquote>`;
  const host = doc.createElement("article"); host.append(helpers.renderMarkdown(doc, source, () => {}).fragment);
  assert.deepEqual([...host.querySelectorAll(":scope > div.km-body-prose")].map(p => p.textContent), [
    "An English paragraph with inline formatting.", "Un paragraphe français.", "فقرة باللغة العربية.", "中文正文。",
  ]);
  assert.ok(!host.querySelector("[style].km-body-prose"));
  assert.ok(!host.querySelector("div.km-body-prose > p, div.km-body-prose > img"));
  assert.ok(host.querySelector("blockquote div.km-body-prose"));
});

test("notes default to closed native disclosures while preserving nested content and link handlers", t => {
  const { doc, helpers } = fixture(t), opened = [];
  const source = "> Note: **important** $R^2$. [Source](https://example.org/paper)\n>\n> > Nested quotation.\n\n<table><tr><td colspan=\"2\">$x$</td></tr></table>\n\n> Another note.";
  const host = doc.createElement("article"); host.append(helpers.renderMarkdown(doc, source, url => opened.push(url)).fragment);
  const notes = host.querySelectorAll("details.km-reader-note");
  assert.equal(notes.length, 2);
  assert.ok([...notes].every(note => !note.open));
  assert.equal(notes[0].firstElementChild.tagName, "SUMMARY");
  assert.equal(notes[0].firstElementChild.textContent, "Note");
  assert.equal(notes[0].querySelector("strong").textContent, "important");
  assert.ok(notes[0].querySelector("math"));
  assert.ok(notes[0].querySelector("blockquote blockquote"));
  notes[0].firstElementChild.click(); assert.equal(notes[0].open, true);
  notes[0].querySelector("a").click(); assert.deepEqual(opened, ["https://example.org/paper"]);
  notes[0].firstElementChild.click(); assert.equal(notes[0].open, false);
  const wrapper = host.querySelector(".km-table-scroll");
  assert.equal(wrapper.tabIndex, 0);
  assert.equal(wrapper.getAttribute("role"), "region");
  assert.equal(wrapper.getAttribute("aria-label"), "Table 1");
  assert.equal(wrapper.firstElementChild.tagName, "TABLE");
  assert.equal(wrapper.querySelector("td").colSpan, 2);
  assert.ok(wrapper.querySelector("math"));
});

test("heading navigation expands a collapsed note before scrolling to its heading", async t => {
  const { api, doc } = fixture(t, { content: imported("# Paper\n\n> ## Note section\n>\n> Content inside a note.") });
  await api.startup({ id: "test", version: "test", rootURI: "file:///test/" });
  doc.getElementById("knowledgemcp-markdown-toggle").click(); await settle();
  const note = doc.querySelector(".km-reader-note");
  assert.equal(note.open, false);
  let scrolled = false;
  note.querySelector("h2").scrollIntoView = () => { assert.equal(note.open, true); scrolled = true; };
  doc.querySelectorAll(".km-contents nav button")[0].click();
  assert.equal(scrolled, true);
});

test("adjacent notes share one disclosure while body text and other elements keep note groups separate", t => {
  const { doc, helpers } = fixture(t), opened = [];
  const source = "> First note $R^2$. [Source](https://example.org/paper)\n\n<!-- inert boundary -->\n\n<blockquote>Second note.<blockquote>Nested quotation.</blockquote></blockquote>\n\nA body paragraph.\n\n<blockquote>Third note.</blockquote>\n<div>Visible separator.</div>\n<blockquote>Fourth note.</blockquote>";
  const host = doc.createElement("article"); host.append(helpers.renderMarkdown(doc, source, url => opened.push(url)).fragment);
  const notes = host.querySelectorAll(".km-reader-note");
  assert.equal(notes.length, 3);
  assert.deepEqual([...notes].map(note => note.querySelectorAll(":scope > blockquote").length), [2, 1, 1]);
  assert.equal(notes[0].querySelectorAll("summary").length, 1);
  assert.equal(notes[0].querySelectorAll("blockquote blockquote").length, 1);
  assert.ok(notes[0].querySelector("math"));
  assert.ok([...notes].every(note => !note.open));
  notes[0].querySelector("summary").click(); assert.equal(notes[0].open, true);
  notes[0].querySelector("a").click(); assert.deepEqual(opened, ["https://example.org/paper"]);
  assert.ok(!notes[0].textContent.includes("A body paragraph"));
  assert.ok(!notes[1].textContent.includes("Visible separator"));
});

test("reference sections group numbered bilingual entries without changing paragraph content or following body", t => {
  const { doc, helpers } = fixture(t), opened = [];
  const source = "## Body\n\n[1] An ordinary body citation.\n\n## 6. References\n\n[1] 中文文献。\n\nEnglish translation. [Source](https://example.org/paper)\n\n[2] First fragment\n\ncontinued fragment.\n\n[3] Last reference $x$.\n\n## Appendix\n\nAn appendix paragraph.\n\n[4] Not a bibliography entry.\n\n## Bibliography\n\nAuthor A. One paper.\n\nAuthor B. Another paper.\n\n## 参考文献\n\n1. List entry one.\n2. List entry two.";
  const host = doc.createElement("article"); host.append(helpers.renderMarkdown(doc, source, url => opened.push(url)).fragment);
  const entries = host.querySelectorAll(".km-reference-entry");
  assert.equal(entries.length, 7);
  assert.deepEqual([...entries].map(entry => entry.querySelectorAll("p").length), [2, 2, 1, 1, 1, 1, 1]);
  assert.deepEqual([...entries].map(entry => entry.querySelector(".km-reference-number").textContent), ["[1]", "[2]", "[3]", "[1]", "[2]", "[1]", "[2]"]);
  assert.equal(entries[0].querySelector("p").textContent, "中文文献。");
  assert.equal(entries[0].querySelector(".km-reference-body").lastElementChild.textContent, "English translation. Source");
  assert.equal(entries[1].querySelector("p").textContent, "First fragment");
  assert.equal(entries[1].querySelector(".km-reference-body").lastElementChild.textContent, "continued fragment.");
  entries[0].querySelector("a").click(); assert.deepEqual(opened, ["https://example.org/paper"]);
  assert.ok(entries[2].querySelector("math"));
  for (const text of ["[1] An ordinary body citation.", "An appendix paragraph.", "[4] Not a bibliography entry."]) {
    const paragraph = [...host.querySelectorAll("p")].find(p => p.textContent === text);
    assert.equal(paragraph.parentElement, host);
  }
  assert.equal(host.querySelectorAll("ol.km-reference-list > li").length, 2);
});

test("reference list labels preserve nonconsecutive Markdown and HTML numbering and rich bodies", t => {
  const { doc, helpers } = fixture(t);
  const host = doc.createElement("article");
  host.append(helpers.renderMarkdown(doc, "## References\n\n3. **First** $x$.\n7. [Second](https://example.org/paper).\n\n## Bibliography\n\n<ol start=\"12\"><li>Third.</li><li value=\"19\">Fourth.</li></ol>", () => {}).fragment);
  assert.deepEqual([...host.querySelectorAll(".km-reference-number")].map(e => e.textContent), ["[3]", "[7]", "[12]", "[19]"]);
  assert.ok(host.querySelector(".km-reference-body strong"));
  assert.ok(host.querySelector(".km-reference-body math"));
  assert.equal(host.querySelector(".km-reference-body a").textContent, "Second");
});

test("CJK prose uses character justification across Markdown and OCR HTML without reclassifying code or math", t => {
  const { doc, helpers } = fixture(t);
  const rendered = helpers.renderMarkdown(doc, `An English paragraph.

中文正文和 $ R^2 $ 混排。

> 中文引用正文。

- 한국어 문단.

<div><span>日本語の本文です。</span></div>

<div style="text-align:center">图注居中。</div>

Literal \`中文代码\` and $\\text{中文公式}$.

\`\`\`
中文代码块
\`\`\``, () => {});
  const host = doc.createElement("article"); host.append(rendered.fragment);
  const paragraphs = [...host.querySelectorAll("p")];
  assert.equal(paragraphs[0].classList.contains("km-cjk-prose"), false);
  assert.equal(paragraphs[1].classList.contains("km-cjk-prose"), true);
  assert.ok(host.querySelector("blockquote p.km-cjk-prose"));
  assert.ok(host.querySelector("li .km-cjk-prose"));
  assert.ok(host.querySelector("div.km-cjk-prose span"));
  assert.equal(host.querySelector('div[style]').style.textAlign, "center");
  assert.equal(paragraphs.at(-1).classList.contains("km-cjk-prose"), false);
  assert.equal(host.querySelector("pre.km-cjk-prose, math.km-cjk-prose"), null);
});

test("TeX delimiters render native MathML in paragraphs, headings, lists and tables", t => {
  const { doc, helpers } = fixture(t);
  const source = String.raw`# Energy $E=mc^2$

Inline $x_i$ and \(\frac{a}{b}\). OCR $ R^{2} $.

$$
\begin{aligned}
f(x) &= \int_0^1 x^2\,dx \\
     &= \frac{1}{3}
\end{aligned}
$$

\[
\sum_{i=1}^n i=\frac{n(n+1)}{2}
\]

- Probability $p < 0.05$.

| Symbol | Value |
| --- | --- |
| $\alpha$ | $2$ |

Before $$y=x^2$$ after.
`;
  const rendered = helpers.renderMarkdown(doc, source, () => {});
  const host = doc.createElement("article"); host.append(rendered.fragment);
  assert.equal(host.querySelectorAll("math").length, 10);
  assert.equal(host.querySelectorAll(".km-math-block math[display=block]").length, 3);
  assert.equal(host.querySelectorAll(".km-math-fallback").length, 0);
  assert.ok(host.querySelector("mfrac"));
  assert.ok(host.querySelector("mtable"));
  assert.equal(host.querySelector("h1 math").namespaceURI, "http://www.w3.org/1998/Math/MathML");
  assert.equal(rendered.headings[0].title, "Energy E=mc^2");
  assert.ok(host.querySelector("td math"));
});

test("math leaves code, escaped dollars, prices and unmatched delimiters intact", t => {
  const { doc, helpers } = fixture(t);
  const source = String.raw`Prices $5 and $10. Escaped \$x\$. Unmatched $x.

Code: \`$x$\`.

\`\`\`tex
$$x$$
\`\`\`

    $y$
`.replaceAll("\\`", "`");
  const host = doc.createElement("article");
  host.append(helpers.renderMarkdown(doc, source, () => {}).fragment);
  assert.equal(host.querySelector("math"), null);
  assert.ok(host.textContent.includes("Prices $5 and $10"));
  assert.ok(host.textContent.includes("Escaped $x$"));
  assert.equal(host.querySelectorAll("code").length, 3);
});

test("untrusted or invalid TeX cannot inject active markup and does not break later content", t => {
  const { doc, helpers } = fixture(t);
  const source = String.raw`$\href{javascript:alert(1)}{x}$

$\includegraphics{https://external.invalid/image.png}$

$\htmlClass{evil}{x}$

$\unknowncommand{x}$

$\def\forever{\forever}\forever$

$\gdef\shared{x}$ $\shared$

$\text{<img src=x onerror=evil()>}$

## Still readable

$x^2$`;
  const host = doc.createElement("article");
  host.append(helpers.renderMarkdown(doc, source, () => {}).fragment);
  assert.equal(host.querySelectorAll("a,img,script,iframe,svg,[href],[src],[onclick],[onerror],.evil").length, 0);
  const fallbacks = [...host.querySelectorAll(".km-math-fallback")].map(element => element.textContent);
  for (const command of ["\\unknowncommand", "\\forever", "\\shared"]) {
    assert.ok(fallbacks.some(value => value.includes(command)), command);
  }
  assert.ok(host.textContent.includes("\\unknowncommand{x}"));
  assert.equal(host.querySelector("h2").textContent, "Still readable");
  assert.equal(host.lastElementChild.querySelectorAll("math").length, 1);
  const oversized = `$${"x".repeat(16_385)}$`;
  const limited = helpers.renderMarkdown(doc, oversized, () => {}).fragment;
  assert.equal(limited.querySelector(".km-math-fallback").textContent, oversized);
});

test("OCR HTML preserves table spans and centered captions through the local-only DOM allowlist", t => {
  const { doc, helpers } = fixture(t), opened = [];
  const markdown = `<!-- page 1; width=600; height=800 -->

<table border=1 style="background:url(https://external.invalid/track);margin:auto" onclick="evil()"><tr><th colspan="2">A &amp; B</th></tr><tr><td rowspan="2"><sup>2</sup></td><td><img src="images/local.png" onerror="evil()"><img src="https://external.invalid/image"></td></tr></table>

<div style="text-align: center; color:red" onload="evil()">Figure &lt;1&gt;</div>

<svg onload="evil()"><foreignObject>bad</foreignObject></svg>

<a href="javascript:evil()">Unsafe</a> <a href="https://example.org/paper">Safe</a>`;
  const rendered = helpers.renderMarkdown(doc, markdown, value => opened.push(value), { "images/local.png": "data:image/png;base64,iVBORw0KGgo=" });
  const host = doc.createElement("article"); host.append(rendered.fragment);
  assert.equal(host.querySelector("th").colSpan, 2); assert.equal(host.querySelector("td").rowSpan, 2);
  assert.equal(host.querySelector("th").textContent, "A & B");
  assert.equal(host.querySelector("div[style]").style.textAlign, "center"); assert.equal(host.querySelector("div[style]").textContent, "Figure <1>");
  assert.equal(host.querySelectorAll("img").length, 1); assert.match(host.querySelector("img").src, /^data:/);
  assert.equal(host.querySelectorAll("[onclick],[onerror],[onload],svg,script,iframe").length, 0);
  assert.ok(!host.textContent.includes("<!--")); assert.ok(!host.innerHTML.includes("background"));
  assert.equal(host.querySelectorAll("a[href]").length, 1); host.querySelector("a[href]").click();
  assert.deepEqual(opened, ["https://example.org/paper"]);
});

test("OCR HTML table math renders inside captions, merged cells and nested formatting without reparsing HTML", t => {
  const { doc, helpers } = fixture(t);
  const source = String.raw`<table onclick="evil()">
<caption>Measurements $ R^2 $</caption>
<tr><th colspan="2">Coefficient \(\alpha\)</th></tr>
<tr><td rowspan="2"><b>$ 7.8 \pm 0.3^{c} $</b></td><td>Significance $ p &lt; 0.05 $ &amp; literal H_2O *text*</td></tr>
<tr><td>\[\frac{a}{b}\]</td></tr>
<tr><td>$$\sum_{i=1}^n i$$</td><td>$\text{&lt;img src=x onerror=evil()&gt;}$</td></tr>
<tr><td><code>$x$</code></td><td><span>$y$</span></td></tr>
</table>

| Symbol |
| --- |
| $z$ |`;
  const host = doc.createElement("article"); host.append(helpers.renderMarkdown(doc, source, () => {}).fragment);
  assert.equal(host.querySelectorAll("math").length, 9);
  assert.equal(host.querySelectorAll("table")[0].querySelectorAll("math").length, 8);
  assert.equal(host.querySelector("caption annotation").textContent, "R^2");
  assert.equal(host.querySelector("th").colSpan, 2);
  assert.equal(host.querySelector("td").rowSpan, 2);
  assert.ok(host.querySelector("td b math"));
  assert.ok(host.querySelector("mfrac"));
  assert.equal(host.querySelectorAll(".km-math-block").length, 2);
  assert.equal(host.querySelector("code").textContent, "$x$");
  assert.ok(host.textContent.includes("& literal H_2O *text*"));
  assert.ok([...host.querySelectorAll("annotation")].some(element => element.textContent === "p < 0.05"));
  assert.equal(host.querySelector(".km-math-fallback, script, img, [onclick], [onerror]"), null);
});

test("HTML table math preserves currency, invalid TeX and cell boundaries without activating links or images", t => {
  const { doc, helpers } = fixture(t);
  const source = String.raw`<table><tr>
<td>Prices $5 and $10. Escaped \$x\$.</td><td>$unclosed</td><td>different cell$</td>
<td>$\unknowncommand{x}$</td><td>$\includegraphics{https://external.invalid/image}$</td>
<td>$\href{javascript:evil()}{x}$</td><td>$x^2$</td>
</tr></table>`;
  const host = doc.createElement("article"); host.append(helpers.renderMarkdown(doc, source, () => {}).fragment);
  const cells = host.querySelectorAll("td");
  assert.equal(cells[0].textContent, String.raw`Prices $5 and $10. Escaped \$x\$.`);
  assert.equal(cells[1].textContent, "$unclosed");
  assert.equal(cells[2].textContent, "different cell$");
  assert.equal(cells[3].querySelector(".km-math-fallback").textContent, String.raw`$\unknowncommand{x}$`);
  assert.ok(cells[6].querySelector("math"));
  assert.equal(host.querySelector("a, img, script, [href], [src], [onerror]"), null);
  const markdownTable = helpers.renderMarkdown(doc, String.raw`| Literal | Formula |
| --- | --- |
| \$x\$ | $y$ |`, () => {}).fragment;
  assert.equal(markdownTable.querySelector("td").textContent, "$x$");
  assert.equal(markdownTable.querySelectorAll("math").length, 1, "Markdown cells must not be parsed a second time");
});

test("OCR HTML table line markers render as real breaks around math, nested text and merged cells", t => {
  const { doc, helpers } = fixture(t), host = doc.createElement("article");
  const source = String.raw`Outside \n stays literal.

<table><caption>Caption\nLiteral</caption><tr><th colspan="2">Coefficient\n(SE)</th></tr>
<tr><td rowspan="2">$0.1741^{**}$\n(0.0808)</td><td>0.0060\n(0.0119)</td></tr>
<tr><td><b>0.2765</b>\n<span>(0.1153)</span></td></tr>
<tr><td>A&#92;nB</td><td>Safe\n&lt;img src=x onerror=evil()&gt;</td></tr></table>`;
  host.append(helpers.renderMarkdown(doc, source, () => {}).fragment);
  assert.equal(host.querySelectorAll("br").length, 6);
  assert.equal(host.querySelector("th").colSpan, 2); assert.equal(host.querySelector("td").rowSpan, 2);
  const cells = [...host.querySelectorAll("td")];
  assert.equal(cells[0].querySelector("annotation").textContent, "0.1741^{**}");
  assert.equal(cells[0].querySelector("br").nextSibling.textContent, "(0.0808)");
  assert.equal(cells[1].firstChild.textContent, "0.0060"); assert.equal(cells[1].lastChild.textContent, "(0.0119)");
  assert.ok(cells[2].querySelector("b + br + span"));
  assert.equal(cells[3].querySelectorAll("br").length, 1);
  assert.equal(host.querySelector("caption").textContent, String.raw`Caption\nLiteral`);
  assert.ok(host.querySelector("p").textContent.includes(String.raw`\n`));
  assert.equal(host.querySelector("img, script, [onerror]"), null);
  assert.ok(helpers.readerText(host).includes("0.0060\n(0.0119)"));
  assert.ok(helpers.readerMarkdown(host).includes("0.0060  <br>(0.0119)"));
});

test("Markdown table line markers preserve escaped literals, code and math command backslashes", t => {
  const { doc, helpers } = fixture(t), host = doc.createElement("article");
  const tick = "`";
  const source = String.raw`Outside \n stays literal.

| Estimate\n(SE) | Protected |
| --- | --- |
| $0.1741^{**}$\n(0.0808) | ${tick}keep\nliteral${tick} |
| first\nsecond | first\\nsecond |
| <code>keep\nliteral</code>\nnext | $\nu + \nabla f$ |
| <b>first</b>\nsecond | $\notacommand$ |`;
  host.append(helpers.renderMarkdown(doc, source, () => {}).fragment);
  const cells = [...host.querySelectorAll("td")];
  assert.equal(host.querySelectorAll("br").length, 5);
  assert.equal(cells[0].querySelector("br").nextSibling.textContent, "(0.0808)");
  assert.equal(cells[1].querySelector("code").textContent, String.raw`keep\nliteral`);
  assert.equal(cells[2].querySelectorAll("br").length, 1);
  assert.equal(cells[3].textContent, String.raw`first\nsecond`); assert.equal(cells[3].querySelector("br"), null);
  assert.equal(cells[4].querySelector("code").textContent, String.raw`keep\nliteral`); assert.equal(cells[4].querySelectorAll("br").length, 1);
  assert.equal(cells[5].querySelector("annotation").textContent, String.raw`\nu + \nabla f`);
  assert.equal(cells[7].querySelector(".km-math-fallback").textContent, String.raw`$\notacommand$`);
  assert.equal(host.querySelector("code br, math br, .km-math br"), null);
  assert.ok(host.querySelector("p").textContent.includes(String.raw`\n`));
});

test("HTML table line markers leave explicit backslashes and code or math source literal", t => {
  const { doc, helpers } = fixture(t), host = doc.createElement("article");
  const source = String.raw`<table><tr><td>first\\nsecond</td><td><code>first\nsecond</code></td>
<td>$\nu + \nabla f$\n(0.0808)</td><td>$\notacommand$\nnext</td></tr></table>`;
  host.append(helpers.renderMarkdown(doc, source, () => {}).fragment);
  assert.equal(host.querySelector("td").textContent, String.raw`first\\nsecond`);
  assert.equal(host.querySelector("code").textContent, String.raw`first\nsecond`);
  assert.equal(host.querySelectorAll("br").length, 2);
  assert.equal(host.querySelector("code br, math br, .km-math br"), null);
  assert.equal(host.querySelector("annotation").textContent, String.raw`\nu + \nabla f`);
  assert.equal(host.querySelector(".km-math-fallback").textContent, String.raw`$\notacommand$`);
});

test("Markdown renders structure and a unique ordered heading index without executing HTML or loading images", t => {
  const { doc, helpers } = fixture(t);
  const opened = [];
  const rendered = helpers.renderMarkdown(doc, `# Same\n## Same\n\n**Bold** and *emphasis*.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n\`\`\`html\n<script>evil()</script>\n\`\`\`\n\n<script>evil()</script>\n\n[Unsafe](javascript:alert(1)) ![Remote](https://example.invalid/image.png) [Safe](https://example.org/paper)`, url => opened.push(url));
  const host = doc.createElement("article"); host.append(rendered.fragment);
  assert.equal(host.querySelectorAll("h1,h2").length, 2);
  assert.equal(rendered.headings[0].title, "Same");
  assert.notEqual(rendered.headings[0].id, rendered.headings[1].id);
  assert.equal(host.querySelector("strong").textContent, "Bold");
  assert.equal(host.querySelectorAll("table tbody td").length, 2);
  assert.match(host.querySelector("pre code").textContent, /<script>/);
  assert.equal(host.querySelectorAll("script,iframe,img,svg,object,embed").length, 0);
  assert.equal(host.querySelectorAll("[onclick],[onerror],[onload]").length, 0);
  assert.equal(host.querySelectorAll("a[href]").length, 1);
  host.querySelector("a[href]").click();
  assert.deepEqual(opened, ["https://example.org/paper"]);
  for (const url of ["javascript:alert(1)", "data:text/html,evil", "file:///private.pdf", "zotero://select/items/4"]) {
    assert.equal(helpers.isSafeExternalURL(url), false);
  }
});

test("imports persist only for the exact attachment and reject invalid or oversized input before writes", async t => {
  const { helpers } = fixture(t);
  const records = new Map();
  const repository = {
    async read(id) { return records.get(`${id.libraryID}-${id.itemKey}`) || null; },
    async save(content) { records.set(`${content.attachment.libraryID}-${content.attachment.itemKey}`, content); },
  };
  const service = new helpers.ContentReadService(repository);
  await service.importMarkdown(identity, "# Actual imported text");
  assert.equal((await service.readAttachment(identity)).markdown, "# Actual imported text");
  assert.equal(await service.readAttachment({ libraryID: 1, itemKey: "WXYZ5678" }), null);
  await assert.rejects(() => service.importMarkdown(identity, " "), /empty/);
  await assert.rejects(() => service.importMarkdown(identity, "中".repeat(helpers.MAX_MARKDOWN_BYTES)), /2 MiB/);
  await assert.rejects(() => service.importMarkdown({ libraryID: 1, itemKey: "../wrong" }, "# Text"), /identity/);
  assert.equal(records.size, 1);
});

test("reader import store uses the plugin directory and refuses cross-attachment or corrupt data", async t => {
  const { helpers, files, path } = fixture(t);
  const store = new helpers.ReaderContentStore();
  await store.save(imported("# Saved content"));
  assert.equal((await store.read(identity)).markdown, "# Saved content");
  files.set(path, JSON.stringify({ ...imported("# Foreign"), attachment: { libraryID: 1, itemKey: "WXYZ5678" } }));
  await assert.rejects(() => store.read(identity), /does not match/);
  files.set(path, "{broken");
  await assert.rejects(() => store.read(identity), /JSON/);
  assert.equal(files.has("/isolated/zotero.sqlite"), false);
});

test("concurrent imports serialize writes and a failed write does not block the next import", async t => {
  const { helpers, sandbox } = fixture(t);
  let release;
  const written = [];
  sandbox.IOUtils.writeUTF8 = async (_path, value) => {
    const markdown = JSON.parse(value).markdown;
    written.push(markdown);
    if (markdown === "# First") await new Promise(resolve => { release = resolve; });
    if (markdown === "# Fail") throw new Error("Disk unavailable");
  };
  const store = new helpers.ReaderContentStore();
  const first = store.save(imported("# First"));
  const second = store.save(imported("# Second"));
  await settle();
  assert.deepEqual(written, ["# First"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(written, ["# First", "# Second"]);
  const failed = store.save(imported("# Fail"));
  const recovery = store.save(imported("# Recovery"));
  await assert.rejects(failed, /Disk unavailable/);
  await recovery;
  assert.equal(written.at(-1), "# Recovery");
});

for (const failQueued of [false, true]) {
  test(`store close drains accepted writes across attachments, including ${failQueued ? "failure" : "success"}`, async t => {
    const { helpers, sandbox } = fixture(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const written = [];
    sandbox.IOUtils.writeUTF8 = async (_path, value) => {
      const markdown = JSON.parse(value).markdown;
      if (markdown !== "# Queued") await gate;
      if (failQueued && markdown === "# Queued") throw new Error("Disk unavailable");
      written.push(markdown);
    };
    const store = new helpers.ReaderContentStore();
    const saves = Promise.allSettled([
      store.save(imported("# First")), store.save(imported("# Queued")),
      store.save({ ...imported("# Other"), attachment: { libraryID: 1, itemKey: "WXYZ5678" } }),
    ]);
    let closed = false;
    const closing = store.close();
    assert.equal(store.close(), closing);
    void closing.then(() => { closed = true; });
    try {
      await settle();
      assert.equal(closed, false);
      await assert.rejects(store.save(imported("# Rejected")), /closing/);
    } finally { release(); }
    const results = await saves;
    await closing;
    assert.equal(closed, true);
    assert.deepEqual(results.map(result => result.status), ["fulfilled", failQueued ? "rejected" : "fulfilled", "fulfilled"]);
    assert.ok(written.includes("# First") && written.includes("# Other"));
    assert.equal(written.includes("# Rejected"), false);
    await assert.rejects(store.save(imported("# Still closed")), /closing/);
  });
}

test("application shutdown drains accepted cache writes before the next application saves newer content", async t => {
  const { helpers, sandbox, files, path, listeners } = fixture(t);
  const context = { id: "test", version: "test", rootURI: "file:///test/" };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered = false;
  const write = sandbox.IOUtils.writeUTF8;
  sandbox.IOUtils.writeUTF8 = async (...args) => {
    if (JSON.parse(args[1]).markdown === "# Old") { entered = true; await gate; }
    return write(...args);
  };
  const application = new helpers.PluginApplication(context);
  await application.start();
  const saving = application.services.content.importMarkdown(identity, "# Old");
  await settle();
  let stopped = false;
  let restarted = false;
  const next = new helpers.PluginApplication(context);
  const stopping = application.dispose().then(() => { stopped = true; });
  const restarting = stopping.then(() => next.start()).then(() => { restarted = true; });
  try {
    await settle();
    assert.equal(entered, true);
    assert.equal(stopped, false);
    assert.equal(restarted, false);
    assert.equal(listeners.size, 0);
  } finally { release(); }
  await Promise.all([saving, stopping, restarting]);
  await next.services.content.importMarkdown(identity, "# New");
  await next.dispose();
  assert.equal(JSON.parse(files.get(path)).markdown, "# New");
  assert.equal(listeners.size, 0);
});

test("toolbar injection is idempotent; saved content, contents, resize and shutdown preserve native PDF nodes", async t => {
  const { doc, dom, api, listeners, reader, files, path } = fixture(t);
  const nativePDF = doc.getElementById("split-view");
  const context = { id: "test-plugin", version: "test", rootURI: "file:///test/" };
  await api.startup(context);
  api.onMainWindowLoad(dom.window);
  for (const handler of listeners) handler({ reader, doc, params: {}, append() {} });
  assert.equal(listeners.size, 1);
  assert.equal(doc.querySelectorAll("#knowledgemcp-markdown-toggle").length, 1);
  const toggle = doc.getElementById("knowledgemcp-markdown-toggle");
  assert.equal(toggle.previousElementSibling.id, "sidebarToggle");
  toggle.click(); await settle();
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(doc.getElementById("knowledgemcp-markdown-panel").hidden, false);
  assert.match(doc.querySelector(".km-markdown-content").textContent, /No parsed text/);

  assert.equal(doc.querySelector(".km-reader-actions, input[type=file]"), null);
  files.set(path, JSON.stringify(imported("# Paper\n\n## Methods\n\nSaved content.\n\n### Design\n\nDetails.\n\n## Results\n\nFindings.")));
  toggle.click(); toggle.click(); await settle();
  assert.equal(JSON.parse(files.get(path)).attachment.itemKey, "ABCD1234");
  const contents = [...doc.querySelectorAll(".km-contents nav button")];
  assert.deepEqual(contents.map(button => button.textContent), ["Methods", "Design", "Results"]);
  assert.deepEqual(contents.map(button => button.style.paddingInlineStart), ["8px", "20px", "8px"]);
  assert.equal(doc.querySelector(".km-markdown-content h1").textContent, "Paper");
  let scrolled = false;
  doc.querySelector(".km-markdown-content h2").scrollIntoView = () => { scrolled = true; };
  contents[0].click();
  assert.equal(scrolled, true);
  doc.querySelector("[role=separator]").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight" }));
  assert.equal(doc.body.style.getPropertyValue("--km-markdown-ratio"), "0.55");
  toggle.click();
  assert.equal(doc.body.classList.contains("knowledgemcp-markdown-open"), false);
  await api.shutdown();
  assert.equal(listeners.size, 0);
  assert.equal(doc.getElementById("knowledgemcp-markdown-panel"), null);
  assert.equal(doc.querySelector("style[data-knowledgemcp]"), null);
  assert.equal(doc.getElementById("split-view"), nativePDF);
  await api.startup(context);
  assert.equal(doc.querySelectorAll("#knowledgemcp-markdown-toggle").length, 1);
  api.onMainWindowUnload(dom.window);
  assert.equal(doc.getElementById("knowledgemcp-markdown-toggle"), null);
});

test("contents omit only the first heading for parsed and imported content, including title-only reloads", async t => {
  for (const origin of ["parse", "import"]) {
    const { doc, helpers, reader } = fixture(t);
    const pieces = ["# Paper", "### Methods", "#### Design", "### Results", "# Appendix"];
    let content = { ...imported(pieces.join("\n\n")), origin,
      blocks: pieces.map((markdown, index) => ({ id: `heading-${index}`, type: "heading", label: index ? "paragraph_title" : "doc_title", markdown })) };
    const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return content; } }, () => {});
    t.after(() => view.dispose());
    view.toggle(true); await settle();
    const buttons = [...doc.querySelectorAll(".km-contents nav button")];
    assert.deepEqual(buttons.map(button => button.textContent), ["Methods", "Design", "Results", "Appendix"]);
    assert.deepEqual(buttons.map(button => button.style.paddingInlineStart), ["32px", "44px", "32px", "8px"]);
    assert.equal(doc.querySelectorAll(".km-markdown-content h1").length, 2, "body headings remain intact");
    let scrolled;
    const target = doc.querySelector(".km-markdown-content h4"); target.scrollIntoView = () => { scrolled = target.id; };
    buttons[1].click(); assert.equal(scrolled, target.id, "navigation retains the original unique anchor");
    content = { ...imported("# Paper"), origin };
    view.toggle(false); view.toggle(true); await settle();
    assert.equal(doc.querySelectorAll(".km-contents nav button").length, 0);
    assert.equal(doc.querySelector(".km-contents nav").textContent, "No headings");
    assert.equal(doc.querySelector(".km-markdown-content h1").textContent, "Paper");
  }
});

test("parsed contents exclude translated document titles while retaining genuine level-one sections", async t => {
  const { doc, helpers, reader } = fixture(t);
  const entries = [
    ["doc_title", "# 主文标题"],
    ["paragraph_title", "## 一、引言"],
    ["paragraph_title", "### （一）研究背景"],
    ["paragraph_title", "# Appendix"],
    ["doc_title", "# English Paper Title"],
    ["doc_title", "# English Paper Title Continued"],
    ["paragraph_title", "## Abstract"],
  ];
  let content = { ...imported(entries.map(([, markdown]) => markdown).join("\n\n")), origin: "parse",
    blocks: entries.map(([label, markdown], index) => ({ id: `block-${index}`, type: "heading", label, markdown })) };
  const view = new helpers.MarkdownReaderView(reader, doc, { async readAttachment() { return content; } }, () => {});
  t.after(() => view.dispose());
  view.toggle(true); await settle();
  const buttons = [...doc.querySelectorAll(".km-contents nav button")];
  assert.deepEqual(buttons.map(button => button.textContent), ["一、引言", "（一）研究背景", "Appendix", "Abstract"]);
  assert.deepEqual(buttons.map(button => button.style.paddingInlineStart), ["20px", "32px", "8px", "20px"]);
  assert.equal(doc.querySelectorAll(".km-markdown-content h1").length, 4, "all document titles and the real section remain in the body");
  const original = content.markdown;
  let target;
  const abstract = doc.querySelectorAll(".km-markdown-content h2")[1]; abstract.scrollIntoView = () => { target = abstract.id; };
  buttons[3].click(); assert.equal(target, abstract.id);
  assert.equal(content.markdown, original);
  content = { ...content, markdown: "# 主文标题\n\n# English Paper Title", blocks: [content.blocks[0], content.blocks[4]] };
  view.toggle(false); view.toggle(true); await settle();
  assert.equal(doc.querySelectorAll(".km-contents nav button").length, 0, "a bilingual-title-only document has no sections");
});

test("citation previews are scoped to the current article and removed on close, reload and shutdown", async t => {
  const { doc, dom, api, files, path } = fixture(t, { content: imported("A result [1].\n\n## References\n\n[1] Smith, A. (2020). A complete title.") });
  const context = { id: "test-plugin", version: "test", rootURI: "file:///test/" };
  await api.startup(context);
  const toggle = doc.getElementById("knowledgemcp-markdown-toggle"); toggle.click(); await settle();
  let trigger = doc.querySelector(".km-citation"); assert.ok(trigger); trigger.focus();
  let popup = doc.querySelector(".km-citation-preview"); assert.ok(popup && !popup.hidden); assert.ok(popup.textContent.includes("A complete title."));
  toggle.click(); assert.equal(doc.querySelector(".km-citation-preview"), null);
  trigger.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true })); assert.equal(doc.querySelector(".km-citation-preview"), null);
  files.set(path, JSON.stringify(imported("A different [1].\n\n## References\n\n[1] Jones, B. (2021). A replacement title.")));
  toggle.click(); await settle(); trigger = doc.querySelector(".km-citation"); trigger.focus();
  popup = doc.querySelector(".km-citation-preview"); assert.equal(doc.querySelectorAll(".km-citation-preview").length, 1);
  assert.ok(popup.textContent.includes("A replacement title.")); assert.ok(!popup.textContent.includes("A complete title."));
  await api.shutdown(); assert.equal(doc.querySelector(".km-citation-preview"), null);
  trigger.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true })); assert.equal(doc.querySelector(".km-citation-preview"), null);
});

test("late content and late reader initialization cannot recreate disposed UI", async t => {
  const loaded = fixture(t, { content: imported("# Pending content") });
  let resolveRead;
  loaded.sandbox.IOUtils.readUTF8 = () => new Promise(resolve => { resolveRead = resolve; });
  await loaded.api.startup({ id: "test", version: "test", rootURI: "file:///test/" });
  loaded.doc.getElementById("knowledgemcp-markdown-toggle").click(); await settle();
  await loaded.api.shutdown();
  resolveRead(JSON.stringify(imported("# Late content"))); await settle();
  assert.equal(loaded.doc.querySelector(".km-markdown-panel"), null);

  const pending = fixture(t, { ready: false });
  await pending.api.startup({ id: "test", version: "test", rootURI: "file:///test/" });
  await pending.api.shutdown();
  pending.reader._iframeWindow = pending.dom.window;
  pending.resolveReady(); await settle();
  assert.equal(pending.doc.getElementById("knowledgemcp-markdown-toggle"), null);
});

test("late native PDF citation results cannot recreate a closed or replaced Markdown view", async t => {
  const content = { ...imported("A result [1].\n\n## References\n\n[1] Smith, A. (2020). A reference."), origin: "parse" };
  const { doc, helpers, reader } = fixture(t);
  let release, nativeReads = 0;
  reader._internalReader = { _primaryView: { _iframeWindow: { PDFViewerApplication: { pdfDocument: {
    getProcessedData() { nativeReads++; return new Promise(resolve => { release = resolve; }); },
  } } } } };
  let current = content;
  const view = new helpers.MarkdownReaderView(reader, doc, { readAttachment: async () => current }, () => {}); t.after(() => view.dispose());
  view.toggle(true); await settle(); assert.equal(nativeReads, 1); view.toggle(false);
  current = imported("Replacement content with no bibliography."); view.toggle(true); await settle();
  release({ pages: {} }); await settle();
  assert.equal(doc.querySelector(".km-markdown-content").textContent, "Replacement content with no bibliography.");
  assert.equal(doc.querySelector(".km-citation-preview"), null); view.dispose();
});

test("non-PDF readers receive no Markdown toolbar button", async t => {
  const { reader, api, doc } = fixture(t);
  reader._type = "epub";
  await api.startup({ id: "test", version: "test", rootURI: "file:///test/" });
  assert.equal(doc.getElementById("knowledgemcp-markdown-toggle"), null);
});
