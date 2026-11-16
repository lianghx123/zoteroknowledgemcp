import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { api as parser, parsingFixture, bytes, result } from "./fixtures/parsing.mjs";
import { mineruFiles } from "./fixtures/mineru.mjs";
import { mockLocalization } from "./helpers/localization.mjs";

const compiled = await build({ stdin: { contents: `export * from "./src/services/visual-association.ts";
export * from "./src/repositories/visual-content.ts"; export * from "./src/ui/rendering/structured-content.ts";
export * from "./src/security/mcp-tokens.ts"; export * from "./src/security/mcp-cursor.ts"; export * from "./src/security/mcp-crypto.ts";
export * from "./src/mcp/tools/service.ts"; export * from "./src/mcp/tools/registry.ts";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "browser", format: "esm", target: "firefox140", write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const location = (bbox, page = 1) => ({ page, bbox });
const block = (id, type, box, label = type, page = 1) => ({ id, type, label, page, pageEnd: page, locations: box ? [location(box, page)] : [] });
const layout = [block("heading", "heading", [50, 10, 500, 50]), block("above", "caption", [50, 100, 500, 125], "figure_title"),
  block("visual", "image", [50, 140, 500, 400]), block("below", "caption", [50, 410, 500, 435], "figure_title"),
  block("note", "footnote", [50, 445, 500, 470], "vision_footnote"), block("body", "paragraph", [50, 480, 500, 600])];

test("visual relationships use explicit labels, top/bottom layout and preserve all inputs", () => {
  const snapshot = JSON.stringify(layout), links = api.associateVisualBlocks(layout);
  assert.equal(JSON.stringify(layout), snapshot);
  assert.deepEqual(links, [
    { visualBlockId: "visual", relatedBlockId: "above", role: "caption", position: "before", evidence: "layout" },
    { visualBlockId: "visual", relatedBlockId: "below", role: "caption", position: "after", evidence: "layout" },
    { visualBlockId: "visual", relatedBlockId: "note", role: "note", position: "after", evidence: "layout" },
  ]);
  const table = layout.map(b => b.id === "visual" ? { ...b, type: "table" } : b);
  assert.equal(api.associateVisualBlocks(table).length, 3, "Generic figure_title can caption an actual table");
  const explicit = table.map(b => b.type === "caption" ? { ...b, label: "table_title" } : b);
  assert.equal(api.associateVisualBlocks(explicit).length, 3);
  assert.equal(api.associateVisualBlocks(explicit.map(b => b.id === "visual" ? { ...b, type: "image" } : b)).length, 1, "Explicit table titles do not attach to an image");
});

test("ambiguous, distant, other-column, overlapping and body-separated candidates remain unlinked", () => {
  for (const entries of [
    [block("a", "image", [20, 100, 500, 200]), block("c", "caption", [20, 240, 500, 260]), block("b", "image", [20, 300, 500, 400])],
    [block("a", "image", [20, 100, 250, 300]), block("c", "caption", [500, 310, 750, 340])],
    [block("a", "image", [20, 100, 500, 300]), block("c", "caption", [20, 150, 500, 250])],
    [block("a", "image", [20, 100, 500, 300]), block("c", "caption", [20, 800, 500, 840])],
    [block("a", "image", [20, 100, 500, 300]), block("body", "paragraph", [20, 310, 500, 340]), block("c", "caption", [20, 345, 500, 370])],
    [block("a", "image", null), block("b", "image", null), block("c", "caption", null)],
  ]) assert.deepEqual(api.associateVisualBlocks(entries), []);
  const adjacent = api.associateVisualBlocks([block("caption", "caption", null), block("image", "image", null)]);
  assert.equal(adjacent[0].evidence, "adjacency");
  assert.deepEqual(api.associateVisualBlocks([block("image", "image", null), block("note", "footnote", null, "footnote")]), [], "Unlocated page footnotes are not visual notes");
  assert.deepEqual(api.associateVisualBlocks([block("image", "image", null, "image", 1), block("caption", "caption", null, "figure_title", 3)]), []);
});

const sourceBlock = (label, content, id, bbox) => ({ block_label: label, block_content: content, block_id: id, block_bbox: bbox });
const rawPage = () => ({ prunedResult: { width: 600, height: 900, parsing_res_list: [
  sourceBlock("paragraph_title", "1 Introduction", 0, [50, 10, 500, 50]),
  sourceBlock("abstract", "A separately formatted abstract with $x^2$ and several meaningful words.", 1, [50, 55, 500, 95]),
  sourceBlock("figure_title", "Table 1. Synthetic $R^2$", 2, [50, 100, 500, 125]),
  sourceBlock("table", "<table><tr><td>$x^2$</td><td>42</td></tr></table>", 3, [50, 140, 500, 400]),
  sourceBlock("vision_footnote", "Note: synthetic measurement with $x$.", 4, [50, 410, 500, 435]),
  sourceBlock("text", "An ordinary independent body paragraph after the visual group.", 5, [50, 450, 500, 600]),
] }, markdown: { images: {} } });
async function published(t) {
  const raw = bytes(result([rawPage()])), f = await parsingFixture(t, { download: async () => raw });
  const id = await f.enqueue(); await f.step(); await f.step(); assert.equal((await f.job(id)).state, "succeeded");
  return { ...f, generationID: (await f.job(id)).generation_id };
}

test("publication stores stable UUID relationships with source scopes and rejects partial failures", async t => {
  const f = await published(t), blocks = await f.db.selectFrom("content_blocks").selectAll().where("generation_id", "=", f.generationID).orderBy("canonical_order").execute();
  const before = JSON.stringify(blocks), links = await api.readVisualLinks(f.db, f.generationID);
  assert.equal(links.length, 2);
  assert.equal(links[0].visualBlockId, blocks[3].id);
  assert.deepEqual(new Set(links.map(link => link.relatedBlockId)), new Set([blocks[2].id, blocks[4].id]));
  await f.db.transaction().execute(tx => api.projectVisualContent(tx, f.generationID, f.port.uuid));
  assert.deepEqual(await api.readVisualLinks(f.db, f.generationID), links, "A repeated projection preserves relationship UUIDs");
  assert.equal(JSON.stringify(await f.db.selectFrom("content_blocks").selectAll().where("generation_id", "=", f.generationID).orderBy("canonical_order").execute()), before);
  f.native.options.fail = sql => sql.startsWith('insert into "content_visual_links"');
  await f.enqueue(true); await f.step(); await f.step();
  assert.equal((await f.repository.sourceFor(1, "PDFKEY01")).active_generation_id, f.generationID);
  assert.deepEqual(await api.readVisualLinks(f.db, f.generationID), links);
  f.native.options.fail = undefined;
});

test("local backfill is repeatable, preserves content versions and safely retries a rolled-back batch", async t => {
  const f = await published(t), before = f.native.sqlite.prepare("SELECT * FROM content_blocks ORDER BY id").all();
  await f.db.deleteFrom("content_visual_links").execute(); await f.db.deleteFrom("content_visual_projections").execute();
  const source = await f.repository.sourceFor(1, "PDFKEY01"), repo = new api.VisualContentRepository(f.db, f.port);
  f.native.options.fail = sql => sql.startsWith('insert into "content_visual_projections"');
  await assert.rejects(repo.backfill());
  assert.equal((await f.db.selectFrom("content_visual_links").selectAll().execute()).length, 0);
  f.native.options.fail = undefined;
  await repo.backfill(); const links = await api.readVisualLinks(f.db, f.generationID); await repo.backfill();
  assert.equal(links.length, 2); assert.deepEqual(await api.readVisualLinks(f.db, f.generationID), links);
  assert.deepEqual(f.native.sqlite.prepare("SELECT * FROM content_blocks ORDER BY id").all(), before);
  assert.equal(JSON.stringify(await f.repository.sourceFor(1, "PDFKEY01")), JSON.stringify(source));
});

test("MinerU embedded visual parts are exact provider associations with unchanged canonical text", async t => {
  const f = await parsingFixture(t), parsed = parser.parseMinerUResult(mineruFiles());
  f.parsers.resolve(f.input.parser).process = async () => ({ document: { ...parsed.document, normalizerVersion: parser.parserDefinition("paddleocr").normalizer } });
  const id = await f.enqueue(); await f.step(); await f.step();
  const job = await f.job(id); assert.equal(job.state, "succeeded");
  const content = await new parser.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" });
  const embedded = content.visualLinks.filter(link => link.evidence === "provider");
  assert.equal(embedded.filter(link => link.role === "caption").length, 2);
  assert.equal(embedded.filter(link => link.role === "note").length, 1);
  const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close());
  globalThis.Localization = mockLocalization();
  const host = dom.window.document.createElement("article"); host.append(api.renderStructuredContent(dom.window.document, content, () => {}).fragment);
  assert.equal(host.querySelectorAll(".km-visual-group").length, 2);
  assert.equal(host.querySelectorAll(".km-visual-caption").length, 2);
  assert.equal(host.querySelectorAll(".km-visual-note").length, 1);
  assert.equal((host.textContent.match(/Table 1. Values/g) ?? []).length, 1);
  assert.equal(content.markdown, parsed.document.blocks.map(block => block.markdown).join("\n\n"));
});

test("typed reader renders caption math, collapsed visual notes, abstracts and unique heading targets", async t => {
  const f = await published(t), content = await new parser.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" });
  const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close()); globalThis.Localization = mockLocalization();
  const doc = dom.window.document, host = doc.createElement("article");
  content.blocks.push({ id: "heading-two", type: "heading", label: "paragraph_title", markdown: "## 2 Results" });
  content.markdown += "\n\n## 2 Results";
  const rendered = api.renderStructuredContent(doc, content, () => {}); host.append(rendered.fragment);
  assert.equal(host.querySelectorAll(".km-abstract").length, 1);
  assert.ok(host.querySelector(".km-abstract math"));
  assert.equal(host.querySelector(".km-abstract").getAttribute("aria-label"), "Abstract");
  assert.equal(host.querySelectorAll(".km-visual-group").length, 1);
  assert.ok(host.querySelector(".km-visual-caption math"));
  assert.ok(host.querySelector(".km-visual-note math"));
  assert.equal(host.querySelector(".km-visual-note").open, false);
  assert.ok(host.querySelector(".km-table-scroll td math"));
  assert.equal(new Set(rendered.headings.map(heading => heading.id)).size, 2);
  for (const heading of rendered.headings) assert.ok(host.querySelector(`#${heading.id}`));
  assert.equal(content.markdown, content.blocks.map(block => block.markdown).join("\n\n"));
  assert.equal(host.querySelectorAll(".km-visual-caption script, .km-abstract iframe").length, 0);
  const imported = api.renderStructuredContent(doc, { ...content, origin: "import" }, () => {}).fragment;
  assert.equal(imported.querySelectorAll(".km-visual-group, .km-abstract").length, 0);
});

test("consecutive abstract blocks share one shaded section while retaining paragraphs, provenance and safe formatting", t => {
  const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close()); globalThis.Localization = mockLocalization();
  const doc = dom.window.document, blocks = [
    { id: "title", type: "heading", label: "doc_title", markdown: "# Paper title", pageStart: 1, pageEnd: 1 },
    { id: "abstract-1", type: "abstract", label: "abstract", markdown: "Abstract: **First paragraph** with $x^2$.", pageStart: 1, pageEnd: 1 },
    { id: "abstract-2", type: "abstract", label: "abstract", markdown: "Second paragraph with [source](https://example.org/paper).", pageStart: 1, pageEnd: 2 },
    { id: "abstract-3", type: "abstract", label: "abstract", markdown: "<div>Third paragraph. <script>evil()</script><img src=https://evil.invalid/pixel></div>", pageStart: 2, pageEnd: 2 },
    { id: "keywords", type: "paragraph", label: "text", markdown: "Keywords: outside the abstract.", pageStart: 2, pageEnd: 2 },
  ];
  const input = { formatVersion: 1, origin: "parse", attachment: { libraryID: 1, itemKey: "PDFKEY01" }, updatedAt: 1, blocks, markdown: blocks.map(block => block.markdown).join("\n\n") };
  const snapshot = JSON.stringify(input), opened = [], host = doc.createElement("article");
  host.append(api.renderStructuredContent(doc, input, url => opened.push(url)).fragment);
  assert.equal(host.querySelectorAll(".km-abstract").length, 1);
  const section = host.querySelector(".km-abstract");
  assert.equal(section.children.length, 3); assert.equal(section.getAttribute("aria-label"), "Abstract");
  assert.equal(section.dataset.blockId, "abstract-1"); assert.equal(section.dataset.sourcePageStart, "1"); assert.equal(section.dataset.sourcePageEnd, "2");
  assert.equal(section.children[0].dataset.sourcePageStart, "1"); assert.equal(section.children[1].dataset.sourcePageEnd, "2"); assert.equal(section.children[2].dataset.sourcePageStart, "2");
  assert.ok(section.querySelector("strong")); assert.ok(section.querySelector("math")); assert.ok(!section.textContent.includes("Keywords:"));
  section.querySelector("a").click(); assert.deepEqual(opened, ["https://example.org/paper"]);
  assert.equal(host.querySelector("script,img,iframe"), null); assert.equal(JSON.stringify(input), snapshot);
});

