import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { api, parsingFixture, bytes, result } from "./fixtures/parsing.mjs";
import { mineruFiles, png, zip } from "./fixtures/mineru.mjs";

const repeatedPages = () => Array.from({ length: 4 }, (_, index) => ({
  prunedResult: { width: 600, height: 1000, parsing_res_list: [
    { block_label: index ? "paragraph_title" : "doc_title", block_content: index ? "Synthetic issue label" : "Synthetic paper", block_bbox: [40, 40, 400, 60], block_id: 1 },
    { block_label: "text", block_content: `Unique synthetic paragraph ${index}.`, block_bbox: [40, 150, 550, 850], block_id: 2 },
  ] }, markdown: { images: {} },
}));

for (const [provider, normalizers] of [["paddleocr", ["paddleocr-vl-1", "paddleocr-vl-2", "paddleocr-vl-3", "paddleocr-vl-4", "paddleocr-vl-5", "paddleocr-vl-6", "paddleocr-vl-7", "paddleocr-vl-8", "paddleocr-vl-9", "paddleocr-vl-10", "paddleocr-vl-11", "paddleocr-vl-12", "paddleocr-vl-13", "paddleocr-vl-14"]], ["mineru", ["mineru-v4-1", "mineru-v4-2", "mineru-v4-3", "mineru-v4-4"]]]) {
  for (const accepted of normalizers) test(`${provider} resumes ${accepted} without relabeling its output or changing the accepted identity`, async t => {
    const pages = repeatedPages(), entries = pages.flatMap((page, page_idx) => page.prunedResult.parsing_res_list.map(block => ({
      type: "text", text: block.block_content, ...(block.block_label !== "text" ? { text_level: 1 } : {}), page_idx,
      bbox: block.block_bbox.map((value, axis) => axis % 2 ? value : value * 1000 / 600),
    })));
    const raw = provider === "mineru" ? zip([...mineruFiles(entries, [0, 1, 2, 3])]) : bytes(result(pages));
    const f = await parsingFixture(t, {
      async progress() { return { state: "done", resultURL: "https://fixture.example/result", total: 4 }; }, async download() { return raw; },
    });
    if (provider === "mineru") {
      f.config.current = api.validateParsingConfig({ ...f.config.current, activeProfile: "mineru",
        profiles: { ...f.config.current.profiles, mineru: { ...api.defaultParserProfile("mineru"), key: "synthetic-key" } } });
      f.parsers.resolve(api.parserIdentity(f.config.current.profiles.mineru, "mineru")).client = {
        allocate() { throw Error("Unexpected submission"); }, upload() { throw Error("Unexpected upload"); },
        async progress() { return { state: "done", resultURL: "https://fixture.example/result", total: 4 }; }, async download() { return raw; },
      };
    }
    f.input.parser = { ...api.parserIdentity(f.config.current.profiles[provider], provider), normalizer: accepted };
    const acceptedIdentity = api.canonicalParserJSON(f.input.parser), id = await f.enqueue(), job = await f.repository.claim(f.worker.owner);
    const dedup = job.dedup_key;
    await f.repository.reserveSubmission(job, 2);
    await f.repository.checkpoint(job, { phase: "poll" }, { external_job_id: "previously-accepted", submission_state: "confirmed", stage: "polling" });
    await f.repository.finish(job, "waiting"); await f.step();
    const finished = await f.job(id), run = await f.repository.run(finished);
    assert.equal(finished.state, "succeeded"); assert.equal(f.submissions, 0);
    assert.equal(run.external_job_id, "previously-accepted"); assert.equal(run.normalizer_version, accepted);
    assert.equal(api.canonicalParserJSON(JSON.parse(finished.payload_json).parser), acceptedIdentity);
    assert.equal(finished.dedup_key, dedup);
    const profile = await f.db.selectFrom("provider_profiles").selectAll().where("id", "=", run.provider_profile_id).executeTakeFirstOrThrow();
    assert.equal(profile.config_json, acceptedIdentity);
    const generation = await f.db.selectFrom("content_generations").selectAll().where("id", "=", finished.generation_id).executeTakeFirstOrThrow();
    const legacy = accepted === "paddleocr-vl-1";
    assert.equal(generation.normalizer_version, legacy ? accepted : api.parserDefinition(provider).normalizer);
    const headings = await f.db.selectFrom("content_blocks").select("content_markdown").where("generation_id", "=", generation.id).execute();
    assert.equal(headings.filter(block => block.content_markdown.includes("Synthetic issue label")).length, legacy ? 3 : 0);
    assert.equal(JSON.parse(generation.warnings_json).some(warning => warning.startsWith("running-margin-removed:")), !legacy);
  });
}

