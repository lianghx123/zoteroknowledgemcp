import { t } from "../../shared/localization";
import { adaptMethod } from "../../core/method-adapter";
import { KnowledgeDragDrop } from "./drag-drop";
import { KnowledgeTrashList } from "./trash-list";
import { ImportTasksView, IMPORT_TASKS_ROW_ID } from "./import-tasks";
import type { ImportTaskSource } from "./import-task-model";
import { searchKnowledgeScope } from "./search-scope";
import { indexFolders } from "./folder-index";
import { resourceIDsAt, type KnowledgeLibraryController, type KnowledgeTarget } from "../../shared/contracts/knowledge-library";
import type { KnowledgeMainWindow, NativeCollectionRow, NativeSearch, NativeCollectionView } from "./native-types";

interface KnowledgeRow { id: string; name: string; level: number; target?: KnowledgeTarget; parent?: string; trash?: boolean }
const PREFIX = "Kknowledgemcp:";
const EXPANSION_PREF = "extensions.zotero.knowledgemcp.treeExpansion";

function readExpansion(): { open: string[]; knownLibraries: string[] } | undefined {
  try {
    const value: unknown = JSON.parse(String(Zotero.Prefs?.get(EXPANSION_PREF, true)));
    if (value && typeof value === "object" && "open" in value && "knownLibraries" in value
      && Array.isArray(value.open) && Array.isArray(value.knownLibraries)
      && [...value.open, ...value.knownLibraries].every(id => typeof id === "string" && id.startsWith(PREFIX))) {
      return { open: value.open, knownLibraries: value.knownLibraries };
    }
  } catch { /* Missing or invalid preferences use the first-run defaults. */ }
  return undefined;
}

export function isKnowledgeRow(row: NativeCollectionRow | undefined): boolean { return Boolean(row?.id.startsWith(PREFIX)); }
export function isKnowledgeTrashRow(row: NativeCollectionRow | undefined): boolean { return Boolean(row?.id.startsWith(`${PREFIX}trash`)); }

export class KnowledgeLibraryTree {
  private readonly disposeAdapters: Array<() => void> = [];
  private readonly expansion = readExpansion();
  private readonly open = new Set<string>(this.expansion?.open ?? [`${PREFIX}overview`]);
  private readonly knownLibraries = new Set<string>(this.expansion?.knownLibraries);
  private rows: KnowledgeRow[] = [];
  private rowsByID = new Map<string, KnowledgeRow>();
  private containers = new Set<string>();
  private combined: { id: string; row: NativeCollectionRow } | undefined;
  private disposed = false;
  private refreshing = false;
  private dirty = false;
  private refreshItems = false;
  private readonly dragDrop: KnowledgeDragDrop;
  private readonly trashList: KnowledgeTrashList;
  private readonly tasksView: ImportTasksView;
  private readonly view: NativeCollectionView;

