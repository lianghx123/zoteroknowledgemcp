import { ParseError, type ParsedBlock, type ParsedDocument, type ParsedPage } from "../../shared/contracts/parsing";
import { contentQualityFlags, isKeywordLine } from "../content-quality";
import { normalizeOCRText, object } from "../content";
import { PADDLEOCR_NORMALIZER } from "./definition";
import { rewriteImageSources } from "../image-references";
import { detectRunningMargins, type MarginBlock } from "../running-margins";
import { referencePrefix } from "../../shared/reference-number";
import { unnumberedReferenceContinuation } from "../../shared/reference-continuation";
import { applyHeadingHierarchy } from "../apply-heading-hierarchy";
export { normalizeOCRText, object } from "../content";
export { imageType } from "../assets";

export { PADDLEOCR_NORMALIZER as NORMALIZER_VERSION } from "./definition";
type ObjectValue = Record<string, unknown>;
const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const dimension = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
const mergeable = new Set(["text", "abstract", "reference_content"]);
const canonicalSkips = new Set(["header", "header_image", "footer", "footer_image", "number"]);
const types: Record<string, string> = { doc_title: "heading", paragraph_title: "heading", abstract: "abstract", reference_content: "reference", table: "table", display_formula: "formula", formula_number: "formula_number", figure_title: "caption", table_title: "caption", chart_title: "caption", image: "image", chart: "image", footnote: "footnote", vision_footnote: "footnote" };
const textValue = (value: unknown): string => value === null || value === undefined ? "" : String(value);
const labelOf = (block: ObjectValue): string => textValue(block.block_label);
const contentOf = (block: ObjectValue): string => textValue(block.block_content);

function declaredPages(item: ObjectValue): number | undefined {
  const result = object(item.result);
  return positive(object(result.dataInfo).numPages) ?? positive(object(item.dataInfo).numPages)
    ?? positive(item.pageCount) ?? positive(item.numPages) ?? positive(result.pageCount);
}


function heading(content: string, label: string): string {
  const text = content.trim(); if (text.startsWith("#")) return text;
  const level = label === "doc_title" ? 1 : /^(?:[一二三四五六七八九十百]+、|第.+[章节部分])/.test(text) ? 2 : 3;
  return `${"#".repeat(level)} ${text}`;
}
function centered(content: string): string {
  const text = content.trim(); if (text.toLowerCase().startsWith("<div")) return text;
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
  return `<div style="text-align: center;">${escaped}</div>`;
}
function styledTable(content: string): string {
  const text = content.trim();
  return !/<table/i.test(text) || /<table\b[^>]*\bborder\s*=/i.test(text) ? text
    : text.replace(/<table\b/i, "<table border=1 style='margin: auto; word-wrap: break-word;'");
}
function formulaNumber(formula: string, number: string): string {
  formula = formula.trim(); number = number.trim(); if (!number || formula.includes("\\tag")) return formula;
  const match = /^\$\$\s*([\s\S]*?)\s*\$\$$/.exec(formula);
  return match ? `$$ ${match[1]} \\tag*{${number}}$$` : `${formula}  ${number}`;
}
function replaceImages(content: string, map: ObjectValue): string {
  return rewriteImageSources(content, source => Object.hasOwn(map, source) && typeof map[source] === "string" ? map[source] as string : undefined);
}
function blocksOf(page: ParsedPage): ObjectValue[] {
  const entries = object(page.raw.prunedResult).parsing_res_list;
  return Array.isArray(entries) ? entries.map(object) : [];
}

function runningMargins(pages: ParsedPage[]) {
  return detectRunningMargins(pages.map(page => ({ number: page.number, width: page.width ?? dimension(object(page.raw.prunedResult).width), height: page.height ?? dimension(object(page.raw.prunedResult).height),
    blocks: blocksOf(page).map((block, index): MarginBlock => {
      const label = labelOf(block);
      return { id: `${page.number}:${index}`, text: contentOf(block), bbox: Array.isArray(block.block_bbox) ? block.block_bbox as number[] : undefined,
        protected: label === "doc_title", kind: ["header", "footer"].includes(label) ? label as "header" | "footer"
          : ["paragraph_title", "doc_title"].includes(label) ? "heading" : label === "text" ? "text" : label === "aside_text" ? "aside" : "other" };
    }) })));
}

