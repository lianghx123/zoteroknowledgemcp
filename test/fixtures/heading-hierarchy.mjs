// Fixtures define their own trees. Expected levels do not call the algorithm.
export const cases = [];
const add = (name, rows, group = "curated") => cases.push({ name, rows, group });
const cn = ["", "一", "二", "三", "四", "五", "六"];
const render = {
  chinese: n => `${cn[n]}、Topic`,
  chineseParen: n => `（${cn[n]}）Topic`,
  numericParen: n => `（${n}）Topic`,
  decimal: n => `${n}. Topic`,
  alpha: n => `${String.fromCharCode(64 + n)}. Topic`,
  roman: n => `${["", "I", "II", "III", "IV", "V"][n]} Topic`,
  circled: n => `${String.fromCodePoint(0x245f + n)} Topic`,
  lower: n => `${String.fromCharCode(96 + n)}) Topic`,
};
const perms = values => values.length ? values.flatMap((v, i) => perms(values.filter((_, j) => j !== i)).map(tail => [v, ...tail])) : [[]];
function tree(styles, counts = () => 2) {
  const rows = [];
  const visit = depth => {
    for (let i = 1, count = counts(depth); i <= count; i++) {
      rows.push([render[styles[depth]](i), depth + 1]);
      if (depth + 1 < styles.length) visit(depth + 1);
    }
  };
  visit(0); return rows;
}
add("user-forward-chinese-parenthesized-numeric", tree(["chinese", "chineseParen", "numericParen"]), "user");
add("user-reverse-parenthesized-chinese-numeric", tree(["chineseParen", "chinese", "numericParen"]), "user");
for (const [i, styles] of perms(["chinese", "chineseParen", "numericParen", "decimal"]).entries()) add(`all-four-style-permutations-${i}`, tree(styles), "permutations-four");
for (const [i, styles] of perms(["chinese", "chineseParen", "numericParen", "decimal", "alpha"]).entries()) add(`all-five-style-permutations-${i}`, tree(styles), "permutations-five");
for (const [i, styles] of perms(["roman", "alpha", "chineseParen"]).entries()) add(`roman-letter-permutations-${i}`, tree(styles), "permutations-roman");
for (const [i, styles] of perms(["chinese", "circled", "lower"]).entries()) add(`circled-lowercase-permutations-${i}`, tree(styles), "permutations-list-risk");
let seed = 11062026;
const random = n => { seed = (1664525 * seed + 1013904223) >>> 0; return seed % n; };
const choices = perms(["chinese", "chineseParen", "numericParen", "decimal"]);
for (let i = 0; i < 200; i++) {
  const styles = choices[random(choices.length)];
  add(`fixed-seed-variable-branch-tree-${i}`, tree(styles, () => 2 + random(2)), "generated");
}
const review = text => [text, null, "review"];
add("sparse-forward-chain-is-underdetermined", [review("一、方法"), review("（一）数据"), review("（1）样本")]);
add("sparse-reverse-chain-is-underdetermined", [review("（一）方法"), review("一、数据"), review("（1）样本")]);
add("standalone-parenthesized-Chinese-series", [["（一）方法", 1], ["（二）结果", 1]]);
add("one-parenthesized-Chinese-title-is-uncertain", [review("（一）方法")]);
add("local-numeric-parentheses-stay-review", [["1 Methods", 1], ["2 Results", 1], review("（1）Treatment"), review("（2）Control"), ["3 Conclusion", 1]]);
add("local-circled-list-stays-review", [["一、方法", 1], review("①条件"), review("②条件"), ["二、结论", 1]]);
add("continuously-alternating-counters-are-ambiguous", [["一、方法", 1], review("（一）数据"), ["二、结果", 1], review("（二）发现")]);
add("rule-change-without-boundary-conflicts", ["一、研究", "（一）数据", "（二）模型", "二、发现", "（一）新研究", "一、数据", "二、结果", "（二）讨论"].map(review));
add("different-rules-in-explicit-chapters", [
  ["第一章 方法", 1], ...tree(["chinese", "chineseParen", "numericParen"]).map(([text, depth]) => [text, depth + 1]),
  ["第二章 扩展", 1], ...tree(["chineseParen", "chinese", "numericParen"]).map(([text, depth]) => [text, depth + 1]),
]);
add("different-rules-in-appendices", [
  ["Appendix A. Data", 1], ...tree(["chinese", "chineseParen"]).map(([text, depth]) => [text, depth + 1]),
  ["Appendix B. Checks", 1], ...tree(["chineseParen", "chinese"]).map(([text, depth]) => [text, depth + 1]),
]);
add("skip-unused-middle-style-in-one-branch", [
  ["一、方法", 1], ["（一）样本", 2], ["1. 来源", 3], ["2. 筛选", 3], ["（二）模型", 2], ["1. 估计", 3], ["2. 检验", 3],
  ["二、结果", 1], ["1. 效果", 2], ["2. 分析", 2], ["三、结论", 1],
]);
add("duplicate-parent-blocks-cannot-approve-descendants", [
  ["1 Methods", 1], ["1.1 Data", 2], review("1.1 Duplicate"), review("1.1.1 Child"), ["2 Results", 1],
]);
add("incomplete-explicit-path-does-not-invent-parent", [["1 Methods", 1], review("1.2.1 Missing parent"), ["2 Results", 1]]);
add("closed-one-branch-provides-relative-rule", [["（一）方法", 1], ["一、来源", 2], ["二、筛选", 2], ["（二）结果", 1]]);
add("parenthesized-roots-without-child-structure-stay-review", [review("（1）Treatment"), review("（2）Control")]);
add("caption-sentence-and-OCR-protection", [
  ["Figure 1 Diagram", null, "excluded"], ["Table II Statistics", null, "excluded"], ["H1: Some effect.", null, "excluded"],
  review("1. We collect data."), review("1.l Data"), ["Methods", null, "unchanged"],
]);
add("mislabelled-short-body-list-is-still-unsolved", [["1 Overview", 1], review("2 Mix flour")], "known-ambiguity");

export function documentFor(test) {
  return { id: test.name, blocks: test.rows.map(([text], index) => ({
    id: `${test.name}:${index}`, canonical_order: index, block_type: "heading", content_markdown: `### ${text}`,
    content_normalized: text, page_start: 1, metadata: { ocr_label: "paragraph_title" },
  })) };
}
