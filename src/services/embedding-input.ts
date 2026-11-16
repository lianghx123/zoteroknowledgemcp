import { contentQualityFlags } from "../parsers/content-quality";
import { searchTokens } from "./search-text";
export { searchTokens } from "./search-text";

const excluded = new Set(["short_fragment", "connector_only", "reference_entry", "author_line", "keyword_line", "table_label_only", "bibliographic_boilerplate", "formula_only", "header", "footer", "boilerplate"]);
export interface InputSegment { ordinal: number; start: number; end: number; overlap: number; text: string; }
export function embeddingAdmission(type: string, text: string, flags: readonly string[] = []): string[] {
  return [...new Set([...flags, ...contentQualityFlags(type, text)])].filter(flag => excluded.has(flag));
}
/** Offsets refer to UTF-16 positions in the preserved source, never a trimmed copy. */
export function splitEmbeddingInput(text: string, limit: number, overlap = 80): InputSegment[] {
  if (!Number.isInteger(limit) || limit < 16 || overlap < 0 || overlap >= limit / 2) throw new Error("segment-limit");
  const output: InputSegment[] = []; let start = 0, previousEnd = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const window = text.slice(start, end), minimum = Math.floor(limit / 2);
      const paragraph = window.lastIndexOf("\n\n");
      const sentence = [...window.matchAll(/[.!?。！？][\s\n]?/gu)].at(-1);
      const boundary = paragraph >= minimum ? paragraph + 2 : sentence && sentence.index! >= minimum ? sentence.index! + sentence[0].length : -1;
      if (boundary > 0) end = start + boundary;
      if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    }
    const value = text.slice(start, end);
    if (value.trim()) output.push({ ordinal: output.length, start, end, overlap: Math.max(0, previousEnd - start), text: value });
    if (end === text.length) break;
    previousEnd = end; start = Math.max(start + 1, end - overlap);
    if (/[\uDC00-\uDFFF]/u.test(text[start])) start++;
  }
  return output;
}
export function ftsExpression(query: string): string {
  return [...new Set(searchTokens(query).split(" ").filter(Boolean))].map(token => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}