/** PaddleOCR may put a crop only in markdown.images and leave its layout text empty. */
function visualContent(block: ObjectValue, images: ObjectValue): string {
  const content = contentOf(block), label = labelOf(block), bbox = block.block_bbox;
  if (content.trim() || !["image", "chart"].includes(label) || !Array.isArray(bbox) || bbox.length !== 4
    || !bbox.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)
    || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return content;
  const matches = Object.entries(images).filter(([name, target]) => {
    const match = /(?:^|\/)img_in_(image|chart)_box_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)\.(?:png|jpe?g|webp|gif)$/i.exec(name);
    return typeof target === "string" && target && match?.[1] === label && bbox.every((value, index) => value === Number(match[index + 2]));
  });
  // Matching is page-local and requires the exact label and source box. Never
  // attach a similarly named crop or another page's image by array position.
  if (matches.length !== 1) return content;
  const [reference, target] = matches[0]; block._image_reference = reference;
  return `![](<${String(target).replace(/[<>\r\n]/g, value => encodeURIComponent(value))}>)`;
}
function shouldMerge(previous: ObjectValue, following: ObjectValue, crossPage = false): boolean {
  if (!mergeable.has(labelOf(previous)) || !mergeable.has(labelOf(following))) return false;
  // Reference punctuation occurs inside entries (author initials, journals).
  // Unnumbered entries can continue on the next page with lexical evidence.
  if ([previous, following].some(block => labelOf(block) === "reference_content")) {
    return labelOf(previous) === "reference_content" && labelOf(following) === "reference_content"
      && (numberedReference(previous) || crossPage && unnumberedReferenceContinuation(contentOf(previous), contentOf(following))) && !numberedReference(following)
      && !!contentOf(following).trim() && !structuredText(following);
  }
  const before = contentOf(previous).trim().replace(/(?:\s*(?:\$\s*\^\s*\{?\d+\}?\s*\$|[⁰¹²³⁴⁵⁶⁷⁸⁹]+))+$/u, "").trimEnd(), after = contentOf(following).trim();
  if (isKeywordLine(before) || isKeywordLine(after)) return false;
  if (!before || !after || /^[一二三四五六七八九十百]+、|^第[一二三四五六七八九十百0-9]+[章节部分]|^\d+[.、]\s*/.test(after) || ["参考文献", "【参考文献】"].includes(after)) return false;
  if (/[。！？.!?][”’」』）)"']*$/.test(before)) return false;
  return /[，,、（(:：;；-]$/.test(before) || !/[。！？!?；;：:.]$/.test(before);
}

function numberedReference(block: ObjectValue): boolean {
  return referencePrefix(contentOf(block), true) !== undefined;
}

function appendParagraph(previous: ObjectValue, next: ObjectValue): void {
  const before = contentOf(previous).trimEnd(), after = contentOf(next).trimStart();
  const cjk = /[\u4e00-\u9fff，。！？；：、（）《》“”‘’]/;
  const referenceHyphen = labelOf(previous) === "reference_content" && /[-‐‑]$/u.test(before) && /^[A-Za-z]/.test(after);
  previous.block_content = before + (referenceHyphen || cjk.test(before.slice(-1)) || cjk.test(after.slice(0, 1)) ? "" : " ") + after;
  for (const key of ["_source_pages", "_source_block_ids", "_source_locations"]) previous[key] = [...previous[key] as unknown[], ...next[key] as unknown[]];
  if (previous.cross_page_merged || next.cross_page_merged || new Set(previous._source_pages as number[]).size > 1) previous.cross_page_merged = true;
  if (next.cross_image_merged) previous.cross_image_merged = true;
  if (next.cross_table_merged) previous.cross_table_merged = true;
  if (next.cross_note_merged) previous.cross_note_merged = true;
  if (next.reference_continuation_merged) previous.reference_continuation_merged = true;
}

function structuredText(block: ObjectValue): boolean {
  return /!?\[[^\]]*\]\(|<\/?[a-z][^>]*>|^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)、]\s|\$\$|\\\[)/i.test(contentOf(block));
}