  constructor(private readonly window: KnowledgeMainWindow, private readonly controller: KnowledgeLibraryController,
    private readonly remove: (target: KnowledgeTarget) => void, add: (ids: number[], target: KnowledgeTarget) => Promise<void>, tasks?: ImportTaskSource) {
    const view = window.ZoteroPane.collectionsView;
    this.view = view;
    try {
      this.trashList = new KnowledgeTrashList(window, controller);
      this.tasksView = new ImportTasksView(window, () => { void this.refresh(false).catch(() => {
        Zotero.debug("[ZoteroKnowledgeMCP] Import task navigation refresh failed.");
      }); }, tasks);
      const wrap = (key: string, handler: Parameters<typeof adaptMethod>[2]) => { this.disposeAdapters.push(adaptMethod(view, key, handler)); };
      wrap("refresh", async (receiver, native, args) => {
        const result = await Reflect.apply(native, receiver, args);
        if (!this.disposed) this.insert();
        return result;
      });
      wrap("getIconName", (receiver, native, args) => {
        const row = view.getRow(args[0] as number);
        if (row?.id === `${PREFIX}trash`) return controller.snapshot.trash.length ? "trash-full" : "trash";
        if (row?.id === IMPORT_TASKS_ROW_ID) return "km-import-tasks";
        return isKnowledgeRow(row) ? row.level <= 1 ? "km-knowledge" : "collection" : Reflect.apply(native, receiver, args);
      });
      wrap("isContainerEmpty", (receiver, native, args) => {
        const row = view.getRow(args[0] as number);
        return isKnowledgeRow(row) ? !this.containers.has(row.id) : Reflect.apply(native, receiver, args);
      });
      wrap("toggleOpenState", async (receiver, native, args) => {
        const row = view.getRow(args[0] as number);
        if (!isKnowledgeRow(row)) return Reflect.apply(native, receiver, args);
        if (this.open.has(row.id)) this.open.delete(row.id); else this.open.add(row.id);
        this.saveExpansion();
        const changed = this.insert(row.id); view.tree.invalidate();
        if (changed) await pane.onCollectionSelected();
      });
      wrap("_closeContainer", (receiver, native, args) => {
        const row = view.getRow(args[0] as number);
        if (!isKnowledgeRow(row)) return Reflect.apply(native, receiver, args);
        this.open.delete(row.id);
        this.saveExpansion();
        const changed = this.insert(row.id); view.tree.invalidate();
        if (changed) void pane.onCollectionSelected().catch(() => {});
      });
      wrap("selectByID", (receiver, native, args) => String(args[0]).startsWith(PREFIX) ? this.select(String(args[0])) : Reflect.apply(native, receiver, args));
      wrap("_handleSelectAll", (receiver, native, args) => {
        const selected = view.getSelectedRows();
        const definitions = selected.map(row => this.rowsByID.get(row.id));
        if (!definitions.length || definitions.some(row => !row?.target) || new Set(definitions.map(row => Boolean(row?.target?.nodeID))).size !== 1) {
          return Reflect.apply(native, receiver, args);
        }
        const parents = new Set(definitions.map(row => row!.parent));
        const ids = new Set(this.rows.filter(row => row.target && Boolean(row.target.nodeID) === Boolean(definitions[0]!.target!.nodeID) && parents.has(row.parent)).map(row => row.id));
        const suppressed = view.selection.selectEventsSuppressed;
        view.selection.selectEventsSuppressed = true;
        try { view.selection.selected = new Set(view._rows.flatMap((row, index) => ids.has(row.id) ? [index] : [])); }
        finally { view.selection.selectEventsSuppressed = suppressed; }
        return Promise.resolve();
      });
      const pane = window.ZoteroPane;
      // Zotero's pane only combines known native row types. Expose one plugin-owned
      // union scope to the pane while the collection tree retains its actual selection.
      this.disposeAdapters.push(adaptMethod(pane, "getCollectionTreeRows", (receiver, native, args) =>
        this.paneRows(Reflect.apply(native, receiver, args) as NativeCollectionRow[])));
      if (typeof Reflect.get(pane, "canRestoreSelectedItems") === "function") this.disposeAdapters.push(adaptMethod(pane, "canRestoreSelectedItems", (receiver, native, args) =>
        pane.getCollectionTreeRows().some(isKnowledgeTrashRow) ? this.selectedTrashIDs().length > 0 : Reflect.apply(native, receiver, args)));
      for (const key of ["deleteSelectedItems", "deleteSelectedCollection", "editSelectedCollection", "restoreSelectedItems", "emptyTrash", "newItem", "newCollection", "newSearch"]) {
        if (typeof Reflect.get(pane, key) !== "function") continue;
        this.disposeAdapters.push(adaptMethod(pane, key, (receiver, native, args) => {
          if (!pane.getCollectionTreeRows().some(isKnowledgeRow)) return Reflect.apply(native, receiver, args);
          const target = this.selectedTarget();
          if (key === "restoreSelectedItems" && pane.getCollectionTreeRows().some(isKnowledgeTrashRow)) return this.trashList.restoreSelected();
          if (key === "deleteSelectedItems" && pane.getCollectionTreeRows().some(isKnowledgeTrashRow)) return this.trashList.purgeSelected();
          if (key === "emptyTrash" && pane.getCollectionTreeRows().some(isKnowledgeTrashRow)) return this.trashList.purgeSelected(true);
          if (key === "deleteSelectedItems" && target) this.remove(target);
          else if (isKnowledgeTrashRow(pane.getCollectionTreeRows()[0])) return Promise.resolve();
          else window.alert(t("manage-hint"));
          return Promise.resolve();
        }));
      }
      if (typeof Reflect.get(pane.itemsView, "deleteSelection") === "function") {
        this.disposeAdapters.push(adaptMethod(pane.itemsView, "deleteSelection", (receiver, native, args) => {
          if (pane.itemsView.collectionTreeRows.some(isKnowledgeTrashRow)) return this.trashList.purgeSelected();
          if (pane.itemsView.collectionTreeRows.some(isKnowledgeRow)) return Promise.resolve();
          return Reflect.apply(native, receiver, args);
        }));
      }
      this.insert();
      if (!this.expansion) this.saveExpansion();
      this.dragDrop = new KnowledgeDragDrop(window, controller, row => {
        const target = this.rowsByID.get(row.id)?.target;
        if (target) return target;
        if (row.id === `${PREFIX}overview`) {
          const library = controller.snapshot.libraries.find(library => library.isDefault) ?? controller.snapshot.libraries[0];
          if (library) return { libraryID: library.id, nodeID: null };
        }
        return undefined;
      }, add);
      // VirtualizedTree retains callback props from CollectionTree.render().
      // Invalidate only after React commits the adapted props: VirtualizedTree's
      // old isContainerEmpty callback otherwise removes the freshly drawn arrows.
      if (!this.window.closed && !Zotero.closing) view.forceUpdate(() => {
        if (!this.disposed && !window.closed) view.tree.invalidate();
      });
    } catch (error) { this.dispose(); throw error; }
  }

