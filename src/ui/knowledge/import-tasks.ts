import { adaptMethod } from "../../core/method-adapter";
import { t } from "../../shared/localization";
import { parsingErrorMessage } from "../../shared/parsing-errors";
import { isActiveImportTask, type FolderImportTask, type ImportTask, type ImportTaskAction, type ImportTaskSource, type ImportTaskStatus, type ItemImportTask } from "./import-task-model";
import type { KnowledgeMainWindow } from "./native-types";
import styles from "../../../addon/content/ui/import-tasks.css";
import { parserCatalog } from "../../parsers/catalog";
import { modelProviders } from "../../providers/models";
import { retrievalErrorMessage } from "../../shared/retrieval-errors";
import { currentAction, extractionPhase, extractionStep, extractionSteps, pageProgress, semanticState, waitingProgress, workflowGroup } from "./task-progress";
import { TaskDetailsPane } from "./task-details-pane";

export const IMPORT_TASKS_ROW_ID = "Kknowledgemcp:import-tasks";
type Filter = "all" | "active" | "syncing" | "attention" | "completed";
const columnLabels = ["tasks-item", "location", "tasks-processing"];
const columnPreference = "extensions.zotero.knowledgemcp.importTaskColumns";

function readColumnWidths(): number[] {
  try {
    const value: unknown = JSON.parse(String(Zotero.Prefs?.get(columnPreference, true)));
    if (Array.isArray(value) && [3, 4].includes(value.length) && value.every(width => typeof width === "number" && Number.isFinite(width) && width >= 5 && width <= 85)
      && Math.abs(value.reduce((total, width) => total + width, 0) - 100) < 0.01) return value.length === 4 ? [value[0], value[1], value[2] + value[3]] : value;
  } catch { /* Missing or invalid preferences use the initial layout. */ }
  return [49, 22, 29];
}

/** Window-owned task presentation. The source owns task state and operations. */
export class ImportTasksView {
  private tasks: readonly ImportTask[] = [];
  private selected: string | undefined;
  private readonly selection = new Set<string>();
  private anchor: string | undefined;
  private contextMenu: Element | undefined;
  private filter: Filter = "all";
  private query = "";
  private readonly expanded = new Set<string>();
  private readonly knownFolders = new Set<string>();
  private readonly pendingActions = new Set<string>();
  private readonly actionErrors = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  private columnWidths = readColumnWidths();
  private endResize: ((commit: boolean) => void) | undefined;
  private refreshPending = false;
  private snapshotKey = "";
  private navigationCount = 0;
  private active = false;
  private disposed = false;
  private readonly list: HTMLElement | undefined;
  private readonly details: HTMLElement | undefined;
  private readonly detailsPane: TaskDetailsPane | undefined;
  private readonly style: Element | undefined;
  private readonly restore: (() => void) | undefined;
  private readonly inert = new Map<Element, string | null>();

