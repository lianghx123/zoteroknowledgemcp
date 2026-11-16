import { isReferenceType, legacyReferencePrefix, referencePrefix } from "../shared/reference-number";
import { unnumberedReferenceContinuation } from "../shared/reference-continuation";

export interface ReferenceSourceBlock {
  id: string;
  type: string;
  markdown: string;
  page: number | null;
  pageEnd: number | null;
  protected?: boolean;
}
export interface ReferenceEntry {
  number: number | null;
  label: string | null;
  markdown: string;
  blockIds: string[];
  order: number;
}

/** Derive entries beside immutable source blocks, retaining cross-page tails. */
export function referenceEntries(blocks: readonly ReferenceSourceBlock[]): ReferenceEntry[] {
  return deriveEntries(blocks, referencePrefix, true);
}

/** Replay only to identify unchanged automatic records created by projection v1. */
export function legacyReferenceEntries(blocks: readonly ReferenceSourceBlock[]): ReferenceEntry[] {
  return deriveEntries(blocks, legacyReferencePrefix, false);
}

function deriveEntries(blocks: readonly ReferenceSourceBlock[], prefixOf: typeof referencePrefix, mergeUnnumbered: boolean): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  let owner: ReferenceEntry | undefined, lastPage: number | null = null;
  for (const block of blocks) {
    if (block.protected) { owner = undefined; lastPage = null; continue; }
    if (!isReferenceType(block.type)) {
      if (!["image", "table", "caption", "footnote"].includes(block.type)) { owner = undefined; lastPage = null; }
      continue;
    }
    if (block.page !== null && lastPage !== null && block.page > lastPage + 1) owner = undefined;
    // Providers occasionally put several explicitly numbered entries in a
    // single block. Split only at a line start with a recognized full prefix.
    const lines = block.markdown.split(/\r?\n/), chunks: string[] = [];
    for (const line of lines) {
      if (!chunks.length || prefixOf(line, true)) chunks.push(line);
      else chunks[chunks.length - 1] += `\n${line}`;
    }
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const prefix = prefixOf(chunk, true);
      const crossPageTail = mergeUnnumbered && owner && block.page !== null && lastPage !== null && block.page === lastPage + 1
        && unnumberedReferenceContinuation(owner.markdown, chunk);
      if (!prefix && owner && (owner.number !== null || crossPageTail)) {
        const before = owner.markdown.trimEnd(), after = chunk.trimStart();
        // A repeated translated line is not a second citation. Remove only an
        // exact suffix/prefix overlap, retaining all distinct source text.
        let overlap = 0;
        for (let size = Math.min(before.length, after.length, 1024); size >= 16; size--) if (before.endsWith(after.slice(0, size))) { overlap = size; break; }
        const lexical = mergeUnnumbered ? /[-‐‑\u00ad]$/u.test(before) && /^[\p{L}]/u.test(after)
          : /[-‐‑]$/u.test(before) && /^[A-Za-z]/u.test(after);
        const cjk = /[\p{Script=Han}]/u.test(before.slice(-1) + after.slice(0, 1));
        const separator = owner.number === null ? cjk ? "" : " " : "\n\n";
        owner.markdown = before + (!before || overlap || lexical ? "" : separator) + after.slice(overlap);
        if (!owner.blockIds.includes(block.id)) owner.blockIds.push(block.id);
      } else {
        owner = { number: prefix?.number ?? null, label: prefix?.label ?? null, markdown: prefix?.content ?? chunk.trim(), blockIds: [block.id], order: entries.length };
        entries.push(owner);
      }
    }
    lastPage = block.pageEnd ?? block.page;
  }
  return entries;
}
