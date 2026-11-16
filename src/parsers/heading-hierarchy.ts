import { normalizeHeadingNumbering as normalize, tokenizeNumbering, type Numbering } from "./heading-numbering";

export function parseNumbering(text: string): Numbering | null {
  const parsed = tokenizeNumbering(text);
  if (parsed?.kind !== "list-like" || parsed.reason === "ambiguous-ocr-digit") return parsed;
  const normalized = normalize(text);
  let match;
  if ((match = /^\((\d+)\)\s*(.+)$/.exec(normalized))) return { ...parsed, kind: "numeric-paren", value: Number(match[1]), risky: true };
  if ((match = /^(\d+)\)\s*(.+)$/.exec(normalized))) return { ...parsed, kind: "numeric-close", value: Number(match[1]), risky: true };
  if ((match = /^\(([A-Z])\)\s*(.+)$/.exec(normalized))) return { ...parsed, kind: "alpha-paren-upper", value: match[1].charCodeAt(0) - 64, risky: true };
  if ((match = /^\(([a-z])\)\s*(.+)$/.exec(normalized))) return { ...parsed, kind: "alpha-paren-lower", value: match[1].charCodeAt(0) - 96, risky: true };
  if ((match = /^([a-z])[.)]\s*(.+)$/.exec(normalized))) return { ...parsed, kind: "alpha-lower", value: match[1].charCodeAt(0) - 96, risky: true };
  if ((match = /^([①-⑳❶-❿])\s*(.+)$/.exec(text.trim()))) {
    const code = match[1].codePointAt(0)!;
    return { ...parsed, kind: "circled", value: code >= 0x2776 ? code - 0x2775 : code - 0x245f, risky: true };
  }
  return parsed;
}


export interface HeadingInputBlock {
  id: string;
  canonical_order: number;
  block_type: string;
  content_normalized: string;
  content_markdown?: string;
  page_start?: number;
  metadata?: Record<string, unknown>;
}
export interface HeadingInput { blocks: HeadingInputBlock[] }
export interface HeadingDecision {
  id: string; order: number; text: string; page?: number;
  status: "automatic" | "review" | "protected" | "unchanged" | "excluded";
  reason: string; numbering: Numbering | null; depth: number | null; parent: string | null; currentLevel: number | null;
}
interface Entry { block: HeadingInputBlock; p: Numbering; style: string; value: number | string | null; path: boolean }
interface Anchor { id: string; depth: number; key?: string; invalid?: string; style?: string; rank?: number }
interface Scope { id: string; entries: Entry[]; base: Anchor | null }
interface InferredNode extends Anchor {
  entry: Entry; style: string; value: number | string | null; rank: number; parent: string | null; parentStyle: string | null; path: boolean; reason: string;
}
interface Violation { id: string; reason: string; style: string }
interface Model { order: string[]; nodes: InferredNode[]; violations: Violation[]; noninitialStarts: string[] }
interface EvidenceRecord { kind: string; ids: string[] }
type Evidence = Map<string, EvidenceRecord[]>;
export interface HeadingRule {
  id: string; base: string | null; styles: string[]; candidateCount: number; viableOrders: string[][];
  evidence: Array<{ order: string[]; relations: Array<{ relation: string; records: EvidenceRecord[] }> }>;
  status: string; minimumDuplicateAnomalies?: number | null; minimumNoninitialStarts?: number | null; bestViolations?: Violation[];
}

const chineseUnits = ["篇", "部分", "章", "节", "条", "目"];
const englishUnits = ["part", "chapter", "section"];
const styleOf = (p: Numbering): string => p.kind === "roman" ? `roman-${p.caseLower ? "lower" : "upper"}` : p.kind;
const scalarValue = (p: Numbering): number | string | null => Array.isArray(p.value) ? p.value[0] : p.value;
const isPath = (p: Numbering): boolean => p.kind === "alpha-path" || p.kind === "decimal" && Array.isArray(p.value) && p.value.length > 1;
const isAnchor = (p: Numbering): boolean => p && ["unit", "english-unit", "appendix"].includes(p.kind);
const rowFor = (block: HeadingInputBlock, status: HeadingDecision["status"], reason: string, numbering: Numbering | null = null, depth: number | null = null, parent: string | null = null): HeadingDecision => ({
  id: block.id, order: block.canonical_order, text: block.content_normalized, page: block.page_start,
  status, reason, numbering, depth, parent, currentLevel: /^#+/.exec(block.content_markdown ?? "")?.[0].length ?? null,
});

