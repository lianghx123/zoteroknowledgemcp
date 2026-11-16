import type { NativeCitationHint } from "../../shared/contracts/citations";

interface NativeChar { c: string; spaceAfter?: boolean; offset?: number; }
interface ProcessedPDF { getProcessedData(): Promise<unknown>; }
const cache = new WeakMap<ProcessedPDF, Promise<NativeCitationHint[]>>();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
const characters = (value: unknown): NativeChar[] => Array.isArray(value) ? value.filter((char): char is NativeChar => object(char) && typeof char.c === "string") : [];
const text = (chars: NativeChar[]) => chars.map(char => char.c + (char.spaceAfter ? " " : "")).join("");

/** Guard the inspected Zotero 10 interface; absent/changed APIs retain local matching. */
export async function nativeCitationHints(reader: ZoteroReader): Promise<NativeCitationHint[]> {
  const pdf = reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument;
  if (!pdf || typeof pdf.getProcessedData !== "function") return [];
  let pending = cache.get(pdf);
  if (!pending) {
    pending = Promise.resolve().then(() => pdf.getProcessedData()).then(extractNativeCitationHints).catch(() => { cache.delete(pdf); return []; }); cache.set(pdf, pending);
  }
  return pending;
}

export function extractNativeCitationHints(data: unknown): NativeCitationHint[] {
  if (!object(data) || !object(data.pages)) return [];
  const hints: NativeCitationHint[] = [];
  for (const [key, page] of Object.entries(data.pages)) {
    const number = Number(key) + 1;
    if (!Number.isInteger(number) || number < 1 || !object(page) || !Array.isArray(page.overlays)) continue;
    const chars = characters(page.chars);
    for (const overlay of page.overlays) {
      if (!object(overlay) || overlay.type !== "citation" || !Array.isArray(overlay.references)) continue;
      const word = characters(overlay.word); if (!word.length) continue;
      const start = word[0].offset, end = word[word.length - 1].offset;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start! < 0 || end! < start! || end! >= chars.length) continue;
      const references = overlay.references.filter(object).map(reference => reference.text).filter((value): value is string => typeof value === "string" && value.trim().length > 10);
      const label = text(word).trim();
      if (!references.length || !label || label.length > 500) continue;
      hints.push({ page: number, text: label, before: text(chars.slice(Math.max(0, start! - 70), start)), after: text(chars.slice(end! + 1, end! + 71)), references });
    }
  }
  return hints;
}
