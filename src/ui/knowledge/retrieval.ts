import { adaptMethod } from "../../core/method-adapter";
import { t } from "../../shared/localization";
import { retrievalErrorMessage } from "../../shared/retrieval-errors";
import type { KnowledgeLibraryController } from "../../shared/contracts/knowledge-library";
import type { RetrievalMode, RetrievalResult } from "../../shared/contracts/retrieval";
import type { RetrievalService } from "../../services/retrieval";
import type { EmbeddingService } from "../../services/embedding";
import type { KnowledgeMainWindow, NativeCollectionRow, NativeListObject } from "./native-types";
import { recoveryNotice, type StartupRecovery } from "../../services/startup-recovery";
import { RetrievalResultList } from "./retrieval-results";

interface QuickSearch extends HTMLElement {
  searchTextbox: HTMLInputElement; inputField: HTMLInputElement; searchModePopup: Element; updateMode(): void;
}
const selectionPref = "extensions.zotero.knowledgemcp.retrievalSelection";
const modes: RetrievalMode[] = ["fulltext", "semantic", "enhanced", "fusion"];

class SearchWindow {
  private mode: RetrievalMode | undefined;
  private requestedMode: RetrievalMode | undefined;
  private controller: AbortController | undefined;
  private request = 0;
  private collecting = false;
  private filtering = false;
  private resultIDs = new Set<number | string>();
  private ranking = new Map<number | string, number>();
  private manualSort = false;
  private composing = false;
  private nativeInput: string | undefined;
  private disposed = false;
  private unbind: Array<() => void> = [];
  private rowUnbind: Array<() => void> = [];
  private menus = new Map<RetrievalMode, Element>();
  private quick: QuickSearch;
  private popup: Element;
  private restoreFeedback: (() => void) | undefined;
  private recoveryFeedback = false;
  private previousFilters = new Map<NativeCollectionRow, string>();
  private previousTrashModes = new Map<NativeCollectionRow, boolean | undefined>();
  private tables = new Set<string>();
  private tableRequests = new Set<Promise<string>>();
  private table: { request: number; promise: Promise<string> } | undefined;
  private display: RetrievalResultList | undefined;
  result: RetrievalResult | undefined;
  constructor(readonly window: KnowledgeMainWindow, private readonly knowledge: KnowledgeLibraryController,
    private readonly retrieval: RetrievalService, embedding: EmbeddingService, private readonly recovery?: StartupRecovery) {
    const doc = window.document;
    this.quick = doc.getElementById("zotero-tb-search") as QuickSearch;
    if (!this.quick?.searchTextbox || !this.quick.searchModePopup) throw new Error("search-interface");
    try {
    this.popup = this.quick.searchModePopup;
    for (const mode of modes) {
      const menu = doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "menuitem");
      menu.id = `km-search-${mode}`; menu.setAttribute("data-mode", mode);
      menu.setAttribute("label", t(`vector-search-${mode}`)); menu.setAttribute("type", "radio");
      if (mode !== "fulltext") menu.setAttribute("tooltiptext", t(`vector-search-help-${mode}`));
      menu.addEventListener("command", event => { event.stopPropagation(); void this.select(mode); });
      this.menus.set(mode, menu); this.popup.append(menu); this.unbind.push(() => menu.remove());
    }
    const listen = (element: EventTarget, event: string, handler: EventListener, capture = false) => {
      element.addEventListener(event, handler, capture); this.unbind.push(() => element.removeEventListener(event, handler, capture));
    };
    listen(this.popup, "command", event => { if (![...this.menus.values()].includes(event.target as Element)) void this.select(undefined); });
    listen(this.quick, "compositionstart", () => { this.composing = true; }, true);
    listen(this.quick, "compositionend", () => { this.composing = false; }, true);
    listen(this.quick, "keydown", event => {
      const key = event as KeyboardEvent;
      if (!this.mode || this.composing || key.isComposing || key.keyCode === 229) return;
      if (key.key === "Enter") { key.preventDefault(); key.stopImmediatePropagation(); void this.submit(); }
      if (key.key === "Escape") { key.preventDefault(); key.stopImmediatePropagation(); this.quick.searchTextbox.value = ""; void this.submit(); }
    }, true);
    listen(this.quick, "input", event => { if (this.mode) event.stopImmediatePropagation(); }, true);
    this.unbind.push(adaptMethod(window.ZoteroPane, "search", (receiver, original, args) => this.mode ? Promise.resolve() : Reflect.apply(original, receiver, args)));
    this.unbind.push(adaptMethod(this.quick, "updateMode", (receiver, original, args) => { const result = Reflect.apply(original, receiver, args); this.paint(); return result; }));
    this.unbind.push(adaptMethod(window.ZoteroPane, "onCollectionSelected", async (receiver, original, args) => {
      this.cancel(); this.filtering = false; this.result = undefined; this.resultIDs.clear(); this.ranking.clear(); this.clearStatus(); this.changed();
      this.restoreRows(); const result = await Reflect.apply(original, receiver, args);
      if (!this.disposed) { if (this.requestedMode) this.nativeInput = this.quick.searchTextbox.value; this.attachRows(); this.updateAvailability(); this.paint(); this.showRecovery(); if (this.mode) await window.ZoteroPane.itemsView.refreshAndMaintainSelection(); } return result;
    }));
    this.unbind.push(adaptMethod(window.ZoteroPane.itemsView, "setFilter", async (receiver, original, args) => {
      if (this.mode && args[0] === "tags") {
        this.cancel(); this.filtering = false; this.result = undefined; this.resultIDs.clear(); this.ranking.clear();
        this.restoreRows(); this.attachRows(); this.showStatus("vector-search-scope-changed"); this.changed();
      }
      return Reflect.apply(original, receiver, args);
    }));
    this.unbind.push(adaptMethod(window.ZoteroPane.itemsView, "_handleColumnSort", (receiver, original, args) => { if (this.mode) this.manualSort = true; return Reflect.apply(original, receiver, args); }));
    this.display = new RetrievalResultList(window, knowledge, embedding, () => !this.disposed && this.mode && this.filtering ? this.result : undefined, () => this.ranking, () => this.manualSort);
    const saved = String(Zotero.Prefs?.get(selectionPref, true) ?? "");
    this.requestedMode = modes.includes(saved as RetrievalMode) ? saved as RetrievalMode : undefined;
    if (this.requestedMode) this.nativeInput = this.quick.searchTextbox.value;
    if (this.recovery) this.unbind.push(this.recovery.subscribe(() => { this.updateAvailability(); this.paint(); this.showRecovery(); }));
    this.attachRows(); this.updateAvailability(); this.paint(); this.showRecovery();
    } catch (error) { this.dispose(); throw error; }
  }
  private changed(): void { this.display?.refresh(); }
  private attachRows(): void {
    for (const row of this.window.ZoteroPane.itemsView.collectionTreeRows) {
      this.rowUnbind.push(adaptMethod(row, "getSearchResults", async (receiver, original, args) => {
        const result = await Reflect.apply(original, receiver, args);
        if (this.disposed || !this.mode || !this.filtering || this.collecting || args[1] && (args[1] as { unfiltered?: boolean }).unfiltered) return result;
        if (args[0]) return this.resultTable();
        return (result as number[]).filter(id => this.resultIDs.has(id));
      }));
      this.rowUnbind.push(adaptMethod(row, "getItems", async (receiver, original, args) => {
        const items = await Reflect.apply(original, receiver, args) as NativeListObject[];
        return !this.mode || !this.filtering || this.collecting || (args[0] as { unfiltered?: boolean } | undefined)?.unfiltered ? items : items.filter(item => this.resultIDs.has(item.id));
      }));
    }
  }
  private restoreRows(): void {
    for (const dispose of this.rowUnbind.splice(0).reverse()) { try { dispose(); } catch { /* Detached windows still release the remaining adapters. */ } }
    for (const [row, text] of this.previousFilters) { try { row.searchText = text; row.clearCache(); } catch { /* The row may already be destroyed. */ } } this.previousFilters.clear();
    for (const [row, value] of this.previousTrashModes) { if (value === undefined) delete row.knowledgeRetrieval; else row.knowledgeRetrieval = value; } this.previousTrashModes.clear();
  }
  private resultTable(): Promise<string> {
    if (this.table?.request === this.request) return this.table.promise;
    const promise = Zotero.Search!.idsToTempTable([...this.resultIDs].filter((id): id is number => typeof id === "number")).then(table => {
      if (!/^tmpSearchResults_[A-Za-z0-9]+$/.test(table)) throw new Error("search-table");
      this.tables.add(table); return table;
    });
    this.tableRequests.add(promise); void promise.then(() => this.tableRequests.delete(promise), () => this.tableRequests.delete(promise));
    this.table = { request: this.request, promise }; return promise;
  }
  private async cleanupTables(keepCurrent = true): Promise<void> {
    await Promise.allSettled([...this.tableRequests]);
    const keep = keepCurrent && !this.disposed && this.mode && this.filtering && this.table?.request === this.request ? await this.table.promise.catch(() => undefined) : undefined;
    for (const table of this.tables) if (table !== keep) {
      try { await Zotero.DB?.queryAsync(`DROP TABLE IF EXISTS temp.${table}`, false, { noCache: true }); this.tables.delete(table); }
      catch { /* Native connection shutdown drops its temporary schema. */ }
    }
  }
  private updateAvailability(): void {
    const rows = this.window.ZoteroPane.itemsView.collectionTreeRows;
    const available = rows.length > 0 && rows.every(row => !row.advancedSearch && !/import-tasks/.test(row.id));
    this.mode = available ? this.requestedMode : undefined;
    for (const [mode, menu] of this.menus) {
      menu.setAttribute("disabled", String(!available || Boolean(this.recovery && !this.recovery.isRetrievalReady(mode))));
    }
    if (this.mode && this.filtering) for (const row of rows) {
      if (!this.previousFilters.has(row)) this.previousFilters.set(row, row.searchText); row.searchText = "";
      if (row.id === "Kknowledgemcp:trash") { if (!this.previousTrashModes.has(row)) this.previousTrashModes.set(row, row.knowledgeRetrieval); row.knowledgeRetrieval = true; }
      row.clearCache();
    }
  }
  private paint(): void {
    for (const [mode, menu] of this.menus) menu.setAttribute("checked", String(this.mode === mode));
    if (this.mode) {
      for (const menu of Array.from(this.popup.children)) if (![...this.menus.values()].includes(menu)) menu.removeAttribute("checked");
      this.quick.searchTextbox.placeholder = t("vector-search-placeholder", { mode: t(`vector-search-${this.mode}`) });
    }
  }
  private async select(mode: RetrievalMode | undefined): Promise<void> {
    this.cancel();
    // Picking a mode changes the next submission, not the displayed item set.
    if (!mode) { this.filtering = false; this.result = undefined; this.resultIDs.clear(); this.ranking.clear(); this.manualSort = false; }
    if (mode && !this.requestedMode) this.nativeInput = this.quick.searchTextbox.value;
    if (!mode && this.nativeInput !== undefined) { this.quick.searchTextbox.value = this.nativeInput; this.nativeInput = undefined; }
    this.restoreRows(); this.requestedMode = mode; Zotero.Prefs?.set(selectionPref, mode ?? "", true);
    this.attachRows(); this.updateAvailability(); this.quick.updateMode(); this.paint(); this.showRecovery(); this.changed();
    await this.window.ZoteroPane.itemsView.refreshAndMaintainSelection();
    if (!this.mode) await this.window.ZoteroPane.search(true);
    await this.cleanupTables(Boolean(this.mode));
  }
  private cancel(): void { this.request++; this.controller?.abort(); this.controller = undefined; this.clearStatus(); }
  private clearStatus(): void { this.restoreFeedback?.(); this.restoreFeedback = undefined; this.recoveryFeedback = false; }
  private showStatus(key: string, args?: Record<string, string | number>, busy = false): void {
    const input = this.quick.searchTextbox;
    if (!this.restoreFeedback) {
      const original = new Map(["title", "tooltiptext", "aria-description", "aria-busy"].map(name => [name, input.getAttribute(name)]));
      this.restoreFeedback = () => { for (const [name, value] of original) { if (value === null) input.removeAttribute(name); else input.setAttribute(name, value); } };
    }
    const message = t(key, args);
    input.setAttribute("title", message); input.setAttribute("tooltiptext", message); input.setAttribute("aria-description", message); input.setAttribute("aria-busy", String(busy));
    this.recoveryFeedback = false;
  }
  private showRecovery(): void {
    const snapshot = this.recovery?.snapshot(), notice = recoveryNotice(snapshot);
    if (notice && (!this.mode || !this.recovery!.isRetrievalReady(this.mode))) {
      this.showStatus(snapshot?.state === "failed" ? "startup-failed" : "startup-restoring", { stage: t(`startup-stage-${snapshot!.stage}`) });
      this.recoveryFeedback = true;
    } else if (this.recoveryFeedback) this.clearStatus();
  }
  async submit(): Promise<void> {
    if (!this.mode || this.disposed) return;
    const query = this.quick.searchTextbox.value.trim();
    if (query && this.recovery && !this.recovery.isRetrievalReady(this.mode)) { this.showRecovery(); return; }
    this.cancel(); const request = this.request, mode = this.mode;
    this.filtering = Boolean(query);
    this.restoreRows(); this.attachRows(); this.updateAvailability();
    this.result = undefined; this.resultIDs.clear(); this.ranking.clear(); this.manualSort = false; this.changed();
    await this.window.ZoteroPane.itemsView.refreshAndMaintainSelection();
    if (!query) { this.clearStatus(); await this.cleanupTables(false); return; }
    if (this.disposed || request !== this.request || mode !== this.mode) return;
    const scope = this.window as unknown as Window & typeof globalThis; this.controller = new scope.AbortController(); const signal = this.controller.signal;
    this.showStatus("vector-searching", undefined, true);
    try {
      const itemIDs = new Set<number>(), references = new Map<string, string>(); this.collecting = true;
      const rows = this.window.ZoteroPane.itemsView.collectionTreeRows, trash = rows.some(row => row.id === "Kknowledgemcp:trash");
      try { for (const row of rows) {
        for (const id of await row.getSearchResults(false) as number[]) itemIDs.add(id);
        if (trash) for (const object of await row.getItems()) if ("knowledgeTrashResourceID" in object && object.knowledgeTrashResourceID) references.set(object.knowledgeTrashResourceID, object.id);
      } }
      finally { this.collecting = false; }
      const resources = (trash ? this.knowledge.snapshot.trashedResources : this.knowledge.snapshot.resources).filter(row => references.has(row.id) || row.itemID !== null && itemIDs.has(row.itemID));
      const result = await this.retrieval.search(query, mode, resources.map(row => row.id), signal, trash ? "trash" : "active");
      if (this.disposed || request !== this.request || signal.aborted) return;
      this.result = result;
      for (const [rank, hit] of result.hits.entries()) { const itemID = references.get(hit.resourceID) ?? resources.find(row => row.id === hit.resourceID)?.itemID; if (itemID) { this.resultIDs.add(itemID); this.ranking.set(itemID, rank); } }
      this.table = undefined;
      if (result.degraded.length) this.showStatus("vector-search-degraded", { count: result.hits.length,
        channels: result.channels.map(channel => t(`vector-channel-${channel}`)).join(" / "), reason: result.degraded.map(row => `${t(`vector-channel-${row.channel}`)}: ${retrievalErrorMessage(row.code)}`).join("; ") });
      else this.clearStatus();
      for (const row of this.window.ZoteroPane.itemsView.collectionTreeRows) row.clearCache();
      await this.window.ZoteroPane.itemsView.refreshAndMaintainSelection(); await this.cleanupTables(); this.changed();
    } catch { if (!this.disposed && request === this.request && !signal.aborted) this.showStatus("vector-search-failed"); }
  }
  dispose(): void { this.disposed = true; try { this.cancel(); } finally { this.restoreRows(); this.display?.dispose(); void this.cleanupTables(false); for (const dispose of this.unbind.splice(0).reverse()) { try { dispose(); } catch { /* Continue releasing a detached window. */ } } } }
}