  selectedTarget(): KnowledgeTarget | undefined {
    const selected = this.window.ZoteroPane.collectionsView.getSelectedRows();
    if (selected.length !== 1) return undefined;
    return this.rowsByID.get(selected[0].id)?.target;
  }

  selectedTrashIDs(): string[] {
    if (!this.window.ZoteroPane.collectionsView.getSelectedRows().some(isKnowledgeTrashRow)) return [];
    return this.trashList.selectedEntryIDs();
  }

  selectedLibraryIDs(): string[] {
    const selected = this.window.ZoteroPane.collectionsView.getSelectedRows();
    const definitions = selected.map(row => this.rowsByID.get(row.id));
    if (!definitions.length || definitions.some(row => !row || row.trash || row.id === IMPORT_TASKS_ROW_ID)) return [];
    if (definitions.some(row => row?.id === `${PREFIX}overview`)) return this.controller.snapshot.libraries.map(library => library.id);
    return [...new Set(definitions.flatMap(row => row?.target ? [row.target.libraryID] : []))];
  }

  private saveExpansion(): void {
    try { Zotero.Prefs?.set(EXPANSION_PREF, JSON.stringify({ open: [...this.open], knownLibraries: [...this.knownLibraries] }), true); }
    catch { Zotero.debug("[ZoteroKnowledgeMCP] Knowledge tree expansion could not be saved."); }
  }

  private paneRows(selected: NativeCollectionRow[]): NativeCollectionRow[] {
    if (selected.length < 2) return selected;
    const definitions = selected.map(row => this.rowsByID.get(row.id));
    if (definitions.some(row => !row?.target) || new Set(definitions.map(row => Boolean(row?.target?.nodeID))).size !== 1) return selected;
    const id = `${PREFIX}selection:${JSON.stringify(selected.map(row => row.id).sort())}`;
    if (this.combined?.id !== id) {
      const targets = definitions.map(row => row!.target!);
      const kind = targets[0].nodeID ? "folders" : "libraries";
      this.combined = { id, row: this.createRow({ id, name: `${selected.length} knowledge ${kind} selected`, level: 0 }, targets) };
    }
    return [this.combined.row];
  }

  private definitions(): KnowledgeRow[] {
    const root = `${PREFIX}overview`;
    const result: KnowledgeRow[] = [{ id: root, name: t("tree-root"), level: 0 }];
    const folders = indexFolders(this.controller.snapshot.folders);
    for (const library of this.controller.snapshot.libraries) {
      const id = `${PREFIX}library:${library.id}`;
      if (library.isDefault && !this.knownLibraries.has(id)) this.open.add(id);
      this.knownLibraries.add(id);
      result.push({ id, name: library.name, level: 1, parent: root, target: { libraryID: library.id, nodeID: null } });
      const visit = (parentID: string | null, parent: string, depth: number, seen: Set<string>) => {
        for (const folder of folders.get(library.id)?.get(parentID) ?? []) {
          if (seen.has(folder.id) || depth > 64) continue;
          const childID = `${PREFIX}folder:${folder.id}`;
          result.push({ id: childID, name: folder.name, level: depth, parent, target: { libraryID: library.id, nodeID: folder.id } });
          visit(folder.id, childID, depth + 1, new Set([...seen, folder.id]));
        }
      };
      visit(null, id, 2, new Set());
    }
    const trash = `${PREFIX}trash`;
    result.push({ id: IMPORT_TASKS_ROW_ID, name: `${t("tasks-title")}${this.tasksView.activeCount ? ` · ${this.tasksView.activeCount}` : ""}`, level: 1, parent: root });
    result.push({ id: trash, name: t("trash"), level: 1, parent: root, trash: true });
    return result;
  }

