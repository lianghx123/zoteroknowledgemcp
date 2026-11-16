import { adaptMethod } from "../../core/method-adapter";
import type { CollectionSyncBinding, CollectionSyncController } from "../../shared/contracts/collection-sync";
import type { KnowledgeMainWindow, NativeCollectionRow } from "./native-types";
import { t } from "../../shared/localization";

/** Descendant mappings participate in synchronization but do not own settings. */
export function bindingsForSyncRoot(bindings: readonly CollectionSyncBinding[], row: NativeCollectionRow | undefined): CollectionSyncBinding[] {
  if (!row) return [];
  return bindings.filter(binding => row.isCollection()
    ? binding.nativeLibraryID === row.ref.libraryID && binding.collectionKey === row.ref.key
    : binding.folders?.some(folder => folder.collectionKey === binding.collectionKey && row.id === `Kknowledgemcp:folder:${folder.nodeID}`));
}

export function canConfigureCollectionSync(bindings: readonly CollectionSyncBinding[], row: NativeCollectionRow): boolean {
  if (bindingsForSyncRoot(bindings, row).length) return true;
  if (!row.isCollection()) return false;
  const sameLibrary = bindings.filter(binding => binding.nativeLibraryID === row.ref.libraryID);
  // A newly added descendant may not have a mapping until the next scan.
  const visited = new Set<number>();
  for (let collection = row.ref.id ? Zotero.Collections?.get(row.ref.id) : undefined; collection && !visited.has(collection.id);) {
    visited.add(collection.id);
    const key = collection.key;
    if (sameLibrary.some(binding => binding.collectionKey === key)) return false;
    collection = collection.parentID ? Zotero.Collections?.get(collection.parentID) : undefined;
  }
  return visited.size > 0 || !sameLibrary.some(binding => binding.folders?.some(folder => folder.collectionKey === row.ref.key));
}

export class CollectionSyncBadges {
  private readonly restore: () => void;
  private readonly unsubscribe: () => void = () => {};
  constructor(private readonly window: KnowledgeMainWindow, sync: CollectionSyncController) {
    const view = window.ZoteroPane.collectionsView;
    this.restore = adaptMethod(view, "_getIcon", (receiver, native, args) => {
      const icon = Reflect.apply(native, receiver, args) as Element;
      const row = view.getRow(args[0] as number);
      const bindings = bindingsForSyncRoot(sync.snapshot(), row);
      if (!bindings.length) return icon;
      const wrapper = window.document.createElementNS("http://www.w3.org/1999/xhtml", "span"); wrapper.className = "km-sync-folder-icon";
      wrapper.title = bindings.map(binding => `${t(binding.enabled ? "sync-to" : "sync-paused-at", { target: binding.location })} · ${t(`sync-mode-${binding.mode ?? "flexible"}`)}`).join("\n");
      const badge = window.document.createElementNS("http://www.w3.org/1999/xhtml", "span"); badge.className = "km-sync-badge"; badge.setAttribute("aria-hidden", "true");
      const arrows = window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
      arrows.setAttribute("viewBox", "0 0 12 12"); arrows.setAttribute("focusable", "false");
      const path = window.document.createElementNS(arrows.namespaceURI, "path");
      path.setAttribute("d", "M2 4.5h8l-2-2M10 7.5H2l2 2");
      path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
      arrows.append(path); badge.append(arrows);
      wrapper.append(icon, badge); return wrapper;
    });
    try {
      this.unsubscribe = sync.subscribe(() => view.tree.invalidate()); view.tree.invalidate();
    } catch (error) {
      try { this.unsubscribe(); } finally { this.restore(); }
      throw error;
    }
  }
  dispose(): void {
    try { this.unsubscribe(); } finally { this.restore(); }
    try { if (!this.window.closed) this.window.ZoteroPane?.collectionsView?.tree?.invalidate(); }
    catch { Zotero.debug("[ZoteroKnowledgeMCP] Sync badge refresh skipped during window cleanup."); }
  }
}
