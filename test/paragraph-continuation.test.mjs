import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { api, parsingFixture, bytes, result } from "./fixtures/parsing.mjs";
import { mockLocalization } from "./helpers/localization.mjs";

const block = (label, content, id) => ({ block_label: label, block_content: content, block_id: id, block_bbox: [30, 150, 550, 250] });
const page = (number, blocks) => ({ number, raw: { prunedResult: { width: 600, height: 900, parsing_res_list: blocks }, markdown: { images: {} } } });
const tableHTML = "<table><tr><th>Model</th><th>Score</th></tr><tr><td>$L_{task}$</td><td>0.896</td></tr></table>";
const tableGroup = () => [block("table_title", "Table 1. Ablation results", 1), block("table", tableHTML, 2), block("vision_footnote", "Note: synthetic scores.", 3)];

test("table interruptions join body prose while retaining captions, notes, cells and source geometry", () => {
  globalThis.Localization = mockLocalization();
  for (const [before, after, expected] of [["表5展示了各模块", "消融的结果。", "表5展示了各模块消融的结果。"],
    ["The table reports", "the ablation results.", "The table reports the ablation results."]]) {
    // Place the physical page boundary at every point inside the interruption.
    const entries = [block("text", before, 0), ...tableGroup(), block("text", after, 4)];
    for (let split = 1; split <= entries.length; split++) {
      const pages = [page(1, entries.slice(0, split)), ...(split < entries.length ? [page(2, entries.slice(split))] : [])];
      const snapshot = JSON.stringify(pages), blocks = api.buildCanonicalBlocks(pages);
      assert.equal(JSON.stringify(pages), snapshot);
      assert.deepEqual(blocks.map(b => b.label), ["text", "table_title", "table", "vision_footnote"]);
      assert.equal(blocks[0].markdown, expected);
      assert.deepEqual(blocks[0].sourceIDs, ["0", "4"]);
      assert.deepEqual(blocks[0].locations.map(location => location.sourceID), ["0", "4"]);
      assert.deepEqual([blocks[0].page, blocks[0].pageEnd], [1, split === entries.length ? 1 : 2]);
      assert.equal(blocks[0].metadata.cross_table_merged, true);
      assert.equal(blocks[0].metadata.cross_note_merged, true);
      assert.equal(blocks[0].metadata.cross_page_merged, split < entries.length);
      assert.equal(blocks[0].metadata.cross_image_merged, undefined);
      assert.match(blocks[1].markdown, /text-align: center/);
      assert.equal(blocks[3].markdown, "> Note: synthetic scores.");
      const exported = api.paddlePagesToMarkdown(pages);
      assert.ok(exported.includes(`\n${expected}\n\n`));
      assert.equal((exported.match(/<table\b/g) ?? []).length, 1);
      const dom = new JSDOM("<html><body></body></html>");
      try {
        const rendered = api.renderMarkdown(dom.window.document, blocks.map(b => b.markdown).join("\n\n"), () => {}).fragment;
        assert.equal(rendered.querySelector("p").textContent, expected);
        assert.equal(rendered.querySelectorAll("table").length, 1);
        assert.ok(rendered.querySelector("td math"));
        assert.equal(rendered.querySelector("details").open, false);
      } finally { dom.window.close(); }
    }
  }
});

test("mixed image, table and note interruptions are independent of group order and page split", () => {
  const groups = [[block("figure_title", "Figure 1. Plot", 1), block("image", "![](figure.png)", 2)],
    [block("table_title", "Table 1. Values", 3), block("table", tableHTML, 4)], [block("footnote", "An independent note.", 5)]];
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const order of permutations) {
    const gap = order.flatMap(index => groups[index]), entries = [block("text", "The model uses", 0), ...gap, block("text", "the shared features.", 6)];
    for (let split = 1; split <= entries.length; split++) {
      const pages = [page(1, entries.slice(0, split)), ...(split < entries.length ? [page(2, entries.slice(split))] : [])];
      const blocks = api.buildCanonicalBlocks(pages);
      assert.equal(blocks[0].markdown, "The model uses the shared features.");
      assert.deepEqual(blocks[0].sourceIDs, ["0", "6"]);
      assert.deepEqual(blocks.slice(1).map(b => b.label), gap.map(b => b.block_label));
      assert.equal(blocks[0].metadata.cross_image_merged, true);
      assert.equal(blocks[0].metadata.cross_table_merged, true);
      assert.equal(blocks[0].metadata.cross_note_merged, true);
    }
  }
});

