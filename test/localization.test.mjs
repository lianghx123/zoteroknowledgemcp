import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import { build } from "esbuild";
import { parse } from "@fluent/syntax";
import { FluentBundle, FluentResource } from "@fluent/bundle";
import { JSDOM } from "jsdom";
import { mockLocalization } from "./helpers/localization.mjs";

const localeRoot = "addon/locale";
const locales = readdirSync(localeRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
const source = locale => readFileSync(`${localeRoot}/${locale}/knowledgemcp.ftl`, "utf8");
const args = { percent: 60, time: 1793232000000, days: 180, stage: "Restoring semantic index", threshold: 0.5, state: "Saved", field: "Candidates", min: 1, max: 500, minimum: 20, mode: "Semantic", channels: "Vectors", reason: "Network", type: "Cosine", score: "0.9", skipped: 2, page: 3, name: '<img src=x onerror="alert(1)"> { $name }', warning: "Example warning", title: "Example title", alt: "Example image", id: 1, error: "Example error", added: 2, removed: 1, failed: 1, completed: 12, total: 20, count: 2, target: "Fixture Knowledge Base › Folder", status: 400 };

function variables(node, names = new Set()) {
  if (!node || typeof node !== "object") return names;
  if (node.type === "VariableReference") names.add(node.id.name);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => variables(child, names));
    else if (value && typeof value === "object") variables(value, names);
  }
  return names;
}

function contract(locale) {
  const ast = parse(source(locale));
  assert.deepEqual(ast.body.filter(node => node.type === "Junk"), [], `${locale}: valid Fluent`);
  const entries = ast.body.filter(node => node.type === "Message");
  for (const entry of entries) assert.ok(entry.id.name.startsWith("knowledgemcp-"), `${locale}: message IDs must use the runtime prefix`);
  assert.equal(new Set(entries.map(entry => entry.id.name)).size, entries.length, `${locale}: unique IDs`);
  return Object.fromEntries(entries.map(entry => [entry.id.name, {
    value: entry.value !== null,
    attributes: entry.attributes.map(attribute => attribute.id.name).sort(),
    variables: [...variables(entry)].sort(),
  }]));
}

test("all discovered locales have complete Fluent messages, attributes, variables and packaged assets", () => {
  for (const locale of ["en-US", "zh-CN", "de", "fr-FR", "es-ES", "ja-JP", "zh-TW"]) assert.ok(locales.includes(locale));
  const baseline = contract("en-US");
  for (const locale of locales) {
    assert.deepEqual(contract(locale), baseline, locale);
    assert.equal(readFileSync(`.scaffold/build/addon/locale/${locale}/knowledgemcp.ftl`, "utf8"), source(locale));
    const bundle = new FluentBundle(locale, { useIsolating: false });
    assert.deepEqual(bundle.addResource(new FluentResource(source(locale))), []);
    for (const id of Object.keys(baseline)) {
      const message = bundle.getMessage(id);
      for (const pattern of [message.value, ...Object.values(message.attributes)].filter(Boolean)) {
        const errors = [];
        assert.ok(bundle.formatPattern(pattern, { ...args, depth: 2, number: 1, citation: "[1]" }, errors).trim(), `${locale}: ${id} is not empty`);
        assert.deepEqual(errors, [], `${locale}: ${id} formats without errors`);
      }
    }
  }
});

test("literal translation calls and native l10n IDs resolve in the English contract", () => {
  const baseline = contract("en-US");
  function check(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) { check(path); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const contents = readFileSync(path, "utf8");
      for (const match of contents.matchAll(/\bt\("([\w-]+)"/g)) {
        const message = baseline[`knowledgemcp-${match[1]}`];
        assert.ok(message?.value || message?.attributes.includes("label"), `${path}: ${match[1]}`);
      }
      for (const match of contents.matchAll(/l10nID: "(knowledgemcp-[\w-]+)"/g)) {
        const message = baseline[match[1]];
        assert.ok(message, `${path}: ${match[1]}`);
        assert.equal(message.value, false, `${path}: ${match[1]} must preserve native icon and submenu children`);
        assert.ok(message.attributes.length, `${path}: ${match[1]} translates native attributes`);
      }
    }
  }
  check("src");
});

