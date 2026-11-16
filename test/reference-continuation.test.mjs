import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { api, parsingFixture, bytes, result } from "./fixtures/parsing.mjs";

const block = (label, content, id) => ({ block_label: label, block_content: content, block_id: id, block_bbox: [30, 150, 550, 250] });
const reference = (content, id) => block("reference_content", content, id);
const page = (number, blocks) => ({ number, raw: { prunedResult: { width: 600, height: 900, parsing_res_list: blocks }, markdown: { images: {} } } });

test("numbered references rejoin adjacent same-page column fragments and preserve lexical hyphens", () => {
  for (const [first, last, expected] of [
    ["[4] Synthetic Author. Multimodal bag-of-", "words for sentiment analysis. 2025: 1-5", "[4] Synthetic Author. Multimodal bag-of-words for sentiment analysis. 2025: 1-5"],
    ["[30] Synthetic Author. A conversational transformer", "network for emotion recognition. 2025: 1-5", "[30] Synthetic Author. A conversational transformer network for emotion recognition. 2025: 1-5"],
    ["[1] Synthetic Author.", "A title after the author initial.", "[1] Synthetic Author. A title after the author initial."],
  ]) {
    const pages = [page(1, [reference(first, 0), reference(last, 1), reference("[31] A separate reference.", 2)])];
    const snapshot = JSON.stringify(pages), blocks = api.buildCanonicalBlocks(pages);
    assert.equal(JSON.stringify(pages), snapshot);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, "reference");
    assert.equal(blocks[0].markdown, expected);
    assert.deepEqual(blocks[0].sourceIDs, ["0", "1"]);
    assert.deepEqual(blocks[0].locations.map(location => location.sourceID), ["0", "1"]);
    assert.equal(blocks[0].metadata.reference_continuation_merged, true);
    assert.equal(blocks[0].metadata.cross_page_merged, false);
    assert.ok(api.paddlePagesToMarkdown(pages).includes(`\n${expected}\n\n`));
    assert.equal(blocks[1].markdown, "[31] A separate reference.");
  }
});

test("numbered references continue through notes, photos, tables and consecutive pages in one scan", () => {
  const groups = [[block("footnote", "A page note.", 1)], [block("vision_footnote", "A visual note.", 2)],
    [block("image", "![](portrait.png)", 3)], [block("table_title", "Table 1", 4), block("table", "<table><tr><td>Value</td></tr></table>", 5)],
    [block("image", "![](portrait.png)", 3), block("vision_footnote", "A note.", 2)]];
  for (const gap of groups) for (const split of [false, true]) {
    const first = reference("[73] Synthetic Author. Modality-invariant", 0), last = reference("features with missing modalities. 2025: 1-5", 6);
    const pages = split ? [page(1, [first, ...gap]), page(2, [last])] : [page(1, [first, ...gap, last])];
    const snapshot = JSON.stringify(pages), blocks = api.buildCanonicalBlocks(pages);
    assert.equal(blocks[0].markdown, "[73] Synthetic Author. Modality-invariant features with missing modalities. 2025: 1-5");
    assert.deepEqual(blocks[0].sourceIDs, ["0", "6"]);
    assert.equal(blocks[0].metadata.reference_continuation_merged, true);
    assert.equal(blocks[0].metadata.cross_page_merged, split);
    assert.deepEqual(blocks.slice(1).map(b => b.label), gap.map(b => b.block_label));
    assert.equal(JSON.stringify(pages), snapshot);
  }
  const pages = [page(1, [reference("[1] Synthetic Author.", 0), block("footnote", "Note.", 1), reference("A title with", 2)]),
    page(2, [block("image", "![](portrait.png)", 3)]), page(3, [reference("a continued title", 4), block("vision_footnote", "Another note.", 5), reference("and journal. 2025: 1-5", 6)])];
  const blocks = api.buildCanonicalBlocks(pages);
  assert.equal(blocks[0].markdown, "[1] Synthetic Author. A title with a continued title and journal. 2025: 1-5");
  assert.deepEqual(blocks[0].sourceIDs, ["0", "2", "4", "6"]);
  assert.deepEqual([blocks[0].page, blocks[0].pageEnd], [1, 3]);
  for (const flag of ["reference_continuation_merged", "cross_note_merged", "cross_image_merged", "cross_page_merged"]) assert.equal(blocks[0].metadata[flag], true);
});

