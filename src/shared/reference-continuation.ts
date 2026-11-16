import { referencePrefix } from "./reference-number";

/** Called only for ordered reference blocks on consecutive physical pages. */
export function unnumberedReferenceContinuation(before: string, after: string): boolean {
  before = before.trimEnd(); after = after.trimStart();
  if (!before || !after || referencePrefix(after, true)) return false;
  // An author/year opening is evidence of a new citation, even when the
  // preceding provider block was truncated. Initials are not sentence ends.
  if (/^[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,3},\s*\p{Lu}\./u.test(after)
    || /^[\p{Script=Han}]{2,12}[，,、：:]/u.test(after)
    || /^[\p{Lu}\p{Script=Han}][\p{L}\p{M}\s.'’,、，&-]{0,100}[,，]\s*(?:18|19|20|21)\d{2}[a-z]?[.,，。:：]/u.test(after)) return false;
  if (/[-‐‑\u00ad]$/u.test(before) && /^[\p{L}]/u.test(after)) return true;
  if (/[。！？.!?;；][”’」』）)"']*$/u.test(before)) return false;
  const quotes = before.replace(/[“”]/gu, '"').match(/"/g)?.length ?? 0;
  const open = (left: string, right: string) => before.split(left).length > before.split(right).length;
  return quotes % 2 === 1 || open("《", "》") || open("〈", "〉") || open("(", ")") || open("（", "）")
    || /^[\p{Ll}]/u.test(after) || /[,，:：]$/u.test(before)
    || /\b(?:of|and|in|on|for|the|with|to|an?|by|from|at|into|under|using|via|between)$/iu.test(before)
    || /^(?:\d+\s*[(（:：]|https?:\/\/|doi\s*:|(?:vol|pp|no)\.)/iu.test(after);
}
