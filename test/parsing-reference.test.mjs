import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { api, bytes, result, parsingFixture } from "./fixtures/parsing.mjs";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/parsing-reference.json", import.meta.url), "utf8"));
// The historical oracle predates heading review diagnostics; retain its text,
// structure and original quality expectations independently of the new flag.
const project = block => Object.fromEntries(["type", "label", "markdown", "text", "page", "pageEnd", "sourceIDs", "qualityFlags"].map(key => [key,
  key === "qualityFlags" ? block.qualityFlags.filter(flag => flag !== "heading_hierarchy_uncertain") : block[key]]).concat([["metadata", { cross_page_merged: block.metadata.cross_page_merged }]]));
test("effective provider parameters match the integration defaults and preserve validated overrides", async (t) => {
  const f = await parsingFixture(t);
  const expected = {
    markdownIgnoreLabels: ["header", "header_image", "footer", "footer_image", "number", "footnote", "aside_text"],
    useDocOrientationClassify: false, useDocUnwarping: false, useLayoutDetection: true,
    useChartRecognition: false, useSealRecognition: false, useOcrForImageBlock: false,
    mergeTables: true, relevelTitles: true, layoutShapeMode: "auto", promptLabel: "ocr",
    repetitionPenalty: 1, temperature: 0, topP: 1, minPixels: 147384, maxPixels: 2822400,
    layoutNms: true, restructurePages: true,
  };
  assert.deepEqual(f.config.current.profiles.paddleocr.options, expected);
  const config = structuredClone(f.config.current);
  config.profiles.paddleocr.options = { temperature: 0.25, useChartRecognition: true, extensionOption: "preserved" };
  const valid = api.validateParsingConfig(config).profiles.paddleocr.options;
  assert.equal(valid.minPixels, 147384);
  assert.equal(valid.temperature, 0.25);
  assert.equal(valid.extensionOption, "preserved");
  for (const options of [{ topP: 0 }, { maxPixels: 100 }, { mergeTables: "true" }, { temperature: -1 }, { markdownIgnoreLabels: [1] }]) {
    config.profiles.paddleocr.options = options;
    assert.throws(() => api.validateParsingConfig(config), error => error.code === "config");
  }
  let submitted;
  f.provider.submit = async (parser) => { submitted = parser.options; return "remote"; };
  await f.enqueue();
  await f.step();
  assert.deepEqual(submitted, expected);
});
for (const [index, entry] of fixture.cases.entries())
  test(`normalization matches original Python oracle: synthetic case ${index + 1}`, () => {
    const pages = entry.pages.map((raw, i) => ({ raw, number: raw._parse_page_number ?? i + 1 }));
    const original = JSON.stringify(pages);
    assert.deepEqual(api.buildCanonicalBlocks(pages).map(project), entry.expected.blocks);
    assert.equal(api.paddlePagesToMarkdown(pages), entry.expected.markdown);
    assert.equal(JSON.stringify(pages), original, "Raw layout must remain unchanged");
    const document = api.parsePaddleResult(result(entry.pages));
    assert.deepEqual(document.detectedMetadata, entry.expected.detectedMetadata);
  });
test("reference section hierarchy, merged locations, quality and metadata are published atomically", async (t) => {
  const pages = structuredClone(fixture.cases[0].pages);
  const f = await parsingFixture(t, { progress: async () => ({ state: "done", total: 4, resultURL: "https://fixture.example/result" }), download: async () => bytes(result(pages)) });
  const id = await f.enqueue();
  await f.step();
  await f.step();
  assert.equal((await f.job(id)).state, "succeeded");
  const nodes = await f.db.selectFrom("structure_nodes").selectAll().orderBy("path").execute();
  assert.deepEqual(nodes.map(n => [n.path, n.label, n.depth, n.sort_order]), [["/", "\u4E2D\u6587\u5408\u6210\u8BBA\u6587", 0, 0], ["/1", "\u4E00\u3001\u65B9\u6CD5", 1, 0], ["/1/1", "Details", 2, 0], ["/2", "\u4E8C\u3001\u7ED3\u679C", 1, 1]]);
  const blocks = await f.db.selectFrom("content_blocks").selectAll().orderBy("canonical_order").execute();
  assert.equal(blocks[0].structure_node_id, nodes[0].id, "Document title is not a section");
  const merged = blocks.find(b => b.content_markdown.startsWith("This paragraph"));
  assert.deepEqual([merged.page_start, merged.page_end], [2, 3]);
  assert.deepEqual(JSON.parse(merged.source_block_ids_json), ["g5", "g7"]);
  assert.deepEqual(JSON.parse(merged.locations_json).map(v => v.page), [2, 3]);
  assert.equal(nodes[1].page_end, 4, "Ancestor range includes nested section content");
  assert.equal(blocks.find(b => b.block_type === "footnote").content_role, "note");
  assert.ok(JSON.parse(blocks.find(b => b.content_markdown.startsWith("Keywords:")).quality_flags_json).includes("keyword_line"));
  const resource = await f.db.selectFrom("knowledge_resources").selectAll().executeTakeFirstOrThrow();
  assert.equal(resource.title, "Synthetic paper");
  assert.equal(resource.language, "en");
  assert.equal(JSON.parse(resource.metadata_json).detected_title, "\u4E2D\u6587\u5408\u6210\u8BBA\u6587");
  assert.match(resource.abstract, /这是跨页摘要/);
  assert.equal((await f.db.selectFrom("block_embeddings").selectAll().execute()).length, 0);
});