/** Keep image/table/note groups intact; only surrounding text can continue. */
function mergeParagraphContinuations(pages: ParsedPage[]): void {
  const visuals = new Set(["image", "chart"]);
  const visualParts = new Set(["figure_title", "chart_title", "table_title", "vision_footnote", "footnote"]);
  let previous: ObjectValue | undefined, previousPage: number | undefined, hasImage = false, hasTable = false;
  const notes = new Set(["footnote", "vision_footnote"]);
  let gap: ObjectValue[] = [], lastPage: number | undefined;
  for (const page of pages) {
    const layout = blocksOf(page), removed = new Set<ObjectValue>();
    if (lastPage !== undefined && page.number !== lastPage + 1) { previous = undefined; gap = []; hasImage = false; hasTable = false; }
    let meaningful = false, hasParagraph = false;
    for (const block of layout) {
      const label = labelOf(block), image = visuals.has(label), table = label === "table" && !!contentOf(block).trim(), visual = image || table;
      if (canonicalSkips.has(label)) continue;
      if (!visual && !contentOf(block).trim()) {
        // An empty heading/table/unknown block still leaves an uncertain boundary.
        if (label === "table_title" || (!mergeable.has(label) && !visualParts.has(label))) { previous = undefined; gap = []; hasImage = false; hasTable = false; }
        continue;
      }
      meaningful = true;
      if (mergeable.has(label)) {
        hasParagraph = true;
        const hasNotes = gap.some(part => notes.has(labelOf(part)));
        const bodyPair = previous && labelOf(previous) === "text" && label === "text" && !structuredText(previous) && !structuredText(block);
        const referencePair = previous && labelOf(previous) === "reference_content" && label === "reference_content";
        const continuationPair = bodyPair || referencePair;
        // PaddleOCR also uses figure_title for table captions. Keep its label;
        // only an explicit table_title requires a table in the floating group.
        const pairedCaptions = hasTable || !gap.some(part => labelOf(part) === "table_title");
        const acrossImage = hasImage && continuationPair && pairedCaptions, acrossTable = hasTable && continuationPair && pairedCaptions;
        const acrossNotes = hasNotes && !hasImage && !hasTable && continuationPair && gap.every(part => notes.has(labelOf(part)));
        const acrossPage = !hasImage && !hasTable && previousPage !== page.number && gap.every(part => labelOf(part) === "footnote");
        const adjacentReference = referencePair && gap.length === 0;
        if (previous && (acrossImage || acrossTable || acrossNotes || acrossPage || adjacentReference) && shouldMerge(previous, block, previousPage !== page.number)) {
          appendParagraph(previous, block);
          if (referencePair) previous.reference_continuation_merged = true;
          if (acrossImage) previous.cross_image_merged = true;
          if (acrossTable) previous.cross_table_merged = true;
          if (hasNotes) previous.cross_note_merged = true;
          removed.add(block);
          // The same paragraph may continue through another float or page.
          previousPage = page.number; gap = []; hasImage = false; hasTable = false;
        } else {
          previous = block; previousPage = page.number;
          gap = []; hasImage = false; hasTable = false;
        }
      } else if (previous && (label === "footnote" || (["text", "reference_content"].includes(labelOf(previous)) && (visual || visualParts.has(label))))) {
        gap.push(block); hasImage ||= image; hasTable ||= table;
      } else { previous = undefined; gap = []; hasImage = false; hasTable = false; }
    }
    if (!meaningful || (!hasParagraph && !hasImage && !hasTable)) { previous = undefined; gap = []; hasImage = false; hasTable = false; }
    object(page.raw.prunedResult).parsing_res_list = layout.filter(block => !removed.has(block));
    lastPage = page.number;
  }
}

