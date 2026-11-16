import assert from "node:assert/strict";
import { test } from "node:test";
import { api, result } from "./fixtures/parsing.mjs";
import { mineruFiles } from "./fixtures/mineru.mjs";

const block = (id, text, y, kind = "text", extra = {}) => ({ id, text, kind, bbox: [50, y, 400, y + 15], ...extra });
const pages = (make, count = 10) => Array.from({ length: count }, (_, i) => ({ number: i + 1, height: 1000, blocks: make(i + 1) }));
const sample = (number, text = "Synthetic issue label", y = 60, kind = "heading") => [
  block(`${number}:0`, number === 1 ? "Different front matter" : text, y, kind),
  block(`${number}:1`, `Body paragraph on page ${number} with several ordinary sentences.`, 160),
  block(`${number}:2`, `Unique ending ${number}.`, 850),
];

test("running margins detect daily and alternating short lines, retain the first page and record cadence", () => {
  const input = pages(n => [block(`${n}:top1`, n % 2 ? "Synthetic Journal" : "Synthetic paper label", 30, "header"),
    block(`${n}:top2`, n % 2 ? "Volume 12 Issue 3" : "Special issue call", 60, "heading"),
    block(`${n}:body`, `Unique body ${n}.`, 200), block(`${n}:bottom`, "© Synthetic Press", 940), block(`${n}:number`, String(n), 975, "other")]);
  const before = JSON.stringify(input), removed = api.detectRunningMargins(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(removed.size, 27);
  assert.ok(![...removed.values()].some(value => value.page === 1));
  assert.equal(removed.get("4:top2").cadence, 2);
  assert.equal(removed.get("5:bottom").edge, "footer");
  assert.equal(removed.get("5:bottom").cadence, 1);
});

test("margin safeguards retain numbered/standard headings, sentences, captions, notes and missing locations", () => {
  for (const text of ["一、研究方法", "（二）研究结果", "1 Introduction", "2.1 Results", "III Results", "Appendix A", "Results", "参考文献", "A short ordinary sentence.", "重复的正常正文。", "Source: synthetic data", "图 2 合成图注", "Table A1 Continued results"]) {
    assert.equal(api.detectRunningMargins(pages(n => sample(n, text))).size, 0, text);
  }
  assert.equal(api.detectRunningMargins(pages(n => sample(n).map(value => ({ ...value, bbox: undefined })))).size, 0);
  assert.equal(api.detectRunningMargins(pages(n => sample(n).map(value => ({ ...value, protected: true })))).size, 0);
  assert.equal(api.detectRunningMargins(pages(n => sample(n, "Synthetic caption", 60, "other"))).size, 0);
});

test("sparse, unstable, duplicate or interior repetitions do not prove running margins", () => {
  assert.equal(api.detectRunningMargins(pages(n => sample(n, n <= 4 ? "Repeated label" : `Different label ${n}`))).size, 0);
  assert.equal(api.detectRunningMargins(pages(n => sample(n, "Repeated label", [20, 50, 80][n % 3]))).size, 0);
  assert.equal(api.detectRunningMargins(pages(n => [block(`${n}:0`, "Repeated label", 25), block(`${n}:1`, "Repeated label", 60), block(`${n}:2`, "Body sentence.", 200)])).size, 0);
  const interior = pages(n => [...sample(n, "Repeated label"), ...(n === 4 ? [block(`${n}:middle`, "Repeated label", 500)] : [])]);
  assert.equal(api.detectRunningMargins(interior).size, 0);
  assert.equal(api.detectRunningMargins([2, 8, 14].map(number => ({ number, height: 1000, blocks: sample(number) }))).size, 0);
});

test("PaddleOCR removes alternating false headings before merging, keeping raw pages and source IDs", () => {
  const raw = Array.from({ length: 9 }, (_, i) => {
    const n = i + 1;
    return { prunedResult: { width: 600, height: 1000, parsing_res_list: [
      { block_label: n === 1 ? "doc_title" : "header", block_content: n === 1 ? "Synthetic paper" : n % 2 ? "Synthetic Journal" : "Synthetic paper label", block_bbox: [50, 30, 400, 45], block_id: 0 },
      ...(n === 1 ? [] : [{ block_label: n % 2 ? "text" : "paragraph_title", block_content: n % 2 ? "Volume 12 Issue 3" : "Special issue call", block_bbox: [50, 60, 400, 75], block_id: 1 }]),
      { block_label: "text", block_content: `continuation on page ${n} without punctuation`, block_bbox: [50, 160, 550, 850], block_id: 2 },
    ] }, markdown: { images: {} } };
  });
  const before = JSON.stringify(raw), parsed = api.parsePaddleResult(result(raw), 9);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(JSON.stringify(parsed.pages.map(page => page.raw)), before);
  assert.doesNotMatch(parsed.markdown, /Special issue call|Volume 12 Issue 3/);
  assert.ok(parsed.blocks.some(block => block.page === 1 && block.pageEnd === 9 && block.sourceIDs.length === 9));
  assert.equal(parsed.blocks.filter(block => block.type === "heading").length, 1);
  assert.equal(parsed.warnings.filter(value => value.startsWith("running-margin-removed:")).length, 16);
  assert.equal(parsed.detectedMetadata.title, "Synthetic paper");
});

test("MinerU removes misclassified running headings/footers before section creation and retains raw content", () => {
  const entries = Array.from({ length: 8 }, (_, page_idx) => [
    { type: "text", text: page_idx === 0 ? "Synthetic paper" : "Special issue call", text_level: 1, page_idx, bbox: [50, 35, 600, 65] },
    { type: "text", text: `1.${page_idx} Real section`, text_level: 2, page_idx, bbox: [50, 160, 600, 200] },
    { type: "text", text: `Body paragraph ${page_idx} with ordinary content.`, page_idx, bbox: [50, 230, 900, 800] },
    { type: "text", text: "© Synthetic Press", page_idx, bbox: [50, 940, 600, 960] },
  ]).flat();
  const parsed = api.parseMinerUResult(mineruFiles(entries, Array.from({ length: 8 }, (_, i) => i)), 8).document;
  assert.doesNotMatch(parsed.markdown, /Special issue call/);
  assert.equal(parsed.blocks.filter(block => block.text.includes("© Synthetic Press")).length, 1);
  assert.equal(parsed.blocks.filter(block => block.type === "heading").length, 9);
  assert.equal(parsed.pages.flatMap(page => page.raw.mineru.content).length, entries.length);
  assert.equal(parsed.warnings.filter(value => value.startsWith("running-margin-removed:")).length, 14);
  const broken = structuredClone(entries); broken[8].text_level = 9;
  assert.throws(() => api.parseMinerUResult(mineruFiles(broken, Array.from({ length: 8 }, (_, i) => i)), 8), error => error.code === "format");
});

test("isolated second-line headers extend to 15 percent with alternating cadence and title safeguards", () => {
  const input = pages(n => [block(`${n}:first`, "Synthetic Journal", 30, "header"),
    block(`${n}:second`, n % 2 ? "Volume 12 Issue 3" : "Business Studies", 135, "heading"),
    block(`${n}:body`, `Body paragraph ${n}.`, 200)]);
  const removed = api.detectRunningMargins(input);
  assert.equal([...removed.values()].filter(value => value.id.endsWith(":second")).length, 9);
  assert.equal(removed.get("4:second").cadence, 2);
  for (const title of ["一、研究设计", "2.1 Results", "I Literature and Background", "References", "A normal sentence.", "First line\nSecond line"]) {
    assert.equal(api.detectRunningMargins(pages(n => sample(n, title, 120))).size, 0, title);
  }
  assert.equal(api.detectRunningMargins(pages(n => sample(n, "A repeated label", 136))).size, 0, "a bottom edge beyond 15 percent stays outside");
  const third = pages(n => [block(`${n}:first`, "First", 25), block(`${n}:second`, "Second", 50),
    block(`${n}:third`, "A repeated third block", 120), block(`${n}:body`, `Body paragraph ${n}.`, 200)]);
  assert.ok(![...api.detectRunningMargins(third).keys()].some(id => id.endsWith(":third")));
});

test("localized running titles require five consecutive daily or alternating occurrences", () => {
  for (const cadence of [1, 2]) {
    const start = 4, end = start + 4 * cadence;
    const input = pages(n => sample(n, n >= start && n <= end && (n - start) % cadence === 0 ? "Local running label" : `Unique label ${n}`, 120), 24);
    const removed = api.detectRunningMargins(input);
    assert.deepEqual([...removed.values()].map(value => value.page).sort((a, b) => a - b), Array.from({ length: 5 }, (_, i) => start + i * cadence));
    assert.ok([...removed.values()].every(value => value.cadence === cadence));
  }
  const four = pages(n => sample(n, n >= 4 && n <= 7 ? "Local running label" : `Unique label ${n}`, 120), 24);
  assert.equal(api.detectRunningMargins(four).size, 0);
  const interior = pages(n => [...sample(n, "Local running label", 120), ...(n === 12 ? [block("12:middle", "Local running label", 500)] : [])], 24);
  assert.equal(api.detectRunningMargins(interior).size, 0);
});

test("60 percent coverage accepts daily/parity repetition and rejects lower coverage without a proven run", () => {
  const make = (occurrences, count) => pages(n => sample(n, occurrences.includes(n) ? "Repeated issue label" : `Unique label ${n}`, 120), count);
  const daily = api.detectRunningMargins(make([2, 3, 4, 8, 9, 10], 11));
  assert.deepEqual([...daily.values()].map(value => value.page).sort((a, b) => a - b), [2, 3, 4, 8, 9, 10]);
  assert.ok([...daily.values()].every(value => value.cadence === 1));
  assert.equal(api.detectRunningMargins(make([2, 3, 4, 8, 9], 11)).size, 0);
  const alternating = api.detectRunningMargins(make([3, 5, 7], 11));
  assert.equal(alternating.size, 3);
  assert.ok([...alternating.values()].every(value => value.cadence === 2));
  assert.equal(api.detectRunningMargins(make([3, 5, 7], 13)).size, 0);
});

test("a confirmed run propagates to disconnected matches before and after it at the same position and parity", () => {
  for (const cadence of [1, 2]) {
    const occurrences = cadence === 1 ? [2, 5, 6, 7, 8, 9, 13] : [3, 9, 11, 13, 15, 17, 23];
    const input = pages(n => sample(n, occurrences.includes(n) || cadence === 2 && n === 24 ? "Local running label" : `Unique label ${n}`, 120), 40);
    const removed = api.detectRunningMargins(input);
    assert.deepEqual([...removed.values()].map(value => value.page).sort((a, b) => a - b), occurrences);
    assert.ok([...removed.values()].every(value => value.cadence === cadence));
    const shifted = structuredClone(input);
    shifted[occurrences[0] - 1].blocks[0].bbox = [50, 50, 400, 65];
    const guarded = api.detectRunningMargins(shifted);
    assert.ok(!guarded.has(`${occurrences[0]}:0`));
    assert.ok(guarded.has(`${occurrences.at(-1)}:0`));
  }
});

test("propagation retains first-page content and respects interior, uncertain-geometry and duplicate vetoes", () => {
  const occurrences = [1, 3, 9, 11, 13, 15, 17, 23];
  const input = pages(n => sample(n, occurrences.includes(n) ? "Local running label" : `Unique label ${n}`, 120), 40);
  assert.ok(!api.detectRunningMargins(input).has("1:0"));
  for (const extra of [block("20:interior", "Local running label", 500), { id: "20:uncertain", text: "Local running label", kind: "text" }]) {
    const guarded = structuredClone(input); guarded[19].blocks.push(extra);
    assert.equal(api.detectRunningMargins(guarded).size, 0);
  }
  const duplicate = structuredClone(input);
  duplicate[10].blocks.splice(1, 0, block("11:duplicate", "Local running label", 120));
  assert.equal(api.detectRunningMargins(duplicate).size, 0);
});

test("PaddleOCR removes all seven alternating issue labels across missing OCR and an English end page", () => {
  const occurrences = [1, 3, 5, 9, 11, 13, 15, 17];
  const raw = Array.from({ length: 19 }, (_, i) => {
    const n = i + 1;
    return { prunedResult: { width: 1225, height: 1650, parsing_res_list: [
      { block_label: "header", block_content: "Synthetic Journal", block_bbox: [140, 111, 660, 136], block_id: `${n}:header` },
      ...(occurrences.includes(n) ? [{ block_label: "paragraph_title", block_content: "Economics", block_bbox: [138, 152, 218, 177], block_id: `${n}:label` }] : []),
      { block_label: "text", block_content: `Unique body paragraph ${n}.`, block_bbox: [140, 250, 1050, 800], block_id: `${n}:body` },
    ] }, markdown: { images: {} } };
  });
  const parsed = api.parsePaddleResult(result(raw), 19);
  assert.equal(parsed.blocks.filter(b => b.text === "Economics").length, 1, "first page is protected");
  assert.equal(parsed.blocks.filter(b => b.text.startsWith("Unique body paragraph")).length, 19);
  assert.equal(parsed.warnings.filter(value => /header:(?:3|5|9|11|13|15|17):1:cadence-2$/.test(value)).length, 7);
});

const notice = n => `15406261, 2026, ${n}, Downloaded from https://${n % 2 ? "publisher" : "pub1isher"}.example/doi/${n}. See the Terms and Conditions; applicable Creative Commons License${n % 3 ? "." : ""}`;
const sidePages = (side = "right", make = n => notice(n)) => pages(n => [
  ...sample(n, `Unique title ${n}`),
  { id: `${n}:aside`, text: make(n), kind: "aside", bbox: side === "left" ? [10, 20, 25, 980] : [575, 20, 590, 980] },
]).map(page => ({ ...page, width: 600 }));

test("side margins scan every block and group download notice variants without altering ordinary text", () => {
  for (const side of ["left", "right"]) {
    const input = sidePages(side), snapshot = JSON.stringify(input), removed = api.detectRunningMargins(input);
    assert.equal(removed.size, 9);
    assert.ok([...removed.values()].every(value => value.edge === side && value.cadence === 1 && value.id.endsWith(":aside")));
    assert.equal(JSON.stringify(input), snapshot);
  }
  const mislabeled = sidePages().map(page => ({ ...page, blocks: page.blocks.map(b => b.kind === "aside" ? { ...b, kind: "text" } : b) }));
  assert.equal(api.detectRunningMargins(mislabeled).size, 9);
  assert.equal(api.detectRunningMargins(sidePages("left", () => "Synthetic Press")).size, 9);
  assert.equal(api.detectRunningMargins(sidePages("right", n => `Copyright ${2020 + n} Synthetic Press. All rights reserved.`)).size, 9);
});

test("side cleanup retains substantive sidebars, body notices, missing geometry, short runs and protected notes", () => {
  for (const text of ["A normal sidebar sentence.", "Table 1 Continued", "Source: Synthetic data", "2.1 Results", "First line\nSecond line", "A substantive sidebar about copyright law and its economic effects."]) {
    assert.equal(api.detectRunningMargins(sidePages("right", () => text)).size, 0, text);
  }
  for (const change of [
    b => ({ ...b, bbox: [100, 20, 500, 980] }),
    b => ({ ...b, bbox: [550, 20, 590, 980] }),
    b => ({ ...b, bbox: undefined }),
    b => ({ ...b, protected: true }),
    b => ({ ...b, kind: "other" }),
    b => ({ ...b, text: "A substantive sidebar ".repeat(30) }),
  ]) {
    const input = sidePages().map(page => ({ ...page, blocks: page.blocks.map(b => b.kind === "aside" ? change(b) : b) }));
    assert.equal(api.detectRunningMargins(input).size, 0);
  }
  assert.equal(api.detectRunningMargins(sidePages().map(page => ({ ...page, width: undefined }))).size, 0);
  assert.equal(api.detectRunningMargins(sidePages().slice(0, 3)).size, 0);
});

test("PaddleOCR removes confirmed side notices before paragraph merging but retains ordinary aside text and raw diagnostics", () => {
  const raw = Array.from({ length: 6 }, (_, i) => ({ prunedResult: { width: 600, height: 1000, parsing_res_list: [
    { block_label: i ? "header" : "doc_title", block_content: i ? "Synthetic Journal" : "Synthetic paper", block_bbox: [50, 30, 400, 45], block_id: i * 10 },
    { block_label: "paragraph_title", block_content: "Business Studies", block_bbox: [50, 120, 200, 140], block_id: i * 10 + 1 },
    { block_label: "text", block_content: i === 0 ? "The synthetic paragraph continues" : "with more retained words", block_bbox: [50, 180, 550, 850], block_id: i * 10 + 2 },
    { block_label: "aside_text", block_content: notice(i), block_bbox: [575, 20, 590, 980], block_id: i * 10 + 3 },
    ...(i === 5 ? [{ block_label: "aside_text", block_content: "A substantive sidebar sentence.", block_bbox: [400, 200, 550, 400], block_id: 99 }] : []),
  ] }, markdown: { images: {} } }));
  const snapshot = JSON.stringify(raw), parsed = api.parsePaddleResult(result(raw), 6);
  assert.equal(JSON.stringify(raw), snapshot);
  assert.equal(parsed.blocks.filter(b => b.markdown.includes("Downloaded from")).length, 1, "first-page content remains protected");
  assert.equal(parsed.blocks.filter(b => b.text === "Business Studies").length, 1);
  assert.ok(parsed.blocks.some(b => b.page === 2 && b.pageEnd === 6 && b.sourceIDs.length === 5));
  assert.ok(parsed.blocks.some(b => b.text === "A substantive sidebar sentence."));
  assert.equal(parsed.warnings.filter(value => value.startsWith("running-margin-removed:right:")).length, 5);
});

test("MinerU applies side cleanup in actual page coordinates before heading publication", () => {
  const entries = Array.from({ length: 6 }, (_, page_idx) => [
    { type: "text", text: "Synthetic running title", text_level: 1, page_idx, bbox: [100, 120, 600, 140] },
    { type: "text", text: `Body paragraph ${page_idx} remains.`, page_idx, bbox: [100, 200, 900, 800] },
    { type: page_idx % 2 ? "text" : "aside_text", text: notice(page_idx), page_idx, bbox: [960, 20, 980, 980] },
  ]).flat();
  const parsed = api.parseMinerUResult(mineruFiles(entries, [0, 1, 2, 3, 4, 5]), 6).document;
  assert.equal(parsed.blocks.filter(b => b.text.includes("Downloaded from")).length, 1);
  assert.equal(parsed.blocks.filter(b => b.type === "heading").length, 1);
  assert.equal(parsed.blocks.filter(b => b.text.startsWith("Body paragraph")).length, 6);
  assert.deepEqual(parsed.pages.flatMap(page => page.raw.mineru.content), entries);
  assert.equal(parsed.warnings.filter(value => value.startsWith("running-margin-removed:right:")).length, 5);
});