function prepare(document: HeadingInput) {
  const entries: Entry[] = [], rows: HeadingDecision[] = [];
  let previousAlpha: string | undefined;
  for (const [index, block] of document.blocks.entries()) {
    if (block.block_type !== "heading") continue;
    if (block.metadata?.ocr_label === "doc_title") { rows.push(rowFor(block, "protected", "document-title")); continue; }
    const p = parseNumbering(block.content_normalized);
    if (!p) { rows.push(rowFor(block, "unchanged", "unnumbered")); continue; }
    if (p.kind === "nonsection") { rows.push(rowFor(block, "excluded", p.reason ?? "nonsection", p)); continue; }
    const next = document.blocks[index + 1];
    if (["alpha", "roman"].includes(p.kind) && next?.block_type === "image" && next.page_start === block.page_start) {
      rows.push(rowFor(block, "review", "possible-figure-panel", p)); continue;
    }
    if (p.kind === "list-like") { rows.push(rowFor(block, "review", p.reason ?? "ambiguous-enumeration", p)); continue; }
    if (p.title.length > 180 || /[。.]$/.test(p.title)) { rows.push(rowFor(block, "review", "possible-sentence-or-list-item", p)); continue; }
    // Resolve letter/Roman lexical ambiguity using a contiguous alphabet series,
    // independently of its eventual hierarchy rank.
    if (p.kind === "roman" && p.ambiguousLetter && /^[A-Z]\.\s*/.test(normalize(block.content_normalized))
      && previousAlpha && p.token.charCodeAt(0) === previousAlpha.charCodeAt(0) + 1) {
      p.kind = "alpha"; p.value = p.token.charCodeAt(0) - 64;
    }
    if (p.kind === "alpha") previousAlpha = p.token;
    // Descendants can intervene between B and C. Clear at a semantic scope or
    // a genuine Roman heading, rather than at every differently styled child.
    else if (isAnchor(p) || p.kind === "roman") previousAlpha = undefined;
    entries.push({ block, p, style: styleOf(p), value: scalarValue(p), path: isPath(p) });
  }
  return { entries, rows };
}

function permutations(styles: string[]): string[][] {
  if (!styles.length) return [[]];
  return styles.flatMap(style => permutations(styles.filter(s => s !== style)).map(rest => [style, ...rest]));
}

// Simulate each candidate grammar against the complete scope. Counters are
// scoped to the actual parent; skipped numbers are permitted, reversals are not.
function simulate(entries: Entry[], order: string[], base: Anchor | null): Model {
  const ranks = new Map(order.map((s, i) => [s, i]));
  const stack: Array<Anchor & { rank: number; style: string }> = base ? [{ ...base, style: "anchor", rank: -1, key: base.key }] : [];
  const counters = new Map<string, { max: number; seen: Set<string> }>(), nodes: InferredNode[] = [], violations: Violation[] = [], noninitialStarts: string[] = [];
  for (const entry of entries) {
    const { block, p, style, value } = entry;
    let parent: (Anchor & { rank: number; style: string }) | undefined, rank: number, reason: string;
    if (entry.path) {
      const parentKey = (p.value as Array<string | number>).slice(0, -1).join(".");
      const index = stack.map(node => node.key).lastIndexOf(parentKey);
      if (index < 0) { nodes.push({ id: block.id, entry, style, value, rank: -1, depth: 0, parent: null, parentStyle: null, path: true, reason: "missing-explicit-path-parent", invalid: "missing-explicit-path-parent" }); continue; }
      stack.splice(index + 1); parent = stack[index]; rank = parent.rank;
      reason = "explicit-number-path";
    } else {
      rank = ranks.get(style)!;
      while (stack.length && stack[stack.length - 1].rank >= rank) stack.pop();
      parent = stack.at(-1);
      if (rank > 0 && (!parent || parent.style === "anchor")) violations.push({ id: block.id, reason: "missing-style-parent", style });
      reason = "document-numbering-rule";
    }
    const depth = (parent?.depth ?? 0) + 1;
    const identity = `${parent?.id ?? "root"}:${style}:${entry.path ? (p.value as Array<string | number>).join(".") : value}`;
    const counterKey = `${parent?.id ?? "root"}:${style}`;
    const prior = counters.get(counterKey);
    let invalid;
    const numeric = entry.path ? Number((p.value as Array<string | number>).at(-1)) : value;
    if (!entry.path && parent && !prior && Number.isFinite(numeric) && Number(numeric) > 1) noninitialStarts.push(block.id);
    if (prior?.seen.has(identity)) invalid = "duplicate-number-in-scope";
    else if (Number.isFinite(numeric) && prior && Number(numeric) < prior.max) {
      invalid = "counter-reversal-in-scope";
      // Explicit path errors are local and cannot establish a flat style order.
      if (!entry.path) violations.push({ id: block.id, reason: invalid, style });
    }
    const state = prior ?? { max: -Infinity, seen: new Set() };
    state.seen.add(identity); if (Number.isFinite(numeric)) state.max = Math.max(state.max, Number(numeric));
    counters.set(counterKey, state);
    if (parent?.invalid) invalid = "unresolved-parent";
    if (depth > 5) invalid = "html-heading-depth-overflow";
    const node: InferredNode = { id: block.id, entry, style, value, rank, depth, parent: parent?.id ?? null,
      parentStyle: parent?.style ?? null, key: entry.path ? (p.value as Array<string | number>).join(".") : ["alpha", "roman", "decimal"].includes(p.kind) ? p.token : undefined,
      invalid, reason, path: entry.path };
    if (p.kind === "decimal" && !entry.path) node.key = String(value);
    nodes.push(node); stack.push(node);
  }
  return { order, nodes, violations, noninitialStarts };
}