  private rebuildRows(): void {
    this.rows = this.definitions();
    this.rowsByID = new Map(this.rows.map(row => [row.id, row]));
    this.containers = new Set(this.rows.flatMap(row => row.parent ? [row.parent] : []));
  }

  private insert(fallbackID?: string): boolean {
    if (this.disposed) return false;
    this.rebuildRows();
    const view = this.window.ZoteroPane.collectionsView;
    const selection = view.selection;
    const selectedIDs = new Set(view.getSelectedRows().map(row => row.id));
    const focusedID = view._rows[selection.focused]?.id;
    const pivotID = view._rows[selection.pivot]?.id;
    view._rows = view._rows.filter(row => !isKnowledgeRow(row));
    const visible = new Set<string>();
    for (const definition of this.rows) {
      if (definition.parent && (!visible.has(definition.parent) || !this.open.has(definition.parent))) continue;
      visible.add(definition.id);
      view._rows.push(this.createRow(definition));
    }
    view._refreshRowMap();
    const indices = new Map(view._rows.map((row, index) => [row.id, index]));
    const selectedIndices = view._rows.flatMap((row, index) => selectedIDs.has(row.id) ? [index] : []);
    const fallbackIndex = fallbackID ? indices.get(fallbackID) : undefined;
    if (!selectedIndices.length && selectedIDs.size && fallbackIndex !== undefined) selectedIndices.push(fallbackIndex);
    // Match Zotero's own index-remapping methods: updating these fields directly
    // preserves multi-selection without emitting a selection event or scrolling.
    // Releasing selectEventsSuppressed would itself emit an event in Zotero.
    selection.selected = new Set(selectedIndices);
    selection.focused = (focusedID ? indices.get(focusedID) : undefined) ?? selectedIndices[0] ?? fallbackIndex ?? 0;
    selection.pivot = (pivotID ? indices.get(pivotID) : undefined) ?? selection.focused;
    return selectedIndices.length !== selectedIDs.size || selectedIndices.some(index => !selectedIDs.has(view._rows[index].id));
  }

  private createRow(definition: KnowledgeRow, targets?: KnowledgeTarget[]): NativeCollectionRow {
    const row = new Zotero.CollectionTreeRow!(this.window.ZoteroPane.collectionsView, "knowledgemcp", { libraryID: Zotero.Libraries!.userLibraryID,
      name: definition.name, treeViewID: definition.id }, definition.level, this.open.has(definition.id));
    Object.defineProperties(row, { id: { value: definition.id }, editable: { value: false }, filesEditable: { value: false } });
    row.isContainer = () => this.containers.has(definition.id);
    row.setAdvancedSearch = search => { row.advancedSearch = search; row.clearCache(); };
    row.getSearchResults = async (asTempTable = false, options = {}) => {
      const ids = await this.itemsFor(definition, row, options.unfiltered ?? false, targets);
      return asTempTable ? Zotero.Search!.idsToTempTable(ids) : ids;
    };
    row.getItems = async options => {
      const ids = await this.itemsFor(definition, row, options?.unfiltered ?? false, targets);
      const items = await Promise.all(ids.map(id => Zotero.Items.getAsync!(id)));
      const available = items.filter((item): item is ZoteroItem => Boolean(item));
      return definition.trash ? this.trashList.objects(row, available, options?.unfiltered ?? false) : available;
    };
    return row;
  }

