import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mockLocalization } from "./helpers/localization.mjs";

const compiled = await build({ stdin: { contents: `export * from "./src/services/citation-matching.ts";
export * from "./src/ui/rendering/citation-preview.ts";
export * from "./src/integrations/zotero/citation-evidence.ts";
export * from "./src/ui/rendering/structured-content.ts";
export * from "./src/ui/rendering/markdown.ts";`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "browser", format: "esm", target: "firefox140", write: false });
globalThis.Localization = mockLocalization();
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const reference = (id, number, text) => ({ id, number, text });
const sources = [reference("smith-a", 1, "Smith, A., Jones, B. (2020a). First title. Journal, 1, 1–20."),
  reference("smith-b", 2, "Smith, A., Lee, C. (2020b). Second title. Journal, 2, 21–40."),
  reference("jones", 3, "Jones, B., Smith, A. (2021). Third title. Journal, 3, 41–60."),
  reference("cjk", null, "张三、李四：《中文测试文献》，测试期刊，2022年第1期。"),
  reference("accent", null, "García, M. (2019). Another title. Journal, 4, 61–80.")];

test("numeric citations resolve original numbers, grouped ranges and duplicates without using generated labels", () => {
  const index = new api.CitationIndex([...sources, reference("duplicate", 1, "Other, D. (2018). Duplicate source number.")]);
  for (const text of ["Earlier work [1, 3].", "Earlier work ［１，３］.", "Earlier work 【1、3】.", "Earlier work 〔1–3〕."]) {
    const match = index.matches(text)[0]; assert.ok(match, text);
    assert.ok(match.referenceIds.includes("smith-a")); assert.ok(match.referenceIds.includes("jones")); assert.equal(match.ambiguous, true);
  }
  const partial = index.matches("Earlier work [2, 99].")[0]; assert.deepEqual(partial.referenceIds, ["smith-b"]); assert.equal(partial.missing, 1);
  for (const text of ["No match [4].", "Too large [1–99999].", "Backwards [3–1].", "Equation (1).", "Table [1].", "[1） Wrong bracket.", "A decimal [1.2]."]) {
    assert.equal(index.matches(text).length, 0, text);
  }
  assert.equal(new api.CitationIndex([reference("only-generated", null, "Author. A paper.")]).matches("An unrelated [1].").length, 0);
  assert.equal(index.matches("Three components: (1) Dynamic weighting; (2) Masked modelling; and (3) Distillation.").length, 0);
  const round = new api.CitationIndex([{ ...sources[0], numberStyle: "round" }]);
  assert.equal(round.matches("An existing result (1).").length, 1);
  assert.equal(round.matches("A list: (1) First component.").length, 0);
});

test("author-year citations support narrative, groups, CJK names, accents, coauthors and year suffix ambiguity", () => {
  const index = new api.CitationIndex(sources);
  for (const [text, ids, ambiguous] of [
    ["See (Smith et al., 2020a).", ["smith-a"], false],
    ["See (Smith, 2020).", ["smith-a", "smith-b"], true],
    ["Smith et al. (2020a) found a result.", ["smith-a"], false],
    ["According to Smith (2020a), this holds.", ["smith-a"], false],
    ["See (Smith and Jones, 2020; Jones, 2021).", ["smith-a", "jones"], false],
    ["See (Smith & Lee, 2020b).", ["smith-b"], false],
    ["See (Smith, 2020a,b).", ["smith-a", "smith-b"], false],
    ["Smith (2020a, 2020b) found a result.", ["smith-a", "smith-b"], false],
    ["See (Smith,\n2020a, p. 12).", ["smith-a"], false],
    ["参见（张三等，2022）。", ["cjk"], false],
    ["已有研究表明张三等（2022）支持这一结果。", ["cjk"], false],
    ["See (Garcia, 2019).", ["accent"], false],
  ]) {
    const matches = index.matches(text); assert.equal(matches.length, 1, text);
    assert.deepEqual(matches[0].referenceIds, ids, text); assert.equal(matches[0].ambiguous, ambiguous, text);
    if (text.startsWith("According")) assert.equal(text.slice(matches[0].start, matches[0].end), "Smith (2020a)");
    if (text.startsWith("已有")) assert.equal(text.slice(matches[0].start, matches[0].end), "张三等（2022）");
  }
  const partial = index.matches("See (Jones, 2021; Unknown, 2019).")[0]; assert.equal(partial.missing, 1);
  for (const text of ["A year (2020).", "Smith (2020c).", "Wrong author (Other, 2020a).", "See (Smith and Unknown, 2020a).", "An ordinary date (April 2020)."])
    assert.equal(index.matches(text).length, 0, text);
});

const roundSources = Array.from({ length: 6 }, (_, i) => ({ ...reference(String(i + 1), i + 1, `Author, A. (2020). Complete paper ${i + 1}.`), numberStyle: "round" }));
const reportedParagraphs = [
  "在综合评价得分计算中，任务可用度采用[0,1]范围内的归一化数值表示，因此100%的任务可用度以1代入式(28)。",
  "现有文献主要从以下几个方面展开。（1）就业。罗森塔尔和斯特兰奇（2003）以企业容纳的就业量为创业指标进行研究。（2）企业创新。李松林等（2023）证实了楼宇的建设会增加周围人口密度。陈霖和刘俊岩（2024）表明产业空间集聚的多样化技术知识池。（3）创业活动。陈强远等（2024）发现中关村科技园的空间溢出效应。",
  "是对加总在圆环层面的企业总数量集聚的分析。第(1)～(3)列是个体工商户样本，第(4)～(6)列是其他非个体户企业。此外，第(1)～(3)列核心变量的系数绝对值相应地均大于第(4)～(6)列。",
  "研究试图讨论：（1）企业如何发展进程中建设效能合法性与在地合法性；（2）双重合法性悖论如何形成与演化；（3）企业采用何种治理策略回应悖论。",
];

test("numeric context excludes the reported intervals, prose enumerations and table columns for both local and native matches", () => {
  const local = new api.CitationIndex(roundSources);
  for (const text of reportedParagraphs) {
    assert.equal(local.matches(text).length, 0, text);
    const native = [...text.matchAll(/[\[（(][0-9,]+[\]）)]/gu)].filter(marker => !/[0-9]{4}/u.test(marker[0])).map(marker => ({
      page: 1, text: marker[0], before: text.slice(0, marker.index), after: text.slice(marker.index + marker[0].length), referenceIds: ["1"],
    }));
    const enriched = new api.CitationIndex(roundSources, native);
    assert.equal(enriched.matches(text, { pageStart: 1, pageEnd: 1 }).length, 0, "Native evidence must respect exclusions: " + text);
    // Native overlays sometimes expose only the digit, without parentheses.
    const digits = native.map(hint => ({ ...hint, text: hint.text.slice(1, -1), before: hint.before + hint.text[0], after: hint.text.slice(-1) + hint.after }));
    assert.equal(new api.CitationIndex(roundSources, digits).matches(text, { pageStart: 1, pageEnd: 1 }).length, 0);
  }
  for (const text of ["The value is in the interval [1,2].", "取值范围为[1,2]。", "采用［０，１］范围的归一化指标。", "The interval [0,1) has an open endpoint.",
    "Columns (1)–(3) show the estimates; columns (4) and (6) report controls.", "第（1）至（3）列显示结果。", "第（1）、（2）、（3）列显示结果。", "Columns (1), (2) and (3) report controls.", "表[1]和式(2)显示了结果。", "主要从以下方面展开。（1）就业。",
    "主要包括：[1] 第一项。[2] 第二项。[3] 第三项。", "(1) First component. (2) Second component. (3) Third component."])
    assert.equal(local.matches(text).length, 0, text);
});

test("semantic exclusions preserve nearby real citations, partial groups and sentence-final round citations", () => {
  const text = "任务可用度采用[0,1]范围；文献[1,3]提出另一方案。第(1)～(3)列报告结果，参见[2,99]。已有研究(4)支持这一结果。";
  const index = new api.CitationIndex(roundSources);
  const matches = index.matches(text);
  assert.deepEqual(matches.map(match => text.slice(match.start, match.end)), ["[1,3]", "[2,99]", "(4)"]);
  assert.equal(matches[1].missing, 1); assert.equal(matches[0].source, "local");
  const sentence = "An existing result (1). Another study (2). A third result (3).";
  assert.equal(index.matches(sentence).length, 3);
  const references = "以下文献[1]提出方法，文献[2]验证结果。";
  assert.equal(index.matches(references).length, 2);
  const terminology = "深度学习模型[1]与协作新范式[2]。A new model [3] supports this result. 文献[4]列举了相关证据。";
  assert.equal(index.matches(terminology).length, 4);
  const narrative = "现有文献主要从以下几个方面展开。（1）就业。Smith（2020）报告就业结果。（2）创新。Jones（2021）报告创新结果。文献[3]提供另一证据。";
  const real = new api.CitationIndex([...roundSources, ...sources]);
  const labels = real.matches(narrative).map(match => narrative.slice(match.start, match.end));
  assert.ok(labels.includes("Smith（2020）")); assert.ok(labels.includes("Jones（2021）")); assert.ok(labels.includes("[3]"));
  assert.ok(!labels.includes("（1）") && !labels.includes("（2）"));
});

test("round numeric fallback requires a dominant bibliography style and respects an author-year body", () => {
  const mixed = new api.CitationIndex(roundSources.map((source, i) => ({ ...source, numberStyle: i ? "bracket" : "round" })));
  assert.equal(mixed.matches("An existing result (1).").length, 0);
  const body = "Smith (2020) reports employment. Jones (2021) reports innovation. A discussion (1).";
  assert.equal(new api.CitationIndex([...roundSources, ...sources], [], { body }).matches(body).some(match => body.slice(match.start, match.end) === "(1)"), false);
  assert.equal(new api.CitationIndex(roundSources).matches("An existing result (1).").length, 1);
  assert.equal(new api.CitationIndex(roundSources, [], { body: "Dates (2020) and (2021) describe the sample. An existing result (1)." }).matches("An existing result (1).").length, 1);
});

test("DOM previews keep all reported numeric non-citations plain while preserving real rich citations and source diagnostics", t => {
  const markdown = reportedParagraphs.join("\n\n") + "\n\n文献[2]提供依据。归一化指标<sup>[0,1]</sup>范围不属于引文。研究 $^{[1-3]}$ 提供证据。\n\n## References\n\n" + roundSources.map(source => `(${source.number}) ${source.text}`).join("\n\n");
  const marker = "（1）", paragraph = reportedParagraphs[1], offset = paragraph.indexOf(marker);
  const f = fixture(t, markdown, [{ page: 1, text: marker, before: paragraph.slice(0, offset), after: paragraph.slice(offset + marker.length), references: [roundSources[0].text] }], {
    sourceSpans: reportedParagraphs.map((_, i) => ({ startLine: i * 2, endLine: i * 2 + 1, pageStart: 1, pageEnd: 1 })),
  });
  const triggers = [...f.article.querySelectorAll(".km-citation")]; assert.equal(triggers.length, 2);
  assert.equal(f.article.textContent, f.original); assert.ok(triggers.every(trigger => trigger.dataset.citationSource === "local"));
  assert.ok(triggers.some(trigger => trigger.querySelector("math")));
  assert.equal(f.article.querySelectorAll("sup .km-citation").length, 0);
  triggers.find(trigger => trigger.querySelector("math")).click(); assert.equal(f.doc.querySelectorAll(".km-citation-preview-entry").length, 3);
  f.preview.dispose(); assert.equal(f.article.textContent, f.original);
});

test("Vancouver authors and institutional names match without conflating different institutions", () => {
  const index = new api.CitationIndex([reference("vancouver", null, "Miller AB, Brown CD. A study. Journal. 2018;2:3–4."),
    reference("institution", null, "World Bank (2023). A report.")]);
  assert.deepEqual(index.matches("See (Miller, 2018).")[0].referenceIds, ["vancouver"]);
  assert.deepEqual(index.matches("World Bank (2023) reports this.")[0].referenceIds, ["institution"]);
  assert.equal(index.matches("See (River Bank, 2023).").length, 0);
  const economics = new api.CitationIndex([reference("economics", null, "Anderson, D., and P. Brown, 2018, “An economics paper”, An edited volume.")]);
  assert.deepEqual(economics.matches("See (Anderson & Brown, 2018).")[0].referenceIds, ["economics"]);
});

const standardInitialReferences = [
  reference("hall-lerner", 21, "Hall, B. H., and J. Lerner. The Financing of R&D and Innovation [A]. Hall, B. H., and N. Rosenberg. Handbook of the Economics of Innovation [C]. Amsterdam: Elsevier, 2010."),
  reference("benmelech-bergman", 18, "Benmelech, E., and N. K. Bergman. Collateral Pricing[J]. Journal of Financial Economics, 2009, 91(3):339-360."),
  reference("stiglitz-weiss", 36, "Stiglitz, J. E., and A. Weiss. Credit Rationing in Markets with Imperfect Information [J]. American Economic Review, 1981, 71(3):393-410."),
  reference("amable", 17, "Amable, B., Chatelain, J. B., and K. Ralf. Patents as Collateral[J]. Journal of Economic Dynamics and Control, 2010, 34(6):1092-1104."),
];

test("standard bibliography initials retain all coauthors without indexing titles or later book editors", () => {
  const index = new api.CitationIndex(standardInitialReferences);
  for (const [text, ids] of [
    ["（Hall and Lerner，2010）", ["hall-lerner"]],
    ["Hall and Lerner (2010) study innovation.", ["hall-lerner"]],
    ["See (Hall & Lerner, 2010).", ["hall-lerner"]],
    ["（Stiglitz and Weiss，1981）", ["stiglitz-weiss"]],
    ["（Benmelech and Bergman，2009）", ["benmelech-bergman"]],
    ["（Benmelech and Bergman，2009；Amable et al.，2010）", ["benmelech-bergman", "amable"]],
  ]) {
    const matches = index.matches(text); assert.equal(matches.length, 1, text);
    assert.deepEqual(matches[0].referenceIds, ids, text); assert.equal(matches[0].missing, 0, text); assert.equal(matches[0].ambiguous, false, text);
  }
  for (const text of ["(Hall and Rosenberg, 2010)", "(Hall and Innovation, 2010)", "(Benmelech and Economics, 2009)", "(Stiglitz and Review, 1981)", "(Hall and Unknown, 2010)"])
    assert.equal(index.matches(text).length, 0, text);
});

test("bibliography initials support compact, spaced, inverted, forward and wrapped author lists", () => {
  for (const authors of ["Hall, B. H., and J. Lerner.", "Hall, B.H., and J. Lerner.", "Hall, B.H., and J.Lerner.", "HALL B H, LERNER J.", "Hall BH, Lerner J.",
    "Hall, B. H., Lerner, J.", "Hall, B. H. and J. Lerner.", "Hall, B. H.,\nand J. Lerner.", "B. H. Hall and J. Lerner."]) {
    const index = new api.CitationIndex([reference("paper", null, authors + " The Financing of R&D and Innovation. Journal, 2010.")]);
    assert.deepEqual(index.matches("(Hall and Lerner, 2010)")[0]?.referenceIds, ["paper"], authors);
  }
  const particles = new api.CitationIndex([reference("paper", null, "García, M. A., and J.-P. van der Waals. A synthetic study. Journal, 2019.")]);
  assert.deepEqual(particles.matches("(Garcia and van der Waals, 2019)")[0]?.referenceIds, ["paper"]);
});

test("complete grouped previews resolve both standard initial-based references with no partial-match notice", t => {
  const f = fixture(t, "（Hall and Lerner，2010）。信贷配给（Stiglitz and Weiss，1981）。研究（Benmelech and Bergman，2009；Amable et al.，2010）。\n\n## References\n\n"
    + standardInitialReferences.map(source => `[${source.number}] ${source.text}`).join("\n\n"));
  const triggers = [...f.article.querySelectorAll(".km-citation")]; assert.equal(triggers.length, 3);
  triggers[2].click(); const popup = f.doc.querySelector(".km-citation-preview");
  assert.equal(popup.querySelectorAll(".km-citation-preview-entry").length, 2);
  assert.deepEqual([...popup.querySelectorAll(".km-reference-body")].map(body => body.textContent), [standardInitialReferences[1].text, standardInitialReferences[3].text]);
  assert.equal(popup.querySelector(".km-citation-notice"), null);
  assert.equal(f.article.textContent, f.original);
});

function fixture(t, markdown, native = [], options = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body><article class='km-markdown-content'></article></body></html>", { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, article = doc.querySelector("article"), opened = [];
  article.append(api.renderMarkdown(doc, markdown, url => opened.push(url), {}, options).fragment);
  const original = article.textContent, preview = new api.CitationPreview(article, url => opened.push(url), native); t.after(() => preview.dispose());
  return { dom, doc, article, opened, preview, original };
}

test("citation text uses non-atomic inline triggers with keyboard activation and focus return", t => {
  const f = fixture(t, "Earlier work (Smith **et al.**, 2020) and [1].\n\n## References\n\n[1] Smith, A. (2020). A complete reference.");
  const triggers = [...f.article.querySelectorAll(".km-citation")]; assert.equal(triggers.length, 2);
  const popup = f.doc.querySelector(".km-citation-preview");
  for (const trigger of triggers) {
    assert.equal(trigger.tagName, "SPAN"); assert.equal(trigger.getAttribute("role"), "button"); assert.equal(trigger.tabIndex, 0);
    for (const key of ["Enter", " "]) {
      trigger.focus();
      const event = new f.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      trigger.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
      assert.equal(popup.hidden, false); assert.equal(f.doc.activeElement, popup.querySelector("button"));
      f.doc.activeElement.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      assert.equal(popup.hidden, true); assert.equal(f.doc.activeElement, trigger);
    }
    const ordinary = new f.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    trigger.dispatchEvent(ordinary); assert.equal(ordinary.defaultPrevented, false);
  }
  assert.ok(triggers[0].querySelector("strong")); assert.equal(f.article.textContent, f.original);
  f.preview.dispose();
  triggers[0].dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(f.doc.querySelector(".km-citation-preview"), null); assert.equal(f.article.textContent, f.original);
});

test("hover previews preserve complete rich reference text, grouped items, interaction, jumping and disposal", async t => {
  const long = "A long reference continuation. ".repeat(120);
  const f = fixture(t, `A result [1–2]. Another [2, 99]. Smith **et al.** (2020a).

## References

[1] Smith, A. (2020a). **First title** $x^2$. [Source](https://example.org/paper). ${long}

[2] Jones, B. (2021). Second title.`);
  const citations = f.article.querySelectorAll(".km-citation"); assert.equal(citations.length, 3);
  assert.equal(f.article.textContent, f.original); assert.ok(citations[2].querySelector("strong"));
  const popup = f.doc.querySelector(".km-citation-preview"); assert.ok(popup.hidden);
  citations[0].dispatchEvent(new f.dom.window.Event("pointerover", { bubbles: true }));
  assert.equal(popup.hidden, false); assert.equal(popup.querySelectorAll(".km-citation-preview-entry").length, 2);
  assert.equal(popup.querySelector(".km-reference-body").textContent, f.article.querySelector(".km-reference-body").textContent);
  assert.ok(popup.querySelector("math")); assert.ok(popup.querySelector("strong"));
  popup.querySelector("a").click(); assert.deepEqual(f.opened, ["https://example.org/paper"]);
  citations[0].dispatchEvent(new f.dom.window.Event("pointerout", { bubbles: true }));
  popup.dispatchEvent(new f.dom.window.Event("pointerenter")); await new Promise(resolve => setTimeout(resolve, 220)); assert.equal(popup.hidden, false);
  f.doc.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); assert.ok(popup.hidden); assert.equal(citations[0].getAttribute("aria-expanded"), "false");
  citations[1].focus(); assert.equal(popup.hidden, false); assert.ok(popup.querySelector(".km-citation-notice").textContent.includes("1"));
  let jumped = 0; const target = f.article.querySelectorAll(".km-reference-entry")[1]; target.scrollIntoView = () => jumped++;
  popup.querySelector(".km-citation-go").click(); assert.equal(jumped, 1); assert.ok(popup.hidden); assert.equal(f.doc.activeElement, target);
  f.preview.dispose(); f.preview.dispose(); assert.equal(f.doc.querySelector(".km-citation-preview"), null);
  assert.equal(f.article.querySelectorAll(".km-citation").length, 0); assert.equal(f.article.textContent, f.original);
});

