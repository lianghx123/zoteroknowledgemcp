import { adaptMethod } from "../../core/method-adapter";
import { t } from "../../shared/localization";
import { searchTokens } from "../../services/embedding-input";
import type { KnowledgeLibraryController } from "../../shared/contracts/knowledge-library";
import type { RetrievalEvidence, RetrievalHit, RetrievalResult } from "../../shared/contracts/retrieval";
import type { EmbeddingService } from "../../services/embedding";
import type { KnowledgeMainWindow, NativeItemRow, NativeListObject, NativeWindowedList } from "./native-types";
import styles from "../../../addon/content/ui/retrieval-results.css";

/** Find literal text spans only. Semantic relevance never fabricates a keyword hit. */
export function highlightRanges(text: string, query: string): Array<[number, number]> {
  const terms = [...new Set(searchTokens(query).split(" ").filter(Boolean))].sort((a, b) => b.length - a.length);
  const expression = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!expression) return [];
  return [...text.matchAll(new RegExp(expression, "giu"))].map(match => [match.index!, match.index! + match[0].length]);
}
export function evidenceExcerpt(text: string, query: string, limit = 650): string {
  if (text.length <= limit) return text;
  const first = highlightRanges(text, query)[0]?.[0] ?? 0;
  let start = Math.max(0, first - 120), end = Math.min(text.length, start + limit);
  if (/[\uDC00-\uDFFF]/u.test(text[start])) start--;
  if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Expand native item rows without inserting references or rebuilding the list. */
export class RetrievalResultList {
  private unbind: Array<() => void> = [];
  private decorated = new Map<NativeItemRow, Array<() => void>>();
  private disposed = false;
  private projected = false;
  private firstPossibleID: string | undefined;
  private result: RetrievalResult | undefined;
  private hits = new Map<string, RetrievalHit>();
  private panels = new Map<string, { hit: RetrievalHit; panel: HTMLElement }>();
  private opened = new Set<string>();
  private heights: Array<[number, number]> = [];
  private pending: ReturnType<typeof setTimeout> | undefined;
  private dirtyRows = new Set<number>();
  private visibleLists = new Map<NativeWindowedList, Array<() => void>>();
  private readonly noteHeight = 24;
  private readonly evidenceHeight = 224;
  private style: HTMLElement;
  constructor(private readonly window: KnowledgeMainWindow, private readonly knowledge: KnowledgeLibraryController,
    private readonly embedding: EmbeddingService, private readonly current: () => RetrievalResult | undefined,
    private readonly ranking: () => Map<number | string, number>, private readonly manualSort: () => boolean) {
    const doc = window.document, view = window.ZoteroPane.itemsView, provider = view.rowProvider;
    this.style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style"); this.style.textContent = styles; doc.documentElement.append(this.style);
    try {
      this.bindVisibility(view.tree?._jsWindow);
      if (provider && typeof provider.createRow === "function") this.unbind.push(adaptMethod(provider, "createRow", (receiver, native, args) => {
        const row = Reflect.apply(native, receiver, args) as NativeItemRow;
        this.decorate(row); return row;
      }));
      if (provider) this.unbind.push(adaptMethod(provider, "_sort", (receiver, native, args) => {
        if (!this.current() && !this.projected) return Reflect.apply(native, receiver, args);
        const value = Reflect.apply(native, receiver, args); this.project(); return value;
      }));
      if (provider) for (const key of ["toggleOpenState", "_toggleOpenState"] as const) {
        if (typeof provider[key] === "function") this.unbind.push(adaptMethod(provider, key, (receiver, native, args) => {
          const index = args[0] as number, row = provider._rows[index], hit = row && this.hit(row.ref);
          if (!hit) return Reflect.apply(native, receiver, args);
          this.setOpen(hit, !this.opened.has(hit.resourceID), index, Boolean(args[1]));
        }));
      }
      if (view._renderItem) this.unbind.push(adaptMethod(view, "_renderItem", (receiver, native, args) => {
        this.bindVisibility(view.tree?._jsWindow);
        const index = args[0] as number, row = provider?._rows[index], hit = row && this.hit(row.ref);
        if (row && hit) row.isOpen = this.opened.has(hit.resourceID);
        const node = Reflect.apply(native, receiver, args) as HTMLElement;
        node.classList.remove("km-inline-result"); node.style.removeProperty("--km-note-height"); node.style.removeProperty("--km-base-height");
        if (hit) this.renderInline(node, hit);
        return node;
      }));
      if (view.tree?._getWindowedListOptions) this.unbind.push(adaptMethod(view.tree, "_getWindowedListOptions", (receiver, native, args) => ({
        ...Reflect.apply(native, receiver, args) as object, ...(this.current() ? { customRowHeights: this.heights } : {}),
      })));
    } catch (error) { this.dispose(); throw error; }
  }
  private synchronize(): void {
    const result = !this.disposed ? this.current() : undefined;
    if (result === this.result) return;
    this.result = result; this.panels.clear(); this.opened.clear(); this.firstPossibleID = undefined;
    this.hits = new Map(result?.hits.map(hit => [hit.resourceID, hit]) ?? []);
    if (!result) { this.restoreRows(); this.layout(false); }
  }
  private hit(ref: NativeListObject): RetrievalHit | undefined {
    this.synchronize(); if (!this.result) return;
    const id = "knowledgeTrashResourceID" in ref ? ref.knowledgeTrashResourceID : this.knowledge.snapshot.itemResources.get(Number(ref.id))
      ?? this.knowledge.snapshot.resources.find(row => row.itemID === ref.id)?.id ?? this.knowledge.snapshot.trashedResources?.find(row => row.itemID === ref.id)?.id;
    return id ? this.hits.get(id) : undefined;
  }
  private decorate(row: NativeItemRow): void {
    if (this.decorated.has(row) || !this.hit(row.ref) || !row.getChildItems || !row.isContainer || !row.isContainerEmpty) return;
    const restores: Array<() => void> = [];
    const wasOpen = row.isOpen;
    restores.push(() => { row.isOpen = wasOpen; });
    for (const key of ["isContainer", "isContainerEmpty", "getChildItems"] as const) restores.push(adaptMethod(row, key, (receiver, native, args) => {
      const hit = this.hit(row.ref); if (!hit) return Reflect.apply(native, receiver, args);
      return key === "getChildItems" ? [] : key === "isContainer";
    }));
    this.decorated.set(row, restores);
  }
  private project(): void {
    this.synchronize();
    const provider = this.window.ZoteroPane.itemsView.rowProvider, result = this.result; if (!provider) return;
    if (!result) {
      this.restoreRows();
      this.projected = false; return;
    }
    this.projected = true;
    const groups: NativeItemRow[][] = [];
    for (const row of provider._rows.filter(row => row.isObjectRow)) {
      if ((row.level ?? 0) > 0 && groups.length) groups.at(-1)!.push(row); else groups.push([row]);
    }
    const rank = this.ranking();
    const allowed = groups.filter(group => this.hit(group[0].ref));
    for (const group of allowed) {
      this.decorate(group[0]);
      group[0].isOpen = this.opened.has(this.hit(group[0].ref)!.resourceID);
      group.splice(1); // Attachments are replaced only while a submitted result exists.
    }
    allowed.sort((a, b) => {
      const group = Number(this.hit(a[0].ref)?.relevance?.group === "possible") - Number(this.hit(b[0].ref)?.relevance?.group === "possible");
      return group || (this.manualSort() ? 0 : (rank.get(a[0].ref.id) ?? Infinity) - (rank.get(b[0].ref.id) ?? Infinity));
    });
    const rows = allowed.flat();
    this.firstPossibleID = allowed.map(group => this.hit(group[0].ref)!).find(hit => hit.relevance?.group === "possible")?.resourceID;
    provider._rows = rows; provider.refreshRowMap();
    this.layout(false);
    const live = new Set(rows);
    for (const [row, restores] of this.decorated) if (!live.has(row)) { for (const restore of restores.reverse()) restore(); this.decorated.delete(row); }
  }
  refresh(): void { if (!this.disposed) this.synchronize(); }
  private node<K extends keyof HTMLElementTagNameMap>(tag: K, text = ""): HTMLElementTagNameMap[K] {
    const node = this.window.document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K]; node.textContent = text; return node;
  }
  private restoreRows(): void {
    for (const restores of this.decorated.values()) for (const restore of restores.reverse()) restore();
    this.decorated.clear();
  }
  private baseHeight(): number { return this.window.ZoteroPane.itemsView.tree?._jsWindow?.itemHeight ?? 28; }
  private bindVisibility(list: NativeWindowedList | undefined): void {
    if (!list || this.disposed || this.visibleLists.has(list)) return;
    const restores: Array<() => void> = [];
    this.visibleLists.set(list, restores);
    for (const key of ["getFirstVisibleRow", "getLastVisibleRow"] as const) restores.push(adaptMethod(list, key, (receiver, native, args) => {
      if (!this.current() || !this.heights.length) return Reflect.apply(native, receiver, args);
      // Native offset lookup divides by the base height inside a custom row.
      // Search actual row boundaries so a partially visible evidence row stays mounted.
      const trailing = key === "getLastVisibleRow", offset = list.scrollOffset + (trailing ? list.getWindowHeight() + 1 : 0);
      const count = list.getItemCount();
      let low = 0, high = count;
      while (low < high) {
        const middle = Math.floor((low + high) / 2), top = list._getItemPosition(middle);
        if (trailing ? top < offset : top <= offset) low = middle + 1; else high = middle;
      }
      return Math.max(0, Math.min(count - 1, low - 1));
    }));
  }
  private setOpen(hit: RetrievalHit, open: boolean, index: number, deferred = false): void {
    if (this.disposed) return;
    if (open) this.opened.add(hit.resourceID); else this.opened.delete(hit.resourceID);
    const row = this.window.ZoteroPane.itemsView.rowProvider?._rows[index]; if (row) row.isOpen = open;
    this.dirtyRows.add(index);
    if (deferred) {
      if (this.pending === undefined) this.pending = this.window.setTimeout(() => { this.pending = undefined; this.layout(); }, 0);
    } else this.layout();
  }
  private layout(redraw = true): void {
    const view = this.window.ZoteroPane.itemsView, tree = view.tree, rows = view.rowProvider?._rows ?? [], base = this.baseHeight();
    this.bindVisibility(tree?._jsWindow);
    const heights: Array<[number, number]> = [];
    if (this.result && !this.disposed) for (const [index, row] of rows.entries()) {
      const hit = this.hit(row.ref); if (!hit) continue;
      const extra = (hit.resourceID === this.firstPossibleID ? this.noteHeight : 0) + (this.opened.has(hit.resourceID) ? this.evidenceHeight : 0);
      if (extra) heights.push([index, base + extra]);
    }
    const changed = heights.length !== this.heights.length || heights.some(([index, height], i) => this.heights[i][0] !== index || this.heights[i][1] !== height);
    if (changed) {
      this.heights = heights;
      if (!this.window.closed && !Zotero.closing && tree?._jsWindow) tree.updateCustomRowHeights?.(heights);
    }
    if (this.window.closed || Zotero.closing) { this.dirtyRows.clear(); return; }
    if (!redraw) return;
    const list = tree?._jsWindow;
    if (!list || !tree.invalidateRow) { if (changed) tree?.invalidate(); this.dirtyRows.clear(); return; }
    // The native height updater computes total height before its new offsets.
    // Correct the extent, then move retained rows without rendering their cells.
    if (changed) list.innerElem.style.height = `${list._getItemPosition(rows.length)}px`;
    list.render();
    for (const index of this.dirtyRows) if (list._renderedRows.has(index)) tree.invalidateRow(index);
    this.dirtyRows.clear();
    if (changed) for (const [index, node] of list._renderedRows) {
      const top = `${list._getItemPosition(index)}px`; if (node.style.top !== top) node.style.top = top;
    }
  }
  private renderInline(node: HTMLElement, hit: RetrievalHit): void {
    const open = this.opened.has(hit.resourceID), noteHeight = hit.resourceID === this.firstPossibleID ? this.noteHeight : 0;
    node.dataset.kmResourceId = hit.resourceID;
    node.classList.add("km-inline-result"); node.style.setProperty("--km-note-height", `${noteHeight}px`); node.style.setProperty("--km-base-height", `${this.baseHeight()}px`);
    if (noteHeight) {
      const note = this.node("div", t("vector-results-possible-note")); note.className = "km-relevance-note";
      note.setAttribute("role", "note"); note.title = note.textContent ?? "";
      for (const event of ["mousedown", "mouseup", "click", "dblclick", "dragstart"]) note.addEventListener(event, e => { e.preventDefault(); e.stopPropagation(); });
      node.append(note);
    }
    if (open) {
      const body = this.node("div"); body.className = "km-inline-evidence"; body.style.height = `${this.evidenceHeight}px`;
      this.renderPanel(body, hit); node.append(body);
    }
  }
  private highlighted(host: HTMLElement, text: string, query: string): void {
    let start = 0;
    for (const [from, to] of highlightRanges(text, query)) { host.append(this.window.document.createTextNode(text.slice(start, from)), this.node("mark", text.slice(from, to))); start = to; }
    host.append(this.window.document.createTextNode(text.slice(start)));
  }
  private renderPanel(div: HTMLElement, hit: RetrievalHit): void {
    const existing = this.panels.get(hit.resourceID);
    if (existing?.hit === hit) { if (existing.panel.parentElement !== div) div.append(existing.panel); return; }
    const result = this.current(); if (!result) return;
    const panel = this.node("section"); panel.className = "km-retrieval-panel"; panel.setAttribute("aria-label", t("vector-match-content")); panel.tabIndex = 0;
    // Evidence controls and text selection must not trigger the containing
    // native item's activation, context menus or drag/drop.
    for (const event of ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "dragstart", "keydown"]) panel.addEventListener(event, e => {
      if (event !== "keydown" || !["Tab", "Escape"].includes((e as KeyboardEvent).key)) e.stopPropagation();
    });
    const notices: string[] = [];
    if (!hit.parsed) notices.push(t("vector-unparsed"));
    if (hit.partialContent) notices.push(t("vector-partial-content"));
    if (!hit.embedded) notices.push(t("vector-unembedded"));
    if (hit.embeddingCoverage && hit.embeddingCoverage.completed + hit.embeddingCoverage.skipped < hit.embeddingCoverage.total) notices.push(t("vector-partial-embedding", hit.embeddingCoverage));
    if (hit.metadataOnly) notices.push(t("vector-metadata-only"));
    for (const text of notices) { const p = this.node("p", text); p.className = "km-evidence-warning"; panel.append(p); }
    for (const match of hit.metadataMatches ?? []) {
      const card = this.node("div"); card.className = "km-evidence-card"; card.append(this.node("strong", t(`vector-match-field-${match.field}`)));
      const text = this.node("p"); this.highlighted(text, evidenceExcerpt(match.text, result.query), result.query); card.append(text); panel.append(card);
    }
    const evidence = hit.evidence.filter((row, index, all) => !all.slice(0, index).some(other => other.blockID === row.blockID && other.text === row.text));
    for (const [index, row] of evidence.entries()) {
      const card = this.node("details"); card.className = "km-evidence-card"; card.open = index === 0;
      const location = `${row.section ?? t("vector-section-missing")} · ${row.page === null ? t("vector-page-missing") : t("vector-page", { page: row.page })}`;
      card.append(this.node("summary", location));
      const excerpt = evidenceExcerpt(row.text, result.query), quote = this.node("blockquote"); this.highlighted(quote, excerpt, result.query); card.append(quote);
      const source = this.knowledge.snapshot.sources.find(source => source.id === row.sourceID), origin = this.node("p", t("vector-source-label"));
      origin.className = "km-evidence-location";
      const link = this.node("a", source?.title ?? t("vector-source-missing")); link.className = "km-evidence-source"; link.href = "#";
      link.setAttribute("aria-label", `${t("vector-open-source")}: ${link.textContent}`);
      let opening = false;
      link.onclick = event => {
        event.preventDefault(); if (opening) return; opening = true; link.setAttribute("aria-disabled", "true");
        void this.open(row).catch(() => { const p = this.node("p", t("vector-source-open-failed")); p.setAttribute("role", "status"); card.append(p); })
          .finally(() => { opening = false; link.removeAttribute("aria-disabled"); });
      };
      origin.append(" ", link); card.append(origin);
      const actions = this.node("div"); actions.className = "km-evidence-actions";
      if (excerpt !== row.text) { const expand = this.node("button", t("vector-expand-passage")); expand.type = "button"; let full = false;
        expand.onclick = () => { full = !full; quote.replaceChildren(); this.highlighted(quote, full ? row.text : excerpt, result.query); expand.textContent = t(full ? "vector-collapse-passage" : "vector-expand-passage"); }; actions.append(expand); }
      if (actions.childElementCount) card.append(actions); panel.append(card);
    }
    if (!evidence.length && !hit.metadataOnly) panel.append(this.node("p", t("vector-no-evidence")));
    div.append(panel); this.panels.set(hit.resourceID, { hit, panel });
  }
  private async open(evidence: RetrievalEvidence): Promise<void> {
    const row = await this.embedding.repository.db.selectFrom("zotero_item_links").select("local_item_id").where("source_id", "=", evidence.sourceID).where("state", "=", "current").executeTakeFirst();
    if (!row?.local_item_id || !Zotero.Reader) throw new Error("source-unavailable");
    await Zotero.Reader.open(row.local_item_id, evidence.page === null ? undefined : { pageIndex: Math.max(0, evidence.page - 1) });
  }
  dispose(): void {
    this.disposed = true;
    if (this.pending !== undefined) this.window.clearTimeout(this.pending);
    this.opened.clear(); this.dirtyRows.clear(); this.panels.clear(); this.hits.clear();
    this.layout(false);
    for (const restore of this.unbind.splice(0).reverse()) restore();
    for (const restores of this.visibleLists.values()) for (const restore of restores.reverse()) restore();
    this.visibleLists.clear();
    this.restoreRows();
    const view = this.window.ZoteroPane.itemsView;
    try { if (!this.window.closed && !Zotero.closing && this.projected) view.tree?.invalidate(); } catch { /* Window teardown releases its virtual list. */ }
    this.style.remove();
  }
}