test("abstract groups stop at every intervening canonical content block", t => {
  const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close()); globalThis.Localization = mockLocalization(); const doc = dom.window.document;
  for (const [type, markdown] of [["paragraph", "Intervening body."], ["heading", "## Introduction"], ["caption", "Table caption."],
    ["image", "![Local figure](local.png)"], ["footnote", "A note."], ["reference", "[1] A reference."], ["paragraph", ""]]) {
    const blocks = [{ id: "first", type: "abstract", label: "abstract", markdown: "First abstract." }, { id: "break", type, label: type, markdown },
      { id: "second", type: "abstract", label: "abstract", markdown: "Second abstract." }];
    const input = { formatVersion: 1, origin: "parse", attachment: { libraryID: 1, itemKey: "PDFKEY01" }, updatedAt: 1, blocks, markdown: blocks.map(block => block.markdown).join("\n\n") };
    const host = doc.createElement("article"); host.append(api.renderStructuredContent(doc, input, () => {}).fragment);
    assert.equal(host.querySelectorAll(".km-abstract").length, 2, type);
    assert.deepEqual([...host.querySelectorAll(".km-abstract")].map(section => section.textContent), ["First abstract.", "Second abstract."], type);
  }
});

test("MCP exposes relation identifiers, keeps content budgets and rejects other resource scopes", async t => {
  const f = await published(t), tokens = new api.McpTokens(f.db), cursors = new api.McpCursor(f.db); await cursors.start();
  const secret = await tokens.create({ name: "Visual relationships", libraryIds: [f.target.libraryID], scopes: ["knowledge:read"] });
  const principal = await tokens.authenticate(secret.secret), tools = new api.McpTools(tokens, cursors);
  const call = async (name, args) => {
    const response = await tools.call(name, args, principal, new AbortController().signal);
    if (!response.isError) api.validate(api.toolDefinitions.find(tool => tool.name === name).outputSchema, response.structuredContent, "output");
    return response;
  };
  const response = await call("list_content_blocks", { resourceId: f.input.resourceID, responseMode: "full" });
  assert.ok(!response.isError);
  const caption = response.structuredContent.items.find(block => block.blockType === "caption"), visual = response.structuredContent.items.find(block => block.blockType === "table");
  assert.equal(caption.metadata.visualRelation.visualBlockId, visual.blockId);
  assert.deepEqual(visual.metadata.visualGroup.captionBlockIds, [caption.blockId]);
  const text = await call("get_content_blocks_text", { resourceId: f.input.resourceID, blockIds: [caption.blockId], responseMode: "full", maxTotalChars: 1 });
  assert.equal(text.structuredContent.items[0].contentMarkdown.length, 1);
  assert.equal(text.structuredContent.items[0].metadata.visualRelation.visualBlockId, visual.blockId);
  const foreign = await call("get_content_blocks_text", { resourceId: f.port.uuid(), blockIds: [caption.blockId], responseMode: "full" });
  assert.equal(foreign.isError, true);
});