test("the worker rejects missing, unknown and foreign output normalizers before publication", async t => {
  for (const normalizerVersion of [undefined, "unknown-version", api.parserDefinition("mineru").normalizer]) {
    const f = await parsingFixture(t), id = await f.enqueue(); await f.step();
    f.parsers.resolve(f.input.parser).process = async () => ({ document: { ...api.parsePaddleResult(result()), normalizerVersion } });
    await f.step();
    assert.equal((await f.job(id)).error_code, "format");
    assert.equal((await f.repository.sourceFor(1, "PDFKEY01")).active_generation_id, null);
    assert.equal((await f.db.selectFrom("content_generations").selectAll().execute()).length, 0);
  }
});

const textPage = (number, text, extra = {}) => ({ number, raw: { prunedResult: { width: 600, height: 1000,
  parsing_res_list: [{ block_label: "text", block_content: text, block_bbox: [40, 150, 550, 850], ...extra }] }, markdown: { images: {} } } });

const imageBlock = (label, content, id) => ({ block_label: label, block_content: content, block_id: id, block_bbox: [40, 200, 550, 300] });
const imagePage = (number, blocks) => ({ number, raw: { prunedResult: { width: 600, height: 1000, parsing_res_list: blocks }, markdown: { images: {} } } });
const visualGroup = () => [imageBlock("figure_title", "Figure 1. Caption", 1), imageBlock("image", "![](images/figure.png)", 2), imageBlock("vision_footnote", "Source note.", 3)];

test("image-interrupted prose merges without absorbing or reordering visual content and raw locations", () => {
  for (const [before, after, expected] of [["The model uses", "a shared representation.", "The model uses a shared representation."],
    ["模型利用", "共同的表示。", "模型利用共同的表示。"]]) {
    const pages = [imagePage(1, [imageBlock("text", before, 0), ...visualGroup(), imageBlock("text", after, 4), imageBlock("text", "A separate paragraph.", 5)])];
    const snapshot = JSON.stringify(pages), blocks = api.buildCanonicalBlocks(pages);
    assert.equal(JSON.stringify(pages), snapshot);
    assert.deepEqual(blocks.map(block => block.label), ["text", "figure_title", "image", "vision_footnote", "text"]);
    assert.equal(blocks[0].markdown, expected);
    assert.deepEqual(blocks[0].sourceIDs, ["0", "4"]);
    assert.deepEqual(blocks[0].locations.map(location => location.sourceID), ["0", "4"]);
    assert.deepEqual([blocks[0].page, blocks[0].pageEnd], [1, 1]);
    assert.equal(blocks[0].metadata.cross_image_merged, true);
    assert.equal(blocks[0].metadata.cross_page_merged, false);
    assert.equal(blocks[1].markdown, '<div style="text-align: center;">Figure 1. Caption</div>');
    assert.equal(blocks[3].markdown, "> Source note.");
    assert.ok(api.paddlePagesToMarkdown(pages).includes(`\n${expected}\n\n`));
    assert.equal(blocks.at(-1).markdown, "A separate paragraph.");
  }
});