  constructor(private readonly window: KnowledgeMainWindow, private readonly changed: () => void, private readonly source?: ImportTaskSource) {
    const doc = window.document;
    const middle = doc?.getElementById("zotero-items-pane-container");
    const right = doc?.getElementById("zotero-item-pane");
    if (!middle || !right) return;
    try {
      this.style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
      this.style.textContent = styles;
      doc.documentElement.append(this.style);
      this.list = this.element("section", "km-import-tasks");
      this.list.id = "km-import-tasks";
      this.list.setAttribute("aria-label", t("tasks-title"));
      this.detailsPane = new TaskDetailsPane(window);
      this.details = this.detailsPane.content;
      this.list.hidden = true;
      middle.append(this.list);
      this.restore = adaptMethod(window.ZoteroPane, "onCollectionSelected", async (receiver, native, args) => {
        this.sync();
        try { return await Reflect.apply(native, receiver, args); }
        finally { this.sync(); }
      });
      this.refreshTasks(false);
      this.unsubscribe = source?.subscribe(() => this.refreshTasks());
      this.sync();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get activeCount(): number {
    return this.roots().filter(task => ["queued", "parsing", "publishing", "retrying", "syncing"].includes(this.status(task))).length;
  }

  private refreshTasks(notify = true): void {
    if (this.disposed) return;
    if (this.endResize) { this.refreshPending = true; return; }
    const tasks = this.source?.snapshot() ?? [];
    const key = JSON.stringify([tasks, this.source?.notice?.()]);
    if (key === this.snapshotKey) return;
    const previousCount = this.navigationCount; this.snapshotKey = key;
    const focused = this.window.document.activeElement as HTMLElement | null;
    const input = focused?.matches(".km-tasks-search") ? focused as HTMLInputElement : null;
    const cursor = input ? [input.selectionStart, input.selectionEnd] : null;
    const focusedTask = focused?.closest<HTMLElement>("[data-task]")?.dataset.task;
    const focusedFilter = focused?.closest<HTMLElement>("[data-filter]")?.dataset.filter;
    const titleFocus = focused?.classList.contains("km-task-select");
    const scrollTop = this.list?.querySelector(".km-tasks-scroll")?.scrollTop ?? 0;
    this.tasks = tasks;
    if (this.selected && !this.tasks.some(task => task.id === this.selected)) {
      this.selected = this.tasks.find(task => task.replacesID === this.selected)?.id ?? this.selected;
    }
    const folders = new Set(this.tasks.filter(task => task.kind === "folder").map(task => task.id));
    for (const id of this.knownFolders) if (!folders.has(id)) { this.knownFolders.delete(id); this.expanded.delete(id); }
    for (const id of folders) if (!this.knownFolders.has(id)) { this.knownFolders.add(id); this.expanded.add(id); }
    this.render();
    const scroll = this.list?.querySelector(".km-tasks-scroll");
    if (input) {
      const next = this.list?.querySelector<HTMLInputElement>(".km-tasks-search"); next?.focus();
      if (cursor && cursor[0] !== null && cursor[1] !== null) next?.setSelectionRange(cursor[0], cursor[1]);
    } else if (focusedTask) {
      const row = Array.from(this.list?.querySelectorAll<HTMLElement>("[data-task]") ?? []).find(row => row.dataset.task === focusedTask);
      row?.querySelector<HTMLButtonElement>(titleFocus ? ".km-task-select" : ".km-task-toggle")?.focus();
    } else if (focusedFilter) {
      Array.from(this.list?.querySelectorAll<HTMLButtonElement>("[data-filter]") ?? []).find(button => button.dataset.filter === focusedFilter)?.focus();
    }
    if (scroll) scroll.scrollTop = scrollTop;
    this.navigationCount = this.activeCount;
    if (notify && previousCount !== this.navigationCount) this.changed();
  }

  private roots(): ImportTask[] { return this.tasks.filter(task => task.kind === "folder" || !task.parentID); }

  private children(task: ImportTask): ItemImportTask[] {
    return this.tasks.filter((child): child is ItemImportTask => child.kind === "item" && child.parentID === task.id);
  }

  private status(task: ImportTask): ImportTaskStatus {
    if (task.kind === "item" || task.mode === "sync") return task.status;
    const children = this.children(task);
    if (!children.length) return task.status;
    const active = children.filter(isActiveImportTask);
    if (active.length) return active.every(child => child.status === "retrying") ? "retrying" : active.every(child => child.status === "queued") ? "queued"
      : active.every(child => child.status === "publishing") ? "publishing" : "parsing";
    if (children.some(child => child.status === "attention")) return "attention";
    if (children.every(child => child.status === "completed")) return "completed";
    if (children.every(child => child.status === "cancelled")) return "cancelled";
    if (children.every(child => child.status === "paused")) return "paused";
    return children.every(child => child.status === "failed") ? "failed" : "partial";
  }

  private element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
    const element = this.window.document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  private button(label: string, action: () => void, className = ""): HTMLButtonElement {
    const button = this.element("button", className, label);
    button.type = "button";
    button.addEventListener("click", () => { if (!this.disposed) action(); });
    return button;
  }

  private sync(): void {
    if (this.disposed || !this.list || !this.details) return;
    const rows = this.window.ZoteroPane.collectionsView.getSelectedRows();
    const active = rows.length === 1 && rows[0].id === IMPORT_TASKS_ROW_ID;
    this.detailsPane?.show(active);
    if (active === this.active) return;
    this.active = active;
    this.list.hidden = !active;
    for (const surface of this.detailsPane?.native ? [this.list] : [this.list, this.details]) {
      surface.parentElement?.classList.toggle("km-import-host-active", active);
      for (const child of Array.from(surface.parentElement?.children ?? [])) {
        if (child === surface) continue;
        if (active) {
          if (!this.inert.has(child)) this.inert.set(child, child.getAttribute("inert"));
          child.setAttribute("inert", "");
        }
      }
    }
    if (active) this.render();
    else { this.endResize?.(false); this.restoreInert(); }
  }

  private restoreInert(): void {
    for (const [element, value] of this.inert) {
      if (value === null) element.removeAttribute("inert");
      else element.setAttribute("inert", value);
    }
    this.inert.clear();
  }

  private matches(task: ImportTask): boolean {
    const state = this.status(task);
    const status = this.filter === "all" || (this.filter === "active" && ["queued", "parsing", "publishing", "retrying"].includes(state))
      || (this.filter === "syncing" && state === "syncing")
      || (this.filter === "attention" && ["failed", "partial", "attention"].includes(state))
      || (this.filter === "completed" && state === "completed");
    return status && (this.matchesText(task) || this.children(task).some(child => this.matchesText(child)));
  }

  private matchesText(task: ImportTask): boolean {
    const source = task.kind === "item" ? `${task.fileName} ${this.parserLabel(task)} ${task.parser?.model ?? ""}` : task.sourceCollection;
    return `${task.title} ${source} ${task.target}`.toLowerCase().includes(this.query.toLowerCase().trim());
  }

  private parserLabel(task: ItemImportTask): string {
    const parser = task.parser;
    if (!parser) return "";
    const definition = parserCatalog.get(parser.provider);
    const model = modelProviders.list().find(provider => provider.definition.id === parser.provider)?.definition;
    return definition ? t(definition.labelKey) : model ? t(model.labelKey) : parser.provider;
  }

  private visibleTasks(): ImportTask[] {
    return this.roots().filter(task => this.matches(task)).flatMap(task => task.kind === "folder" && this.expanded.has(task.id)
      ? [task, ...this.children(task).filter(child => this.matchesText(task) || this.matchesText(child))] : [task]);
  }

  private progress(task: ImportTask, compact = false): HTMLElement {
    const cell = this.element("div", "km-task-progress");
    if (task.kind === "folder") {
      const children = this.children(task);
      cell.append(this.element("span", "", task.mode === "sync" && task.changes ? t("tasks-sync-changes", task.changes)
        : t("tasks-items", { completed: children.filter(child => child.status === "completed").length, total: children.length })));
      return cell;
    }
    const pages = compact && task.pages?.total && task.pages.completed <= task.pages.total
      ? t("tasks-pages", { completed: task.pages.completed, total: task.pages.total }) : pageProgress(task);
    const parsing = workflowGroup(task) === 1 && extractionPhase(task) === "parsing" && task.status === "parsing";
    if (parsing && pages) {
      if (task.pages!.total && task.pages!.completed <= task.pages!.total) {
        const bar = this.element("progress");
        bar.max = task.pages!.total;
        bar.value = task.pages!.completed;
        bar.setAttribute("aria-label", pages); cell.append(bar);
      }
      cell.append(this.element("span", "", pages));
    } else cell.append(this.element("span", "", currentAction(task)));
    return cell;
  }

  private applyColumnWidths(table: HTMLTableElement): void {
    table.querySelectorAll("col").forEach((column, index) => { column.style.width = `${this.columnWidths[index]}%`; });
    table.querySelectorAll<HTMLElement>("[role=separator]").forEach((handle, index) => {
      handle.setAttribute("aria-valuenow", String(Math.round(this.columnWidths[index])));
    });
  }

  private saveColumnWidths(): void {
    try { Zotero.Prefs?.set(columnPreference, JSON.stringify(this.columnWidths), true); }
    catch { Zotero.debug("[ZoteroKnowledgeMCP] Import task column widths could not be saved."); }
  }

  private resizeHandle(index: number, table: HTMLTableElement): HTMLElement {
    const handle = this.element("span", "km-task-column-resize");
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator"); handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", t("tasks-resize-column", { name: t(columnLabels[index]) }));
    handle.setAttribute("aria-valuemin", "5"); handle.setAttribute("aria-valuemax", "85");
    handle.setAttribute("aria-valuenow", String(Math.round(this.columnWidths[index])));
    const adjust = (original: number[], delta: number, width: number) => {
      const pair = original[index] + original[index + 1];
      const minimum = Math.max(5, Math.min(72 / width * 100, pair / 2));
      this.columnWidths = [...original];
      this.columnWidths[index] = Math.max(minimum, Math.min(pair - minimum, original[index] + delta / width * 100));
      this.columnWidths[index + 1] = pair - this.columnWidths[index];
      this.applyColumnWidths(table);
    };
    handle.addEventListener("keydown", event => {
      if (this.disposed) return;
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      adjust(this.columnWidths, event.key === "ArrowRight" ? 10 : -10, table.getBoundingClientRect().width || 1000);
      this.saveColumnWidths();
    });
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || this.disposed) return;
      event.preventDefault(); event.stopPropagation(); this.endResize?.(false);
      const width = table.getBoundingClientRect().width;
      if (!width) return;
      const original = [...this.columnWidths], origin = event.clientX;
      const doc = this.window.document;
      const move = (next: PointerEvent) => adjust(original, next.clientX - origin, width);
      const up = () => this.endResize?.(true);
      const cancel = () => this.endResize?.(false);
      this.endResize = commit => {
        doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up);
        doc.removeEventListener("pointercancel", cancel); this.window.removeEventListener("blur", cancel);
        this.list?.classList.remove("km-task-columns-resizing"); this.endResize = undefined;
        if (commit) this.saveColumnWidths();
        else { this.columnWidths = original; this.applyColumnWidths(table); }
        if (this.refreshPending) void Promise.resolve().then(() => {
          if (!this.disposed && this.refreshPending) { this.refreshPending = false; this.refreshTasks(); }
        });
      };
      doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", up);
      doc.addEventListener("pointercancel", cancel); this.window.addEventListener("blur", cancel);
      this.list?.classList.add("km-task-columns-resizing");
    });
    return handle;
  }

  private render(): void {
    if (!this.list || !this.details || this.disposed || !this.active) return;
    this.endResize?.(false);
    const visible = this.visibleTasks();
    if (!visible.some(task => task.id === this.selected)) this.selected = visible[0]?.id;
    for (const id of this.selection) if (!visible.some(task => task.id === id)) this.selection.delete(id);
    if (!this.selection.size && this.selected) this.selection.add(this.selected);
    this.list.replaceChildren();
    const toolbar = this.element("div", "km-tasks-toolbar");
    toolbar.setAttribute("role", "toolbar"); toolbar.setAttribute("aria-label", t("tasks-title"));
    const filters = this.element("div", "km-tasks-filters");
    filters.setAttribute("role", "group"); filters.setAttribute("aria-label", t("tasks-filter"));
    const counts: Record<Filter, number> = {
      all: this.roots().length,
      active: this.roots().filter(task => ["queued", "parsing", "publishing", "retrying"].includes(this.status(task))).length,
      syncing: this.roots().filter(task => this.status(task) === "syncing").length,
      attention: this.roots().filter(task => ["failed", "partial", "attention"].includes(this.status(task))).length,
      completed: this.roots().filter(task => this.status(task) === "completed").length,
    };
    for (const filter of ["all", "active", "syncing", "attention", "completed"] as const) {
      const button = this.button(t(`tasks-filter-${filter}`), () => { this.filter = filter; this.render();
        this.list?.querySelector<HTMLButtonElement>(`[data-filter="${filter}"]`)?.focus(); });
      button.append(this.element("span", "km-task-count", String(counts[filter])));
      button.dataset.filter = filter; button.setAttribute("aria-pressed", String(filter === this.filter)); filters.append(button);
    }
    const search = this.element("input", "km-tasks-search");
    search.type = "search"; search.placeholder = t("tasks-search"); search.setAttribute("aria-label", t("tasks-search")); search.value = this.query;
    search.addEventListener("input", () => {
      const start = search.selectionStart, end = search.selectionEnd;
      this.query = search.value; this.render();
      const next = this.list?.querySelector<HTMLInputElement>("input"); next?.focus();
      if (start !== null && end !== null) next?.setSelectionRange(start, end);
    });
    toolbar.append(filters, search);
    if (this.source?.openConfig) {
      const settings = this.button("", () => this.source?.openConfig?.(), "km-tasks-config");
      settings.title = t("settings-open"); settings.setAttribute("aria-label", t("settings-open"));
      const icon = this.element("span", "km-settings-icon"); icon.setAttribute("aria-hidden", "true"); settings.append(icon);
      toolbar.append(settings);
    }
    this.list.append(toolbar);
    const notice = this.source?.notice?.();
    if (notice) { const message = this.element("p", "km-tasks-config-notice", notice); message.setAttribute("role", "status"); this.list.append(message); }
    const scroll = this.element("div", "km-tasks-scroll");
    const table = this.element("table", "km-tasks-table focus-states-target"); table.setAttribute("aria-label", t("tasks-title"));
    table.setAttribute("aria-multiselectable", "true"); table.setAttribute("role", "grid");
    table.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault(); event.stopPropagation(); for (const task of visible) this.selection.add(task.id); this.render();
        this.list?.querySelector<HTMLButtonElement>(`[data-task="${this.selected}"] .km-task-select`)?.focus();
      } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault(); event.stopPropagation(); const row = this.list?.querySelector<HTMLElement>(`[data-task="${this.selected}"]`);
        if (row && this.selected) { const rect = row.getBoundingClientRect(); this.showContextMenu(this.selected, rect.x + 30, rect.bottom); }
      }
    });
    const columns = this.element("colgroup");
    for (const width of this.columnWidths) { const column = this.element("col"); column.style.width = `${width}%`; columns.append(column); }
    table.append(columns);
    const head = this.element("thead"), row = this.element("tr");
    for (const [index, key] of columnLabels.entries()) {
      const cell = this.element("th", "", t(key)); cell.scope = "col"; row.append(cell);
      if (index < columnLabels.length - 1) cell.append(this.resizeHandle(index, table));
    }
    head.append(row); table.append(head);
    const body = this.element("tbody");
    for (const task of visible) {
      const tr = this.element("tr", this.selection.has(task.id) ? "row selected" : "row"); tr.dataset.task = task.id;
      tr.setAttribute("aria-selected", String(this.selection.has(task.id)));
      tr.dataset.kind = task.kind;
      const title = this.element("td", "km-task-title");
      const titleRow = this.element("div", "km-task-title-row");
      if (task.kind === "item" && task.parentID) titleRow.classList.add("child");
      if (task.kind === "folder") {
        const toggle = this.button(this.expanded.has(task.id) ? "▾" : "▸", () => this.toggleFolder(task), "km-task-toggle");
        toggle.setAttribute("aria-expanded", String(this.expanded.has(task.id)));
        toggle.setAttribute("aria-label", t(this.expanded.has(task.id) ? "tasks-collapse-folder" : "tasks-expand-folder", { name: task.title }));
        titleRow.append(toggle);
      } else titleRow.append(this.element("span", "km-task-toggle-space"));
      const button = this.button(task.title, () => {}, "km-task-select");
      button.addEventListener("click", event => this.select(task.id, event));
      button.setAttribute("aria-pressed", String(this.selection.has(task.id)));
      button.addEventListener("keydown", event => {
        if (event.key === "ArrowRight" && task.kind === "folder") {
          event.preventDefault(); if (!this.expanded.has(task.id)) this.toggleFolder(task, true); return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          if (task.kind === "folder" && this.expanded.has(task.id)) this.toggleFolder(task, true);
          else if (task.kind === "item" && task.parentID) this.select(task.parentID);
          return;
        }
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const index = visible.findIndex(candidate => candidate.id === task.id);
        const next = visible[index + (event.key === "ArrowDown" ? 1 : -1)]; if (next) this.select(next.id, event);
      });
      button.title = task.title;
      const icons = this.window.require?.("components/icons");
      const icon = task.kind === "folder" ? icons?.getCSSIcon("collection") : icons?.getCSSItemTypeIcon(task.itemType);
      if (icon) { icon.setAttribute("aria-hidden", "true"); button.prepend(icon); }
      titleRow.append(button); title.append(titleRow);
      const target = this.element("td", "km-task-target", task.target); target.title = task.target;
      const status = this.status(task);
      const stage = this.element("td"), processing = this.element("div", "km-task-processing");
      const waiting = task.kind === "item" && workflowGroup(task) === 1 ? waitingProgress(task) : undefined;
      const label = task.kind === "item" ? [currentAction(task), waiting].filter(Boolean).join(" · ") : t(`tasks-status-${status}`);
      processing.append(this.element("span", `km-task-status ${status}`, label));
      if (task.kind === "item" && workflowGroup(task) === 1 && extractionPhase(task) === "parsing" && status === "parsing" && pageProgress(task)) processing.append(this.progress(task, true));
      stage.title = processing.textContent ?? label;
      stage.append(processing);
      tr.append(title, target, stage); tr.addEventListener("click", event => { if (!(event.target as Element).closest("button")) this.select(task.id, event); });
      tr.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation();
        if (!this.selection.has(task.id)) this.select(task.id);
        this.showContextMenu(task.id, event.clientX, event.clientY);
      });
      body.append(tr);
    }
    table.append(body); scroll.append(table);
    if (!visible.length) scroll.append(this.element("p", "km-tasks-empty", t(this.tasks.length ? "tasks-empty" : "tasks-none")));
    this.list.append(scroll);
    this.renderDetails();
  }

  private select(id: string, event?: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">): void {
    if (event?.shiftKey && this.anchor) {
      const visible = this.visibleTasks(), start = visible.findIndex(task => task.id === this.anchor), end = visible.findIndex(task => task.id === id);
      if (!event.ctrlKey && !event.metaKey) this.selection.clear();
      if (start >= 0 && end >= 0) for (const task of visible.slice(Math.min(start, end), Math.max(start, end) + 1)) this.selection.add(task.id);
    } else if (event?.ctrlKey || event?.metaKey) {
      if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
      this.anchor = id;
    } else { this.selection.clear(); this.selection.add(id); this.anchor = id; }
    this.selected = id; this.render();
    this.list?.querySelector<HTMLButtonElement>(`[data-task="${id}"] .km-task-select`)?.focus();
  }

  private toggleFolder(task: FolderImportTask, focusTitle = false): void {
    if (this.expanded.has(task.id)) {
      this.expanded.delete(task.id);
      if (this.children(task).some(child => child.id === this.selected)) this.selected = task.id;
    } else this.expanded.add(task.id);
    this.render(); this.list?.querySelector<HTMLButtonElement>(`[data-task="${task.id}"] ${focusTitle ? ".km-task-select" : ".km-task-toggle"}`)?.focus();
  }

  private renderDetails(): void {
    if (!this.details || !this.detailsPane) return;
    this.detailsPane.reset();
    const info = this.detailsPane.body("info"), progress = this.detailsPane.body("progress"), technical = this.detailsPane.body("processing");
    if (this.selection.size > 1) {
      this.detailsPane.setTitle(t("tasks-selected", { count: this.selection.size }));
      info.append(this.element("p", "", t("tasks-selected", { count: this.selection.size })));
      this.detailsPane.hide("progress"); this.detailsPane.hide("processing"); this.detailsPane.refresh(); return;
    }
    const task = this.tasks.find(task => task.id === this.selected);
    this.detailsPane.setTitle(task?.title ?? t("tasks-details"));
    if (!task) { info.append(this.element("p", "km-tasks-empty", t("tasks-select"))); this.detailsPane.hide("progress"); this.detailsPane.hide("processing"); this.detailsPane.refresh(); return; }
    if (task.kind === "folder") { this.renderFolderDetails(task, info, progress, technical); this.detailsPane.refresh(); return; }
    info.append(this.element("span", `km-task-status ${task.status}`, ["parsing", "publishing"].includes(task.status) ? currentAction(task) : t(`tasks-status-${task.status}`)));
    const fields = this.element("dl", "km-task-fields");
    for (const [key, value] of [["tasks-file", task.fileName], ["location", task.target]]) {
      fields.append(this.element("dt", "", t(key)), this.element("dd", "", value));
    }
    info.append(fields);
    this.renderWorkflow(task, progress);
    const technicalFields = this.element("dl", "km-task-fields");
    if (task.parser) {
      technicalFields.append(this.element("dt", "", t("tasks-parser")), this.element("dd", "", this.parserLabel(task)),
        this.element("dt", "", t("tasks-model")), this.element("dd", "", task.parser.model));
    }
    if (task.embedding) technicalFields.append(this.element("dt", "", t("vector-dimensions")), this.element("dd", "", String(task.embedding.dimensions)));
    const embeddingProvider = modelProviders.list().find(provider => provider.definition.id === task.embedding?.provider)?.definition;
    if (task.embedding?.provider) technicalFields.append(this.element("dt", "", t("vector-embedding-provider")), this.element("dd", "", embeddingProvider ? t(embeddingProvider.labelKey) : task.embedding.provider),
      this.element("dt", "", t("vector-embedding-model")), this.element("dd", "", task.embedding.model ?? ""));
    if (task.counts) technicalFields.append(this.element("dt", "", t("vector-progress")), this.element("dd", "", t("vector-counts", task.counts)));
    if (technicalFields.childElementCount) technical.append(technicalFields);
    const message = task.status === "failed" ? "tasks-failed-note" : task.status === "partial" ? "tasks-partial-note" : "tasks-progress-note";
    const note = this.element("p", `km-task-note ${task.status}`, task.errorCode ? task.embedding && task.embedding.status !== "completed" ? retrievalErrorMessage(task.errorCode) : parsingErrorMessage(task.errorCode)
      : task.status === "cancelled" ? t("parse-cancelled-note") : t(message)); note.setAttribute("role", "status");
    if (task.errorCode || ["failed", "partial", "cancelled", "attention"].includes(task.status)) progress.append(note);
    this.renderActions(task, technical);
    if (!technical.childElementCount) this.detailsPane.hide("processing");
    this.detailsPane.refresh();
  }

  private renderWorkflow(task: ItemImportTask, target: HTMLElement): void {
    const group = workflowGroup(task), semantic = semanticState(task);
    const extractionDone = group === 2 || ["completed", "partial"].includes(task.status);
    const contentPartial = task.processing?.contentPartial || group === 1 && task.status === "partial";
    const terminal = ["completed", "partial", "failed", "cancelled"].includes(task.status);
    const steps = this.element("ol", "km-task-steps"); steps.setAttribute("aria-label", t("tasks-stage"));
    for (const [index, label] of ["join", "extract", "semantic"].entries()) {
      const state = index === 0 ? "done" : index === 1 ? extractionDone ? contentPartial ? "partial" : "done" : task.status : semantic;
      const li = this.element("li", state);
      const details = this.element("div", "km-task-stage");
      const marker = this.element("span", "km-task-step-marker", state === "done" ? "✓" : String(index + 1)); marker.setAttribute("aria-hidden", "true");
      const summary = this.element("h3", "km-task-stage-title", t(`tasks-workflow-${label}`)); summary.prepend(marker); details.append(summary);
      const stateLabel = ["done", "manual", "disabled", "automatic"].includes(state) ? `tasks-workflow-${state}` : `tasks-status-${state}`;
      const stateText = index === 2 && group === 2 && !terminal
        ? t(["parsing", "publishing"].includes(task.status) ? "tasks-filter-active" : stateLabel)
        : index === group && !terminal ? currentAction(task) : t(stateLabel);
      if (state !== "done") details.append(this.element("span", "km-task-group-state", stateText));
      if (index === group && !terminal) summary.setAttribute("aria-current", "step");
      if (index === 0) {
        const substeps = this.element("ol", "km-task-substeps"), sub = this.element("li", "done");
        sub.append(this.element("span", "km-task-step-marker", "✓"), this.element("span", "", t("tasks-joined-note")));
        substeps.append(sub); details.append(substeps);
      }
      if (index === 1) {
        const substeps = this.element("ol", "km-task-substeps"), current = extractionStep(task);
        for (const [position, step] of extractionSteps.entries()) {
          const done = extractionDone || position < current;
          const sub = this.element("li", done ? "done" : position === current ? "current" : "pending");
          sub.append(this.element("span", "km-task-step-marker", done ? "✓" : "·"), this.element("span", "", t(`tasks-extract-${step}`)));
          substeps.append(sub);
        }
        details.append(substeps);
        if (!extractionDone) {
          details.append(this.progress(task));
          if (waitingProgress(task)) details.append(this.element("p", "km-task-subnote", waitingProgress(task)));
          if (task.extraction?.updatedAt) details.append(this.element("p", "km-task-subnote", t("tasks-last-progress-update", { time: task.extraction.updatedAt })));
        } else if (pageProgress(task)) details.append(this.element("p", "km-task-subnote", pageProgress(task)));
        if (contentPartial) details.append(this.element("p", "km-task-subnote", t("tasks-partial-note")));
      }
      if (index === 2) {
        if (task.embedding) {
          const substeps = this.element("ol", "km-task-substeps");
          for (const [position, step] of ["prepare", "index"].entries()) {
            const done = semantic === "done" || position === 0 && task.stage === "index";
            const current = !terminal && position === (task.stage === "index" ? 1 : 0);
            const sub = this.element("li", done ? "done" : current ? "current" : "pending");
            sub.append(this.element("span", "km-task-step-marker", done ? "✓" : "·"), this.element("span", "", t(`tasks-semantic-${step}`)));
            substeps.append(sub);
          }
          details.append(substeps);
        } else details.append(this.element("p", "km-task-subnote", t(`tasks-semantic-${task.semanticPlan ?? "manual"}`)));
      }
      li.append(details); steps.append(li);
    }
    target.append(steps);
    const complete = task.status === "completed" && (semantic === "done"
      || !task.embedding && (!task.semanticPlan || ["disabled", "manual"].includes(task.semanticPlan)));
    if (complete) {
      const result = this.element("p", "km-task-completion"); result.setAttribute("role", "status");
      const marker = this.element("span", "km-task-step-marker", "✓"); marker.setAttribute("aria-hidden", "true");
      result.append(marker, this.element("span", "", t("tasks-status-completed"))); target.append(result);
    }
  }

  private renderFolderDetails(task: FolderImportTask, info: HTMLElement, progress: HTMLElement, technical: HTMLElement): void {
    const status = this.status(task);
    info.append(this.element("span", `km-task-status ${status}`, t(`tasks-status-${status}`)));
    const fields = this.element("dl", "km-task-fields");
    for (const [key, value] of [["tasks-source-folder", task.sourceCollection], ["location", task.target],
      ["tasks-import-mode", t(task.mode === "sync" ? "tasks-mode-sync" : "tasks-mode-once")]]) {
      fields.append(this.element("dt", "", t(key)), this.element("dd", "", value));
    }
    const note = this.element("p", `km-task-note ${status}`, t(task.mode === "sync"
      ? status === "paused" ? "tasks-sync-paused" : status === "attention" ? "tasks-sync-attention" : "tasks-sync-note" : "tasks-folder-note"));
    note.setAttribute("role", "status");
    info.append(fields); progress.append(this.progress(task), note);
    this.renderActions(task, technical);
    if (!technical.childElementCount) this.detailsPane?.hide("processing");
  }

  private renderActions(task: ImportTask, target: HTMLElement): void {
    if (!this.details || !this.source?.runAction) return;
    const status = this.status(task), actions = this.element("div", "km-task-actions");
    const add = (key: string, action: ImportTaskAction) => {
      const button = this.button(t(key), () => { void this.runAction(task.id, action); });
      button.disabled = this.pendingActions.has(task.id) || (task.kind === "item" && task.embedding?.active === false && (!task.processing?.parseTaskID || task.embedding.status !== "completed") && !["cancel", "delete"].includes(action)); actions.append(button);
    };
    if (task.kind === "folder" && task.mode === "sync") {
      if (status === "paused") add("tasks-resume-sync", "resume");
      else { add("tasks-pause-sync", "pause"); if (status === "attention") add("tasks-retry", "retry"); }
    } else {
      if (task.kind === "item" && task.stage === "embed") {
        if (status === "paused") add("vector-task-resume", "resume");
        else if (["queued", "parsing", "retrying"].includes(status)) add("vector-task-pause", "pause");
      }
      if (["queued", "parsing", "publishing", "retrying", "attention", "paused"].includes(status)) add("tasks-cancel", "cancel");
      if (task.kind === "item" && task.errorCode === "ambiguous") add("parse-recover", "recover");
      else if (["failed", "partial", "cancelled", "attention", "retrying"].includes(status)) add("tasks-retry", "retry");
      if (status === "completed" && task.kind === "item") add(task.processing?.parseTaskID || !task.embedding ? "parse-again" : "vector-enqueue", "retry");
    }
    if (["completed", "partial", "failed", "cancelled"].includes(status)) add("tasks-delete-record", "delete");
    target.append(actions);
    if (this.actionErrors.has(task.id)) {
      const error = this.element("p", "km-task-note failed km-task-action-error", t("tasks-action-failed"));
      error.setAttribute("role", "alert"); target.append(error);
    }
  }

  private showContextMenu(id: string, x: number, y: number): void {
    this.contextMenu?.remove();
    const doc = this.window.document as Document & { createXULElement?(name: string): Element };
    const native = Boolean(doc.createXULElement);
    const menu = native ? doc.createXULElement!("menupopup") : this.element("div", "km-task-context-menu");
    this.contextMenu = menu;
    const selected = this.tasks.filter(task => this.selection.has(task.id));
    const add = (key: string, action: ImportTaskAction, enabled = true) => {
      const item = native ? doc.createXULElement!("menuitem") : this.element("button", "", t(key));
      item.setAttribute("label", t(key)); item.setAttribute("role", "menuitem");
      enabled = enabled && (action === "cancel" || action === "delete" || selected.every(task => task.kind !== "item" || task.embedding?.active !== false || task.processing?.parseTaskID && task.embedding.status === "completed"));
      if (!enabled) item.setAttribute("disabled", "true");
      item.addEventListener(native ? "command" : "click", () => {
        if (!enabled) return;
        menu.remove(); this.contextMenu = undefined;
        void this.runSelectionAction(selected.map(task => task.id), action);
      }); menu.append(item);
    };
    const syncing = selected.filter(task => task.kind === "folder" && task.mode === "sync");
    if (syncing.length === selected.length) {
      add("tasks-pause-sync", "pause"); add("tasks-resume-sync", "resume");
      if (selected.some(task => this.status(task) === "attention")) add("tasks-retry", "retry");
    }
    else {
      add("tasks-retry", "retry", selected.every(task => ["failed", "partial", "cancelled", "attention", "retrying"].includes(this.status(task)) && !(task.kind === "item" && task.errorCode === "ambiguous")));
      add("tasks-cancel", "cancel", selected.some(task => ["queued", "parsing", "publishing", "retrying", "attention", "paused"].includes(this.status(task))));
      if (selected.length === 1 && selected[0].kind === "item" && selected[0].errorCode === "ambiguous") add("parse-recover", "recover");
    }
    add("tasks-delete-record", "delete", selected.every(task => (task.kind === "folder" && task.mode === "sync") || ["completed", "partial", "failed", "cancelled"].includes(this.status(task))));
    menu.addEventListener("popuphidden", () => { menu.remove(); if (this.contextMenu === menu) this.contextMenu = undefined; }, { once: true });
    (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(menu);
    if (native) (menu as Element & { openPopupAtScreen(x: number, y: number, context: boolean): void }).openPopupAtScreen(x + this.window.screenX, y + this.window.screenY, true);
    else { (menu as HTMLElement).style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:1000`; menu.setAttribute("role", "menu"); }
    this.selected = id;
  }

  private async runSelectionAction(ids: string[], action: ImportTaskAction): Promise<void> {
    const selected = new Set(ids);
    for (const id of ids) {
      const task = this.tasks.find(task => task.id === id);
      if (task?.kind === "item" && task.parentID && selected.has(task.parentID)) continue;
      await this.runAction(id, action);
    }
  }

  private async runAction(taskID: string, action: ImportTaskAction): Promise<void> {
    if (this.disposed || this.pendingActions.has(taskID) || !this.source?.runAction) return;
    const value = action === "recover" ? this.window.prompt(t("parse-recover-prompt"), "") : undefined;
    if (action === "recover" && !value) return;
    this.pendingActions.add(taskID); this.actionErrors.delete(taskID); this.renderDetails();
    try { await this.source.runAction(taskID, action, value ?? undefined); }
    catch { if (!this.disposed) this.actionErrors.add(taskID); }
    finally {
      this.pendingActions.delete(taskID);
      if (!this.disposed) this.renderDetails();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.contextMenu?.remove(); this.contextMenu = undefined;
    try { this.unsubscribe?.(); }
    catch { Zotero.debug("[ZoteroKnowledgeMCP] Task source subscription cleanup failed."); }
    this.unsubscribe = undefined;
    this.endResize?.(false);
    this.restore?.(); this.restoreInert();
    for (const surface of [this.list, this.details]) surface?.parentElement?.classList.remove("km-import-host-active");
    this.detailsPane?.dispose(); this.list?.remove();
    this.style?.remove();
  }
}
