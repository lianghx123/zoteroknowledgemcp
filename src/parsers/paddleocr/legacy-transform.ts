import { ParseError, type ParsedBlock, type ParsedDocument, type ParsedPage } from "../../shared/contracts/parsing";

export const NORMALIZER_VERSION = "paddleocr-vl-1";
type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue { return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {}; }
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const skips = new Set(["header", "header_image", "footer", "footer_image", "number"]);

function declaredPages(item: ObjectValue): number | undefined {
  const result = object(item.result), info = object(result.dataInfo);
  return count(item.pageCount) ?? count(item.numPages) ?? count(result.pageCount) ?? count(info.numPages) ?? count(object(item.dataInfo).numPages);
}

function plain(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
}

function tableMarkdown(value: string): string {
  if (!/<table\b/i.test(value)) return value;
  const rows = [...value.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map(cell => plain(cell[1]).replaceAll("|", "\\|")));
  if (!rows.length || !rows[0].length) return plain(value);
  const width = Math.max(...rows.map(row => row.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
  return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

/** Preserve page gaps; an ambiguous failed chunk must never renumber later pages. */
export function parsePaddleResult(text: string, expectedPages?: number): ParsedDocument {
  const chunks: Array<{ pages: ObjectValue[]; count?: number; failed: boolean }> = [];
  let items: unknown[];
  try {
    const trimmed = text.replace(/^\uFEFF/, "").trim();
    try { const value = JSON.parse(trimmed); items = Array.isArray(value) ? value : [value]; }
    catch { items = trimmed.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
  } catch { throw new ParseError("format"); }
  for (const value of items) {
    const item = object(value), result = object(item.result);
    const pages = result.layoutParsingResults;
    const failed = ![undefined, 0, "0"].includes(item.errorCode as 0) || !Array.isArray(pages) || !pages.length;
    if (!failed && (!pages.every(page => page && typeof page === "object" && !Array.isArray(page)))) throw new ParseError("format");
    chunks.push({ pages: failed ? [] : pages as ObjectValue[], count: declaredPages(item) ?? (!failed ? pages.length : undefined), failed });
  }
  const unknown = chunks.filter(chunk => chunk.count === undefined);
  if (unknown.length) {
    const remaining = (expectedPages ?? 0) - chunks.reduce((sum, chunk) => sum + (chunk.count ?? 0), 0);
    if (unknown.length !== 1 || remaining < 1) throw new ParseError("page-positions");
    unknown[0].count = remaining;
  }
  const pages: ParsedPage[] = [], blocks: ParsedBlock[] = [], warnings: string[] = [];
  let cursor = 1;
  for (const chunk of chunks) {
    if (chunk.failed) { warnings.push(`missing-pages:${cursor}-${cursor + chunk.count! - 1}`); cursor += chunk.count!; continue; }
    if (chunk.count !== chunk.pages.length) throw new ParseError("page-positions");
    for (const raw of chunk.pages) {
      const pruned = object(raw.prunedResult), number = cursor++;
      pages.push({ number, width: count(pruned.width), height: count(pruned.height), raw });
      const layout = pruned.parsing_res_list;
      if (!Array.isArray(layout)) throw new ParseError("format");
      for (const [index, entry] of layout.entries()) {
        const block = object(entry), label = typeof block.block_label === "string" ? block.block_label : "text";
        if (typeof block.block_content !== "string" || skips.has(label) || !block.block_content.trim()) continue;
        let markdown = block.block_content.trim(), type = "paragraph", headingLevel: number | undefined;
        if (["doc_title", "paragraph_title"].includes(label)) {
          headingLevel = label === "doc_title" ? 1 : Math.min(6, count(block.block_level) ?? count(block.level) ?? 2);
          markdown = `${"#".repeat(headingLevel)} ${markdown.replace(/^#+\s*/, "")}`; type = "heading";
        } else if (label === "table") { markdown = tableMarkdown(markdown); type = "table"; }
        else if (label === "display_formula") { type = "formula"; if (!markdown.startsWith("$$")) markdown = `$$\n${markdown}\n$$`; }
        else if (["image", "chart"].includes(label)) type = "image";
        else if (label === "abstract") type = "abstract";
        else if (label === "reference_content") type = "reference";
        else if (label.endsWith("_title")) type = "caption";
        else if (label.includes("footnote")) type = "footnote";
        const bbox = Array.isArray(block.block_bbox) && block.block_bbox.length >= 4 && block.block_bbox.every(value => typeof value === "number" && Number.isFinite(value))
          ? block.block_bbox as number[] : null;
        blocks.push({ type, label, markdown, text: plain(markdown), page: number, sourceID: String(block.global_block_id ?? block.block_id ?? `${number}:${index}`), bbox, headingLevel });
      }
    }
  }
  const total = Math.max(expectedPages ?? 0, cursor - 1);
  if (total > cursor - 1) warnings.push(`missing-pages:${cursor}-${total}`);
  if (!pages.length || !blocks.length) throw new ParseError("empty");
  return { normalizerVersion: NORMALIZER_VERSION, pages, blocks, total, partial: warnings.length > 0, warnings, markdown: blocks.map(block => block.markdown).join("\n\n") };
}

export function imageReferences(document: ParsedDocument): Map<string, string> {
  const references = new Map<string, string>();
  for (const page of document.pages) {
    const markdown = object(page.raw.markdown);
    for (const [key, value] of Object.entries(object(markdown.images))) {
      if (typeof value !== "string" || !value) continue;
      // Keys only replace references; they never become filesystem paths.
      references.set(key, value);
    }
    for (const [key, value] of Object.entries(object(page.raw.outputImages))) {
      if (typeof value === "string" && value) references.set(`page-${page.number}-${key}`, value);
    }
  }
  return references;
}

export { imageType } from "../assets";