test("image and ordinary page continuations compose through repeated interruptions", () => {
  const pages = [imagePage(1, [imageBlock("text", "The first", 0), ...visualGroup()]),
    imagePage(2, [imageBlock("text", "middle", 4), imageBlock("chart", "![](images/chart.png)", 5), imageBlock("text", "fragment", 6)]),
    imagePage(3, [imageBlock("text", "continues", 7)]), imagePage(4, [imageBlock("text", "to the final sentence.", 8)])];
  const blocks = api.buildCanonicalBlocks(pages), prose = blocks.filter(block => block.type === "paragraph");
  assert.equal(prose.length, 1);
  assert.equal(prose[0].markdown, "The first middle fragment continues to the final sentence.");
  assert.deepEqual(prose[0].sourceIDs, ["0", "4", "6", "7", "8"]);
  assert.deepEqual(prose[0].locations.map(location => location.page), [1, 2, 2, 3, 4]);
  assert.deepEqual([prose[0].page, prose[0].pageEnd], [1, 4]);
  assert.equal(prose[0].metadata.cross_image_merged, true);
  assert.equal(prose[0].metadata.cross_page_merged, true);
  assert.equal(blocks.filter(block => block.type === "image").length, 2);
});

test("visual merging stops at sentence, keyword, section, nonvisual and missing-page boundaries", () => {
  const before = imageBlock("text", "An unfinished paragraph", 0), after = imageBlock("text", "continued text.", 4);
  const pairs = [[{ ...before, block_content: "A completed sentence." }, after], [before, { ...after, block_content: "Keywords: model; data" }],
    [{ ...before, block_content: "关键词：模型；数据" }, after], [before, { ...after, block_content: "1. A new numbered section" }],
    [{ ...before, block_content: "- A list item" }, after], [before, { ...after, block_content: "<div>A separate HTML block.</div>" }]];
  for (const [first, last] of pairs) assert.equal(api.buildCanonicalBlocks([imagePage(1, [first, ...visualGroup(), last])]).filter(b => b.type === "paragraph").length, 2);
  for (const label of ["paragraph_title", "doc_title", "table_title", "display_formula", "formula_number", "unknown"]) {
    const blocks = api.buildCanonicalBlocks([imagePage(1, [before, ...visualGroup(), imageBlock(label, "Boundary", 9), after])]);
    assert.ok(!blocks.some(block => block.metadata.cross_image_merged), label);
    const empty = api.buildCanonicalBlocks([imagePage(1, [before, ...visualGroup(), imageBlock(label, "", 9), after])]);
    assert.ok(!empty.some(block => block.metadata.cross_image_merged), "Empty " + label);
  }
  for (const middle of [[], [imagePage(2, [])]]) {
    const blocks = api.buildCanonicalBlocks([imagePage(1, [before, ...visualGroup()]), ...middle, imagePage(3, [after])]);
    assert.ok(!blocks.some(block => block.metadata.cross_image_merged));
  }
  assert.equal(api.buildCanonicalBlocks([imagePage(1, [before, after])]).length, 2, "Adjacent same-page paragraphs stay separate");
  for (const group of [[imageBlock("figure_title", "Detached caption", 1)], [imageBlock("footnote", "Detached note", 2)]]) {
    assert.ok(!api.buildCanonicalBlocks([imagePage(1, [before, ...group, after])]).some(block => block.metadata.cross_image_merged));
  }
});

test("page footnotes and visual notes stay independent while interrupted image prose rejoins", () => {
  const before = imageBlock("text", "The model uses", 0), after = imageBlock("text", "a shared representation.", 4), note = imageBlock("footnote", "Figure note.", 3);
  const same = api.buildCanonicalBlocks([imagePage(1, [before, ...visualGroup(), note, after])]);
  assert.equal(same[0].markdown, "The model uses a shared representation.");
  const across = api.buildCanonicalBlocks([imagePage(1, [before, note]), imagePage(2, [...visualGroup(), after])]);
  assert.equal(across[0].markdown, "The model uses a shared representation.");
  assert.equal(across[0].metadata.cross_image_merged, true);
  assert.equal(across[0].metadata.cross_note_merged, true);
  assert.deepEqual(across[0].sourceIDs, ["0", "4"]);
  assert.deepEqual(across.map(b => b.label), ["text", "footnote", "figure_title", "image", "vision_footnote"]);
});