test("numeric superscripts remain formatted and resolve complete ranges without treating mathematical exponents or list markers as citations", t => {
  const refs = Array.from({ length: 11 }, (_, i) => `[${33 + i}] Synthetic author ${i}. A complete reference.`).join("\n\n");
  const f = fixture(t, "Three components: (1) Dynamic weighting; (2) Modelling; and (3) Distillation.\n\n研究 $ ^{[33-43]} $。MCTN <sup>[38]</sup> 使用此方法。文献[42]提出另一方法。\n\nAn equation $x^{[38]}$ and an affiliation $^{1),2)}$ remain math.\n\n## References\n\n" + refs);
  const triggers = [...f.article.querySelectorAll(".km-citation")]; assert.equal(triggers.length, 3);
  const range = triggers.find(e => e.getAttribute("aria-label").includes("[33-43]")); assert.ok(range.querySelector("math"));
  range.dispatchEvent(new f.dom.window.Event("pointerover", { bubbles: true }));
  assert.equal(f.doc.querySelectorAll(".km-citation-preview-entry").length, 11);
  assert.ok(triggers.some(e => e.querySelector("sup")?.textContent === "[38]"));
  assert.equal(f.article.querySelector(".km-citation annotation")?.textContent, "^{[33-43]}");
  f.preview.dispose(); assert.equal(f.article.textContent, f.original); assert.equal(f.article.querySelectorAll("math").length, 3);
});

