import { adaptMethod } from "../../core/method-adapter";
import { knowledgeErrorMessage } from "../../shared/knowledge-errors";
import { resourceIDsAt, type KnowledgeLibraryController, type KnowledgeTarget } from "../../shared/contracts/knowledge-library";
import type { KnowledgeMainWindow, NativeCollectionRow, NativeDropEvent } from "./native-types";

const isKnowledge = (row?: NativeCollectionRow | null) => Boolean(row?.id.startsWith("Kknowledgemcp:"));
const isTrash = (row?: NativeCollectionRow | null) => row?.id === "Kknowledgemcp:trash";
const FOLDER_TYPE = "application/x-zotero-knowledge-folders";
type TrashDrop = { kind: "items"; ids: number[]; libraries: string[] } | { kind: "folders"; targets: KnowledgeTarget[] };

/** Keep knowledge membership copies separate from Zotero's native item/collection copies. */
export class KnowledgeDragDrop {
  private readonly adapters: Array<() => void> = [];
  private disposed = false;
  private knowledgeHover = false;
  private folderSource: NativeCollectionRow | undefined;

  constructor(private readonly window: KnowledgeMainWindow, private readonly controller: KnowledgeLibraryController,
    private readonly targetFor: (row: NativeCollectionRow) => KnowledgeTarget | undefined,
    private readonly add: (ids: number[], target: KnowledgeTarget) => Promise<void>) {
    const view = window.ZoteroPane.collectionsView;
    const items = window.ZoteroPane.itemsView;
    try {
      const wrap = (object: object, key: string, handler: Parameters<typeof adaptMethod>[2]) => {
        if (typeof Reflect.get(object, key) === "function") this.adapters.push(adaptMethod(object, key, handler));
      };
      // Virtualized rows can retain an earlier dragend callback across addon reloads.
      const endFolderDrag = () => this.clearFolderSource();
      window.document?.addEventListener("dragend", endFolderDrag, true);
      this.adapters.push(() => window.document?.removeEventListener("dragend", endFolderDrag, true));
      wrap(view, "onDragStart", (receiver, native, args) => {
        const result = Reflect.apply(native, receiver, args);
        const [event, index] = args as [NativeDropEvent, number];
        const row = view.getRow(index);
        if (!row?.id.startsWith("Kknowledgemcp:folder:")) return result;
        const rows = view.getSelectedRows();
        const targets = rows.map(candidate => this.targetFor(candidate));
        if (!rows.some(candidate => candidate.id === row.id) || !targets.length || targets.some(target => !target?.nodeID)) return result;
        event.dataTransfer.setData(FOLDER_TYPE, JSON.stringify(targets.map(target => target!.nodeID)));
        event.dataTransfer.effectAllowed = "move";
        this.folderSource = row;
        if (Zotero.DragDrop) Zotero.DragDrop.currentDragSource = row;
        return result;
      });
      wrap(view, "onDragEnd", (receiver, native, args) => {
        try { return Reflect.apply(native, receiver, args); }
        finally { this.clearFolderSource(); }
      });
      wrap(view, "canDropCheck", (receiver, native, args) => {
        const [index, orientation, transfer] = args as [number, number, DataTransfer];
        const row = view.getRow(index);
        if (isTrash(row)) return orientation === 0 && Boolean(this.trashDrop(transfer));
        if (transfer.types?.includes(FOLDER_TYPE)) return false;
        if (isKnowledge(row)) return orientation === 0 && this.canAdd(transfer, this.targetFor(row));
        if (this.fromKnowledge(transfer) && (orientation !== 0 || !this.nativeTarget(row))) return false;
        return Reflect.apply(native, receiver, args);
      });
      wrap(view, "canDropCheckAsync", (receiver, native, args) => {
        const [index, orientation, transfer] = args as [number, number, DataTransfer];
        if (isKnowledge(view.getRow(index))) return Promise.resolve(view.canDropCheck(index, orientation, transfer));
        if (transfer.types?.includes(FOLDER_TYPE)) return Promise.resolve(false);
        if (this.fromKnowledge(transfer) && !view.canDropCheck(index, orientation, transfer)) return Promise.resolve(false);
        return Reflect.apply(native, receiver, args);
      });
      wrap(view, "onDragOver", (receiver, native, args) => {
        const result = Reflect.apply(native, receiver, args);
        const [event, index] = args as [NativeDropEvent, number];
        const row = view.getRow(index);
        this.knowledgeHover = isKnowledge(row);
        if (isKnowledge(row)) {
          const effect = Zotero.DragDrop?.currentOrientation === 0 ? this.effectFor(event.dataTransfer, row) : "none";
          view.setDropEffect(event, effect);
          const dropRow = effect === "none" ? null : index;
          if (view._dropRow !== dropRow) { view._dropRow = dropRow; view.tree.invalidate(); }
        }
        return result;
      });
      wrap(view, "onDrop", async (receiver, native, args) => {
        const [event, index] = args as [NativeDropEvent, number];
        const row = view.getRow(index);
        if (isKnowledge(row)) {
          if (Zotero.DragDrop?.currentOrientation !== 0) return;
          if (isTrash(row)) return this.dropIntoTrash(event);
          return this.drop(event, this.targetFor(row));
        }
        if (event.dataTransfer.types?.includes(FOLDER_TYPE)) return;
        if (this.fromKnowledge(event.dataTransfer)) {
          if (!view.canDropCheck(index, Zotero.DragDrop?.currentOrientation ?? 0, event.dataTransfer)) return;
          this.copyEffect(event);
        }
        return Reflect.apply(native, receiver, args);
      });

      const currentRow = () => items.collectionTreeRows.length === 1 ? items.collectionTreeRows[0] : undefined;
      wrap(items, "canDropCheck", (receiver, native, args) => {
        const transfer = args[2] as DataTransfer;
        const row = currentRow();
        if (isTrash(row)) return Boolean(this.trashDrop(transfer));
        if (transfer.types?.includes(FOLDER_TYPE)) return false;
        if (isKnowledge(row)) return this.canAdd(transfer, this.targetFor(row!));
        if (items.collectionTreeRows.some(isKnowledge)) return false;
        if (this.fromKnowledge(transfer)) {
          const index = row && view._rows.findIndex(candidate => candidate.id === row.id);
          return index !== undefined && index >= 0 && this.nativeTarget(row) && view.canDropCheck(index, 0, transfer);
        }
        return Reflect.apply(native, receiver, args);
      });
      wrap(items, "onDragOver", (receiver, native, args) => {
        const result = Reflect.apply(native, receiver, args);
        const row = currentRow();
        if (isKnowledge(row)) {
          const event = args[0] as NativeDropEvent;
          items.setDropEffect(event, this.effectFor(event.dataTransfer, row!));
        }
        return result;
      });
      wrap(items, "onDrop", async (receiver, native, args) => {
        const event = args[0] as NativeDropEvent;
        const row = currentRow();
        if (isTrash(row)) return this.dropIntoTrash(event);
        if (event.dataTransfer.types?.includes(FOLDER_TYPE)) return;
        if (isKnowledge(row)) return this.drop(event, this.targetFor(row!));
        if (items.collectionTreeRows.some(isKnowledge)) return;
        if (this.fromKnowledge(event.dataTransfer)) {
          const index = row && view._rows.findIndex(candidate => candidate.id === row.id);
          if (index === undefined || index < 0 || !this.nativeTarget(row) || !view.canDropCheck(index, 0, event.dataTransfer)) return;
          // Copy to the container through Zotero, never reparent onto the item under the pointer.
          Zotero.DragDrop!.currentOrientation = 0;
          this.copyEffect(event);
          return view.onDrop(event, index);
        }
        return Reflect.apply(native, receiver, args);
      });
    } catch (error) { this.dispose(); throw error; }
  }