test("notes alone can interrupt the same paragraph on one or consecutive pages", () => {
  for (const label of ["footnote", "vision_footnote"]) for (const splitPage of [false, true]) {
    const before = imageBlock("text", "The agreement permits", 0), note = imageBlock(label, "Independent source note.", 1), after = imageBlock("text", "a later sale.", 2);
    const pages = splitPage ? [imagePage(1,[before,note]),imagePage(2,[after])] : [imagePage(1,[before,note,after])];
    const snapshot=JSON.stringify(pages), blocks=api.buildCanonicalBlocks(pages);
    assert.equal(blocks[0].markdown,"The agreement permits a later sale.");
    assert.deepEqual(blocks[0].sourceIDs,["0","2"]);
    assert.equal(blocks[0].metadata.cross_note_merged,true);
    assert.equal(blocks[0].metadata.cross_page_merged,splitPage);
    assert.equal(blocks[1].markdown,"> Independent source note.");
    assert.equal(JSON.stringify(pages),snapshot);
  }
});

test("sentence stops remain hard boundaries across notes even before parenthetical explanations", () => {
  const note=imageBlock("footnote","15 A note with $m_b$.",1);
  for(const prefix of ["(i.e.,","(e.g.,"]) {
    const pages=[imagePage(1,[imageBlock("text","The buyer pays rent.",0),note]),imagePage(2,[imageBlock("text",prefix+" $P_t H$). Next, the buyer pays maintenance.",2)])];
    const blocks=api.buildCanonicalBlocks(pages);
    assert.equal(blocks.filter(b=>b.type==="paragraph").length,2);
    assert.equal(blocks[0].markdown,"The buyer pays rent.");
    assert.deepEqual(blocks[0].sourceIDs,["0"]);
    assert.equal(blocks[1].label,"footnote");
    const dom=new JSDOM("<html><body></body></html>");
    try{const fragment=api.renderMarkdown(dom.window.document,blocks.map(b=>b.markdown).join("\n\n"),()=>{}).fragment;
      assert.equal(fragment.querySelectorAll("details").length,1);
      assert.equal(fragment.querySelector("p").textContent,"The buyer pays rent.");
      assert.ok(fragment.querySelector("p math"));
    }finally{dom.window.close();}
  }
  for(const ending of ["A completed sentence.","A completed sentence. $ ^{9} $","A completed sentence. ⁹",'A completed sentence."',"中文完整句子。","Keywords: rent; maintenance"]) {
    const blocks=api.buildCanonicalBlocks([imagePage(1,[imageBlock("text",ending,0),note]),imagePage(2,[imageBlock("text","A separate paragraph.",2)])]);
    assert.equal(blocks.filter(b=>b.type==="paragraph").length,2,ending);
  }
  const adjacent=api.buildCanonicalBlocks([imagePage(1,[imageBlock("text","A completed sentence.",0),imageBlock("text","(i.e., $P_t$).",2)])]);
  assert.equal(adjacent.length,2,"No interruption evidence means no same-page merge");
});

test("a paragraph spanning three physical pages retains all zero/fallback IDs and locations", () => {
  const pages = [textPage(1, "First fragment", { global_block_id: 0, block_id: 9 }), textPage(2, "middle fragment"), textPage(3, "final fragment.", { block_id: 7 })];
  const before = JSON.stringify(pages), blocks = api.buildCanonicalBlocks(pages);
  assert.equal(JSON.stringify(pages), before); assert.equal(blocks.length, 1);
  assert.equal(blocks[0].markdown, "First fragment middle fragment final fragment.");
  assert.deepEqual([blocks[0].page, blocks[0].pageEnd], [1, 3]);
  assert.deepEqual(blocks[0].sourceIDs, ["0", "2:0", "7"]);
  assert.deepEqual(blocks[0].locations.map(location => [location.page, location.sourceID]), [[1, "0"], [2, "2:0"], [3, "7"]]);
});

test("multi-page paragraph continuation stops at gaps, blank pages, headings and completed sentences", () => {
  const first = textPage(1, "First fragment"), third = textPage(3, "final fragment.");
  for (const middle of [undefined, { number: 2, raw: { prunedResult: { parsing_res_list: [] } } }, textPage(2, "A detached page footnote.", { block_label: "footnote" }), textPage(2, "New section", { block_label: "paragraph_title" })]) {
    const blocks = api.buildCanonicalBlocks([first, ...(middle ? [middle] : []), third]);
    assert.equal(blocks.filter(block => block.type === "paragraph").length, 2);
    assert.ok(!blocks.some(block => block.pageEnd > block.page));
  }
  assert.equal(api.buildCanonicalBlocks([textPage(1, "A completed sentence."), textPage(2, "Another sentence.")]).length, 2);
});