test("visual relation foreign keys reject cross-generation links and projection cursors become stale", async t => {
  const f = await published(t), firstLinks = await api.readVisualLinks(f.db, f.generationID);
  await f.enqueue(true); await f.step(); await f.step();
  const source = await f.repository.sourceFor(1, "PDFKEY01"), secondLinks = await api.readVisualLinks(f.db, source.active_generation_id);
  await f.db.deleteFrom("content_visual_links").where("id", "=", secondLinks[0].id).execute();
  await assert.rejects(f.db.insertInto("content_visual_links").values({ id: f.port.uuid(), generation_id: f.generationID,
    visual_block_id: firstLinks[0].visualBlockId, related_block_id: secondLinks[0].relatedBlockId, role: "caption", position: "before",
    evidence: "layout", ordinal: 99, content_markdown: null, created_at: Date.now() }).execute(), /FOREIGN KEY/);
  const tokens = new api.McpTokens(f.db), cursors = new api.McpCursor(f.db); await cursors.start();
  const token = await tokens.create({ name: "Visual cursor check", libraryIds: [f.target.libraryID], scopes: ["knowledge:read"] });
  const principal = await tokens.authenticate(token.secret), tools = new api.McpTools(tokens, cursors);
  const args = { resourceId: f.input.resourceID, responseMode: "full", limit: 1 };
  const first = await tools.call("list_content_blocks", args, principal, new AbortController().signal);
  assert.ok(first.structuredContent.nextCursor);
  await f.db.deleteFrom("content_visual_links").where("generation_id", "=", source.active_generation_id).execute();
  await f.db.deleteFrom("content_visual_projections").where("generation_id", "=", source.active_generation_id).execute();
  const stale = await tools.call("list_content_blocks", { ...args, cursor: first.structuredContent.nextCursor }, principal, new AbortController().signal);
  assert.equal(stale.structuredContent.error.code, "CURSOR_STALE");
  await new api.VisualContentRepository(f.db, f.port).backfill();
  assert.equal((await api.readVisualLinks(f.db, source.active_generation_id)).length, 2);
  assert.deepEqual(await api.readVisualLinks(f.db, f.generationID), firstLinks, "Historical associations stay anchored to their own blocks");
});