export class RetrievalUI {
  private windows = new Map<KnowledgeMainWindow, SearchWindow>();
  private pending = new Map<Window, ReturnType<typeof setTimeout>>();
  constructor(_pluginID: string, _rootURI: string, private readonly knowledge: KnowledgeLibraryController,
    private readonly retrieval: RetrievalService, private readonly embedding: EmbeddingService, private readonly recovery?: StartupRecovery) {}
  start(): void {
    for (const window of Zotero.getMainWindows?.() ?? []) this.loadWindow(window);
  }
  loadWindow(window: Window, attempt = 0): void {
    if (this.windows.has(window as KnowledgeMainWindow) || window.closed) return;
    const old = this.pending.get(window); if (old) clearTimeout(old);
    this.pending.delete(window);
    try { this.windows.set(window as KnowledgeMainWindow, new SearchWindow(window as KnowledgeMainWindow, this.knowledge, this.retrieval, this.embedding, this.recovery)); }
    catch { if (attempt < 100) this.pending.set(window, setTimeout(() => this.loadWindow(window, attempt + 1), 100)); }
  }
  unloadWindow(window: Window): void { clearTimeout(this.pending.get(window)); this.pending.delete(window); this.windows.get(window as KnowledgeMainWindow)?.dispose(); this.windows.delete(window as KnowledgeMainWindow); }
  dispose(): void {
    for (const window of [...this.pending.keys(), ...this.windows.keys()]) this.unloadWindow(window);
  }
}