/** Preserve raw pages; merging changes only a deep copy used for canonical content. */
export function mergeCrossPageParagraphs(pages: ParsedPage[]): ParsedPage[] {
  const merged = JSON.parse(JSON.stringify(pages)) as ParsedPage[];
  const removed = runningMargins(pages);
  for (const page of merged) {
    const pruned = object(page.raw.prunedResult), blocks = blocksOf(page); pruned.parsing_res_list = blocks;
    const images = object(object(page.raw.markdown).images);
    for (const [index, block] of blocks.entries()) {
      block._source_index = index;
      if (["image", "chart"].includes(labelOf(block))) block.block_content = visualContent(block, images);
      const id = block.global_block_id ?? block.block_id ?? `${page.number}:${index}`;
      block._source_pages = [page.number]; block._source_block_ids = [String(id)];
      const bbox = block.block_bbox;
      block._source_locations = Array.isArray(bbox) && bbox.length >= 4 && bbox.every(value => typeof value === "number" && Number.isFinite(value))
        ? [{ page: page.number, bbox, sourceID: textValue(id ?? `${page.number}:${index}`) }] : [];
    }
    pruned.parsing_res_list = blocks.filter((_block, index) => !removed.has(`${page.number}:${index}`));
  }
  mergeParagraphContinuations(merged);
  return merged;
}