test("partial chunks retain physical page gaps, failure lines and review states", async t => {
  const page = fixture.cases[1].pages[0];
  const raw = [result([page]), "", JSON.stringify({ result: { dataInfo: { numPages: 2 }, layoutParsingResults: [] } }), JSON.stringify({ errorCode: 500 }), result([page])].join("\n");
  const parsed = api.parsePaddleResult(raw, 6);
  assert.deepEqual(parsed.pages.map(page => page.number), [1, 6]);
  assert.deepEqual(parsed.errors, [{ line: 4, error_code: 500, error_message: null, page_start: 4, page_end: 5 }]);
  const f = await parsingFixture(t, { progress: async () => ({ state: "done", total: 6, resultURL: "https://fixture.example/result" }), download: async () => bytes(raw) });
  const id = await f.enqueue(); await f.step(); await f.step();
  assert.equal((await f.job(id)).state, "partially_succeeded");
  assert.ok((await f.db.selectFrom("content_blocks").selectAll().execute()).every(block => block.review_status === "needs_review"));
  assert.ok((await f.db.selectFrom("structure_nodes").selectAll().execute()).every(node => node.review_status === "needs_review"));
});
test("page-scoped images, raw normalized pages and local artifacts survive publication without temporary URL dependencies", async (t) => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const pages = [1, 2].map(n => ({ prunedResult: { parsing_res_list: [{ block_label: "image", block_content: "![Figure](images/same.png)", block_id: n }] }, markdown: { images: { "images/same.png": `https://fixture.example/embedded${n}` } }, inputImage: `https://fixture.example/page${n}` }));
  const f = await parsingFixture(t, { progress: async () => ({ state: "done", total: 2, resultURL: "https://fixture.example/result" }), download: async (url) => url.endsWith("/result") ? bytes(result(pages)) : png });
  const id = await f.enqueue();
  await f.step();
  await f.step();
  assert.equal((await f.job(id)).state, "succeeded");
  const artifacts = await f.db.selectFrom("parse_artifacts as a").innerJoin("stored_files as f", "f.id", "a.stored_file_id").selectAll().execute();
  assert.deepEqual(artifacts.filter(a => a.artifact_type === "page_image").map(a => a.page_number), [1, 2]);
  assert.equal(artifacts.filter(a => a.artifact_type === "image").length, 2);
  const normalized = artifacts.find(a => a.artifact_key === "normalized.json");
  const original = JSON.parse(new TextDecoder().decode(f.files.get(api.parseFilePath(normalized.relative_path))));
  assert.equal(original[0].markdown.images["images/same.png"], "https://fixture.example/embedded1");
  const reader = await new api.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" });
  assert.equal(Object.keys(reader.assets).length, 2);
  assert.ok(!reader.markdown.includes("https:"));
  assert.ok(!reader.markdown.includes("same.png"));
  const md = artifacts.find(a => a.artifact_key === "document.md");
  assert.match(new TextDecoder().decode(f.files.get(api.parseFilePath(md.relative_path))), /<!-- page 2;/);
});
for (const normalizer of ["paddleocr-vl-1", "paddleocr-vl-2", "paddleocr-vl-3", "paddleocr-vl-4"]) test(`confirmed ${normalizer} work keeps its identity; unsubmitted work adopts the current normalizer`, async (t) => {
  const f = await parsingFixture(t);
  f.input.parser.normalizer = normalizer;
  const id = await f.enqueue();
  await f.step();
  assert.equal((await f.repository.run(await f.job(id))).normalizer_version, api.NORMALIZER_VERSION);
  // Simulate a confirmed task left by the previous release, without resubmitting it.
  const job = await f.job(id), payload = JSON.parse(job.payload_json);
  payload.parser.normalizer = normalizer;
  await f.db.updateTable("processing_jobs").set({ payload_json: JSON.stringify(payload) }).where("id", "=", id).execute();
  await f.db.updateTable("parse_runs").set({ normalizer_version: normalizer }).where("job_id", "=", id).execute();
  await f.step();
  assert.equal((await f.job(id)).state, "succeeded");
  assert.equal(f.submissions, 1);
  const generation = await f.db.selectFrom("content_generations").selectAll().executeTakeFirstOrThrow();
  assert.equal((await f.repository.run(await f.job(id))).normalizer_version, normalizer);
  assert.equal(generation.normalizer_version, normalizer === "paddleocr-vl-1" ? normalizer : api.NORMALIZER_VERSION);
});

