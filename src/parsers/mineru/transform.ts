import { ParseError, type ParsedBlock, type ParsedDocument, type ParsedPage } from "../../shared/contracts/parsing";
import { contentQualityFlags } from "../content-quality";
import { normalizeOCRText, object } from "../content";
import { archiveName } from "./archive";
import { detectRunningMargins, type MarginBlock } from "../running-margins";
import { MINERU_NORMALIZER } from "./definition";
import { rewriteImageSources } from "../image-references";
import { applyHeadingHierarchy } from "../apply-heading-hierarchy";

export function parseMinerUResult(files: Map<string, Uint8Array>, expectedPages?: number): { document: ParsedDocument; version?: string } {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const unique = (pattern: RegExp) => {
    const names = [...files.keys()].filter(name => pattern.test(name));
    if (names.length !== 1) throw new ParseError("format"); return names[0];
  };
  let layout: Record<string, unknown>, entries: unknown;
  try {
    layout = object(JSON.parse(decoder.decode(files.get(unique(/(?:^|\/)layout\.json$/)))));
    entries = JSON.parse(decoder.decode(files.get(unique(/(?:^|\/)[^/]+_content_list\.json$/))));
    unique(/(?:^|\/)full\.md$/);
  } catch { throw new ParseError("format"); }
  if (!Array.isArray(layout.pdf_info) || !layout.pdf_info.length || layout.pdf_info.length > 200 || !Array.isArray(entries)) throw new ParseError("format");
  const pages: ParsedPage[] = [], byPage = new Map<number, ParsedPage>(), blocks: ParsedBlock[] = [], warnings = new Set<string>();
  let previous = -1;
  for (const value of layout.pdf_info) {
    const raw = object(value), index = raw.page_idx;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= 200 || index <= previous) throw new ParseError("page-positions");
    previous = index;
    const dimensions = raw.page_size;
    const known = Array.isArray(dimensions) && dimensions.length === 2 && dimensions.every(value => typeof value === "number" && Number.isFinite(value) && value > 0);
    if (!known) warnings.add("missing-page-dimensions");
    const page: ParsedPage = { number: index + 1, width: known ? dimensions[0] : undefined, height: known ? dimensions[1] : undefined,
      raw: { mineru: { layout: raw, content: [] } } };
    pages.push(page); byPage.set(index, page);
  }
  const text = (value: unknown) => typeof value === "string" ? value : "";
  const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === "string") ? value as string[] : [];
  const marginPages = pages.map(page => ({ number: page.number, width: page.width, height: page.height, blocks: [] as MarginBlock[] }));
  const marginByPage = new Map(marginPages.map(page => [page.number - 1, page]));
  for (const [index, value] of entries.entries()) {
    const entry = object(value), page = marginByPage.get(entry.page_idx as number), kind = text(entry.type), box = entry.bbox;
    if (page) page.blocks.push({ id: `mineru:${page.number}:${index}`, text: text(entry.text), kind: ["header", "page_header"].includes(kind) ? "header"
      : ["footer", "page_footer"].includes(kind) ? "footer" : kind === "text" ? entry.text_level === undefined ? "text" : "heading" : kind === "aside_text" ? "aside" : "other",
      bbox: Array.isArray(box) && page.height && page.width ? box.map((value, axis) => Number(value) * (axis % 2 ? page.height! : page.width!) / 1000) : undefined });
  }
  const removed = detectRunningMargins(marginPages);
  for (const margin of removed.values()) warnings.add(`running-margin-removed:${margin.edge}:${margin.id}:cadence-${margin.cadence}`);
  previous = -1;
  for (const [index, value] of entries.entries()) {
    const entry = object(value), page = byPage.get(entry.page_idx as number), kind = text(entry.type);
    if (!page || !kind || (entry.page_idx as number) < previous) throw new ParseError("page-positions");
    previous = entry.page_idx as number;
    (object(page.raw.mineru).content as unknown[]).push(entry);
    if (["page_number", "header", "footer", "page_header", "page_footer"].includes(kind)) continue;
    const box = entry.bbox;
    if (box !== undefined && box !== null && (!Array.isArray(box) || box.length !== 4
      || !box.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000)
      || box[0] > box[2] || box[1] > box[3])) throw new ParseError("format");
    const bbox = Array.isArray(box) && page.width && page.height ? box.map((value, index) => value * (index % 2 ? page.height! : page.width!) / 1000) : null;
    if (kind === "text" && entry.text_level !== undefined
      && (!Number.isSafeInteger(entry.text_level) || Number(entry.text_level) < 1 || Number(entry.text_level) > 6)) throw new ParseError("format");
    if (removed.has(`mineru:${page.number}:${index}`)) continue;
    let type = kind === "equation" ? "formula" : ["reference", "ref_text"].includes(kind) ? "reference"
      : kind === "page_footnote" ? "footnote" : kind === "chart" ? "image" : kind;
    let label = kind, markdown = text(entry.text), headingLevel: number | undefined;
    const metadata: Record<string, unknown> = { provider: "mineru", provider_type: kind, provider_bbox: box ?? null, provider_bbox_units: "normalized-1000", provider_index: index };
    if (kind === "text" && entry.text_level !== undefined) {
      headingLevel = Number(entry.text_level); metadata.provider_heading_level = headingLevel;
      type = "heading"; label = headingLevel === 1 && !blocks.length ? "doc_title" : "paragraph_title";
      markdown = `${"#".repeat(headingLevel)} ${markdown.replace(/^#+\s*/, "")}`;
    } else if (["table", "image", "chart"].includes(kind)) {
      for (const key of [`${kind}_caption`, `${kind}_footnote`]) if (entry[key] !== undefined
        && (!Array.isArray(entry[key]) || !(entry[key] as unknown[]).every(value => typeof value === "string"))) throw new ParseError("format");
      for (const key of ["img_path", "content", ...(kind === "table" ? ["table_body"] : [])]) {
        if (entry[key] !== undefined && typeof entry[key] !== "string") throw new ParseError("format");
      }
      const captions = strings(entry[`${kind}_caption`]), notes = strings(entry[`${kind}_footnote`]);
      const imagePath = text(entry.img_path);
      if (imagePath) { archiveName(imagePath); if (!files.has(imagePath)) throw new ParseError("format"); metadata.provider_image_path = imagePath; }
      const body = kind === "table" ? text(entry.table_body) || (imagePath ? `![](${imagePath})` : "") : imagePath ? `![](${imagePath})` : text(entry.content);
      if (!body.trim()) {
        // MinerU emits detached table captions/notes, including continuations
        // on a different page. Preserve them without inventing a table body.
        if (kind !== "table") throw new ParseError("format");
        if (![...captions, ...notes].some(value => value.trim())) {
          // A valid empty table placeholder has explicit empty image/text
          // fields. Retain it in raw content, just like empty text entries.
          if (entry.img_path !== "" || ![entry.table_caption, entry.table_footnote].every(value => Array.isArray(value) && value.every(item => typeof item === "string"))) throw new ParseError("format");
          warnings.add(`empty-block-skipped:${page.number}:${index}`); continue;
        }
        metadata.missing_visual_body = true; warnings.add(`table-body-missing:${page.number}:${index}`);
      }
      markdown = [...captions, body, ...notes.map(note => `> ${note}`)].filter(Boolean).join("\n\n");
    } else if (kind === "list") markdown = strings(entry.list_items).map(item => `- ${item}`).join("\n");
    else if (kind === "code") markdown = `\`\`\`\n${text(entry.code_body) || markdown}\n\`\`\``;
    else if (["footnote", "page_footnote"].includes(kind) && markdown.trim()) markdown = `> ${markdown}`;
    else if (!markdown) markdown = text(entry.content);
    if (!markdown.trim()) {
      if (kind === "text" && typeof entry.text === "string") { warnings.add(`empty-block-skipped:${page.number}:${index}`); continue; }
      // A recognized visual block must provide a usable image/content. Unknown
      // semantic structures cannot silently disappear from a published document.
      throw new ParseError("format");
    }
    const sourceID = `mineru:${page.number}:${index}`;
    blocks.push({ type, label, markdown, text: normalizeOCRText(markdown), page: page.number, sourceID, bbox, headingLevel, metadata,
      qualityFlags: [...contentQualityFlags(type, markdown), ...(metadata.heading_level_inferred ? ["heading_level_inferred"] : []),
        ...(metadata.missing_visual_body ? ["missing_visual_body"] : [])],
      locations: bbox ? [{ page: page.number, bbox, sourceID }] : [] });
  }
  if (!blocks.length) throw new ParseError("empty");
  const headingWarnings: string[] = [];
  applyHeadingHierarchy(blocks, headingWarnings);
  for (const warning of headingWarnings) warnings.add(warning);
  const total = Math.max(expectedPages ?? 0, pages[pages.length - 1].number);
  if (expectedPages === undefined) warnings.add("source-page-count-unverified");
  if (total > 200) throw new ParseError("page-positions");
  for (let page = 1; page <= total; page++) if (!byPage.has(page - 1)) warnings.add(`missing-page:${page}`);
  const title = blocks.find(block => block.label === "doc_title")?.text ?? null;
  return { document: { normalizerVersion: MINERU_NORMALIZER, sectionHierarchy: "heading-levels", pages, blocks, total, partial: pages.length !== total, warnings: [...warnings],
    markdown: blocks.map(block => block.markdown).join("\n\n"), detectedMetadata: { title, abstract: null, language: null } },
    version: typeof layout._version_name === "string" ? layout._version_name : undefined };
}

export function rewriteMinerUImages(document: ParsedDocument, paths: Map<string, string>): void {
  for (const block of document.blocks) {
    block.markdown = rewriteImageSources(block.markdown, path => {
      const key = paths.get(path); if (!key) throw new ParseError("format"); return key;
    });
  }
  document.markdown = document.blocks.map(block => block.markdown).join("\n\n");
}