test("structured rendering keeps every note line collapsed and sanitizes captions and abstracts", t => {
  globalThis.Localization = mockLocalization();
  const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close());
  const doc = dom.window.document, blocks = [
    { id: "abstract", type: "abstract", label: "abstract", markdown: "Abstract with $x^2$. <script>alert(1)</script><img src=https://evil.invalid/image>" },
    { id: "caption", type: "caption", label: "figure_title", markdown: '<div style="text-align:center" onclick="alert(1)">Figure $R^2$ <a href="javascript:alert(1)">link</a></div>' },
    { id: "image", type: "image", label: "image", markdown: "![](local.png)" },
    { id: "note", type: "footnote", label: "vision_footnote", markdown: "> First note paragraph.\n\nSecond note paragraph with $x$." },
    { id: "note-two", type: "footnote", label: "footnote", markdown: "> An adjacent independent note." },
  ];
  const visualLinks = ["caption", "note", "note-two"].map((id, ordinal) => ({ id, visualBlockId: "image", relatedBlockId: id, role: id === "caption" ? "caption" : "note",
    position: id === "caption" ? "before" : "after", evidence: "layout", ordinal, markdown: null }));
  const content = { formatVersion: 1, attachment: { libraryID: 1, itemKey: "PDFKEY01" }, origin: "parse", updatedAt: 1, blocks, visualLinks,
    markdown: blocks.map(b => b.markdown).join("\n\n") };
  const before = JSON.stringify(content), host = doc.createElement("article"); host.append(api.renderStructuredContent(doc, content, () => {}).fragment);
  assert.equal(JSON.stringify(content), before);
  const note = host.querySelector(".km-visual-note");
  assert.equal(host.querySelectorAll(".km-visual-note").length, 1);
  assert.equal(note.open, false); assert.ok(note.textContent.includes("Second note paragraph"));
  assert.ok(note.textContent.includes("An adjacent independent note")); assert.ok(note.querySelector("math"));
  assert.ok(host.querySelector(".km-visual-caption math")); assert.ok(host.querySelector(".km-abstract math"));
  assert.equal(host.querySelector("script, iframe, img, [onclick], a[href^='javascript:']"), null);
  const invalid = { ...content, blocks: blocks.slice(1) };
  const fallback = api.renderStructuredContent(doc, invalid, () => {}).fragment;
  assert.ok(fallback.textContent.includes("Abstract with"));
  assert.equal(fallback.querySelectorAll(".km-visual-group, .km-abstract").length, 0);
  const headingCaption = blocks.map(block => block.id === "caption" ? { ...block, markdown: "## A caption $x^2$" } : block);
  const headingContent = { ...content, blocks: headingCaption, markdown: headingCaption.map(b => b.markdown).join("\n\n") };
  const headingResult = api.renderStructuredContent(doc, headingContent, () => {});
  assert.equal(headingResult.headings.length, 0, "A provider caption never becomes a directory heading");
  assert.equal(headingResult.fragment.querySelector(".km-visual-caption h2"), null);
  assert.ok(headingResult.fragment.querySelector(".km-visual-caption math"));
});
