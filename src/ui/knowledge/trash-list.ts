import { t } from "../../shared/localization";
import { adaptMethod } from "../../core/method-adapter";
import type { KnowledgeLibraryController } from "../../shared/contracts/knowledge-library";
import { knowledgeErrorMessage } from "../../shared/knowledge-errors";
import type { KnowledgeMainWindow, KnowledgeTrashObject, NativeCollectionRow, NativeListObject, NativeItemRow } from "./native-types";

const TRASH_ID = "Kknowledgemcp:trash";

export function isTrashObject(object: NativeListObject): object is KnowledgeTrashObject {
  return "knowledgeTrashID" in object;
}

export async function confirmTrashPurge(window: KnowledgeMainWindow, controller: KnowledgeLibraryController, entryIDs: string[]): Promise<void> {
  const available = new Set(controller.snapshot.trash.map(entry => entry.id));
  const ids = [...new Set(entryIDs)].filter(id => available.has(id));
  if (!ids.length) return;
  const prompt = Services.prompt;
  const flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_CANCEL + prompt.BUTTON_POS_1_DEFAULT;
  const result = prompt.confirmEx(window, t("purge-title"), t("purge-message"),
    flags, t("purge-button"), null, null, null, { value: false });
  if (result === 0) await controller.purgeTrash(ids);
}