function evidenceFor(model: Model): Evidence {
  const evidence: Evidence = new Map(), byId = new Map(model.nodes.map(node => [node.id, node]));
  const add = (parentStyle: string, childStyle: string, kind: string, ids: string[]) => {
    const key = `${parentStyle}>${childStyle}`, records = evidence.get(key) ?? [];
    if (!records.some(r => r.kind === kind && r.ids.join() === ids.join())) records.push({ kind, ids });
    evidence.set(key, records);
  };
  const flat = model.nodes.filter(n => !n.path && !n.invalid);
  const continuousAcrossParents = (parentStyle: string, childStyle: string) => {
    const children = flat.filter(n => n.style === childStyle && n.parentStyle === parentStyle);
    return new Set(children.map(n => n.parent)).size > 1 && children.every((n, i) => !i || Number(n.value) > Number(children[i - 1].value));
  };
  for (const child of flat) {
    const parent = byId.get(child.parent ?? "");
    if (!parent || parent.path || continuousAcrossParents(parent.style, child.style)) continue;
    const nextSibling = flat.find(n => n.entry.block.canonical_order > child.entry.block.canonical_order
      && n.style === parent.style && n.parent === parent.parent && Number(n.value) > Number(parent.value));
    if (nextSibling) add(parent.style, child.style, "enclosed-by-sibling-progression", [parent.id, child.id, nextSibling.id]);
  }
  for (const childStyle of model.order) for (const parentStyle of model.order) {
    const children = flat.filter(n => n.style === childStyle && n.parentStyle === parentStyle);
    const parents = [...new Set(children.map(n => n.parent))];
    if (parents.length >= 2 && !continuousAcrossParents(parentStyle, childStyle)) add(parentStyle, childStyle, "repeated-parent-counter-resets", parents.filter((id): id is string => id !== null));
  }
  // Transitivity permits a branch to omit an otherwise established middle
  // style, without forcing an empty intermediate section into the tree.
  for (const middle of model.order) for (const from of model.order) for (const to of model.order) {
    if (evidence.has(`${from}>${middle}`) && evidence.has(`${middle}>${to}`) && !evidence.has(`${from}>${to}`)) {
      add(from, to, "transitive-established-rules", [middle]);
    }
  }
  return evidence;
}

function riskyStyleSupported(style: string, model: Model, evidence: Evidence): boolean {
  const nodes = model.nodes.filter(n => n.style === style && !n.invalid);
  // A single local (1)/(2) run cannot establish that these are section titles.
  const parents = new Set(nodes.filter(n => n.parentStyle && n.parentStyle !== "anchor"
    && evidence.has(`${n.parentStyle}>${style}`)).map(n => n.parent));
  if (parents.size >= 2) return true;
  // A parenthesized top-level scheme needs repeated nested subtrees as evidence.
  const hasTrustedDescendant = (root: InferredNode): boolean => model.nodes.some(candidate => {
    if (candidate.invalid || candidate.entry.p.risky) return false;
    let current: InferredNode | undefined = candidate;
    while (current?.parent) {
      if (current.parent === root.id) return true;
      const parentID: string = current.parent;
      current = model.nodes.find(n => n.id === parentID);
    }
    return false;
  });
  const structured = nodes.filter(n => model.nodes.filter(c => c.parent === n.id && !c.invalid).length >= 2 && hasTrustedDescendant(n));
  return structured.length >= 2;
}