test("keyword lists remain separate from adjacent-page prose with raw source boundaries intact", () => {
  for (const keyword of ["Keywords: Ulva prolifera; partial least squares regression analysis", "Key words: drying; moisture", "KEY-WORDS: test; analysis",
    "关键词：浒苔；热风烘干", "关键字: 论文；分析", "關鍵詞：測試；分析", "關鍵字：測試", "**Keywords**: drying; analysis", "<b>Keywords:</b> drying; analysis"]) {
    for (const before of [true, false]) {
      const body = "浒苔隶属于绿藻门，是一种常见的大型天然经济绿藻。";
      const pages = [textPage(1, before ? keyword : "An unfinished body paragraph", { global_block_id: 12 }),
        textPage(2, before ? body : keyword, { global_block_id: 22 }), textPage(3, "A new paragraph.", { block_label: "paragraph_title" })];
      const snapshot = JSON.stringify(pages), blocks = api.buildCanonicalBlocks(pages);
      assert.equal(JSON.stringify(pages), snapshot);
      assert.equal(blocks.length, 3, keyword);
      assert.ok(blocks.every(block => block.page === block.pageEnd));
      assert.deepEqual(blocks.slice(0, 2).map(block => block.sourceIDs), [["12"], ["22"]]);
      assert.ok(blocks[before ? 0 : 1].qualityFlags.includes("keyword_line"));
      const markdown = api.paddlePagesToMarkdown(pages);
      assert.ok(markdown.includes(`\n${keyword}\n\n`), keyword);
      assert.ok(!blocks.some(block => block.metadata.cross_page_merged));
    }
  }
  const paragraphs = api.buildCanonicalBlocks([textPage(1, "Keywords are useful for"), textPage(2, "searching a document.")]);
  assert.equal(paragraphs.length, 1, "Ordinary prose containing the word keywords still continues");
});

test("malformed PaddleOCR page layouts cannot publish as successful blank pages", () => {
  const valid = textPage(1, "Synthetic body.").raw;
  for (const malformed of [{}, { prunedResult: {} }, { prunedResult: { parsing_res_list: {} } },
    { prunedResult: { parsing_res_list: [null] } }, { prunedResult: { parsing_res_list: [{ block_content: { text: "Lost text" } }] } }]) {
    assert.throws(() => api.parsePaddleResult(result([valid, malformed]), 2), error => error.code === "format");
  }
  const blank = { prunedResult: { parsing_res_list: [] } }, parsed = api.parsePaddleResult(result([valid, blank]), 2);
  assert.equal(parsed.partial, false); assert.equal(parsed.pages.length, 2); assert.equal(parsed.blocks.length, 1);
});

test("Markdown and HTML image targets resolve exactly without changing prose, alt text or URL substrings", () => {
  const source = "images/figure(1).png", url = `https://fixture.example/${source}?a=1&b=2`, local = "images/local.png";
  const targets = new Map([[source, local], [url, local]]);
  const input = `${source}\n![A](<${url}> "Caption")\n![B](${source})\n![External](https://other.example/${source})\n<img alt="text src=${source}" src='${url.replaceAll("&", "&amp;")}'><img src=${source}/>`;
  const output = api.rewriteImageSources(input, source => targets.get(source));
  assert.ok(output.startsWith(`${source}\n`));
  assert.match(output, /!\[A\]\(<images\/local\.png> "Caption"\)/);
  assert.match(output, /!\[B\]\(images\/local\.png\)/);
  assert.ok(output.includes(`![External](https://other.example/${source})`));
  assert.ok(output.includes(`alt="text src=${source}"`));
  assert.equal((output.match(/src="images\/local\.png"/g) ?? []).length, 2);
});