test("superscript references after model and paradigm nouns remain citations while true equation locators stay plain", t => {
  const refs = roundSources.map(source => `[${source.number}] ${source.text}`).join("\n\n");
  const f = fixture(t, "深度学习模型 $^{[1-3]}$ 取得了结果。教师模型的知识传递给学生模型 $^{[4]}$。协作式维修决策系统提供新范式 $^{[5-6]}$。代入式(1)与方程(2)。\n\n## References\n\n" + refs);
  const triggers = [...f.article.querySelectorAll(".km-citation")]; assert.equal(triggers.length, 3);
  assert.ok(triggers.every(trigger => trigger.querySelector("math")));
  triggers[0].click(); assert.equal(f.doc.querySelectorAll(".km-citation-preview-entry").length, 3);
});

test("native PDF citation evidence is scoped by source page and surrounding text and can supply an OCR-missing reference", t => {
  const statement = "The earlier housing supply literature discusses Miller and Brown, 2019, followed by a detailed local analysis of allocation.";
  const start = statement.indexOf("Miller"), full = "Miller, A., Brown, B., 2019. A complete housing supply reference from the native PDF.";
  const hint = { page: 2, text: "Miller", before: statement.slice(0, start), after: statement.slice(start + 6), references: [full] };
  const f = fixture(t, statement + "\n\n" + statement + "\n\n## References\n\n[1] Local, L. (2020). A local reference.", [hint], {
    sourceSpans: [{ startLine: 0, endLine: 1, pageStart: 2, pageEnd: 2 }, { startLine: 2, endLine: 3, pageStart: 3, pageEnd: 3 }],
  });
  const triggers = f.article.querySelectorAll(".km-citation"); assert.equal(triggers.length, 1); assert.equal(triggers[0].textContent, "Miller");
  triggers[0].dispatchEvent(new f.dom.window.Event("pointerover", { bubbles: true }));
  const popup = f.doc.querySelector(".km-citation-preview"); assert.equal(popup.querySelector(".km-reference-body").textContent, full);
  assert.ok(popup.querySelector(".km-citation-notice").textContent.includes("Zotero")); assert.equal(popup.querySelector(".km-citation-go"), null);
  const index = new api.CitationIndex([reference("native", null, full)], [{ ...hint, referenceIds: ["native"] }]);
  assert.equal(index.matches(statement, { pageStart: 2, pageEnd: 2 }).length, 1);
  assert.equal(index.matches(statement, { pageStart: 3, pageEnd: 3 }).length, 0);
  assert.equal(index.matches("An unrelated sentence about Miller in 2019.", { pageStart: 2, pageEnd: 2 }).length, 0);
  const dated = "Earlier housing research discusses (Smith, 2020), followed by a detailed explanation of the result.";
  const year = dated.indexOf("2020");
  const preferred = new api.CitationIndex([reference("wrong", null, "Smith, A. (2020). A different paper."), reference("right", null, "Smith, A. (2020). The native target paper.")],
    [{ page: 2, text: "2020", before: dated.slice(0, year), after: dated.slice(year + 4), referenceIds: ["right"] }]);
  assert.deepEqual(preferred.matches(dated, { pageStart: 2, pageEnd: 2 })[0].referenceIds, ["right"]);
  assert.equal(preferred.matches(dated, { pageStart: 2, pageEnd: 2 })[0].ambiguous, false);
  assert.equal(preferred.matches(dated, { pageStart: 3, pageEnd: 3 })[0].ambiguous, true);
});