function inferScope(scope: Scope): { report: HeadingRule; rows: HeadingDecision[] } {
  const { entries, base, id } = scope;
  const styles = [...new Set(entries.filter(e => !e.path).map(e => e.style))];
  const report: HeadingRule = { id, base: base?.id ?? null, styles, candidateCount: 0, viableOrders: [], evidence: [], status: "inferred" };
  const candidateCount = styles.reduce((count, _, index) => count * (index + 1), 1);
  if (styles.length > 7 || candidateCount * entries.length > 250_000) {
    report.status = "style-budget-exceeded";
    return { report, rows: entries.map(e => rowFor(e.block, "review", report.status, e.p)) };
  }
  const models = permutations(styles).map(order => simulate(entries, order, base));
  report.candidateCount = models.length;
  const hardValid = models.filter(m => !m.violations.length);
  // A wrong parent often turns legitimate numbering resets into duplicates.
  // Genuine local duplicates remain review items, rather than invalidating all
  // other headings in an otherwise supported document grammar.
  const duplicateCount = (model: Model): number => model.nodes.filter(n => n.invalid === "duplicate-number-in-scope").length;
  const minimumDuplicates = Math.min(...hardValid.map(duplicateCount));
  const duplicateValid = hardValid.filter(m => duplicateCount(m) === minimumDuplicates);
  const minimumNoninitialStarts = Math.min(...duplicateValid.map(m => m.noninitialStarts.length));
  const valid = duplicateValid.filter(m => m.noninitialStarts.length === minimumNoninitialStarts);
  report.minimumDuplicateAnomalies = Number.isFinite(minimumDuplicates) ? minimumDuplicates : null;
  report.minimumNoninitialStarts = Number.isFinite(minimumNoninitialStarts) ? minimumNoninitialStarts : null;
  report.viableOrders = valid.map(m => m.order);
  if (!valid.length) {
    report.status = "conflicting-numbering-evidence";
    report.bestViolations = models.sort((a, b) => a.violations.length - b.violations.length)[0]?.violations;
    return { report, rows: entries.map(e => rowFor(e.block, "review", report.status, e.p)) };
  }
  if (valid.every(model => new Set(model.nodes.filter(n => !n.path && !n.parent
    && n.invalid === "duplicate-number-in-scope").map(n => `${n.style}:${n.value}`)).size >= 2)) {
    report.status = "unanchored-numbering-regime-change";
    return { report, rows: entries.map(e => rowFor(e.block, "review", report.status, e.p)) };
  }
  const allEvidence = valid.map(evidenceFor);
  report.evidence = allEvidence.map((e, i) => ({ order: valid[i].order, relations: [...e].map(([relation, records]) => ({ relation, records })) }));
  const outputs = valid.map((model, modelIndex) => {
    const evidence = allEvidence[modelIndex], byId = new Map(model.nodes.map(n => [n.id, n]));
    const output = new Map<string, HeadingDecision>();
    for (const node of model.nodes) {
      const entry = node.entry;
      let reason = node.invalid;
      if (!reason && entry.p.risky && !riskyStyleSupported(entry.style, model, evidence)) reason = "enumeration-without-repeated-section-structure";
      if (!reason && !entry.path) {
        const parent = byId.get(node.parent ?? "");
        if (parent && parent.style !== entry.style && !evidence.has(`${parent.style}>${entry.style}`)) reason = "insufficient-style-relation-evidence";
        const peers = model.nodes.filter(n => n.style === entry.style && !n.path && !n.invalid);
        const explicitChild = model.nodes.some(n => n.path && n.parent === node.id);
        if (!parent && peers.length < 2 && !explicitChild) reason = "insufficient-root-series-evidence";
        if (entry.p.kind === "roman" && entry.p.ambiguousLetter && peers.length < 2 && !explicitChild) reason = "ambiguous-letter-or-roman";
      }
      if (node.parent && node.parent !== base?.id && output.get(node.parent)?.status !== "automatic") reason = "unresolved-parent";
      output.set(entry.block.id, rowFor(entry.block, reason ? "review" : "automatic", reason ?? node.reason, entry.p, reason ? null : node.depth, reason ? null : node.parent));
    }
    return output;
  });
  const rows = entries.map(entry => {
    const candidates = outputs.map(m => m.get(entry.block.id)!), first = candidates[0];
    if (candidates.some(r => r.status !== first.status || r.depth !== first.depth || r.parent !== first.parent)) {
      return rowFor(entry.block, "review", "ambiguous-document-numbering-rule", entry.p);
    }
    return first;
  });
  // Consensus also requires that the selected parent survived consensus.
  const rowsById = new Map(rows.map(r => [r.id, r]));
  for (const row of rows) if (row.parent && row.parent !== base?.id && rowsById.get(row.parent)?.status !== "automatic") {
    row.status = "review"; row.reason = "unresolved-parent"; row.depth = row.parent = null;
  }
  if (rows.some(r => r.status === "review")) report.status = "partial-or-ambiguous";
  return { report, rows };
}