  private fromKnowledge(transfer: DataTransfer): boolean {
    return isKnowledge(Zotero.DragDrop?.getDragSource(transfer) ?? Zotero.DragDrop?.currentDragSource);
  }

  private nativeTarget(row?: NativeCollectionRow): boolean { return Boolean(row && (row.isCollection() || row.isLibrary(true))); }

  private effectFor(transfer: DataTransfer, row: NativeCollectionRow): "copy" | "move" | "none" {
    if (isTrash(row)) return this.trashDrop(transfer) ? "move" : "none";
    return this.canAdd(transfer, this.targetFor(row)) ? "copy" : "none";
  }

  private sourceScope(source: NativeCollectionRow): { libraries: string[]; resources: Set<string> } | undefined {
    const snapshot = this.controller.snapshot;
    if (source.id === "Kknowledgemcp:overview") return { libraries: snapshot.libraries.map(library => library.id), resources: resourceIDsAt(snapshot) };
    let ids: unknown = [source.id];
    if (source.id.startsWith("Kknowledgemcp:selection:")) {
      try { ids = JSON.parse(source.id.slice("Kknowledgemcp:selection:".length)); } catch { return; }
    }
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string")) return;
    const targets = ids.map(id => {
      const library = snapshot.libraries.find(library => id === `Kknowledgemcp:library:${library.id}`);
      if (library) return { libraryID: library.id, nodeID: null };
      const folder = snapshot.folders.find(folder => id === `Kknowledgemcp:folder:${folder.id}`);
      return folder ? { libraryID: folder.libraryID, nodeID: folder.id } : undefined;
    });
    if (targets.some(target => !target)) return;
    return { libraries: [...new Set(targets.map(target => target!.libraryID))],
      resources: new Set(targets.flatMap(target => [...resourceIDsAt(snapshot, target)])) };
  }