test("empty PaddleOCR image/chart blocks resolve exact page-local crops and publish readable local images", async t => {
  const key = "imgs/img_in_chart_box_10_20_110_120.jpg", headerKey = "imgs/img_in_header_image_box_0_0_100_10.jpg";
  const pages = [1, 2].map(n => ({ prunedResult: { width: 600, height: 800, parsing_res_list: [
    { block_label: "header_image", block_content: "", block_id: n * 10, block_bbox: [0, 0, 100, 10] },
    { block_label: "text", block_content: "A synthetic paragraph without ending punctuation", block_id: n * 10 + 1 },
    { block_label: "chart", block_content: "", block_id: n * 10 + 2, block_bbox: [10, 20, 110, 120] },
  ] }, markdown: { images: { [key]: `https://fixture.example/chart-${n}`, [headerKey]: `https://fixture.example/header-${n}` } } }));
  const original = JSON.stringify(pages), parsed = api.parsePaddleResult(result(pages));
  assert.equal(JSON.stringify(pages), original);
  const prose = parsed.blocks.filter(block => block.type === "paragraph");
  assert.equal(prose.length, 1, "A chart can interrupt an unfinished paragraph across consecutive pages");
  assert.deepEqual(prose[0].sourceIDs, ["11", "21"]);
  assert.deepEqual([prose[0].page, prose[0].pageEnd], [1, 2]);
  assert.equal(prose[0].metadata.cross_image_merged, true);
  assert.deepEqual(parsed.blocks.filter(block => block.type === "image").map(block => [block.page, block.bbox, block.metadata.image_reference]), [[1, [10, 20, 110, 120], key], [2, [10, 20, 110, 120], key]]);
  assert.doesNotMatch(parsed.markdown, /!\[\]\(<https:\/\/fixture.example\/header-/);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]), downloads = [];
  const f = await parsingFixture(t, { progress: async () => ({ state: "done", total: 2, resultURL: "https://fixture.example/result" }),
    download: async url => { downloads.push(url); return url.endsWith("/result") ? bytes(result(pages)) : png; } });
  const id = await f.enqueue(); await f.step(); await f.step(); assert.equal((await f.job(id)).state, "succeeded");
  assert.ok(downloads.includes("https://fixture.example/chart-1") && downloads.includes("https://fixture.example/chart-2"));
  const reader = await new api.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" });
  assert.equal((reader.markdown.match(/!\[\]\(/g) ?? []).length, 2);
  assert.match(reader.markdown, /images\/page-1-/); assert.match(reader.markdown, /images\/page-2-/);
  assert.doesNotMatch(reader.markdown, /https:|img_in_chart/);
  const saved = await f.db.selectFrom("content_blocks").selectAll().where("generation_id", "=", (await f.job(id)).generation_id).orderBy("canonical_order").execute();
  assert.deepEqual(saved.map(block => block.block_type), ["paragraph", "image", "image"]);
  assert.deepEqual(JSON.parse(saved[0].source_block_ids_json), ["11", "21"]);
  assert.equal(JSON.parse(saved[0].metadata_json).cross_image_merged, true);
  for (const target of [...reader.markdown.matchAll(/!\[\]\(<([^>]+)>\)/g)].map(match => match[1])) assert.ok(reader.assets[target]);
});

test("PaddleOCR crop association rejects wrong labels, boxes and duplicate matches without changing raw pages", () => {
  const block = { block_label: "image", block_content: "", block_id: 1, block_bbox: [10, 20, 110, 120] };
  for (const images of [
    { "imgs/img_in_chart_box_10_20_110_120.jpg": "https://fixture.example/wrong-type" },
    { "imgs/img_in_image_box_11_20_110_120.jpg": "https://fixture.example/wrong-box" },
    { "imgs/img_in_image_box_10_20_110_120.jpg": "https://fixture.example/one", "imgs/img_in_image_box_10_20_110_120.png": "https://fixture.example/two" },
  ]) {
    const pages = [{ number: 1, raw: { prunedResult: { parsing_res_list: [block] }, markdown: { images } } }], original = JSON.stringify(pages);
    assert.equal(api.buildCanonicalBlocks(pages).length, 0);
    assert.equal(JSON.stringify(pages), original);
  }
});