  private async itemsFor(definition: KnowledgeRow, row: NativeCollectionRow, unfiltered: boolean, targets?: KnowledgeTarget[]): Promise<number[]> {
    if (this.disposed || definition.id === IMPORT_TASKS_ROW_ID) return [];
    const snapshot = this.controller.snapshot;
    const trash = definition.trash;
    const allowed = trash ? new Set(snapshot.trash.filter(entry => row.knowledgeRetrieval || entry.kind === "item").flatMap(entry => entry.resourceIDs))
      : targets ? new Set(targets.flatMap(target => [...resourceIDsAt(snapshot, target)])) : resourceIDsAt(snapshot, definition.target);
    const groups = new Map<number, number[]>();
    for (const resource of trash ? snapshot.trashedResources : snapshot.resources) {
      if (!allowed.has(resource.id) || resource.state !== "current" || resource.itemID === null) continue;
      const item = Zotero.Items.get(resource.itemID);
      if (!item || item.deleted || item.key !== resource.itemKey || item.libraryID !== resource.nativeLibraryID) continue;
      const ids = groups.get(item.libraryID) ?? []; ids.push(item.id); groups.set(item.libraryID, ids);
    }
    const result: number[] = [];
    for (const [libraryID, ids] of groups) {
      let search: NativeSearch;
      if (!unfiltered && row.advancedSearch) search = row.advancedSearch.clone(libraryID);
      else { search = new Zotero.Search!(); search.libraryID = libraryID; }
      if (!unfiltered) {
        const mode = ["fields", "titleCreatorYear", "titleCreatorYearNote", "everything"].includes(row.searchMode) ? row.searchMode : "fields";
        if (row.searchText && !row.advancedSearch) search.addCondition(`quicksearch-${mode}`, "contains", row.searchText);
        for (const tag of row.tags ?? []) search.addCondition("tag", "is", tag);
      }
      // Intersection guards against an unexpected native search expansion.
      const permitted = new Set(ids);
      for (const id of await searchKnowledgeScope(search, libraryID, ids)) if (permitted.has(id)) result.push(id);
    }
    return this.disposed ? [] : result;
  }

  async select(id: string): Promise<boolean> {
    const view = this.window.ZoteroPane.collectionsView;
    this.rebuildRows();
    const definition = this.rowsByID.get(id);
    if (!definition || this.disposed) return false;
    let parent = definition.parent;
    while (parent) { this.open.add(parent); parent = this.rowsByID.get(parent)?.parent; }
    this.saveExpansion();
    this.insert(); view.tree.invalidate();
    await view.selectWait(view._rows.findIndex(row => row.id === id));
    return true;
  }

  async refresh(refreshItems = true): Promise<void> {
    if (this.disposed) return;
    this.refreshItems ||= refreshItems;
    if (this.refreshing) { this.dirty = true; return; }
    this.refreshing = true;
    try {
      do {
        this.dirty = false;
        const refreshItems = this.refreshItems; this.refreshItems = false;
        const changed = this.insert(`${PREFIX}overview`);
        this.window.ZoteroPane.collectionsView.tree.invalidate();
        if (changed) await this.window.ZoteroPane.onCollectionSelected();
        else if (refreshItems && this.window.ZoteroPane.itemsView.collectionTreeRows.some(isKnowledgeRow)) await this.window.ZoteroPane.itemsView.refreshAndMaintainSelection();
      } while (this.dirty && !this.disposed);
    } finally { this.refreshing = false; }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.combined = undefined;
    for (const dispose of [() => this.tasksView?.dispose(), () => this.dragDrop?.dispose(), () => this.trashList?.dispose(),
      ...this.disposeAdapters.splice(0).reverse()]) {
      try { dispose(); } catch { Zotero.debug("[ZoteroKnowledgeMCP] Native tree cleanup skipped a detached surface."); }
    }
    const view = this.view;
    try {
      const customSelected = view.getSelectedRows().some(isKnowledgeRow);
      view._rows = view._rows.filter(row => !isKnowledgeRow(row)); view._refreshRowMap();
      view.forceUpdate(() => {
        try { if (!this.window.closed) view.tree.invalidate(); }
        catch { Zotero.debug("[ZoteroKnowledgeMCP] Native tree redraw skipped during cleanup."); }
      });
      if (customSelected && !this.window.closed && !Zotero.closing && this.window.ZoteroPane?.collectionsView === view)
        void view.selectByID(`L${Zotero.Libraries!.userLibraryID}`).catch(() => {});
    } catch { Zotero.debug("[ZoteroKnowledgeMCP] Native tree redraw skipped during cleanup."); }
  }
}