test("every explicit reference number stops merging even without a terminal period", () => {
  for (const marker of ["[2]", "［２］", "【2】", "(2)", "（２）", "2.", "2)", "2、", "**[2]**", "〔2〕.", "〖2〗", "{2}", "〈2〉", "❨2❩"]) {
    for (const split of [false, true]) {
      const next = reference(`${marker} Another author. A separate reference.`, 2), first = reference("[1] An entry without terminal punctuation", 0);
      const pages = split ? [page(1, [first, block("footnote", "Note.", 1)]), page(2, [next])]
        : [page(1, [first, block("image", "![](photo.png)", 1), next])];
      const blocks = api.buildCanonicalBlocks(pages);
      assert.equal(blocks.filter(b => b.type === "reference").length, 2, marker);
      assert.ok(!blocks.some(b => b.metadata.reference_continuation_merged));
    }
    const owned = api.buildCanonicalBlocks([page(1, [reference(`${marker} Synthetic Author.`, 0), reference("A continued title.", 1)])]);
    assert.equal(owned.length, 1, marker + " can also anchor an entry");
  }
});

test("cross-page unnumbered references retain complete text and both source locations", () => {
  for (const gap of [[], [block("footnote", "A page note.", 9)], [block("image", "![](figure.png)", 9)]]) {
    const first = reference('Synthetic Author, 2021, “Synthetic Difference-in-', 0);
    const last = reference('Differences", Synthetic Journal, 111(12), 1–20.', 1);
    const pages = [page(1, [first, ...gap]), page(2, [last, reference("Nextauthor, A., 2025, Another paper.", 2)])];
    const snapshot = JSON.stringify(pages), refs = api.buildCanonicalBlocks(pages).filter(b => b.type === "reference");
    assert.equal(refs.length, 2); assert.equal(JSON.stringify(pages), snapshot);
    assert.equal(refs[0].markdown, 'Synthetic Author, 2021, “Synthetic Difference-in-Differences", Synthetic Journal, 111(12), 1–20.');
    assert.deepEqual(refs[0].sourceIDs, ["0", "1"]); assert.deepEqual(refs[0].locations.map(l => l.page), [1, 2]);
    assert.deepEqual([refs[0].page, refs[0].pageEnd], [1, 2]);
    assert.equal(refs[0].metadata.reference_continuation_merged, true); assert.equal(refs[0].metadata.cross_page_merged, true);
  }
});

test("reference rules do not merge unnumbered entries, body prose, author biographies or section boundaries", () => {
  const first = reference("[73] Synthetic Author. A complete citation", 0);
  const biography = block("text", "SYNTHETIC Author, professor. Research interests include multimodal learning.", 2);
  const mixed = [page(1, [first, block("image", "![](portrait.png)", 1), reference("with journal details. 2025: 1-5", 3),
    block("vision_footnote", "An author note.", 4), biography])];
  const blocks = api.buildCanonicalBlocks(mixed);
  assert.deepEqual(blocks.map(b => b.label), ["reference_content", "image", "vision_footnote", "text"]);
  assert.equal(blocks.at(-1).markdown, biography.block_content);
  for (const pages of [[page(1, [reference("An unnumbered author", 0), reference("Another unnumbered entry.", 1)])],
    [page(1, [reference("An unnumbered author", 0)]), page(2, [reference("Another unnumbered entry.", 1)])],
    [page(1, [first]), page(2, [biography])],
    [page(1, [block("text", "Unfinished body prose", 0)]), page(2, [reference("A reference fragment.", 1)])]]) {
    assert.equal(api.buildCanonicalBlocks(pages).length, 2);
  }
  for (const boundary of [block("paragraph_title", "Author biographies", 1), block("display_formula", "$$x$$", 1),
    block("unknown", "Unknown boundary", 1), block("table", "", 1), block("figure_title", "Detached title", 1)]) {
    const stopped = api.buildCanonicalBlocks([page(1, [first, boundary, reference("A separate fragment.", 2)])]);
    assert.ok(!stopped.some(b => b.metadata.reference_continuation_merged));
  }
  for (const middle of [[], [page(2, [])]]) {
    assert.equal(api.buildCanonicalBlocks([page(1, [first]), ...middle, page(3, [reference("A separate fragment.", 2)])]).length, 2);
  }
  const prose = api.buildCanonicalBlocks([page(1, [block("text", "A completed sentence.", 0), block("footnote", "Note.", 1), block("text", "A separate paragraph.", 2)])]);
  assert.equal(prose.filter(b => b.type === "paragraph").length, 2, "Body sentence-stop policy is unchanged");
});