/** Reuse Zotero's mixed item/collection list without creating native collections. */
export class KnowledgeTrashList {
  private readonly references = new Map<string, KnowledgeTrashObject>();
  private readonly adapters: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly window: KnowledgeMainWindow, private readonly controller: KnowledgeLibraryController) {
    const pane = window.ZoteroPane;
    const provider = pane.itemsView.rowProvider;
    try {
      if (provider) this.adapters.push(adaptMethod(provider, "createRow", (receiver, native, args) => {
        const row = Reflect.apply(native, receiver, args) as NativeItemRow;
        const ref = args[0] as NativeListObject;
        if (!isTrashObject(ref)) return row;
        const kind = ref.knowledgeTrashKind;
        row.getTypeLabel = () => kind === "library" ? t("library-type") : kind === "folder" ? t("folder-type") : t("document-type");
        const icons = window.require?.("components/icons");
        if (icons && kind !== "folder") row.getIcon = () => {
          const icon = kind === "library" ? icons.getCSSIcon("km-knowledge") : icons.getCSSItemTypeIcon("document");
          icon.classList.add("icon-item-type"); return icon;
        };
        return row;
      }));
      if (typeof Reflect.get(pane, "onItemTreeActivate") === "function") this.adapters.push(adaptMethod(pane, "onItemTreeActivate", (receiver, native, args) => {
        if (pane.getCollectionTreeRows().some(row => row.id === TRASH_ID) && this.selectedEntryIDs().length) return;
        return Reflect.apply(native, receiver, args);
      }));
      const itemPane = pane.itemPane;
      if (itemPane) this.adapters.push(adaptMethod(itemPane, "updateItemPaneButtons", (receiver, native, args) => {
        const result = Reflect.apply(native, receiver, args);
        if (!pane.getCollectionTreeRows().some(row => row.id === TRASH_ID) || !this.selectedEntryIDs().length) return result;
        itemPane.getCurrentPane().renderCustomHead(({ doc, append }) => {
          const button = doc.createXULElement("button"); button.classList.add("item-restore-button");
          button.setAttribute("label", t("restore-items")); button.setAttribute("data-knowledgemcp", "restore-trash");
          button.addEventListener("command", () => { void this.restoreSelected(); }); append(button);
          const remove = doc.createXULElement("button"); remove.classList.add("item-delete-button");
          remove.setAttribute("label", t("purge-items")); remove.setAttribute("data-knowledgemcp", "purge-trash");
          remove.addEventListener("command", () => { void this.purgeSelected(); }); append(remove);
        });
        return result;
      }));
    } catch (error) { this.dispose(); throw error; }
  }

  selectedEntryIDs(): string[] {
    const selected = this.window.ZoteroPane.itemsView.getSelectedObjects?.() ?? [];
    if (!selected.length) return [];
    const entries = this.controller.snapshot.trash;
    const ids = new Set<string>();
    const entriesByResource = new Map<string, string[]>();
    for (const entry of entries) if (entry.kind === "item") for (const resourceID of entry.resourceIDs) {
      const matches = entriesByResource.get(resourceID) ?? [];
      matches.push(entry.id); entriesByResource.set(resourceID, matches);
    }
    const resourceByIdentity = new Map(this.controller.snapshot.trashedResources.map(resource =>
      [JSON.stringify([resource.nativeLibraryID, resource.itemID, resource.itemKey]), resource.id]));
    for (const object of selected) {
      if (isTrashObject(object)) {
        if (!object.knowledgeTrashResourceID) { ids.add(object.knowledgeTrashID); continue; }
        for (const id of entriesByResource.get(object.knowledgeTrashResourceID) ?? []) ids.add(id);
      } else {
        const resourceID = resourceByIdentity.get(JSON.stringify([object.libraryID, object.id, object.key]));
        if (resourceID) for (const id of entriesByResource.get(resourceID) ?? []) ids.add(id);
      }
    }
    return [...ids];
  }

  async restoreSelected(): Promise<void> {
    if (this.disposed) return;
    try { await this.controller.restoreTrash(this.selectedEntryIDs()); }
    catch (error) { if (!this.disposed && !this.window.closed) this.window.alert(knowledgeErrorMessage(error)); }
  }

  async purgeSelected(all = false): Promise<void> {
    if (this.disposed) return;
    try { await confirmTrashPurge(this.window, this.controller, all ? this.controller.snapshot.trash.map(entry => entry.id) : this.selectedEntryIDs()); }
    catch (error) { if (!this.disposed && !this.window.closed) this.window.alert(knowledgeErrorMessage(error)); }
  }

  objects(row: NativeCollectionRow, nativeItems: ZoteroItem[], unfiltered: boolean): NativeListObject[] {
    if (this.disposed) return [];
    const snapshot = this.controller.snapshot;
    const resourcesByID = new Map(snapshot.trashedResources.map(resource => [resource.id, resource]));
    const current = new Set(snapshot.trash.map(entry => entry.id));
    for (const id of this.references.keys()) if (!current.has(id)) this.references.delete(id);
    const result: NativeListObject[] = [...nativeItems];
    const missing = new Set<string>();
    const itemFilters = !unfiltered && (row.advancedSearch || row.tags?.size);
    const words = unfiltered ? [] : row.searchText?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    for (const entry of snapshot.trash) {
      if (entry.kind === "item") {
        const resourceID = entry.resourceIDs[0];
        const resource = resourcesByID.get(resourceID);
        const item = resource?.itemID ? Zotero.Items.get(resource.itemID) : false;
        if (resource && resource.state === "current" && item && !item.deleted && item.key === resource.itemKey && item.libraryID === resource.nativeLibraryID) continue;
        if (missing.has(resourceID)) continue;
        missing.add(resourceID);
      }
      // Native Trash also hides non-item rows when item-only filters are active.
      if (itemFilters) continue;
      const title = entry.kind === "item" ? resourcesByID.get(entry.resourceIDs[0])?.title ?? entry.name : entry.name;
      if (words.length) {
        const normalized = title.toLowerCase();
        if (words.some(word => !normalized.includes(word))) continue;
      }
      let reference = this.references.get(entry.id);
      if (!reference) {
        reference = new Zotero.Collection!() as KnowledgeTrashObject;
        reference.libraryID = Zotero.Libraries!.userLibraryID;
        reference.name = title; reference.deleted = true;
        const id = `Kknowledgemcp:trash-object:${entry.id}`;
        Object.defineProperties(reference, { id: { value: id }, treeViewID: { value: id }, knowledgeTrashID: { value: entry.id },
          knowledgeTrashKind: { value: entry.kind },
          knowledgeTrashResourceID: { value: entry.kind === "item" ? entry.resourceIDs[0] : undefined } });
        // Zotero normally appends collection rows after filtering native items.
        // Our mixed source enters earlier, so supply the item-query safe defaults.
        for (const method of ["isEmbeddedImageAttachment", "isRegularItem", "isAttachment", "isNote", "isAnnotation"]) {
          Object.defineProperty(reference, method, { value: () => false });
        }
        Object.defineProperty(reference, "getField", { value: (field: string) => field === "title" ? reference!.name : "" });
        Object.defineProperty(reference, "getItemLastRead", { value: () => null });
        // These are unsaved display references. Native commands must never persist them.
        for (const method of ["save", "saveTx", "erase", "eraseTx"]) Object.defineProperty(reference, method, {
          value: () => Promise.reject(new Error("Use the knowledge Trash restore action."))
        });
        this.references.set(entry.id, reference);
      }
      reference.name = title;
      result.push(reference);
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    for (const restore of this.adapters.splice(0).reverse()) restore();
    this.references.clear();
    const pane = this.window.ZoteroPane;
    try { if (!this.window.closed) pane?.itemPane?.updateItemPaneButtons(); }
    catch { Zotero.debug("[ZoteroKnowledgeMCP] Trash controls refresh skipped for a detached pane."); }
  }
}