const compiled = await build({ stdin: { contents: `
export * from "./src/shared/localization.ts";
export * from "./src/shared/knowledge-errors.ts";
export * from "./src/schemas/knowledge-content.ts";
export * from "./src/ui/knowledge/details.ts";
export * from "./src/ui/knowledge/trash-list.ts";
export * from "./src/ui/rendering/markdown.ts";
export * from "./src/ui/views/content-reader.ts";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, format: "cjs", platform: "browser", target: "firefox140", write: false, loader: { ".css": "text" } });
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const [locale, status] of [
  ["en-US", "Not added"], ["zh-CN", "未添加"], ["de", "Nicht hinzugefügt"],
  ["fr-FR", "Non ajouté"], ["es-ES", "Sin añadir"], ["ja-JP", "未追加"], ["zh-TW", "未新增"],
]) {
  test(`${locale}: knowledge details, confirmation, errors and reader UI use Fluent`, async t => {
    const dom = new JSDOM("<!doctype html><html><head></head><body><button id='sidebarToggle'></button><div id='split-view'></div></body></html>");
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    let confirmation;
    const module = { exports: {} };
    const sandbox = createContext({ module, exports: module.exports, TextEncoder,
      Localization: mockLocalization(locale),
      Zotero: { Items: { get: () => ({ libraryID: 1, key: "ABCD1234", attachmentReaderType: "pdf" }) } },
      Services: { prompt: { BUTTON_POS_0: 1, BUTTON_POS_1: 2, BUTTON_TITLE_IS_STRING: 4, BUTTON_TITLE_CANCEL: 8, BUTTON_POS_1_DEFAULT: 16,
        confirmEx(...args) { confirmation = args; return 1; } } },
    });
    runInContext(compiled.outputFiles[0].text, sandbox);
    const api = module.exports;
    const formatter = new (mockLocalization(locale))(["knowledgemcp.ftl"], true);
    const [menuMessage] = formatter.formatMessagesSync([{ id: "knowledgemcp-add-default" }]);
    assert.equal(menuMessage.value, null);
    assert.equal(api.t("add-default"), menuMessage.attributes.find(attribute => attribute.name === "label").value);
    const snapshot = { libraries: [], folders: [], memberships: [], resources: [], sources: [], itemResources: new Map(), warnings: new Map() };
    assert.equal(api.renderKnowledgeDetails(doc, snapshot, { id: 1 }).content.querySelector("dd").textContent, status);
    const resource = { id: "paper", itemID: 1, state: "deleted", version: 1, modifiedAt: 1 };
    snapshot.resources.push(resource);
    snapshot.sources.push({ resourceID: "paper", title: args.name, mediaType: null, availability: "missing" });
    const details = api.renderKnowledgeDetails(doc, snapshot, { id: 1 }).content;
    assert.ok(details.textContent.includes(api.t("deleted")));
    assert.ok(details.textContent.includes(api.t("missing")));
    assert.equal(details.querySelector("img"), null);
    assert.ok(details.textContent.includes(args.name));
    assert.ok(api.t("duplicate-folder", { name: args.name }).includes(args.name));
    assert.ok(api.t("delete-library-message", { name: "Example" }).includes("\n\n"));
    assert.equal(api.knowledgeErrorMessage(new Error("SQL SECRET")), api.t("error-operation"));
    const rendered = api.renderMarkdown(doc, "![Example](https://example.invalid/image.png)", () => {});
    assert.equal(rendered.fragment.querySelector(".km-image-placeholder").textContent, api.t("reader-image-placeholder", { alt: "Example" }));
    assert.equal(rendered.fragment.querySelector("img"), null);
    const annotated = api.renderMarkdown(doc, "> A note.\n\n| A |\n| --- |\n| 1 |", () => {}).fragment;
    assert.equal(annotated.querySelector(".km-reader-note summary").textContent, api.t("reader-note"));
    assert.equal(annotated.querySelector(".km-table-scroll").getAttribute("aria-label"), api.t("reader-table", { number: 1 }));
    let purged = false;
    await api.confirmTrashPurge(dom.window, { snapshot: { trash: [{ id: "entry" }] }, async purgeTrash() { purged = true; } }, ["entry"]);
    assert.equal(confirmation[1], api.t("purge-title"));
    assert.equal(confirmation[2], api.t("purge-message"));
    assert.equal(purged, false);

    let failRead = false;
    const service = { async readAttachment() { if (failRead) api.validateMarkdown(" "); return null; } };
    const view = new api.MarkdownReaderView({ itemID: 1 }, doc, service, () => {});
    t.after(() => view.dispose());
    assert.equal(doc.querySelector(".km-reader-actions, input[type=file]"), null);
    assert.equal(doc.querySelector(".km-reader-copy-actions"), null);
    assert.equal(doc.querySelector('[data-sync-target="pdf"]').getAttribute("aria-label"), api.t("reader-sync-pdf"));
    assert.equal(doc.querySelector('[data-sync-target="markdown"]').getAttribute("aria-label"), api.t("reader-sync-markdown"));
    assert.equal(doc.querySelector(".km-reader-sync").title, api.t("reader-sync-no-source"));
    assert.equal(doc.querySelector(".km-contents-heading").textContent, api.t("reader-contents"));
    view.toggle(); await settle();
    assert.equal(doc.querySelector(".km-markdown-content h2").textContent, api.t("reader-empty-title"));
    failRead = true; view.toggle(false); view.toggle(true); await settle();
    assert.equal(doc.querySelector(".km-reader-status").textContent, api.t("unavailable"));
    assert.equal(doc.querySelector(".km-markdown-content h2").textContent, api.t("reader-load-failed"));
    assert.ok(doc.querySelector(".km-markdown-content").textContent.includes(api.t("error-markdown-empty")));
    view.dispose(); view.dispose();
    assert.equal(doc.querySelector(".km-markdown-panel"), null);
    assert.equal(doc.querySelector("style[data-knowledgemcp]"), null);
  });
}
