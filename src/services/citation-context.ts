export interface CitationTextRange { start: number; end: number; }
export interface CitationExclusion extends CitationTextRange { reason: "interval" | "locator" | "enumeration"; }
interface NumericMarker extends CitationTextRange { body: string; round: boolean; number?: number; }

const markers = /[\[［(（【〔〖{｛]\s*([+＋\-−]?\d[\d０-９\s.,，、;；+＋\-−–—~～eE]*|[０-９][０-９\s,，、;；\-–—~～]*)\s*[\]］)）】〕〗}｝]/gu;
const locatorBefore = /(?:\b(?:eq(?:uation)?s?|fig(?:ure)?s?|tables?|sections?|appendi(?:x|ces)|columns?|rows?|panels?|cases?|items?|hypothes(?:is|es))\.?|公式|方程(?:式)?|表达式|表達式|等式|图表|圖表|(?:^|[^\p{Script=Han}])(?:图|圖|表|式)|(?:见|見|如|由|按|于|於|在|的|入|用|上|下|前|后|後|和|与|與|及)(?:图|圖|表|式)|第)\s*$/iu;
const roundLocatorBefore = /(?:\bmodels?\.?|模型)\s*$/iu;
const locatorAfter = /^\s*(?:列(?!举|舉|出)|行(?!为|為|之|动|動)|栏|欄|号|號|\b(?:columns?|rows?|panels?)\b)/iu;
const locatorSeparator = /^\s*(?:[,，、~～–—−-]|至|到|\b(?:to|through|and|or)\b)\s*$/iu;
const listIntroduction = /(?:以下|如下|几个方面|幾個方面|几个部分|幾個部分|主要包括|主要包含|分别为|分別為|试图讨论|試圖討論|\b(?:as follows|following|components?|consists? of|comprises?|includes?|questions?)\b)/iu;
const proseAfter = /^\s*\p{L}/u;
const boundaryBefore = /(?:^|[。！？.!?:：;；\n])\s*$/u;
const citationCueBefore = /(?:文献|文獻|研究|\b(?:references?|studies|citations?))\s*[:：]?\s*$/iu;
const locatorPrefix = (before: string, marker: NumericMarker) => locatorBefore.test(before) || marker.round && roundLocatorBefore.test(before);

/** Semantic exclusions apply equally to local patterns and native PDF evidence. */
export function citationExclusions(text: string): CitationExclusion[] {
  const found: NumericMarker[] = [...text.matchAll(markers)].map(match => {
    const body = match[1].normalize("NFKC").trim();
    return { start: match.index, end: match.index + match[0].length, body,
      round: /^[（(]/u.test(match[0]), number: /^\d{1,5}$/u.test(body) ? Number(body) : undefined };
  });
  const excluded: CitationExclusion[] = [];
  const add = (range: CitationTextRange, reason: CitationExclusion["reason"]) => excluded.push({ start: range.start, end: range.end, reason });
  for (let i = 0; i < found.length; i++) {
    const marker = found[i], before = text.slice(Math.max(0, marker.start - 250), marker.start), after = text.slice(marker.end);
    const endpoints = marker.body.split(/[,，]/u).map(value => value.trim());
    const pair = endpoints.length === 2 && endpoints.every(value => /^[+\-−]?\d+(?:\.\d+)?(?:e[+\-]?\d+)?$/iu.test(value));
    const intervalContext = /(?:区间|區間|取值范围|取值範圍|归一化|歸一化|标准化|標準化|\b(?:interval|range|bounds?|normali[sz]ed))\s*(?:为|為|是|在|到|至|=|∈|:|：|\b(?:of|is|in|to))?\s*$/iu.test(before)
      || /^\s*(?:范围|範圍|区间|區間|之间|之間|内|內|的?(?:取值|数值|數值|范围|範圍|区间|區間)|\b(?:interval|range)\b)/iu.test(after);
    if (pair && (endpoints.some(value => Number(value.replace("−", "-")) <= 0 || /[.e−-]/iu.test(value)) || intervalContext)
      || intervalContext && /^\d+\s*[-–—~～]\s*\d+$/u.test(marker.body)) add(marker, "interval");
    if (locatorPrefix(before, marker) || locatorAfter.test(after)) add(marker, "locator");
    if (marker.round && marker.number !== undefined && proseAfter.test(after)
      && (!before.trim() || /(?:[:：;；]|\b(?:and|or))\s*$/iu.test(before)
        || listIntroduction.test(before) && boundaryBefore.test(before) && !citationCueBefore.test(before))) add(marker, "enumeration");
  }
  for (let i = 0; i < found.length;) {
    let end = i;
    while (end + 1 < found.length && locatorSeparator.test(text.slice(found[end].end, found[end + 1].start))) end++;
    if (end > i && (locatorPrefix(text.slice(0, found[i].start), found[i]) || locatorAfter.test(text.slice(found[end].end)))) {
      add({ start: found[i].start, end: found[end].end }, "locator");
    }
    i = end + 1;
  }
  // A run needs prose after each number and a list boundary or introduction.
  // Sentence-final citations followed by punctuation cannot form such a run.
  for (const round of [true, false]) {
    // Intervening publication years and bracketed citations do not break a
    // round list such as (1)...Author (2023)...(2)...Author [38]...(3).
    const list = found.filter(marker => marker.round === round && marker.number !== undefined && marker.number < 1000 && proseAfter.test(text.slice(marker.end)));
    for (let i = 0; i < list.length;) {
      const first = list[i]; let end = i;
      while (end + 1 < list.length && list[end + 1].number === list[end].number! + 1
        && !text.slice(list[end].end, list[end + 1].start).includes("\n\n")) end++;
      if (end > i) {
        const before = text.slice(Math.max(0, first.start - 250), first.start);
        const boundaries = list.slice(i, end + 1).every(marker => boundaryBefore.test(text.slice(0, marker.start)));
        const introduced = listIntroduction.test(before) && !citationCueBefore.test(before);
        if (round ? introduced || boundaries : introduced && boundaries) {
          for (let j = i; j <= end; j++) add(list[j], "enumeration");
        }
      }
      i = end + 1;
    }
  }
  return excluded;
}

export function overlapsExclusion(range: CitationTextRange, exclusions: readonly CitationExclusion[]): boolean {
  return exclusions.some(exclusion => range.start < exclusion.end && range.end > exclusion.start);
}