test("standalone numbered blocks start a new reference and retain the following body", () => {
  const blocks = api.buildCanonicalBlocks([page(1, [reference("[1] First complete entry.", 0), reference("［２］．", 1), reference("Second entry body.", 2)])]);
  assert.deepEqual(blocks.map(b => b.markdown), ["[1] First complete entry.", "［２］． Second entry body."]);
  assert.deepEqual(blocks[1].sourceIDs, ["1", "2"]);
});

test("merged references publish canonical blocks and expose the same text through bounded MCP reads", async t => {
  const pages = [page(1, [reference("[1] Synthetic Author.", 0), block("footnote", "A page note.", 1),
    reference("A title with", 2), block("vision_footnote", "An independent note.", 3)]),
  page(2, [reference("a continued title. 2025: 1-5", 4), reference("[2] A separate reference.", 5), block("text", "An independent author biography.", 6)])];
  const encoded = bytes(result(pages.map(p => p.raw))), f = await parsingFixture(t, {
    progress: async () => ({ state: "done", total: 2, resultURL: "https://fixture.example/result" }), download: async () => encoded,
  });
  const id = await f.enqueue(); await f.step(); await f.step(); assert.equal((await f.job(id)).state, "succeeded");
  const blocks = await f.db.selectFrom("content_blocks").selectAll().orderBy("canonical_order").execute();
  const refs = blocks.filter(b => b.block_type === "reference"), expected = "[1] Synthetic Author. A title with a continued title. 2025: 1-5";
  assert.equal(refs.length, 2); assert.equal(refs[0].content_markdown, expected);
  assert.deepEqual(JSON.parse(refs[0].source_block_ids_json), ["0", "2", "4"]);
  assert.deepEqual([refs[0].page_start, refs[0].page_end], [1, 2]);
  const stored = await new api.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" });
  assert.ok(stored.markdown.startsWith(expected));
  const bundled = await build({ stdin: { contents: `export { McpTokens } from "./src/security/mcp-tokens.ts";
export { McpCursor } from "./src/security/mcp-cursor.ts"; export { McpTools } from "./src/mcp/tools/service.ts";
export { toolDefinitions, validate } from "./src/mcp/tools/registry.ts";`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, platform: "browser", format: "esm", target: "firefox140", write: false });
  const mcp = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const tokens = new mcp.McpTokens(f.db), cursors = new mcp.McpCursor(f.db); await cursors.start();
  const created = await tokens.create({ name: "Reference continuation fixture", libraryIds: [f.target.libraryID], scopes: ["knowledge:read"] });
  const principal = await tokens.authenticate(created.secret), tools = new mcp.McpTools(tokens, cursors);
  const call = async (name, args) => {
    const response = await tools.call(name, args, principal, new AbortController().signal);
    assert.ok(!response.isError, JSON.stringify(response.structuredContent));
    mcp.validate(mcp.toolDefinitions.find(tool => tool.name === name).outputSchema, response.structuredContent, "output");
    return response.structuredContent;
  };
  const args = { resourceId: f.input.resourceID, responseMode: "full" };
  const text = await call("get_content_blocks_text", { ...args, blockIds: [refs[0].id] });
  assert.equal(text.items[0].contentMarkdown, expected);
  const notes = blocks.filter(b => b.content_role === "note");
  const noteText = await call("get_content_blocks_text", { ...args, blockIds: notes.map(note => note.id) });
  assert.deepEqual(noteText.items.map(note => note.contentMarkdown), notes.map(note => note.content_markdown));
  let combined = "", cursor;
  do { const part = await call("get_resource_content", { ...args, maxChars: 20, includeBoilerplate: true, ...(cursor ? { cursor } : {}) }); combined += part.contentMarkdown; cursor = part.nextCursor; } while (cursor);
  assert.equal(combined, blocks.map(b => b.content_markdown).join("\n\n"), "Document reading preserves original scientific notes alongside references");
});