test("native citation extraction validates evidence, shares pending reads and retries unsupported or failed APIs", async () => {
  const statement = "A sufficiently long prefix cites Miller in an adequately long following explanation.";
  const chars = [...statement].map((c, offset) => ({ c, offset })), start = statement.indexOf("Miller");
  const raw = { pages: { 0: { chars, overlays: [{ type: "citation", word: chars.slice(start, start + 6), references: [{ text: "Miller, A. (2020). A full native reference." }] },
    { type: "reference", word: chars.slice(start, start + 6), references: [{ text: "Not a body citation." }] }] } } };
  const extracted = api.extractNativeCitationHints(raw); assert.equal(extracted.length, 1); assert.equal(extracted[0].page, 1); assert.equal(extracted[0].text, "Miller");
  assert.deepEqual(api.extractNativeCitationHints({ pages: { x: { chars, overlays: [] } } }), []);
  assert.deepEqual(await api.nativeCitationHints({ itemID: 1 }), []);
  let reads = 0, release;
  const pdf = { getProcessedData() { reads++; return new Promise(resolve => { release = resolve; }); } };
  const reader = { _internalReader: { _primaryView: { _iframeWindow: { PDFViewerApplication: { pdfDocument: pdf } } } } };
  const first = api.nativeCitationHints(reader), second = api.nativeCitationHints(reader); await Promise.resolve(); assert.equal(reads, 1); release(raw);
  assert.deepEqual(await first, extracted); assert.deepEqual(await second, extracted); assert.deepEqual(await api.nativeCitationHints(reader), extracted); assert.equal(reads, 1);
  let attempts = 0; const broken = { _internalReader: { _primaryView: { _iframeWindow: { PDFViewerApplication: { pdfDocument: { getProcessedData() { attempts++; throw Error("Unavailable"); } } } } } } };
  assert.deepEqual(await api.nativeCitationHints(broken), []); assert.deepEqual(await api.nativeCitationHints(broken), []); assert.equal(attempts, 2);
});

