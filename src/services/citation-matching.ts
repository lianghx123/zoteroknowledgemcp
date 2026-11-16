import type { NativeCitationHint } from "../shared/contracts/citations";
import { citationExclusions, overlapsExclusion } from "./citation-context";

export interface CitationReference {
  id: string;
  number: number | null;
  text: string;
  numberStyle?: "round" | "bracket";
}
export interface NativeResolvedCitation extends Omit<NativeCitationHint, "references"> { referenceIds: string[]; }
export interface CitationContext { pageStart?: number; pageEnd?: number; }
export interface CitationMatch {
  start: number;
  end: number;
  referenceIds: string[];
  ambiguous: boolean;
  missing: number;
  source: "local" | "pdf" | "local+pdf";
}
interface AuthorReference extends CitationReference {
  year: string;
  authors: Set<string>;
  primary: string[];
}
const yearPattern = /\b(?:18|19|20|21)\d{2}[a-z]?\b/giu;
const normalize = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const openingPairs: Record<string, string> = { "[": "]", "(": ")", "【": "】", "〔": "〕", "〖": "〗", "{": "}", "〈": "〉", "《": "》", "「": "」", "『": "』" };

export function numericSuperscript(source: string): string | undefined {
  const match = /^(?:\{\s*\})?\s*\^\s*\{\s*([\[［【][0-9０-９\s,，、;；\-–—−]+[\]］】])\s*\}$/u.exec(source.trim());
  return match?.[1];
}

function normalizedOffsets(text: string) {
  let value = "", offset = 0; const starts: number[] = [], ends: number[] = [];
  for (const char of text) {
    const normalized = char === "\u0000" ? char : normalize(char);
    value += normalized;
    for (let i = 0; i < normalized.length; i++) { starts.push(offset); ends.push(offset + char.length); }
    offset += char.length;
  }
  return { value, starts, ends };
}

function contextualMatch(before: string, after: string, hint: NativeResolvedCitation): boolean {
  const left = normalize(hint.before), right = normalize(hint.after);
  let suffix = 0, prefix = 0;
  while (suffix < Math.min(before.length, left.length, 60) && before[before.length - 1 - suffix] === left[left.length - 1 - suffix]) suffix++;
  while (prefix < Math.min(after.length, right.length, 60) && after[prefix] === right[prefix]) prefix++;
  return suffix >= 16 || prefix >= 16;
}

