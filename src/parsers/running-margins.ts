/** Provider-independent evidence used before paragraph merging/section creation. */
export interface MarginBlock {
  id: string;
  text: string;
  kind: "text" | "heading" | "header" | "footer" | "aside" | "other";
  bbox?: readonly number[] | null;
  protected?: boolean;
}
export interface MarginPage { number: number; width?: number; height?: number; blocks: readonly MarginBlock[] }
export interface RunningMargin { id: string; page: number; edge: "header" | "footer" | "left" | "right"; cadence: 1 | 2 }
type Candidate = { block: MarginBlock; page: number; edge: RunningMargin["edge"]; center: number; extent: number };

const keyOf = (text: string) => text.normalize("NFKC").toLowerCase().replace(/^\s*#{1,6}\s*/, "").replace(/[\s\u200b-\u200d\ufeff]+/g, "");
const sectionTitle = /^(?:abstract|introduction|background|methods?|materials(?:andmethods)?|results?|discussion|conclusions?|summary|references|bibliography|acknowledg(?:e)?ments|appendix[a-z0-9]*|摘要|关键词|引言|绪论|背景|方法|研究方法|结果|讨论|结论|小结|参考文献|致谢|附录[一二三四五六七八九十a-z0-9]*)$/i;
const numberedTitle = /^(?:[（(](?:[一二三四五六七八九十百\d]+|[IVXLCDM]+)[）)]|\d+(?:\.\d+)*(?:[.)、．]|\s+[A-Za-z\u3400-\u9fff])|[一二三四五六七八九十百]+[、.)．]|第[一二三四五六七八九十百\d]+[章节部分]|[IVXLCDM]+(?:[.)]\s*|\s+))/i;
const noteOrCaption = /^(?:注[：:]|数据来源|资料来源|图\s*[\dA-Z一二三四五六七八九十]|表\s*[\dA-Z一二三四五六七八九十]|(?:source|notes?|table|fig(?:ure)?|equation)\b)/i;
// A notice family tolerates OCR changes in a publisher URL/date/license tail.
// This is never used for ordinary prose or outside a narrow side margin.
const downloadNotice = /^[\d\s,.:;()/-]{0,48}downloaded\s+from\s+https?:\/\//i;
const copyrightNotice = /^(?:©\s*\d{4}|copyright\s*(?:©\s*)?\d{4})/i;
const positive = (value?: number): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function stable(matches: Candidate[]): boolean {
  const centers = matches.map(value => value.center), extents = matches.map(value => value.extent);
  return Math.max(...centers) - Math.min(...centers) <= 0.02 && Math.max(...extents) - Math.min(...extents) <= 0.015;
}

/** Keep raw blocks intact; suppress only repeated, reliably located page furniture. */
export function detectRunningMargins(pages: readonly MarginPage[]): Map<string, RunningMargin> {
  const candidates = new Map<string, Candidate[]>(), interior = new Set<string>();
  const followingPages = pages.filter(page => page.number > 1);
  for (const page of followingPages) {
    const visible = page.blocks.filter(block => block.text.trim());
    for (const [index, block] of visible.entries()) {
      const text = block.text.trim(), key = keyOf(text), box = block.bbox;
      const titleText = text.normalize("NFKC").replace(/^#{1,6}\s*/, "");
      const knownBox = positive(page.height) && box?.length === 4 && box.every(value => Number.isFinite(value) && value >= 0)
        && box[0] < box[2] && box[1] < box[3] && box[3] <= page.height;
      const height = knownBox ? (box[3] - box[1]) / page.height! : Infinity;
      const width = knownBox && positive(page.width) && box[2] <= page.width ? (box[2] - box[0]) / page.width : Infinity;
      const side = width <= 0.04 ? box![2] / page.width! <= 0.10 ? "left" : box![0] / page.width! >= 0.90 ? "right" : undefined : undefined;
      const edge = side ?? (height <= 0.04 ? index < 2 && box![3] / page.height! <= 0.15 ? "header"
        : index >= visible.length - 2 && box![1] / page.height! >= 0.90 ? "footer" : undefined : undefined);
      if (!edge) { if (!["header", "footer"].includes(block.kind)) interior.add(key); continue; }
      const notice = side && (downloadNotice.test(text) ? "download-notice" : copyrightNotice.test(text) ? "copyright-notice" : undefined);
      if (block.protected || !["text", "heading", "header", "footer", ...(side ? ["aside"] : [])].includes(block.kind)) continue;
      if (notice ? [...key].length > 2000 : [...key].length < 3 || [...key].length > 96 || /[\r\n。！？!?；;]/.test(text)
        || /[.,，、:：]$/.test(text) || sectionTitle.test(key) || numberedTitle.test(titleText) || noteOrCaption.test(titleText)) continue;
      const groupKey = `${edge}:${notice ?? key}`, group = candidates.get(groupKey) ?? [];
      group.push({ block, page: page.number, edge, center: side ? (box![0] + box![2]) / (2 * page.width!) : (box![1] + box![3]) / (2 * page.height!),
        extent: side ? width : height }); candidates.set(groupKey, group);
    }
  }
  const removed = new Map<string, RunningMargin>();
  const remove = (matches: Candidate[], cadence: 1 | 2) => {
    for (const value of matches) if (!removed.has(value.block.id)) removed.set(value.block.id, { id: value.block.id, page: value.page, edge: value.edge, cadence });
  };
  for (const [groupKey, group] of candidates) {
    if (interior.has(groupKey.slice(groupKey.indexOf(":") + 1))) continue;
    const side = ["left", "right"].includes(group[0].edge);
    const numberedPages = followingPages.filter(page => positive(page.height) && (!side || positive(page.width)));
    for (const cadence of [1, 2] as const) for (let parity = 0; parity < cadence; parity++) {
      const matches = group.filter(value => cadence === 1 || value.page % 2 === parity).sort((a, b) => a.page - b.page);
      const observed = new Set(matches.map(value => value.page));
      if (observed.size < 3 || observed.size !== matches.length) continue;
      const eligible = numberedPages.filter(page => cadence === 1 || page.number % 2 === parity);
      const adjacent = matches.slice(1).filter((value, index) => value.page - matches[index].page === cadence).length;
      if (observed.size / eligible.length >= 0.6 && adjacent >= 2 && stable(matches)) remove(matches, cadence);
      // A localized running title needs five uninterrupted occurrences, not
      // merely a high fraction within a self-selected short page range.
      let run: Candidate[] = [];
      const finish = () => {
        if (run.length < 5 || !stable(run)) return;
        // A confirmed run also identifies disconnected occurrences at the
        // same edge and cadence/parity, provided their geometry still agrees.
        remove(matches.filter(match => stable([...run, match])), cadence);
      };
      for (const match of matches) {
        if (run.length && match.page - run[run.length - 1].page !== cadence) { finish(); run = []; }
        run.push(match);
      }
      finish();
    }
  }
  return removed;
}
