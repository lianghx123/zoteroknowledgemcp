import { t } from "../shared/localization";
import { retrievalErrorMessage } from "../shared/retrieval-errors";
import { ModelError, type RetrievalMode } from "../shared/contracts/retrieval";
import type { AttachmentMarkdown } from "../shared/contracts/knowledge-content";
import type { ReaderSearchHit, ReaderSearchProvider } from "../shared/contracts/reader-search";
import { readerText } from "./rendering/reader-text";
import { searchKey, searchPosition } from "../services/search-text";

interface Passage extends ReaderSearchHit { target: HTMLElement; }
const modes: RetrievalMode[] = ["fulltext", "semantic", "enhanced", "fusion"];
const modePreference = "extensions.zotero.knowledgemcp.readerSearchMode";

export class ReaderSearch {
  readonly button: HTMLButtonElement;
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly feedback: HTMLElement;
  private readonly results: HTMLElement;
  private readonly modeTrigger: HTMLButtonElement;
  private readonly modeMenu: HTMLElement;
  private readonly outsideMode = (event: Event) => {
    const target = event.target as Node | null;
    if (target && !this.modeMenu.contains(target) && !this.modeTrigger.contains(target)) this.closeModeMenu();
  };
  private readonly closeOnLayout = () => this.closeModeMenu();
  private readonly modeButtons = new Map<RetrievalMode, HTMLButtonElement>();
  private content?: AttachmentMarkdown;
  private mode: RetrievalMode = "fulltext";
  private controller?: AbortController;
  private sequence = 0;
  private disposed = false;
  private active = false;
  private directoryHidden = false;
  private directoryScroll = 0;
  private highlighted?: HTMLElement;
  private timer?: number;
  private anchors?: Map<string, HTMLElement[]>;
  private readonly window: Window & typeof globalThis;
  private readonly shortcut = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault(); event.stopPropagation(); this.open();
    }
  };

  constructor(private readonly article: HTMLElement, private readonly directory: HTMLElement,
    private readonly body: HTMLElement, private readonly visibility: () => void,
    private readonly provider?: ReaderSearchProvider) {
    const doc = article.ownerDocument; this.window = doc.defaultView!;
    try {
      const saved = Zotero.Prefs?.get(modePreference, true);
      if (modes.includes(saved as RetrievalMode)) this.mode = saved as RetrievalMode;
    } catch { /* Keep the local first-run mode when preferences are unavailable. */ }
    const button = (label: string, title: string, action: () => void) => {
      const value = doc.createElement("button"); value.type = "button"; value.textContent = label;
      value.title = title; value.setAttribute("aria-label", title); value.addEventListener("click", action); return value;
    };
    this.button = button("", t("reader-search-title"), () => this.active ? this.close() : this.open());
    this.button.className = "km-reader-search-toggle"; this.button.setAttribute("aria-expanded", "false");
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("width", "18"); svg.setAttribute("height", "18");
    svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M13.5 13.5 18 18 M15 8.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0");
    path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.4");
    path.setAttribute("stroke-linecap", "round"); svg.append(path); this.button.append(svg);
    this.element = doc.createElement("aside"); this.element.className = "km-reader-search"; this.element.hidden = true;
    this.element.id = "knowledgemcp-reader-search"; this.element.setAttribute("aria-label", t("reader-search-title"));
    this.button.setAttribute("aria-controls", this.element.id);
    const header = doc.createElement("div"); header.className = "km-reader-search-header";
    this.modeTrigger = button("", t("reader-search-mode"), () => this.modeMenu.hidden ? this.openModeMenu() : this.closeModeMenu(true));
    this.modeTrigger.className = "km-reader-search-mode";
    this.modeTrigger.setAttribute("aria-haspopup", "menu"); this.modeTrigger.setAttribute("aria-expanded", "false");
    this.modeTrigger.setAttribute("aria-controls", "knowledgemcp-reader-search-modes");
    this.modeTrigger.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); event.stopPropagation(); this.openModeMenu(event.key === "ArrowUp");
      }
    });
    header.append(button("‹", t("reader-search-back"), () => this.close()), this.modeTrigger,
      button("×", t("reader-search-close"), () => this.close()));
    const query = doc.createElement("div"); query.className = "km-reader-search-query";
    this.input = doc.createElement("input"); this.input.type = "search"; this.input.maxLength = 8000;
    this.input.placeholder = t("reader-search-placeholder"); this.input.setAttribute("aria-label", t("reader-search-placeholder"));
    this.input.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void this.submit(); }
      if (event.key === "ArrowDown") { event.preventDefault(); this.results.querySelector<HTMLButtonElement>("button")?.focus(); }
    });
    this.input.addEventListener("input", () => this.reset());
    const submit = button("", t("reader-search-submit"), () => { void this.submit(); });
    submit.append(svg.cloneNode(true)); query.append(this.input, submit);
    this.modeMenu = doc.createElement("div"); this.modeMenu.className = "km-depth-menu km-reader-search-mode-menu";
    this.modeMenu.id = "knowledgemcp-reader-search-modes"; this.modeMenu.hidden = true;
    this.modeMenu.setAttribute("role", "menu"); this.modeMenu.setAttribute("aria-label", t("reader-search-mode"));
    for (const mode of modes) {
      const item = button("", t(`reader-search-help-${mode}`), () => {
        if (this.disposed || !this.active) return;
        this.closeModeMenu();
        if (this.mode !== mode) {
          this.mode = mode; this.paintMode(); this.reset();
          try { Zotero.Prefs?.set(modePreference, mode, true); } catch { /* Reading remains available without preferences. */ }
        }
        this.input.focus();
      });
      const label = doc.createElement("span"); label.textContent = t(`reader-search-${mode}`);
      const check = doc.createElement("span"); check.className = "km-depth-menu-check"; check.setAttribute("aria-hidden", "true");
      item.append(label, check); item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-label", t(`reader-search-${mode}`)); item.dataset.mode = mode; item.tabIndex = -1;
      this.modeButtons.set(mode, item); this.modeMenu.append(item);
    }
    this.paintMode();
    this.modeMenu.addEventListener("pointerdown", event => event.stopPropagation());
    this.modeMenu.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); this.closeModeMenu(true); return; }
      if (event.key === "Tab") { this.closeModeMenu(true); return; }
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(this.modeButtons.values()), current = items.indexOf(doc.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      items[index]?.focus();
    });
    doc.body.append(this.modeMenu);
    this.feedback = doc.createElement("div"); this.feedback.className = "km-reader-search-feedback";
    this.feedback.setAttribute("role", "status"); this.feedback.setAttribute("aria-live", "polite");
    this.results = doc.createElement("div"); this.results.className = "km-reader-search-results";
    this.results.setAttribute("role", "group"); this.results.setAttribute("aria-label", t("reader-search-results"));
    this.results.addEventListener("keydown", event => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault(); event.stopPropagation();
      const items = Array.from(this.results.querySelectorAll<HTMLButtonElement>("button"));
      const index = items.indexOf(doc.activeElement as HTMLButtonElement);
      items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    });
    this.element.append(header, query, this.feedback, this.results);
    this.element.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); this.close(); this.button.focus(); }
    });
    body.prepend(this.element); body.addEventListener("keydown", this.shortcut, true);
    this.reset();
  }

  get isOpen(): boolean { return this.active; }
  setContent(content?: AttachmentMarkdown): void { this.content = content; this.anchors = undefined; this.reset(); }
  private paintMode(): void {
    const label = t(`reader-search-${this.mode}`);
    this.modeTrigger.textContent = label;
    this.modeTrigger.setAttribute("aria-label", `${t("reader-search-mode")}: ${label}`);
    for (const [mode, button] of this.modeButtons) {
      button.setAttribute("aria-checked", String(mode === this.mode));
      button.querySelector(".km-depth-menu-check")!.textContent = mode === this.mode ? "✓" : "";
    }
  }
  private openModeMenu(last = false): void {
    if (this.disposed || !this.active || !this.modeMenu.hidden) return;
    this.modeMenu.hidden = false; this.modeTrigger.setAttribute("aria-expanded", "true");
    const anchor = this.modeTrigger.getBoundingClientRect(), bounds = this.modeMenu.getBoundingClientRect();
    const left = anchor.left + (anchor.width - bounds.width) / 2;
    this.modeMenu.style.left = `${Math.max(8, Math.min(left, this.window.innerWidth - bounds.width - 8))}px`;
    this.modeMenu.style.top = `${Math.max(8, anchor.bottom + 6 + bounds.height <= this.window.innerHeight - 8
      ? anchor.bottom + 6 : anchor.top - bounds.height - 6)}px`;
    (last ? Array.from(this.modeButtons.values()).at(-1) : this.modeButtons.get(this.mode))?.focus();
    const doc = this.article.ownerDocument;
    doc.addEventListener("pointerdown", this.outsideMode, true);
    doc.addEventListener("focusin", this.outsideMode, true);
    doc.addEventListener("scroll", this.closeOnLayout, true);
    this.window.addEventListener("resize", this.closeOnLayout);
  }
  private closeModeMenu(restoreFocus = false): void {
    this.modeMenu.hidden = true; this.modeTrigger.setAttribute("aria-expanded", "false");
    const doc = this.article.ownerDocument;
    doc.removeEventListener("pointerdown", this.outsideMode, true);
    doc.removeEventListener("focusin", this.outsideMode, true);
    doc.removeEventListener("scroll", this.closeOnLayout, true);
    this.window.removeEventListener("resize", this.closeOnLayout);
    if (restoreFocus) this.modeTrigger.focus();
  }
  open(): void {
    if (this.disposed) return;
    if (!this.active) {
      this.directoryHidden = this.directory.hidden; this.directoryScroll = this.directory.scrollTop;
      this.active = true; this.directory.hidden = true; this.element.hidden = false;
      this.button.setAttribute("aria-expanded", "true"); this.body.classList.add("km-reader-search-open"); this.visibility();
    }
    this.input.focus(); this.input.select();
  }
  close(): void {
    this.closeModeMenu();
    const pending = Boolean(this.controller);
    this.cancel();
    if (pending) this.feedback.textContent = this.content ? "" : t("reader-search-no-content");
    this.clearHighlight();
    if (!this.active) return;
    const focused = this.element.contains(this.article.ownerDocument.activeElement);
    this.active = false; this.element.hidden = true; this.directory.hidden = this.directoryHidden;
    this.directory.scrollTop = this.directoryScroll; this.button.setAttribute("aria-expanded", "false");
    this.body.classList.remove("km-reader-search-open"); this.visibility();
    if (focused && !this.disposed) this.button.focus();
  }
  private cancel(): void {
    this.sequence++; this.controller?.abort(); this.controller = undefined; this.element.removeAttribute("aria-busy");
  }
  private reset(): void {
    this.cancel(); this.clearHighlight(); this.results.replaceChildren(); this.feedback.classList.remove("km-reader-search-warning");
    this.feedback.textContent = this.content ? "" : t("reader-search-no-content");
  }
  private passages(): Passage[] {
    const entries: Passage[] = [], headings: Array<{ level: number; text: string }> = [];
    const candidates = this.article.querySelectorAll<HTMLElement>("p,div.km-body-prose,li,pre,table,h1,h2,h3,h4,h5,h6");
    for (const target of Array.from(candidates)) {
      if (target.parentElement?.closest("li,table,pre")) continue;
      if (/^H[1-6]$/.test(target.tagName)) {
        const level = Number(target.tagName[1]); while (headings.length && headings.at(-1)!.level >= level) headings.pop();
        headings.push({ level, text: target.textContent ?? "" });
      }
      const text = readerText(target); if (!text.trim()) continue;
      entries.push({ blockID: `local-${entries.length}`, target, text, section: headings.map(heading => heading.text).join(" › ") || null,
        page: Number(target.closest<HTMLElement>("[data-source-page-start]")?.dataset.sourcePageStart) || null });
    }
    return entries;
  }
  private local(query: string): Passage[] {
    const terms = query.trim().split(/\s+/u).map(searchKey).filter(Boolean);
    return this.passages().filter(row => { const text = searchKey(row.text); return terms.every(term => text.includes(term)); });
  }
  private target(hit: ReaderSearchHit): HTMLElement | undefined {
    if (!this.anchors) {
      this.anchors = new Map();
      for (const element of Array.from(this.article.querySelectorAll<HTMLElement>("[data-source-block-ids],[data-block-id]"))) {
        const ids = new Set<string>(JSON.parse(element.dataset.sourceBlockIds ?? "[]") as string[]);
        if (element.dataset.blockId) ids.add(element.dataset.blockId);
        for (const id of ids) { const list = this.anchors.get(id) ?? []; list.push(element); this.anchors.set(id, list); }
      }
    }
    const candidates = this.anchors.get(hit.blockID) ?? [];
    const leaves = candidates.filter(element => !candidates.some(other => other !== element && element.contains(other)));
    return leaves.find(element => searchKey(readerText(element)).includes(searchKey(hit.text).slice(0, 60))) ?? leaves[0];
  }
  private reason(error: unknown): string {
    const code = error instanceof ModelError ? error.code : "provider";
    return code === "reader-index-partial" ? t("reader-search-index-partial") : code === "reader-not-indexed" ? t("reader-search-unindexed") : code === "reader-content-changed"
      ? t("reader-search-content-changed") : retrievalErrorMessage(code);
  }
  private async submit(): Promise<void> {
    const content = this.content, query = this.input.value.trim(); this.reset();
    if (!query || !content || !this.active || this.disposed) return;
    const sequence = this.sequence, mode = this.mode;
    const controller = new this.window.AbortController(); this.controller = controller;
    this.element.setAttribute("aria-busy", "true"); this.feedback.textContent = t("reader-search-loading");
    try {
      let rows: Passage[], degraded: string[] = [], truncated = false;
      if (mode === "fulltext" || mode === "fusion" && !content.generationID) {
        rows = this.local(query); truncated = rows.length > 50; rows = rows.slice(0, 50);
        if (mode === "fusion") degraded = ["reader-not-indexed"];
      } else {
        if (!content.generationID) throw new ModelError("reader-not-indexed");
        if (!this.provider) throw new ModelError("initializing");
        const result = await this.provider(content.attachment, content.generationID, query, mode, controller.signal);
        controller.signal.throwIfAborted();
        rows = result.hits.flatMap(hit => { const target = this.target(hit); return target ? [{ ...hit, target }] : []; });
        if (rows.length !== result.hits.length) throw new ModelError("reader-content-changed");
        degraded = result.degraded; truncated = result.truncated;
      }
      if (this.disposed || !this.active || sequence !== this.sequence) return;
      this.feedback.textContent = rows.length ? t(truncated ? "reader-search-count-limited" : "reader-search-count", { count: rows.length }) : t("reader-search-empty");
      if (degraded.length) {
        this.feedback.textContent += `\n${t("reader-search-degraded", { reason: [...new Set(degraded)].map(code => this.reason(new ModelError(code))).join(" ") })}`;
        this.feedback.classList.add("km-reader-search-warning");
      }
      for (const row of rows) this.result(row, query);
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed && this.active && sequence === this.sequence) {
        this.feedback.textContent = this.reason(error); this.feedback.classList.add("km-reader-search-warning");
      }
    } finally {
      if (sequence === this.sequence) { this.controller = undefined; this.element.removeAttribute("aria-busy"); }
    }
  }
  private result(row: Passage, query: string): void {
    const doc = this.article.ownerDocument, item = doc.createElement("button"); item.type = "button"; item.className = "km-reader-search-result";
    if (row.section) { const heading = doc.createElement("span"); heading.className = "km-reader-search-section"; heading.textContent = row.section; item.append(heading); }
    const text = doc.createElement("span"); text.className = "km-reader-search-snippet";
    const literal = query.split(/\s+/u).filter(Boolean).map(term => row.text.toLowerCase().indexOf(term.toLowerCase())).filter(index => index >= 0);
    const position = literal.length ? Array.from(row.text.slice(0, Math.min(...literal))).length : searchPosition(row.text, query) ?? 0;
    const characters = Array.from(row.text), start = Math.max(0, position - 35);
    const snippet = `${start ? "…" : ""}${characters.slice(start, start + 240).join("")}${start + 240 < characters.length ? "…" : ""}`;
    const terms = query.split(/\s+/u).filter(Boolean), pattern = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    let offset = 0;
    for (const match of snippet.matchAll(new RegExp(pattern, "giu"))) {
      text.append(doc.createTextNode(snippet.slice(offset, match.index)));
      const mark = doc.createElement("mark"); mark.textContent = match[0]; text.append(mark); offset = match.index! + match[0].length;
    }
    text.append(doc.createTextNode(snippet.slice(offset))); item.append(text);
    if (row.page) { const page = doc.createElement("span"); page.className = "km-reader-search-page"; page.textContent = t("reader-search-page", { page: row.page }); item.append(page); }
    item.addEventListener("click", () => {
      if (this.disposed || !this.active || !this.results.contains(item) || !this.article.contains(row.target)) return;
      this.clearHighlight();
      for (let parent: HTMLElement | null = row.target; parent && parent !== this.article; parent = parent.parentElement) {
        if (parent.matches("details")) (parent as HTMLDetailsElement).open = true;
      }
      for (const button of Array.from(this.results.querySelectorAll("[aria-current]"))) button.removeAttribute("aria-current");
      item.setAttribute("aria-current", "location"); row.target.classList.add("km-reader-search-target"); this.highlighted = row.target;
      row.target.scrollIntoView({ block: "start", behavior: "smooth" });
      this.timer = this.window.setTimeout(() => this.clearHighlight(), 4000);
    }); this.results.append(item);
  }
  private clearHighlight(): void {
    if (this.timer !== undefined) this.window.clearTimeout(this.timer);
    this.timer = undefined; this.highlighted?.classList.remove("km-reader-search-target"); this.highlighted = undefined;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.close(); this.body.removeEventListener("keydown", this.shortcut, true);
    this.results.replaceChildren(); this.anchors?.clear(); this.anchors = undefined;
    this.modeMenu.remove(); this.element.remove(); this.button.remove(); this.content = undefined;
  }
}