function authorKeys(text: string): string[] {
  const clean = text.replace(/\bet\s+al\.?/giu, "").replace(/等(?:人)?/gu, "").replace(/\b\p{Lu}\.(?:\s*\p{Lu}\.)*/gu, " ").trim().replace(/\s+[A-Z]{1,4}$/u, "");
  const words = clean.match(/[\p{L}][\p{L}'’‐-]*/gu) ?? [];
  const names = words.filter(word => word.length > 1);
  if (!names.length) return [];
  const last = normalize(names[names.length - 1]);
  return [...new Set([normalize(names.join(" ")), last])].filter(Boolean);
}

function latinReferenceAuthors(head: string): string[] | undefined {
  const word = String.raw`(?!(?:and|et|al)\b)[\p{Script=Latin}][\p{Script=Latin}\p{M}'’‐-]+`;
  const surname = `${word}(?:\\s+${word}){0,4}`;
  const dotted = String.raw`\p{Lu}\.(?:\s*[-‐‑]?\s*\p{Lu}\.)*`;
  const compact = String.raw`\p{Lu}{1,4}(?:\s+\p{Lu}{1,4})*`;
  const initials = `(?:${dotted}|${compact})`;
  const inverted = new RegExp(`^(${surname})(?:\\s*[,，]\\s*|\\s+)${initials}(?=$|[\\s.,，;；(&])`, "u");
  const forward = new RegExp(`^(?:${dotted}\\s*|${compact}\\s+)(${surname})(?=$|[\\s.,，;；(&])`, "u");
  const separator = /^\s*(?:[,，;；]\s*(?:(?:and|&)\s+)?|(?:and|&)\s+)/iu;
  const names: string[] = []; let rest = head.trimStart();
  while (names.length < 100) {
    const person = inverted.exec(rest) ?? forward.exec(rest);
    if (!person) break;
    names.push(person[1]); rest = rest.slice(person[0].length);
    // The final initial's period belongs to the name. Only an author-list
    // separator can continue the field; prose, titles and editors cannot.
    const next = separator.exec(rest); if (!next) break;
    rest = rest.slice(next[0].length);
  }
  return names.length ? names : undefined;
}

function authorSignature(reference: CitationReference): AuthorReference | undefined {
  const text = reference.text.normalize("NFKC"), match = [...text.matchAll(yearPattern)][0];
  if (!match || match.index > 800) return;
  const prefix = text.slice(0, match.index), latinAuthors = latinReferenceAuthors(prefix);
  let head = prefix.split(/[：:《“"\n]/u)[0].trim();
  if (/\p{Script=Han}/u.test(head)) head = head.split(/[。．.]/u)[0];
  // Recognized Latin author fields exclude titles and later book editors;
  // retain generic name handling for CJK and institutional bibliography styles.
  const parts = latinAuthors ?? head.split(/[,，;；、&]|\band\b|和|与|與/iu).filter(part => part.trim());
  const first = authorKeys(parts[0] ?? "");
  if (!first.length) return;
  const authors = new Set(parts.flatMap(authorKeys));
  return { ...reference, year: match[0].toLowerCase(), authors, primary: first };
}

/** Local per-document indexes. Display-generated numbers are never input here. */
export class CitationIndex {
  private readonly numbered = new Map<number, string[]>();
  private readonly authorYear = new Map<string, AuthorReference[]>();
  private readonly nativePages = new Map<number, NativeResolvedCitation[]>();
  private readonly roundNumeric: boolean;
  constructor(references: readonly CitationReference[], native: readonly NativeResolvedCitation[] = [], document: { body?: string } = {}) {
    const numbered = references.filter(reference => reference.number !== null);
    this.roundNumeric = numbered.length >= references.length * 0.6 && numbered.filter(reference => reference.numberStyle === "round").length > numbered.length * 0.6;
    for (const hint of native) { const hints = this.nativePages.get(hint.page) ?? []; hints.push(hint); this.nativePages.set(hint.page, hints); }
    for (const reference of references) {
      if (reference.number !== null) {
        const values = this.numbered.get(reference.number) ?? []; values.push(reference.id); this.numbered.set(reference.number, values);
      }
      const signature = authorSignature(reference);
      if (!signature) continue;
      for (const primary of signature.primary) {
        const key = `${primary}:${signature.year.slice(0, 4)}`, values = this.authorYear.get(key) ?? [];
        values.push(signature); this.authorYear.set(key, values);
      }
    }
    if (this.roundNumeric && document.body) {
      const body = document.body, matches = this.matches(body);
      const dates = matches.filter(match => /[（(]/u.test(body.slice(match.start, match.end)) && /\b(?:18|19|20|21)\d{2}[a-z]?\b/iu.test(body.slice(match.start, match.end))).length;
      const brackets = matches.filter(match => /^[\[［【〔]/u.test(body.slice(match.start, match.end))).length;
      // A predominantly author-year body does not acquire round numeric
      // citations because one imported bibliography happens to be numbered.
      if (dates >= 2 && dates > brackets * 2) this.roundNumeric = false;
    }
  }

  private numeric(body: string): Pick<CitationMatch, "referenceIds" | "ambiguous" | "missing"> | undefined {
    if (!/^\s*\d{1,5}(?:\s*[-–—−,，、;；]\s*\d{1,5})*\s*$/u.test(body)) return;
    const numbers: number[] = [];
    for (const part of body.split(/[,，、;；]/u)) {
      const bounds = part.trim().split(/\s*[-–—−]\s*/u).map(Number);
      if (bounds.length > 2 || bounds.length === 2 && (bounds[1] < bounds[0] || bounds[1] - bounds[0] > 200)) return;
      for (let value = bounds[0]; value <= (bounds[1] ?? bounds[0]); value++) numbers.push(value);
      if (numbers.length > 200) return;
    }
    const ids = new Set<string>(); let ambiguous = false, missing = 0;
    for (const number of new Set(numbers)) {
      const values = this.numbered.get(number) ?? []; if (!values.length) missing++;
      ambiguous ||= values.length > 1; for (const id of values) ids.add(id);
    }
    return ids.size ? { referenceIds: [...ids], ambiguous, missing } : undefined;
  }

  private author(authors: string, year: string): string[] {
    const parts = authors.replace(/^(?:see|cf\.?|e\.?g\.?|参见|參見|见|見)\s*/iu, "").split(/\s+(?:and|&)\s+|[、&]|和|与|與/iu);
    const keys = authorKeys(parts[0] ?? "").slice(0, 1), candidates = new Map<string, AuthorReference>();
    for (const key of keys) for (const candidate of this.authorYear.get(`${key}:${year.slice(0, 4)}`) ?? []) {
      if (year.length > 4 && candidate.year !== year) continue;
      if (parts.slice(1).every(part => authorKeys(part).some(key => candidate.authors.has(key)))) candidates.set(candidate.id, candidate);
    }
    return [...candidates.keys()];
  }

  private dated(body: string, narrative?: string): Pick<CitationMatch, "referenceIds" | "ambiguous" | "missing"> | undefined {
    const ids = new Set<string>(); let ambiguous = false, missing = 0, previousAuthor = narrative ?? "";
    for (const part of body.split(/[;；]/u)) {
      const years = [...part.matchAll(yearPattern)]; if (!years.length) return;
      const authors = part.slice(0, years[0].index).replace(/[,，\s]+$/u, "").trim() || previousAuthor;
      if (!authors || /[\u0000=<>]/u.test(authors)) return;
      const tail = part.slice(years[0].index).replace(/[,，]\s*(?:pp?\.|页|頁)\s*\d+(?:\s*[-–—]\s*\d+)?\s*$/iu, "");
      const values: string[] = []; let base = "";
      for (const token of tail.split(/[,，、]/u).map(value => value.trim().toLowerCase())) {
        if (/^(?:18|19|20|21)\d{2}[a-z]?$/u.test(token)) { values.push(token); base = token.slice(0, 4); }
        else if (base && /^[a-z]$/u.test(token)) values.push(base + token);
        else return;
      }
      previousAuthor = authors;
      for (const year of values) {
        const candidates = this.author(authors, year); if (!candidates.length) missing++;
        ambiguous ||= candidates.length > 1; for (const id of candidates) ids.add(id);
      }
    }
    return ids.size ? { referenceIds: [...ids], ambiguous, missing } : undefined;
  }

  superscript(text: string, context: { before: string; after: string } = { before: "", after: "" }): CitationMatch | undefined {
    const value = text.normalize("NFKC").trim(), open = value[0], close = value.slice(-1);
    if (openingPairs[open] !== close || !["[", "【"].includes(open)) return;
    if (overlapsExclusion({ start: context.before.length, end: context.before.length + text.length }, citationExclusions(context.before + text + context.after))) return;
    const numeric = this.numeric(value.slice(1, -1));
    return numeric ? { start: 0, end: text.length, ...numeric, source: "local" } : undefined;
  }

  private nativeMatches(text: string, context: CitationContext): CitationMatch[] {
    const matches = new Map<string, CitationMatch>();
    if (!context.pageStart || !context.pageEnd || context.pageEnd - context.pageStart > 100) return [];
    const normalized = normalizedOffsets(text);
    for (let page = context.pageStart; page <= context.pageEnd; page++) for (const hint of this.nativePages.get(page) ?? []) {
      const needle = normalize(hint.text); if (!needle) continue;
      let offset = normalized.value.indexOf(needle);
      while (offset !== -1) {
        const end = offset + needle.length, start = normalized.starts[offset], finish = normalized.ends[end - 1];
        const left = text.slice(Math.max(0, start - 1), start), right = text.slice(finish, finish + 1);
        if (!(/^[A-Za-z]/u.test(hint.text) && /[A-Za-z]/u.test(left)) && !(/[A-Za-z]$/u.test(hint.text) && /[A-Za-z]/u.test(right))
          && contextualMatch(normalized.value.slice(Math.max(0, offset - 100), offset), normalized.value.slice(end, end + 100), hint)) {
          const key = `${start}:${finish}`, old = matches.get(key);
          const referenceIds = [...new Set([...(old?.referenceIds ?? []), ...hint.referenceIds])];
          matches.set(key, { start, end: finish, referenceIds, ambiguous: referenceIds.length > 1, missing: 0, source: "pdf" });
        }
        offset = normalized.value.indexOf(needle, offset + Math.max(1, needle.length));
      }
    }
    return [...matches.values()];
  }

  matches(text: string, context: CitationContext = {}): CitationMatch[] {
    const matches: CitationMatch[] = [];
    const excluded = citationExclusions(text);
    // NFKC preserves offsets for these full-width delimiters and digits. Do not
    // normalize the entire text: ligatures can change source character offsets.
    const groups = /[\[［(（【〔〖{｛〈《「『]([^\[\]［］()（）【】〔〕〖〗{}｛｝〈〉《》「」『』\u0000]{1,500})[\]］)）】〕〗}｝〉》」』]/gu;
    for (const group of text.matchAll(groups)) {
      const raw = group[0], open = raw[0].normalize("NFKC"), close = raw.slice(-1).normalize("NFKC");
      if (openingPairs[open] !== close) continue;
      const body = group[1].normalize("NFKC"); let start = group.index;
      const prefix = text.slice(Math.max(0, start - 140), start);
      if (open === "(" && /^(?:18|19|20|21)\d{2}[a-z]?(?:\s*[,，、;；]\s*(?:(?:18|19|20|21)\d{2}[a-z]?|[a-z]))*$/iu.test(body.trim())) {
        // Try longest matching suffix first, retaining the exact source range.
        const phrase = /[\p{L}][\p{L}\p{M}\s.'’&、-]*$/u.exec(prefix)?.[0] ?? "";
        let found = false;
        for (let offset = 0; offset < phrase.length; offset++) {
          if (offset && !/[\s\p{Script=Han}]/u.test(phrase[offset - 1])) continue;
          const name = phrase.slice(offset).trimEnd(); if (!name || !/^[\p{Lu}\p{Script=Han}]/u.test(name)) continue;
          const firstAuthor = name.split(/\s+(?:and|&)\s+|[、&]|和|与|與/iu)[0];
          const key = authorKeys(firstAuthor)[0];
          if (!key || !this.authorYear.has(`${key}:${body.trim().slice(0, 4)}`)) continue;
          const result = this.dated(body, name);
          if (result) { start -= phrase.length - offset; matches.push({ start, end: group.index + raw.length, ...result, source: "local" }); found = true; break; }
        }
        if (found) continue;
      }
      const dated = open === "(" ? this.dated(body) : undefined;
      if (dated) { matches.push({ start, end: start + raw.length, ...dated, source: "local" }); continue; }
      if (open === "(" && (!this.roundNumeric || !prefix.trim())) continue;
      const numeric = this.numeric(body);
      if (numeric) matches.push({ start, end: start + raw.length, ...numeric, source: "local" });
    }
    const nativeMatches = this.nativeMatches(text, context).filter(match => !overlapsExclusion(match, excluded));
    for (const match of matches) {
      const source = text.slice(match.start, match.end), years = [...source.matchAll(yearPattern)];
      // Prefer the reader's resolved targets when every explicit year in this
      // citation has contextual native evidence. A name-only overlay can be
      // ambiguous across years and must not override a precise dated match.
      if (!years.length || /[,，、]\s*[a-z]\b/iu.test(source)) continue;
      const support = years.map(year => nativeMatches.filter(native => native.start <= match.start + year.index && native.end >= match.start + year.index + year[0].length));
      if (support.every(group => group.length)) {
        match.referenceIds = [...new Set(support.flatMap(group => group.flatMap(native => native.referenceIds)))];
        match.ambiguous = support.some(group => group.some(native => native.ambiguous)); match.missing = 0; match.source = "pdf";
      }
    }
    for (const native of nativeMatches) {
      const overlap = matches.find(match => native.start < match.end && native.end > match.start);
      if (overlap) {
        if (overlap.missing && /\b(?:18|19|20|21)\d{2}/u.test(text.slice(native.start, native.end))) {
          const added = native.referenceIds.filter(id => !overlap.referenceIds.includes(id));
          overlap.referenceIds.push(...added); overlap.missing = Math.max(0, overlap.missing - added.length); overlap.ambiguous ||= native.ambiguous;
          if (added.length) overlap.source = "local+pdf";
        }
      } else matches.push(native);
    }
    const ordered: CitationMatch[] = [];
    for (const match of matches.sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (overlapsExclusion(match, excluded)) continue;
      if (!ordered.length || match.start >= ordered[ordered.length - 1].end) ordered.push(match);
    }
    return ordered;
  }
}
