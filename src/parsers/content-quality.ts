import { normalizeOCRText } from "./content";

/** Keyword lists are standalone front matter, not unfinished body paragraphs. */
export function isKeywordLine(markdown: string): boolean {
  const text = normalizeOCRText(markdown).replace(/^[*_]{1,2}\s*/, "").replace(/[*_]{1,2}\s*(?=[:：])/, "");
  return /^(?:key[\s-]*words?|关键词|关键字|關鍵詞|關鍵字)\s*[:：]/i.test(text);
}

/** Reference admission/quality classification; flags do not discard document content. */
export function contentQualityFlags(type: string, markdown: string): string[] {
  const text = markdown.trim(), normalized = text.replace(/\s+/g, " ").trim(), flags = new Set<string>();
  const cjk = (normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length;
  const latin = (normalized.match(/[A-Za-z0-9]/g) ?? []).length;
  const words = (normalized.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
  if (["header", "running_header"].includes(type)) { flags.add("boilerplate"); flags.add("header"); }
  if (["footer", "running_footer"].includes(type)) { flags.add("boilerplate"); flags.add("footer"); }
  if (["formula", "equation"].includes(type) && text.length < 200) flags.add("formula_only");
  if (["reference", "reference_entry", "bibliography"].includes(type)) flags.add("reference_entry");
  if (["table", "table_cell"].includes(type)) flags.add("table");
  const boilerplate = (condition: boolean, flag: string) => { if (condition) { flags.add("boilerplate"); flags.add(flag); } };
  boilerplate(/^\s*(?:page\s*)?\d{1,4}\s*$/i.test(text), "page_number");
  boilerplate(/downloaded\s+from|下载自|download\s+date/i.test(text), "download_notice");
  boilerplate(/copyright|all rights reserved|©|版权所有/i.test(text), "copyright");
  boilerplate(text.length <= 120 && /^(?:https?:\/\/|www\.|doi:|vol\.?\s*\d+|issue\s*\d+)/i.test(text), "header");
  if (!normalized || (!["heading", "title", "caption"].includes(type) && !(cjk >= 10 || (latin >= 20 && words >= 4)))) flags.add("short_fragment");
  if (/^(?:and|where|implies|which\s+implies|proof\s*:\s*let)\s*[:;,.-]?$/i.test(normalized)) { flags.add("short_fragment"); flags.add("connector_only"); }
  if (/^(?:(?:authors?|作者)\s*[:：].+|(?:[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}|[\u4e00-\u9fff]{2,4})(?:\s*[,;，；]\s*(?:[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}|[\u4e00-\u9fff]{2,4})){1,})$/i.test(normalized)) flags.add("author_line");
  if (/^(?:keywords?|关键词|关键字)\s*[:：]/i.test(normalized)) flags.add("keyword_line");
  if (/^(?:table|tab\.?|表)\s*[A-Za-z0-9一二三四五六七八九十.-]+\s*$/i.test(normalized)) flags.add("table_label_only");
  if (/^(?:doi\s*[:：]|issn\s*[:：]|中图分类号\s*[:：]|文献标识码\s*[:：]|收稿日期\s*[:：])/i.test(normalized)) flags.add("bibliographic_boilerplate");
  if (["formula", "equation"].includes(type) && cjk + latin < 20) { flags.add("formula_only"); flags.add("short_fragment"); }
  if (text.includes("�") || (text && (text.match(/\?/g) ?? []).length / text.length > 0.2)) flags.add("ocr_noise");
  return [...flags].sort();
}
