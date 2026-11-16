import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { cases, documentFor } from "./fixtures/heading-hierarchy.mjs";
import { api, parsingFixture, page, result, bytes } from "./fixtures/parsing.mjs";
import { mineruFiles } from "./fixtures/mineru.mjs";

const compiled = await build({ stdin: { contents: `export * from "./src/parsers/heading-hierarchy.ts";
export * from "./src/parsers/heading-numbering.ts"; export * from "./src/parsers/apply-heading-hierarchy.ts";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, format: "esm", platform: "browser", target: "firefox140", write: false });
const hierarchy = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

for (const fixture of cases.filter(c => c.group !== "known-ambiguity")) test(`document numbering: ${fixture.name}`, () => {
  const document = documentFor(fixture), before = JSON.stringify(document), actual = hierarchy.inferDocument(document), stack = [];
  fixture.rows.forEach(([, depth, status = "automatic"], index) => {
    const row = actual[index]; assert.equal(row.status, status, JSON.stringify(row));
    if (depth !== null) {
      while (stack.length && stack.at(-1).depth >= depth) stack.pop();
      assert.equal(row.depth, depth, row.text); assert.equal(row.parent, stack.at(-1)?.id ?? null, row.text);
      stack.push({ id: row.id, depth });
    }
  });
  assert.equal(JSON.stringify(document), before);
});

test("prefix normalization tolerates width, mixed brackets and whitespace without repairing OCR characters", () => {
  for (const [variants, expectedKind, expectedValue] of [
    [["（一）Title", "(一)Title", "（一)  Title", "  （ 一 ）　Title", "( 一)Title", "（一\t）Title"], "cn-paren", 1],
    [["（1）Title", "(1)Title", "（１）Title", "（ １ ）  Title", "( 1)Title", "(1 )Title"], "numeric-paren", 1],
    [["一、Title", "一 、Title", "一　、Title"], "cn-major", 1],
    [["1.1 Title", "1 . 1 Title", "１ ． １数据", "1.1数据"], "decimal", [1, 1]],
    [["A. Title", "A . Title", "Ａ ．Title"], "alpha", 1],
  ]) for (const text of variants) {
    const p = hierarchy.parseNumbering(text); assert.equal(p?.kind, expectedKind, text); assert.deepEqual(p.value, expectedValue, text);
    const normalized = hierarchy.normalizeHeadingNumbering(text);
    assert.equal(hierarchy.normalizeHeadingNumbering(normalized), normalized, "Normalization must be idempotent");
  }
  assert.equal(hierarchy.parseNumbering("（l）Title").kind, "alpha-paren-lower");
  assert.equal(hierarchy.parseNumbering("1.l Title").reason, "ambiguous-ocr-digit");
  for (const text of ["（—）Title", "（1 2）Title", "（一 二）Title"]) assert.equal(hierarchy.parseNumbering(text), null, text);
});

test("format variation leaves inferred rules, exact parent relationships and source text intact", () => {
  for (const fixture of cases.filter(c => c.group?.startsWith("permutations-"))) {
    const document = documentFor(fixture), expected = hierarchy.inferDocument(document);
    document.blocks.forEach((block, index) => {
      const value = block.content_normalized.replace(/（([^）]+)）/, (_, token) => index % 2 ? `( ${token} )` : `（　${token}　)`)
        .replace(/^([一二三])、/, "$1　、").replace(/^(\d+|[A-Z])\./, "$1 .");
      block.content_normalized = value; block.content_markdown = `### ${value}`;
    });
    const before = JSON.stringify(document), actual = hierarchy.inferDocument(document);
    assert.deepEqual(actual.map(r => [r.status, r.depth, r.parent]), expected.map(r => [r.status, r.depth, r.parent]), fixture.name);
    assert.equal(JSON.stringify(document), before);
  }
});

test("numbered body blocks and document titles are protected; short mislabelled lists remain an explicit limitation", () => {
  for (const type of ["paragraph", "caption", "reference", "table", "formula", "image", "footnote"]) {
    const block = { id: "body", block_type: type, content_normalized: "（ 1 ）Data" };
    assert.equal(hierarchy.inferBlock(block, { blocks: [block] }).status, "protected");
  }
  const document = documentFor({ name: "limits", rows: [["1 Overview"], ["2 Mix flour"]] });
  assert.ok(hierarchy.inferDocument(document).every(row => row.status === "automatic"));
  document.blocks[0].metadata.ocr_label = "doc_title";
  assert.equal(hierarchy.inferDocument(document)[0].status, "protected");
});