function metadata(pages: ParsedPage[]): NonNullable<ParsedDocument["detectedMetadata"]> {
  let title: string | null = null; const abstracts: string[] = [];
  for (const page of pages) for (const block of blocksOf(page)) {
    const content = contentOf(block).trim();
    if (labelOf(block) === "doc_title" && content && title === null) title = content.replace(/^#+\s*/, "");
    else if (labelOf(block) === "abstract" && content) abstracts.push(content);
  }
  const abstract = abstracts.join("\n") || null;
  return { title, abstract, language: /[\u4e00-\u9fff]/.test(`${title ?? ""}\n${abstract ?? ""}`) ? "zh-CN" : null };
}

export function buildCanonicalBlocks(pages: ParsedPage[], warnings: string[] = []): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  for (const page of mergeCrossPageParagraphs(pages)) {
    const layout = blocksOf(page), images = object(object(page.raw.markdown).images);
    for (let index = 0; index < layout.length; index++) {
      const block = layout[index], label = labelOf(block);
      if (canonicalSkips.has(label)) continue;
      const content = replaceImages(contentOf(block), images).trim(); if (!content) continue;
      const type = types[label] ?? "paragraph";
      let markdown = content, headingLevel: number | undefined;
      if (["doc_title", "paragraph_title"].includes(label)) { markdown = heading(content, label); headingLevel = Math.min(6, /^#+/.exec(markdown)?.[0].length ?? 1); }
      else if (["figure_title", "table_title", "chart_title"].includes(label)) markdown = centered(content);
      else if (label === "table") markdown = styledTable(content);
      else if (label === "display_formula" && labelOf(layout[index + 1] ?? {}) === "formula_number") { markdown = formulaNumber(content, contentOf(layout[++index])); }
      else if (["footnote", "vision_footnote"].includes(label)) markdown = `> ${content}`;
      const sourcePages = block._source_pages as number[], sourceIDs = block._source_block_ids as string[], locations = block._source_locations as NonNullable<ParsedBlock["locations"]>;
      const qualityFlags = contentQualityFlags(type, markdown);
      if (isKeywordLine(markdown) && !qualityFlags.includes("keyword_line")) qualityFlags.push("keyword_line");
      qualityFlags.sort();
      blocks.push({ type, label, markdown, text: normalizeOCRText(markdown), page: Math.min(...sourcePages), pageEnd: Math.max(...sourcePages),
        sourceID: sourceIDs[0] ?? `${page.number}:${block._source_index ?? index}`, sourceIDs, bbox: locations[0]?.bbox ?? null, locations, headingLevel,
        qualityFlags, metadata: { cross_page_merged: Boolean(block.cross_page_merged), ...(block.cross_image_merged ? { cross_image_merged: true } : {}), ...(block.cross_table_merged ? { cross_table_merged: true } : {}), ...(block.cross_note_merged ? { cross_note_merged: true } : {}), ...(block.reference_continuation_merged ? { reference_continuation_merged: true } : {}), ...(block._image_reference ? { image_reference: block._image_reference } : {}), ...(qualityFlags.length ? { qualityFlags } : {}) } });
    }
  }
  return applyHeadingHierarchy(blocks, warnings);
}

/** Reference document artifact: page/layout comments plus cleaned, merged Markdown. */
export function paddlePagesToMarkdown(pages: ParsedPage[], blocks = buildCanonicalBlocks(pages)): string {
  const parts: string[] = [];
  const headings = new Map<string, string[]>();
  for (const block of blocks.filter(block => ["doc_title", "paragraph_title"].includes(block.label))) {
    const key = `${block.page}:${block.sourceID}`, values = headings.get(key) ?? [];
    values.push(block.markdown); headings.set(key, values);
  }
  const python = (value: unknown): string => value === null || value === undefined ? "None" : Array.isArray(value) ? `[${value.map(python).join(", ")}]` : String(value);
  for (const page of mergeCrossPageParagraphs(pages)) {
    const pruned = object(page.raw.prunedResult), layout = blocksOf(page), images = object(object(page.raw.markdown).images);
    parts.push(`<!-- page ${page.number}; width=${python(pruned.width)}; height=${python(pruned.height)} -->`);
    for (let index = 0; index < layout.length; index++) {
      const block = layout[index], label = labelOf(block);
      if (["header", "footer", "number"].includes(label)) continue;
      const comment = `<!-- page=${page.number} label=${python(block.block_label)} block_id=${python(block.block_id)} global_block_id=${python(block.global_block_id)} order=${python(block.block_order)} bbox=${python(block.block_bbox)} -->`;
      let content = replaceImages(contentOf(block), images);
      if (["doc_title", "paragraph_title"].includes(label)) {
        const key = `${page.number}:${(block._source_block_ids as string[])?.[0]}`;
        content = (content.trim() ? headings.get(key)?.shift() : undefined) ?? heading(content, label);
      }
      else if (["figure_title", "table_title", "chart_title"].includes(label)) content = centered(content);
      else if (label === "table") content = styledTable(content);
      else if (label === "display_formula" && labelOf(layout[index + 1] ?? {}) === "formula_number") content = formulaNumber(content, contentOf(layout[++index]));
      else if (["footnote", "vision_footnote"].includes(label)) content = `> ${content.trim()}`;
      parts.push([comment, content.trim()].filter(value => value.trim()).join("\n"));
    }
  }
  return parts.filter(part => part.trim()).join("\n\n") + "\n";
}

/** JSONL page-position validation matches the reference; JSON envelopes remain compatible. */
export function parsePaddleResult(text: string, expectedPages?: number): ParsedDocument {
  let items: Array<{ value: unknown; line: number }>;
  try {
    const cleaned = text.replace(/^\uFEFF/, "");
    try { const value = JSON.parse(cleaned); items = (Array.isArray(value) ? value : [value]).map((value, index) => ({ value, line: index + 1 })); }
    catch { items = cleaned.split(/\r?\n/).flatMap((text, index) => text.trim() ? [{ value: JSON.parse(text), line: index + 1 }] : []); }
  } catch { throw new ParseError("format"); }
  const chunks = items.map(({ value, line }) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ParseError("format");
    const item = object(value), result = object(item.result), layout = result.layoutParsingResults;
    const failed = ![undefined, 0, "0"].includes(item.errorCode as 0) || !Array.isArray(layout);
    if (!failed && !(layout as unknown[]).every(page => page && typeof page === "object" && !Array.isArray(page))) throw new ParseError("format");
    return { pages: failed ? [] : layout as ObjectValue[], count: declaredPages(item) ?? (!failed ? (layout as unknown[]).length : undefined),
      error: failed ? { line, ...(![undefined, 0, "0"].includes(item.errorCode as 0) ? { error_code: item.errorCode, error_message: item.errorMsg ?? null }
        : { error_message: item.result && typeof item.result === "object" && !Array.isArray(item.result) ? "layoutParsingResults is not a list" : "missing result" }) } as ObjectValue : undefined };
  });
  const unknown = chunks.filter(chunk => chunk.count === undefined);
  if (unknown.length) {
    const remaining = (expectedPages ?? 0) - chunks.reduce((sum, chunk) => sum + (chunk.count ?? 0), 0);
    if (unknown.length !== 1 || remaining < 1) throw new ParseError("page-positions"); unknown[0].count = remaining;
  }
  const pages: ParsedPage[] = [], warnings: string[] = [], errors: ObjectValue[] = [];
  let cursor = 1;
  for (const chunk of chunks) {
    if (chunk.error) { chunk.error.page_start = cursor; chunk.error.page_end = cursor + chunk.count! - 1; errors.push(chunk.error);
      warnings.push(`missing-pages:${cursor}-${cursor + chunk.count! - 1}`); cursor += chunk.count!; continue; }
    if (!chunk.pages.length && chunk.count) {
      warnings.push(`missing-pages:${cursor}-${cursor + chunk.count - 1}`); cursor += chunk.count; continue;
    }
    if (chunk.count !== chunk.pages.length) throw new ParseError("page-positions");
    for (const raw of chunk.pages) {
      const number = cursor++, normalized = { ...raw }, pruned = object(raw.prunedResult);
      if (!Array.isArray(pruned.parsing_res_list) || !pruned.parsing_res_list.every(value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const block = value as ObjectValue;
        return (block.block_label === undefined || typeof block.block_label === "string")
          && (block.block_content === undefined || block.block_content === null || typeof block.block_content === "string");
      })) throw new ParseError("format");
      if (number !== pages.length + 1) normalized._parse_page_number = number;
      pages.push({ number, width: dimension(pruned.width), height: dimension(pruned.height), raw: normalized });
    }
  }
  const total = Math.max(expectedPages ?? 0, cursor - 1);
  if (total > cursor - 1) warnings.push(`missing-pages:${cursor}-${total}`);
  if (!pages.length) throw new ParseError("empty");
  for (const margin of runningMargins(pages).values()) warnings.push(`running-margin-removed:${margin.edge}:${margin.id}:cadence-${margin.cadence}`);
  const blocks = buildCanonicalBlocks(pages, warnings); if (!blocks.length) throw new ParseError("empty");
  return { normalizerVersion: PADDLEOCR_NORMALIZER, sectionHierarchy: "heading-levels", pages, blocks, total, partial: pages.length < total, warnings, errors, detectedMetadata: metadata(pages), markdown: paddlePagesToMarkdown(pages, blocks) };
}

/** Page-scoped maps avoid collisions when multiple pages reuse the same image filename. */
export function imageReferences(document: ParsedDocument): Map<string, string> {
  const references = new Map<string, string>();
  for (const page of document.pages) {
    for (const [key, value] of Object.entries(object(object(page.raw.markdown).images))) if (typeof value === "string" && value) references.set(`embedded:${page.number}:${key}`, value);
    if (typeof page.raw.inputImage === "string" && page.raw.inputImage) references.set(`page:${page.number}`, page.raw.inputImage);
    // Keep compatibility with deployments returning diagnostic page images.
    for (const [key, value] of Object.entries(object(page.raw.outputImages))) if (typeof value === "string" && value) references.set(`output:${page.number}:${key}`, value);
  }
  return references;
}