test("PaddleOCR publishes HTML and signed-URL images as managed assets while preserving raw results", async t => {
  const relative = "images/figure.png", url = `https://fixture.example/files/${relative}?a=1&b=2`;
  const pages = [{ prunedResult: { parsing_res_list: [
    { block_label: "text", block_content: `The literal filename is ${relative}.`, block_id: 0 },
    { block_label: "table", block_content: `<table><tr><td><img alt="Chart" src="${url.replaceAll("&", "&amp;")}"></td></tr></table>`, block_id: 1 },
    { block_label: "image", block_content: `![Figure](<${url}> "Caption")`, block_id: 2 },
  ] }, markdown: { images: { [relative]: url } } }];
  const encoded = bytes(result(pages)), f = await parsingFixture(t, { async download(source) { return source.endsWith(".jsonl") ? encoded : png; } });
  const id = await f.enqueue(); await f.step(); await f.step(); assert.equal((await f.job(id)).state, "succeeded");
  const reader = await new api.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" });
  assert.ok(reader.markdown.includes(`The literal filename is ${relative}.`)); assert.doesNotMatch(reader.markdown, /https:/);
  const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close());
  const rendered = api.renderMarkdown(dom.window.document, reader.markdown, () => {}, reader.assets);
  assert.equal(rendered.fragment.querySelectorAll("img").length, 2);
  const raw = await f.db.selectFrom("parse_artifacts as a").innerJoin("stored_files as f", "f.id", "a.stored_file_id")
    .select("f.relative_path").where("a.artifact_key", "=", "raw.jsonl").executeTakeFirstOrThrow();
  assert.deepEqual(f.files.get(api.parseFilePath(raw.relative_path)), encoded);
});

test("MinerU rewrites angle-bracket and HTML image references and still rejects missing assets", async t => {
  await parsingFixture(t);
  const { document } = api.parseMinerUResult(mineruFiles([{ type: "table", page_idx: 0,
    table_body: '<table><tr><td><img src=images/figure.png></td></tr></table>\n\n![](<images/figure.png> "Figure")' }], [0]), 1);
  api.rewriteMinerUImages(document, new Map([["images/figure.png", "images/local.png"]]));
  assert.match(document.markdown, /src="images\/local\.png"/);
  assert.match(document.markdown, /!\[\]\(<images\/local\.png> "Figure"\)/);
  assert.throws(() => api.rewriteMinerUImages(document, new Map()), error => error.code === "format");
});

test("running-margin protection handles Markdown headings, full-width numbering and uncertain interior text", () => {
  const make = text => Array.from({ length: 6 }, (_, index) => ({ number: index + 1, height: 1000, blocks: [
    { id: `${index}:header`, text, kind: "heading", bbox: [40, 40, 400, 60] },
    { id: `${index}:body`, text: `Unique body ${index}.`, kind: "text", bbox: [40, 150, 550, 850] },
  ] }));
  for (const title of ["## 2.1 Robustness checks", "### （二）研究结果", "## ２．１ Robustness checks", "## Table 2 Continued values"]) {
    assert.equal(api.detectRunningMargins(make(title)).size, 0, title);
  }
  const pages = make("Synthetic repeated label");
  pages.push({ number: 7, blocks: [{ id: "uncertain", text: "Synthetic repeated label", kind: "text" }] });
  assert.equal(api.detectRunningMargins(pages).size, 0);
});

test("MinerU task details retain the upload stage until the binary PUT finishes", async t => {
  const f = await parsingFixture(t);
  f.config.current = api.validateParsingConfig({ ...f.config.current, activeProfile: "mineru",
    profiles: { ...f.config.current.profiles, mineru: { ...api.defaultParserProfile("mineru"), key: "synthetic-key" } } });
  f.input.parser = api.parserIdentity(f.config.current.profiles.mineru, "mineru");
  f.parsers.resolve(f.input.parser).client = {
    async allocate(_identity, _key, _name, dataID) { return { batchID: "allocated-batch", dataID, uploadURL: "https://fixture.example/upload" }; },
    async upload() {}, progress() { throw Error("Polling must follow upload"); },
  };
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers);
  f.beforeClose(() => service.close()); service.config.current = f.config.current;
  const id = await f.enqueue(); await f.step(); await service.refresh();
  assert.equal(service.snapshot().find(task => task.id === id).stage, "upload");
  await f.step(); await service.refresh(); assert.equal(service.snapshot().find(task => task.id === id).stage, "parse");
});

