import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mockLocalization } from "./helpers/localization.mjs";

const compiled = await build({ entryPoints: ["src/ui/knowledge/task-details-pane.ts"], bundle: true,
  format: "cjs", platform: "browser", write: false });

function fixture(t, failWidget = false) {
  const dom = new JSDOM('<html><body><div id="zotero-item-pane" view-type="item"><div id="zotero-item-pane-content"><div id="original"></div></div><div id="zotero-view-item-sidenav"></div></div></body></html>');
  const win = dom.window, doc = win.document, preferences = new Map(); t.after(() => win.close());
  const deck = doc.getElementById("zotero-item-pane-content"), original = doc.getElementById("original"), nav = doc.getElementById("zotero-view-item-sidenav");
  deck.selectedPanel = original;
  class ContainerBase extends win.HTMLElement {
    connectedCallback() { this.init?.(); }
    disconnectedCallback() { this.replaceChildren(); this.destroy?.(); }
    get sidenav() { return this.nav; }
    set sidenav(value) { this.nav = value; value.container = this; value.render(); }
    getPanes() { return [...this._paneParent.children]; }
    getEnabledPane(id) { return this.getPanes().find(pane => pane.dataset.pane === id && !pane.hidden); }
    async scrollToPane(id) { this.scrolledTo = id; }
  }
  class ItemDetails extends ContainerBase {
    initPaneOrder(order) { for (const id of [...order].reverse()) { const pane = this.getEnabledPane(id); if (pane) this._paneParent.prepend(pane); } }
    async changePaneOrder(id, index) { const panes = this.getPanes(), pane = this.getEnabledPane(id); this._paneParent.insertBefore(pane, panes[index] ?? null); this.render(); }
  }
  win.customElements.define("item-details", ItemDetails);
  doc.createXULElement = name => { if (failWidget && name === "collapsible-section") throw Error("Native widget failed"); return doc.createElement(name); };
  const originalContainer = { getPanes: () => [] }; nav.container = originalContainer;
  nav.render = () => {
    if (nav.container.initPaneOrder) nav.container.initPaneOrder(preferences.get("sidenav.order") ?? []);
    for (const pane of nav.container.getPanes()) if (!nav.querySelector(`[data-pane="${pane.dataset.pane}"]`)) {
      const button = doc.createElement("button"); button.dataset.pane = pane.dataset.pane; nav.append(button);
    }
  };
  nav.toggleDefaultStatus = value => { nav.defaultStatus = value; };
  nav.removePane = id => nav.querySelector(`[data-pane="${id}"]`)?.remove();
  const module = { exports: {} };
  runInContext(compiled.outputFiles[0].text, createContext({ module, exports: module.exports, Localization: mockLocalization(),
    Zotero: { Prefs: { get: key => preferences.get(key), set: (key, value) => preferences.set(key, value) } } }));
  return { win, doc, deck, nav, original, originalContainer, preferences, create: () => new module.exports.TaskDetailsPane(win) };
}

test("task sections share the native deck and sidenav, retain widget state and restore their owners", t => {
  const f = fixture(t), pane = f.create(); t.after(() => pane.dispose());
  pane.show(true); const container = f.deck.selectedPanel;
  assert.equal(pane.native, true); assert.equal(f.nav.container, container);
  assert.equal(pane.content.querySelectorAll("collapsible-section").length, 3);
  assert.equal(pane.content.querySelector('[data-pane="knowledgemcp-task-progress"] collapsible-section').hasAttribute("no-collapse"), false);
  assert.equal(pane.header.parentElement, pane.content.parentElement);
  assert.equal(pane.content.contains(pane.header), false);
  pane.setTitle("Selected task"); assert.equal(pane.header.textContent, "Selected task");
  const info = pane.body("info"); info.textContent = "Old snapshot";
  const section = info.closest("collapsible-section"); section.removeAttribute("open"); pane.reset();
  assert.equal(pane.body("info"), info); assert.equal(section.hasAttribute("open"), false); assert.equal(info.textContent, "");
  // Native collection selection can select a different deck panel before the
  // task view's final synchronization. Keep tasks active without losing owners.
  f.deck.selectedPanel = f.original; f.nav.container = f.originalContainer; pane.show(true);
  assert.equal(f.deck.selectedPanel, container); assert.equal(f.nav.container, container);
  pane.show(false); assert.equal(f.deck.selectedPanel, f.original); assert.equal(f.nav.container, f.originalContainer);
  pane.dispose(); assert.equal(f.doc.querySelector("knowledgemcp-task-pane"), null); assert.equal(f.nav.children.length, 0);
});

test("native reorder does not reapply stale preferences before the native command persists them", async t => {
  const f = fixture(t), pane = f.create(); t.after(() => pane.dispose()); pane.show(true);
  const oldOrder = [...pane.content.children].map(node => node.dataset.pane);
  f.preferences.set("sidenav.order", oldOrder);
  f.nav.prepend(f.nav.lastElementChild);
  await f.deck.selectedPanel.changePaneOrder(oldOrder[2], 0);
  assert.equal(pane.content.firstElementChild.dataset.pane, oldOrder[2]);
  const newOrder = [...pane.content.children].map(node => node.dataset.pane);
  f.preferences.set("sidenav.order", newOrder); pane.refresh();
  assert.deepEqual([...pane.content.children].map(node => node.dataset.pane), newOrder);
  f.deck.selectedPanel.pinnedPane = oldOrder[2];
  assert.equal(f.deck.selectedPanel.scrolledTo, oldOrder[2]);
});

test("partial native construction removes its deck child without replacing the native selection", t => {
  const f = fixture(t, true);
  assert.throws(() => f.create(), /Native widget failed/);
  assert.equal(f.doc.querySelector("knowledgemcp-task-pane"), null);
  assert.equal(f.deck.selectedPanel, f.original); assert.equal(f.nav.container, f.originalContainer);
});