test("previews distinguish ambiguous candidates and exclude links, code, math, bibliography and unknown citations", t => {
  const f = fixture(t, "See (Smith, 2020). A linked [1](https://example.org/linked) and `[1]`.\n\n$[1]$ and unmatched [99]. Equation (1).\n\n## References\n\n[1] Smith, A. (2020a). One paper.\n\n[2] Smith, B. (2020b). Another paper.");
  const trigger = f.article.querySelector(".km-citation"); trigger.click();
  const popup = f.doc.querySelector(".km-citation-preview");
  assert.ok(popup.querySelector(".km-citation-notice").textContent.includes("possible"));
  assert.equal(popup.querySelectorAll(".km-citation-preview-entry").length, 2);
  assert.equal(f.article.querySelectorAll("a .km-citation, code .km-citation, math .km-citation, .km-reference-entry .km-citation").length, 0);
});

test("display numbering never creates a numeric citation association for unnumbered bibliographies", t => {
  const f = fixture(t, "An unrelated [1]. A real citation (Smith, 2020).\n\n## Bibliography\n\nSmith, A. (2020). A paper.");
  const entries = f.article.querySelectorAll(".km-reference-entry"); assert.equal(entries[0].dataset.originalReferenceNumber, undefined);
  assert.equal(f.article.querySelectorAll(".km-citation").length, 1); assert.equal(f.article.querySelector(".km-citation").textContent, "(Smith, 2020)");
});