export function analyzeDocument(document: HeadingInput): { rows: HeadingDecision[]; rules: HeadingRule[] } {
  const { entries, rows } = prepare(document), scopes: Scope[] = [], anchors: HeadingDecision[] = [];
  const unitNodes = new Map<string, Anchor>(), anchorSeen = new Set<string>();
  let scope: Scope = { id: "body", entries: [], base: null };
  scopes.push(scope);
  for (const entry of entries) {
    if (!isAnchor(entry.p)) { scope.entries.push(entry); continue; }
    const { p, block } = entry;
    let parent: Anchor | null | undefined = null, reason: string | undefined, depth = 1;
    if (p.kind === "appendix") unitNodes.clear();
    else {
      const hierarchy = p.kind === "unit" ? chineseUnits : englishUnits;
      const present = hierarchy.filter(unit => entries.some(e => e.p.kind === p.kind && e.p.unit === unit));
      const index = present.indexOf(p.unit!), parentUnit = present[index - 1];
      parent = parentUnit ? unitNodes.get(`${p.kind}:${parentUnit}`) : null;
      if (parentUnit && !parent) reason = "missing-explicit-unit-parent";
      if (parent?.invalid) reason = "unresolved-parent";
      depth = (parent?.depth ?? 0) + 1;
      for (const unit of present.slice(index)) unitNodes.delete(`${p.kind}:${unit}`);
      if (p.kind === "english-unit" && Array.isArray(p.value) && p.value.length > 1) reason = "mixed-explicit-unit-path";
    }
    const identity = `${parent?.id ?? "root"}:${p.kind}:${p.unit ?? ""}:${JSON.stringify(p.value)}`;
    if (anchorSeen.has(identity)) reason = "duplicate-number-in-scope";
    anchorSeen.add(identity);
    if (depth > 5) reason = "html-heading-depth-overflow";
    const anchor: Anchor = { id: block.id, depth, key: p.kind === "appendix" ? p.token : undefined, invalid: reason };
    if (p.kind !== "appendix") unitNodes.set(`${p.kind}:${p.unit}`, anchor);
    anchors.push(rowFor(block, reason ? "review" : "automatic", reason ?? "explicit-semantic-anchor", p, reason ? null : depth, reason ? null : parent?.id ?? null));
    scope = { id: block.id, entries: [], base: anchor }; scopes.push(scope);
  }
  const rules: HeadingRule[] = [];
  for (const current of scopes.filter(s => s.entries.length)) {
    if (current.base?.invalid) {
      rows.push(...current.entries.map(e => rowFor(e.block, "review", "unresolved-explicit-anchor", e.p))); continue;
    }
    const inferred = inferScope(current);
    rows.push(...inferred.rows); rules.push(inferred.report);
  }
  rows.push(...anchors); rows.sort((a, b) => a.order - b.order);
  return { rows, rules };
}

export const inferDocument = (document: HeadingInput): HeadingDecision[] => analyzeDocument(document).rows;
export function inferBlock(block: HeadingInputBlock, document: HeadingInput) {
  if (block.block_type !== "heading") return { status: "protected", reason: "not-a-provider-heading" };
  return inferDocument(document).find(row => row.id === block.id);
}
