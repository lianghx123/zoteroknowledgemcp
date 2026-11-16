/** Token positions use Unicode code points in the original Markdown. */
export type SearchOffset = [token: string, start: number, end: number];
export const fulltextProfile = "unicode-cjk-bigram-2";
export function searchKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().normalize("NFD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC").replace(/ς/gu, "σ");
}
export function searchTokens(text: string): string {
  const tokens = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
  return tokens.flatMap(token => {
    token = searchKey(token); const chars = [...token];
    return /[\u3400-\u9fff\u3040-\u30ff]/u.test(token) && chars.length > 1
      ? [token, ...chars.slice(1).map((char, index) => chars[index] + char)] : [token];
  }).join(" ");
}
export function searchOffsets(text: string): SearchOffset[] {
  let normalized = "", offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const end = offset + [...segment].length, value = segment.normalize("NFKC").toLowerCase();
    normalized += value;
    for (let index = 0; index < value.length; index++) { starts.push(offset); ends.push(end); }
    offset = end;
  }
  const positions: SearchOffset[] = [];
  for (const match of normalized.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)) {
    const word = match[0], start = match.index!;
    positions.push([searchKey(word), starts[start], ends[start + word.length - 1]]);
    if (/[\u3400-\u9fff\u3040-\u30ff]/u.test(word)) {
      let index = start; const chars = [...word];
      for (let part = 0; part + 1 < chars.length; part++) {
        const length = chars[part].length + chars[part + 1].length;
        positions.push([searchKey(chars[part] + chars[part + 1]), starts[index], ends[index + length - 1]]); index += chars[part].length;
      }
    }
  }
  return positions;
}
export function searchPosition(text: string, query: string): number | undefined {
  const terms = new Set(searchTokens(query).split(" ").filter(Boolean).map(searchKey));
  return searchOffsets(text).find(([token]) => terms.has(token))?.[1];
}