test("generic figure/chart caption labels can accompany an actual table without relabeling", () => {
  for (const label of ["figure_title", "chart_title"]) {
    const pages = [page(1, [block("text", "表5展示了各模块", 0), block(label, "表7 消融实验结果", 1),
      block("table", tableHTML, 2), block("text", "消融的结果。", 3)])];
    const snapshot = JSON.stringify(pages), blocks = api.buildCanonicalBlocks(pages);
    assert.equal(blocks[0].markdown, "表5展示了各模块消融的结果。");
    assert.equal(blocks[0].metadata.cross_table_merged, true);
    assert.equal(blocks[0].metadata.cross_image_merged, undefined);
    assert.equal(blocks[1].label, label);
    assert.equal(blocks[1].type, "caption");
    assert.equal(blocks[2].type, "table");
    assert.equal(JSON.stringify(pages), snapshot);
  }
});

test("a paragraph continues repeatedly across notes, images, table-only pages and ordinary page breaks", () => {
  const pages = [page(1, [block("text", "First", 0), block("footnote", "Note.", 1), block("text", "second", 2),
    block("image", "![](figure.png)", 3), block("text", "third", 4), block("table_title", "Table 1", 5)]),
  page(2, [block("table", tableHTML, 6), block("vision_footnote", "Table note.", 7)]),
  page(3, [block("text", "fourth", 8)]), page(4, [block("text", "last.", 9)])];
  const snapshot = JSON.stringify(pages), blocks = api.buildCanonicalBlocks(pages);
  assert.equal(JSON.stringify(pages), snapshot);
  assert.equal(blocks[0].markdown, "First second third fourth last.");
  assert.deepEqual(blocks[0].sourceIDs, ["0", "2", "4", "8", "9"]);
  assert.deepEqual(blocks[0].locations.map(location => location.page), [1, 1, 1, 3, 4]);
  assert.deepEqual([blocks[0].page, blocks[0].pageEnd], [1, 4]);
  for (const flag of ["cross_image_merged", "cross_table_merged", "cross_note_merged", "cross_page_merged"]) assert.equal(blocks[0].metadata[flag], true);
  assert.deepEqual(blocks.slice(1).map(b => b.sourceIDs), [["1"], ["3"], ["5"], ["6"], ["7"]]);
});

test("table continuation respects sentence, keyword, structure, empty-table and missing-page boundaries", () => {
  const before = block("text", "An unfinished paragraph", 0), after = block("text", "continued text.", 4);
  for (const content of ["A completed sentence.", "中文完整句子。", "A complete sentence. $ ^{9} $", "Keywords: model; table"]) {
    const blocks = api.buildCanonicalBlocks([page(1, [{ ...before, block_content: content }, ...tableGroup(), after])]);
    assert.equal(blocks.filter(b => b.type === "paragraph").length, 2, content);
    assert.ok(!blocks.some(b => b.metadata.cross_table_merged));
  }
  for (const label of ["paragraph_title", "display_formula", "formula_number", "unknown"]) for (const content of ["Boundary", ""]) {
    const blocks = api.buildCanonicalBlocks([page(1, [before, ...tableGroup(), block(label, content, 7), after])]);
    assert.ok(!blocks.some(b => b.metadata.cross_table_merged), label);
  }
  for (const gap of [[block("table", "", 2)], [block("table_title", "Detached caption", 2)],
    [block("image", "![](figure.png)", 1), block("table_title", "Detached table caption", 2)],
    [block("figure_title", "Detached figure caption", 1)]]) {
    const blocks = api.buildCanonicalBlocks([page(1, [before, ...gap, after])]);
    assert.equal(blocks.filter(b => b.type === "paragraph").length, 2);
  }
  for (const middle of [[], [page(2, [])]]) {
    const blocks = api.buildCanonicalBlocks([page(1, [before, ...tableGroup()]), ...middle, page(3, [after])]);
    assert.ok(!blocks.some(b => b.metadata.cross_table_merged));
  }
  for (const label of ["abstract", "reference_content"]) {
    const blocks = api.buildCanonicalBlocks([page(1, [{ ...before, block_label: label }, ...tableGroup(), { ...after, block_label: label }])]);
    assert.ok(!blocks.some(b => b.metadata.cross_table_merged), "Only body text crosses tables");
  }
  const structured = api.buildCanonicalBlocks([page(1, [before, ...tableGroup(), { ...after, block_content: "<div>Structured content.</div>" }])]);
  assert.ok(!structured.some(b => b.metadata.cross_table_merged));
});