  private trashDrop(transfer: DataTransfer): TrashDrop | undefined {
    if (this.disposed) return;
    const source = Zotero.DragDrop?.getDragSource(transfer) ?? Zotero.DragDrop?.currentDragSource;
    if (!source || !isKnowledge(source) || isTrash(source)) return;
    const snapshot = this.controller.snapshot;
    if (transfer.types?.includes(FOLDER_TYPE)) {
      let ids: unknown;
      try { ids = JSON.parse(transfer.getData(FOLDER_TYPE)); } catch { return; }
      if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string")
        || !ids.some(id => source.id === `Kknowledgemcp:folder:${id}`)) return;
      const folders = [...new Set(ids)].map(id => snapshot.folders.find(folder => folder.id === id));
      if (folders.some(folder => !folder || !snapshot.libraries.some(library => library.id === folder.libraryID))) return;
      return { kind: "folders", targets: folders.map(folder => ({ libraryID: folder!.libraryID, nodeID: folder!.id })) };
    }
    const scope = this.sourceScope(source);
    if (!scope?.libraries.length) return;
    const data = Zotero.DragDrop?.getDataFromDataTransfer(transfer);
    if (!data || data.dataType !== "zotero/item" || !Array.isArray(data.data)) return;
    const ids = [...new Set(data.data)].filter((id): id is number => {
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return false;
      const resourceID = snapshot.itemResources.get(id);
      const item = Zotero.Items.get(id);
      return Boolean(resourceID && scope.resources.has(resourceID) && item && !item.deleted && (item.isRegularItem() || item.isAttachment()));
    });
    return ids.length ? { kind: "items", ids, libraries: scope.libraries } : undefined;
  }

  private async dropIntoTrash(event: NativeDropEvent): Promise<void> {
    const drop = this.trashDrop(event.dataTransfer);
    this.finishDrop(event);
    if (!drop) return;
    event.dataTransfer.dropEffect = "move";
    try {
      if (drop.kind === "items") await this.controller.moveToTrash(drop.ids, drop.libraries);
      else await this.controller.deleteFolders(drop.targets);
    } catch (error) { if (!this.disposed && !this.window.closed) this.window.alert(knowledgeErrorMessage(error)); }
    finally { this.clearFolderSource(); }
  }

  private clearFolderSource(): void {
    if (this.folderSource && Zotero.DragDrop?.currentDragSource === this.folderSource) Zotero.DragDrop.currentDragSource = null;
    this.folderSource = undefined;
  }

  candidates(transfer: DataTransfer, target?: KnowledgeTarget): number[] {
    if (this.disposed || !target || !this.controller.snapshot.libraries.some(library => library.id === target.libraryID)
      || (target.nodeID && !this.controller.snapshot.folders.some(folder => folder.id === target.nodeID && folder.libraryID === target.libraryID))) return [];
    const data = Zotero.DragDrop?.getDataFromDataTransfer(transfer);
    if (!data || data.dataType !== "zotero/item" || !Array.isArray(data.data)) return [];
    const source = Zotero.DragDrop?.getDragSource(transfer) ?? Zotero.DragDrop?.currentDragSource;
    if (source?.isTrash() || source?.id.startsWith("Kknowledgemcp:trash")) return [];
    const existing = resourceIDsAt(this.controller.snapshot, target);
    return [...new Set(data.data)].filter((id): id is number => {
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return false;
      const item = Zotero.Items.get(id);
      if (!item || item.deleted || item.parentItemID || (!item.isRegularItem() && !item.isAttachment())) return false;
      const library = Zotero.Libraries?.get(item.libraryID);
      if (!library || !["user", "group"].includes(library.libraryType)) return false;
      const resourceID = this.controller.snapshot.itemResources.get(id);
      return !resourceID || !existing.has(resourceID);
    });
  }

  private canAdd(transfer: DataTransfer, target?: KnowledgeTarget): boolean { return this.candidates(transfer, target).length > 0; }

  private copyEffect(event: NativeDropEvent): void {
    event.dataTransfer.dropEffect = "copy";
    if (Zotero.DragDrop) Zotero.DragDrop.currentDropEffect = "copy";
  }

  private async drop(event: NativeDropEvent, target?: KnowledgeTarget): Promise<void> {
    const ids = this.candidates(event.dataTransfer, target);
    this.finishDrop(event);
    if (!target || !ids.length) return;
    event.dataTransfer.dropEffect = "copy";
    try { await this.add(ids, target); }
    catch (error) { if (!this.disposed && !this.window.closed) this.window.alert(knowledgeErrorMessage(error)); }
  }

  private finishDrop(event: NativeDropEvent): void {
    event.preventDefault(); event.stopPropagation();
    const view = this.window.ZoteroPane.collectionsView;
    clearTimeout(view._expandRowOnHoverTimer);
    view._expandRowOnHoverTimer = undefined;
    view._dropRow = null;
    view._flashingRow = null;
    this.window.ZoteroPane.itemsView._dropRow = null;
    view.tree.invalidate(); this.window.ZoteroPane.itemsView.tree.invalidate();
    if (Zotero.DragDrop) Zotero.DragDrop.currentDropEffect = null;
  }

  dispose(): void {
    this.disposed = true;
    this.clearFolderSource();
    try {
      const view = this.window.ZoteroPane.collectionsView;
      if (this.knowledgeHover) {
        clearTimeout(view._expandRowOnHoverTimer);
        view._expandRowOnHoverTimer = undefined;
        view._flashingRow = null;
      }
      for (const id of view._expandedRowsOnDrag ?? []) if (id.startsWith("Kknowledgemcp:")) view._expandedRowsOnDrag?.delete(id);
    } catch { Zotero.debug("[ZoteroKnowledgeMCP] Drag state cleanup skipped for a detached tree."); }
    finally {
      for (const restore of this.adapters.splice(0).reverse()) restore();
    }
  }
}