const sample = cases.find(c => c.group === "user" && c.name.includes("reverse"));
function paddlePage() {
  const source = page();
  source.prunedResult.parsing_res_list = [source.prunedResult.parsing_res_list[0],
    ...sample.rows.flatMap(([text], index) => [
      { block_label: "paragraph_title", block_content: text.replace(/（([^）]+)）/, "( $1 )"), block_id: index * 2 + 1 },
      { block_label: "text", block_content: "A complete synthetic body paragraph.", block_id: index * 2 + 2 },
    ])];
  return source;
}

for (const provider of ["paddleocr", "mineru"]) test(`${provider} normalization applies article rules and retains original numbering text and geometry`, () => {
  let document, original;
  if (provider === "paddleocr") {
    original = paddlePage(); const before = JSON.stringify(original);
    document = api.parsePaddleResult(result([original])); assert.equal(JSON.stringify(original), before);
  } else {
    original = [ { type: "text", text: "Synthetic article", text_level: 1, page_idx: 0 }, ...sample.rows.map(([text], index) => ({ type: "text", text, text_level: 2, page_idx: 0, bbox: [100, 100 + index * 30, 900, 120 + index * 30] })) ];
    const files = mineruFiles(original, [0]); document = api.parseMinerUResult(files, 1).document;
  }
  const headings = document.blocks.filter(b => b.label === "paragraph_title"), stack = [];
  headings.forEach((block, index) => {
    const depth = sample.rows[index][1];
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    assert.equal(block.headingLevel, depth + 1);
    assert.equal(block.headingParentOrder, stack.at(-1)?.order ?? null);
    assert.match(block.markdown, new RegExp(`^${"#".repeat(depth + 1)} `));
    assert.equal(block.markdown.replace(/^#+ /, ""), provider === "paddleocr" ? original.prunedResult.parsing_res_list[index * 2 + 1].block_content : original[index + 1].text);
    assert.ok(document.markdown.includes(block.markdown));
    stack.push({ depth, order: document.blocks.indexOf(block) });
  });
  assert.equal(document.sectionHierarchy, "heading-levels");
});

test("publication preserves exact inferred parents, Markdown levels, source anchors and ancestor ranges", async t => {
  const f = await parsingFixture(t, { download: async () => bytes(result([paddlePage()])) });
  const id = await f.enqueue(); await f.step(); await f.step();
  const job = await f.job(id); assert.equal(job.state, "succeeded");
  const nodes = await f.db.selectFrom("structure_nodes").selectAll().where("generation_id", "=", job.generation_id).execute();
  const blocks = await f.db.selectFrom("content_blocks").selectAll().where("generation_id", "=", job.generation_id).orderBy("canonical_order").execute();
  const headings = blocks.filter(b => JSON.parse(b.metadata_json).ocr_label === "paragraph_title"), stack = [];
  const root = nodes.find(n => n.node_type === "root");
  headings.forEach((block, index) => {
    const depth = sample.rows[index][1];
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const node = nodes.find(n => n.id === block.structure_node_id), parent = stack.at(-1)?.node ?? root;
    assert.equal(node.parent_id, parent.id); assert.equal(node.depth, depth);
    assert.equal(node.canonical_order_start, block.canonical_order);
    assert.ok(node.canonical_order_end > node.canonical_order_start);
    assert.ok(parent.canonical_order_end >= node.canonical_order_end);
    assert.equal(JSON.parse(block.source_block_ids_json)[0], String(index * 2 + 1));
    assert.match(block.content_markdown, new RegExp(`^${"#".repeat(depth + 1)} `));
    stack.push({ depth, node });
  });
});

test("uncertain titles keep provider levels and diagnostics; captions and hypotheses create no sections", async t => {
  const source = page();
  source.prunedResult.parsing_res_list.push(...["1. New section", "Table 1 Statistics", "H1: Some effect."].map((text, index) => ({ block_label: "paragraph_title", block_content: text, block_id: index + 2 })));
  const document = api.parsePaddleResult(result([source]));
  const uncertain = document.blocks.find(b => b.text === "1. New section");
  assert.equal(uncertain.headingLevel, 3); assert.equal(uncertain.headingParentOrder, undefined);
  assert.equal(uncertain.metadata.heading_hierarchy.status, "review");
  assert.ok(uncertain.qualityFlags.includes("heading_hierarchy_uncertain"));
  assert.ok(document.blocks.filter(b => /^(Table|H1:)/.test(b.text)).every(b => b.type === "paragraph" && !b.markdown.startsWith("#")));
  const f = await parsingFixture(t, { download: async () => bytes(result([source])) });
  const id = await f.enqueue(); await f.step(); await f.step();
  assert.equal((await f.job(id)).state, "succeeded");
  const nodes = await f.db.selectFrom("structure_nodes").selectAll().execute();
  assert.equal(nodes.filter(n => n.node_type === "section").length, 1);
  assert.equal(nodes.find(n => n.node_type === "section").review_status, "needs_review");
});

test("reused provider block IDs on and across pages cannot mix Markdown or inferred parents", () => {
  const pages = sample.rows.map(([text]) => ({ prunedResult: { width: 600, height: 800, parsing_res_list: [
    { block_label: "paragraph_title", block_content: text, block_id: 1 },
  ] }, markdown: { images: {} } }));
  const parsed = api.parsePaddleResult(result(pages));
  parsed.blocks.forEach((block, index) => {
    assert.equal(block.headingLevel, sample.rows[index][1] + 1);
    assert.ok(parsed.markdown.includes(block.markdown), block.markdown);
    if (block.headingParentOrder !== null) assert.ok(block.headingParentOrder < index);
  });
  const onePage = paddlePage();
  for (const block of onePage.prunedResult.parsing_res_list) block.block_id = 1;
  const samePage = api.parsePaddleResult(result([onePage]));
  for (const block of samePage.blocks.filter(b => b.type === "heading")) assert.ok(samePage.markdown.includes(block.markdown));
});

test("inference resource limits retain headings for review without enumerating excessive grammars", () => {
  const entries = ["一、Root", "（一）Topic", "(1) Topic", "1. Topic", "A. Topic", "I Topic", "a) Topic"];
  const document = documentFor({ name: "budget", rows: Array.from({ length: 60 }, () => entries).flat().map(text => [text]) });
  const analysis = hierarchy.analyzeDocument(document);
  assert.equal(analysis.rules[0].status, "style-budget-exceeded");
  assert.ok(analysis.rows.every(row => row.status === "review"));
});

test("invalid inferred parent positions reject the publication transaction", async t => {
  const f = await parsingFixture(t);
  const parser = f.parsers.resolve(f.input.parser), process = parser.process.bind(parser);
  parser.process = async context => {
    const result = await process(context);
    if (result) result.document.blocks.push({ type: "heading", label: "paragraph_title", markdown: "## Bad parent", text: "Bad parent", page: 1, sourceID: "bad", bbox: null, headingLevel: 2, headingParentOrder: 999 });
    return result;
  };
  const id = await f.enqueue(); await f.step(); await f.step();
  assert.equal((await f.job(id)).state, "failed");
  assert.equal((await f.db.selectFrom("content_generations").selectAll().execute()).length, 0);
  assert.equal((await f.db.selectFrom("structure_nodes").selectAll().execute()).length, 0);
});

test("approved ancestry survives intervening unnumbered headings with provisional provider levels", async t => {
  const source = page();
  source.prunedResult.parsing_res_list.push(...["（一）Methods", "# General aside", "一、Data", "### Subsection narrative", "二、Model", "（二）Results"].map((text, index) => ({ block_label: "paragraph_title", block_content: text, block_id: index + 2 })));
  const f = await parsingFixture(t, { download: async () => bytes(result([source])) });
  const id = await f.enqueue(); await f.step(); await f.step();
  assert.equal((await f.job(id)).state, "succeeded");
  const nodes = await f.db.selectFrom("structure_nodes").selectAll().execute();
  const parent = nodes.find(n => n.label === "（一）Methods"), child = nodes.find(n => n.label === "Subsection narrative");
  assert.equal(child.parent_id, parent.id);
  assert.equal(child.depth, 2);
});