test("published table continuations reach the stored reader and MCP as one canonical paragraph", async t => {
  const pages = [page(1, [block("text", "A body paragraph uses", 0), ...tableGroup()]), page(2, [block("text", "the shared result.", 4)])];
  const encoded = bytes(result(pages.map(p => p.raw)));
  const f = await parsingFixture(t, { progress: async () => ({ state: "done", total: 2, resultURL: "https://fixture.example/result" }), download: async () => encoded });
  const id = await f.enqueue(); await f.step(); await f.step();
  const job = await f.job(id); assert.equal(job.state, "succeeded");
  const blocks = await f.db.selectFrom("content_blocks").selectAll().where("generation_id", "=", job.generation_id).orderBy("canonical_order").execute();
  assert.deepEqual(blocks.map(b => b.block_type), ["paragraph", "caption", "table", "footnote"]);
  assert.equal(blocks[0].content_markdown, "A body paragraph uses the shared result.");
  assert.deepEqual(JSON.parse(blocks[0].source_block_ids_json), ["0", "4"]);
  assert.deepEqual([blocks[0].page_start, blocks[0].page_end], [1, 2]);
  assert.equal(JSON.parse(blocks[0].metadata_json).cross_table_merged, true);
  const read = await new api.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" });
  assert.ok(read.markdown.startsWith(blocks[0].content_markdown));
  const raw = await f.db.selectFrom("parse_artifacts as a").innerJoin("stored_files as f", "f.id", "a.stored_file_id")
    .select("f.relative_path").where("a.artifact_key", "=", "raw.jsonl").executeTakeFirstOrThrow();
  assert.deepEqual(f.files.get(api.parseFilePath(raw.relative_path)), encoded);

  const bundled = await build({ stdin: { contents: `export { McpTokens } from "./src/security/mcp-tokens.ts";
export { McpCursor } from "./src/security/mcp-cursor.ts"; export { McpTools } from "./src/mcp/tools/service.ts";
export { toolDefinitions, validate } from "./src/mcp/tools/registry.ts";`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, platform: "browser", format: "esm", target: "firefox140", write: false });
  const mcp = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const tokens = new mcp.McpTokens(f.db), cursor = new mcp.McpCursor(f.db); await cursor.start();
  const created = await tokens.create({ name: "Paragraph continuation fixture", libraryIds: [f.target.libraryID], scopes: ["knowledge:read"] });
  const principal = await tokens.authenticate(created.secret), tools = new mcp.McpTools(tokens, cursor);
  const call = async (name, args) => {
    const response = await tools.call(name, args, principal, new AbortController().signal);
    assert.ok(!response.isError, JSON.stringify(response.structuredContent));
    mcp.validate(mcp.toolDefinitions.find(tool => tool.name === name).outputSchema, response.structuredContent, "output");
    return response.structuredContent;
  };
  const args = { resourceId: f.input.resourceID, responseMode: "full" };
  const list = await call("list_content_blocks", args);
  assert.deepEqual(list.items.map(b => b.blockType), ["paragraph", "caption", "table", "footnote"]);
  const text = await call("get_content_blocks_text", { ...args, blockIds: [blocks[0].id] });
  assert.equal(text.items[0].contentMarkdown, blocks[0].content_markdown);
  assert.equal(text.items[0].metadata.cross_table_merged, true);
  const whole = await call("get_resource_content", { ...args, includeBoilerplate: true });
  assert.ok(whole.contentMarkdown.startsWith(blocks[0].content_markdown));
});
