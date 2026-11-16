import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createContext, runInContext } from "node:vm";

const built = await build({ entryPoints: ["src/ui/reader-outline.ts"], bundle: true,
  format: "cjs", platform: "browser", write: false });
const module = { exports: {} };
runInContext(built.outputFiles[0].text, createContext({ module, exports: module.exports }));
const { ReaderOutline } = module.exports;

function fixture(t, levels = [2, 3, 4, 2]) {
  const dom = new JSDOM("<aside><nav></nav></aside><div id='toolbar'></div><article></article>");
  const { document: doc } = dom.window, article = doc.querySelector("article"), directory = doc.querySelector("aside"), toolbar = doc.getElementById("toolbar");
  const frames = new Map(), observers = []; let serial = 0, reads = 0;
  dom.window.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
  dom.window.cancelAnimationFrame = id => frames.delete(id);
  class Observer {
    constructor(callback) { this.callback = callback; this.observed = []; observers.push(this); }
    observe(node) { this.observed.push(node); }
    disconnect() { this.disconnected = true; }
  }
  dom.window.IntersectionObserver = dom.window.ResizeObserver = Observer;
  article.getBoundingClientRect = () => ({ top: 100, height: 500 });
  Object.defineProperties(article, { clientHeight: { value: 500 }, scrollHeight: { value: 2000, configurable: true } });
  directory.getBoundingClientRect = () => ({ top: 100, bottom: 250 });
  directory.getClientRects = () => directory.hidden ? [] : [{}];
  toolbar.getBoundingClientRect = () => ({ bottom: 150 });
  const targets = levels.map((level, index) => {
    const heading = doc.createElement(`h${level}`), button = doc.createElement("button");
    heading.textContent = button.textContent = `Section ${index}`;
    heading.getBoundingClientRect = () => { reads++; return { top: 200 + index * 300 - article.scrollTop }; };
    button.getBoundingClientRect = () => ({ top: 100 + index * 60 - directory.scrollTop, bottom: 130 + index * 60 - directory.scrollTop });
    article.append(heading); directory.querySelector("nav").append(button);
    return { heading, button, level };
  });
  const outline = new ReaderOutline(article, directory, toolbar, targets);
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); };
  const scroll = top => { article.scrollTop = top; article.dispatchEvent(new dom.window.Event("scroll")); flush(); };
  t.after(() => { outline.dispose(); dom.window.close(); });
  return { dom, doc, article, directory, toolbar, targets, outline, flush, scroll, frames, observers, reads: () => reads };
}

test("outline tracks nested ancestry, large forward/reverse jumps, top and short final sections", t => {
  const f = fixture(t), current = () => f.doc.querySelector('[aria-current="location"]');
  f.flush(); assert.equal(current(), null, "the title area precedes directory sections");
  f.scroll(160); assert.equal(current(), f.targets[0].button);
  f.scroll(750); assert.equal(current(), f.targets[2].button);
  assert.deepEqual([...f.doc.querySelectorAll(".km-contents-ancestor")], f.targets.slice(0, 2).map(x => x.button));
  f.scroll(1100); assert.equal(current(), f.targets[3].button);
  assert.equal(f.doc.querySelectorAll(".km-contents-ancestor").length, 0);
  f.scroll(160); assert.equal(current(), f.targets[0].button);
  f.scroll(0); assert.equal(current(), null);
  f.targets[3].heading.getBoundingClientRect = () => ({ top: 2050 - f.article.scrollTop });
  f.scroll(1500); assert.equal(current(), f.targets[3].button, "last section can be current without reaching the top");
});

test("outline depth uses structural nesting and maps a hidden subsection to its nearest shown ancestor", t => {
  const f = fixture(t, [2, 4, 6, 2]);
  assert.equal(f.outline.maxDepth, 3, "skipped Markdown levels do not create empty hierarchy levels");
  f.scroll(750); assert.equal(f.doc.querySelector('[aria-current]'), f.targets[2].button);
  f.outline.setDepth(1); f.flush();
  assert.deepEqual(f.targets.map(t => t.button.hidden), [false, true, true, false]);
  assert.equal(f.doc.querySelector('[aria-current]'), f.targets[0].button);
  f.outline.setDepth(2); f.flush();
  assert.equal(f.doc.querySelector('[aria-current]'), f.targets[1].button);
  f.outline.setDepth(0); f.flush();
  assert.ok(f.targets.every(t => !t.button.hidden));
  assert.equal(f.doc.querySelector('[aria-current]'), f.targets[2].button);
  assert.equal(f.article.scrollTop, 750, "changing directory depth does not scroll the document");
});

test("outline coalesces scrolling, respects the floating menu and reveals only changed/offscreen items", t => {
  const f = fixture(t, Array(300).fill(2));
  Object.defineProperty(f.article, "scrollHeight", { value: 100000 });
  f.flush(); const before = f.reads();
  f.article.scrollTop = 450;
  for (let i = 0; i < 100; i++) f.article.dispatchEvent(new f.dom.window.Event("scroll"));
  assert.equal(f.frames.size, 1); f.flush();
  assert.ok(f.reads() - before <= 9, "binary lookup reads only a logarithmic number of headings");
  assert.equal(f.doc.querySelector('[aria-current="location"]'), f.targets[1].button, "heading under menu is already current");
  f.scroll(1100); const directoryTop = f.directory.scrollTop;
  assert.ok(directoryTop > 0); assert.equal(f.article.scrollTop, 1100, "revealing the directory never moves the document");
  f.directory.scrollTop = 0; f.scroll(1101);
  assert.equal(f.directory.scrollTop, 0, "unchanged section does not fight manual directory scrolling");
  f.outline.refresh(true); f.flush(); assert.equal(f.directory.scrollTop, directoryTop);
});

test("outline handles collapsed notes, hidden directory and layout observation; disposal cancels pending work", t => {
  const f = fixture(t), note = f.doc.createElement("details");
  f.targets[1].heading.before(note); note.append(f.targets[1].heading);
  f.article.dispatchEvent(new f.dom.window.Event("toggle")); f.scroll(450);
  assert.equal(f.doc.querySelector('[aria-current="location"]'), f.targets[0].button);
  note.open = true; note.dispatchEvent(new f.dom.window.Event("toggle")); f.flush();
  assert.equal(f.doc.querySelector('[aria-current="location"]'), f.targets[1].button);
  f.directory.hidden = true; f.scroll(1100); assert.equal(f.directory.scrollTop, 0);
  f.directory.hidden = false; f.outline.refresh(true); f.flush(); assert.ok(f.directory.scrollTop > 0);
  f.targets[2].heading.getBoundingClientRect = () => ({ top: 110 });
  f.targets[3].heading.getBoundingClientRect = () => ({ top: 600 });
  for (const observer of f.observers) observer.callback([]); f.flush();
  assert.equal(f.doc.querySelector('[aria-current="location"]'), f.targets[2].button);
  f.outline.refresh(); assert.equal(f.frames.size, 1); f.outline.dispose(); f.outline.dispose();
  assert.equal(f.frames.size, 0); assert.ok(f.observers.every(observer => observer.disconnected));
  assert.equal(f.doc.querySelector('[aria-current], .km-contents-ancestor'), null);
  f.article.dispatchEvent(new f.dom.window.Event("scroll"));
  for (const observer of f.observers) observer.callback([]);
  assert.equal(f.frames.size, 0);
});