test("background synchronization retains published content across normalizer upgrades and provider changes", async t => {
  for (const partial of [false, true]) {
    const f = await parsingFixture(t, { async progress() { return { state: "done", total: partial ? 2 : 1, resultURL: "https://fixture.example/result" }; } });
    f.input.parser.normalizer = "paddleocr-vl-4";
    const id = await f.enqueue(), accepted = await f.repository.claim(f.worker.owner);
    await f.repository.reserveSubmission(accepted, 2);
    await f.repository.checkpoint(accepted, { phase: "poll" }, { external_job_id: "accepted-before-upgrade", submission_state: "confirmed", stage: "polling" });
    await f.repository.finish(accepted, "waiting"); await f.step();
    const published = await f.job(id), fingerprint = await f.port.hash((await f.port.attachment()).bytes);
    assert.equal(published.state, partial ? "partially_succeeded" : "succeeded");
    const identities = [api.parserIdentity(f.config.current.profiles.paddleocr, "paddleocr"),
      api.parserIdentity(api.defaultParserProfile("mineru"), "mineru")];
    for (const parser of identities) {
      assert.equal(await f.repository.enqueue({ ...f.input, parser }, fingerprint, 3, false, true), id);
    }
    await f.repository.hide(id);
    assert.equal(await f.repository.enqueue({ ...f.input, parser: identities[0] }, fingerprint, 3, false, true), id);
    assert.equal(JSON.parse((await f.job(id)).payload_json).hidden, true);
    assert.equal((await f.repository.list()).length, 1); assert.equal(f.submissions, 0);
    assert.equal((await f.repository.sourceFor(1, "PDFKEY01")).active_generation_id, published.generation_id);
    const explicit = await f.repository.enqueue({ ...f.input, parser: identities[0] }, fingerprint, 3, true);
    assert.notEqual(explicit, id);
    assert.equal(await f.repository.enqueue({ ...f.input, parser: identities[0] }, fingerprint, 3, false, true), explicit);
    await f.repository.cancel(explicit);
    f.setBytes(bytes("%PDF-1.7\nDifferent PDF after upgrade"));
    assert.notEqual(await f.repository.enqueue({ ...f.input, parser: identities[0] }, await f.port.hash((await f.port.attachment()).bytes), 3, false, true), id);
  }
});

test("background upgrades cannot bypass live tracking or restart unchanged failed/cancelled attempts", async t => {
  for (const state of ["running", "waiting", "needs_attention", "failed", "cancelled"]) {
    const f = await parsingFixture(t); f.input.parser.normalizer = "paddleocr-vl-4";
    const id = await f.enqueue(), job = await f.repository.claim(f.worker.owner);
    await f.repository.reserveSubmission(job, 2);
    await f.repository.checkpoint(job, { phase: "download" }, { external_job_id: "existing-accepted", submission_state: "confirmed", stage: "downloading" });
    if (state === "cancelled") await f.repository.cancel(id);
    else if (state !== "running") await f.repository.finish(job, state, state === "failed" ? "format" : state === "needs_attention" ? "credentials" : null);
    const fingerprint = await f.port.hash((await f.port.attachment()).bytes);
    const parser = api.parserIdentity(api.defaultParserProfile("mineru"), "mineru");
    assert.equal(await f.repository.enqueue({ ...f.input, parser }, fingerprint, 3, false, true), id, state);
    assert.equal((await f.job(id)).state, state); assert.equal((await f.repository.list()).length, 1);
    assert.equal((await f.repository.run(await f.job(id))).external_job_id, "existing-accepted");
  }
  const f = await parsingFixture(t); f.input.parser.normalizer = "paddleocr-vl-4";
  const stale = await f.enqueue(), job = await f.repository.claim(f.worker.owner);
  await f.repository.finish(job, "cancelled", "stale");
  const replacement = await f.repository.enqueue({ ...f.input, parser: api.parserIdentity(f.config.current.profiles.paddleocr, "paddleocr") },
    await f.port.hash((await f.port.attachment()).bytes), 3, false, true);
  assert.notEqual(replacement, stale);
});
