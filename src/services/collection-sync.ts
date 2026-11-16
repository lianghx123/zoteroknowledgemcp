import { FOLDER_PATH_SEPARATOR } from "../shared/folder-path";
import { CollectionSyncRepository } from "../repositories/collection-sync";
import type { KnowledgeLibraryController, KnowledgeTarget } from "../shared/contracts/knowledge-library";
import type { CollectionSyncMode, CollectionSyncBinding, CollectionSyncController } from "../shared/contracts/collection-sync";
import type { ParsingService } from "./parsing";
import type { EmbeddingService } from "./embedding";
import { assertSyncDestination } from "../repositories/sync-policy";

interface SyncState { title: string; error: boolean; removed?: boolean; hidden?: boolean; historyCleared?: boolean; added: number; removedItems: number }

/** One-way native collection mirror. Only this binding's membership origins are pruned. */
export class CollectionSyncService implements CollectionSyncController {
  private rows: CollectionSyncBinding[] = [];
  private readonly state = new Map<string, SyncState>();
  private readonly listeners = new Set<() => void>();
  private operations: Promise<unknown> = Promise.resolve();
  private observer: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  constructor(readonly repository: CollectionSyncRepository, private readonly knowledge: KnowledgeLibraryController, private readonly parsing: ParsingService,
    private readonly embeddings?: Pick<EmbeddingService, "refresh">) {}
  beforeWork?: () => Promise<void>;
  private starting: Promise<void> = Promise.resolve();
  start(): Promise<void> { return this.starting = this.restore(); }
  private async restore(): Promise<void> {
    if (this.closed) return;
    await this.repository.knowledge.initialize();
    const states = await this.repository.db.selectFrom("plugin_state").select(["key", "value_json"]).where("key", "like", "collection-sync:%").execute();
    for (const row of states) {
      const id = row.key.slice("collection-sync:".length), state = JSON.parse(row.value_json) as SyncState;
      this.state.set(id, state);
      // Older versions hid the entire binding, including future jobs. Convert
      // that marker once to per-record history while retaining active work.
      if (state.hidden && !state.historyCleared) {
        await this.parsing.clearFinishedBatch(`batch-sync-${id}`);
        await this.embeddings?.refresh();
        state.historyCleared = true; await this.saveState(id);
      }
    }
    if (this.closed) return;
    if (this.observer) Zotero.Notifier?.unregisterObserver(this.observer);
    this.observer = Zotero.Notifier?.registerObserver({ notify: action => { if (action !== "redraw") this.wake(); } }, ["collection", "collection-item", "item", "group"], "knowledge-collection-sync", 90);
    await this.publish(); this.wake(); this.poll();
  }
  snapshot(): readonly CollectionSyncBinding[] { return this.rows; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(Error("Collection synchronization is closed"));
    const pending = this.operations.then(async () => { await this.beforeWork?.(); if (this.closed) throw new Error("Collection synchronization is closed"); return operation(); }); this.operations = pending.catch(() => {}); return pending;
  }
  private poll(): void { if (!this.closed) this.interval = setTimeout(() => { this.wake(); this.poll(); }, 30000); }
  private wake(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.reconcile().catch(() => { Zotero.debug("[ZoteroKnowledgeMCP] Collection synchronization will retry."); }); }, 250);
  }
  async link(ids: number[], target: KnowledgeTarget, mode: CollectionSyncMode = "flexible"): Promise<void> {
    await this.schedule(async () => {
      for (const id of new Set(ids)) {
        const collection = Zotero.Collections?.get(id); if (!collection || collection.deleted) continue;
        const bindingID = await this.repository.bind(collection, target, mode);
        this.state.set(bindingID, { title: collection.name, error: false, added: 0, removedItems: 0 }); await this.saveState(bindingID);
      }
      await this.publish();
    });
    await this.reconcile();
  }
  async configure(id: string, mode: CollectionSyncMode, enabled: boolean, resetExclusions = false): Promise<void> {
    if (!["mirror", "flexible", "append"].includes(mode)) throw Error("Invalid sync mode");
    await this.schedule(async () => {
      await this.repository.db.transaction().execute(async tx => {
        await assertSyncDestination(tx, id);
        await tx.updateTable("zotero_bindings").set({ sync_mode: mode, enabled: Number(enabled), updated_at: Date.now() }).where("id", "=", id).execute();
        if (resetExclusions || mode === "mirror") {
          await tx.deleteFrom("sync_exclusions").where("binding_id", "=", id).execute();
          await tx.deleteFrom("sync_collection_exclusions").where("binding_id", "=", id).execute();
        }
      });
      await this.publish();
    });
    if (enabled) await this.reconcile();
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.schedule(async () => {
      await this.repository.db.transaction().execute(async tx => {
        await assertSyncDestination(tx, id);
        await tx.updateTable("zotero_bindings").set({ enabled: Number(enabled), updated_at: Date.now() }).where("id", "=", id).execute();
      });
      await this.publish();
    });
    if (enabled) await this.reconcile();
  }
  async unlink(id: string): Promise<void> {
    await this.schedule(async () => {
      await this.repository.preserveAndDisable(id);
      const state = this.state.get(id); if (state) { state.removed = true; await this.saveState(id); }
      await this.knowledge.refresh(); await this.publish();
    });
  }
  async hide(id: string): Promise<void> {
    await this.schedule(async () => {
      const state = this.state.get(id); if (!state) return;
      await this.parsing.clearFinishedBatch(`batch-sync-${id}`);
      await this.embeddings?.refresh();
      state.hidden = true; state.historyCleared = true; await this.saveState(id); await this.publish();
    });
  }
  isHidden(id: string): boolean { return Boolean(this.state.get(id)?.hidden); }
  private async saveState(id: string): Promise<void> {
    await this.repository.db.insertInto("plugin_state").values({ key: `collection-sync:${id}`, value_json: JSON.stringify(this.state.get(id)), updated_at: Date.now() })
      .onConflict(conflict => conflict.column("key").doUpdateSet({ value_json: JSON.stringify(this.state.get(id)), updated_at: Date.now() })).execute();
  }
  private async publish(): Promise<void> {
    const bindings = await this.repository.list();
    const links = await this.repository.db.selectFrom("zotero_collection_links").select(["binding_id", "node_id", "collection_key"]).execute();
    const rows = bindings.filter(binding => !this.state.get(binding.id)?.removed).map(binding => {
      const state = this.state.get(binding.id);
      const library = this.knowledge.snapshot.libraries.find(row => row.id === binding.target.libraryID);
      const parts: string[] = []; const seen = new Set<string>();
      for (let node = binding.target.nodeID; node && !seen.has(node);) { seen.add(node); const folder = this.knowledge.snapshot.folders.find(row => row.id === node); if (!folder) break; parts.unshift(folder.name); node = folder.parentID; }
      return { id: binding.id, nativeLibraryID: binding.nativeLibraryID, collectionKey: binding.collectionKey, target: binding.target, enabled: binding.enabled, mode: binding.mode,
        folders: links.filter(link => link.binding_id === binding.id).map(link => ({ nodeID: link.node_id, collectionKey: link.collection_key })),
        title: state?.title ?? binding.collectionKey, location: [library?.name ?? "", ...parts, state?.title ?? binding.collectionKey].filter(Boolean).join(FOLDER_PATH_SEPARATOR),
        error: state?.error ?? false, added: state?.added ?? 0, removed: state?.removedItems ?? 0 };
    });
    if (this.closed || JSON.stringify(rows) === JSON.stringify(this.rows)) return;
    this.rows = rows;
    if (!this.closed) for (const listener of this.listeners) { try { listener(); } catch { Zotero.debug("[ZoteroKnowledgeMCP] Sync view refresh failed."); } }
  }
  reconcile(): Promise<void> { return this.schedule(async () => {
    const bindings = await this.repository.list();
    if (!bindings.some(binding => binding.enabled && !this.state.get(binding.id)?.removed)) { await this.publish(); return; }
    for (const binding of bindings) {
      if (this.closed) break;
      if (!binding.enabled || this.state.get(binding.id)?.removed) continue;
      const state = this.state.get(binding.id) ?? { title: binding.collectionKey, error: false, added: 0, removedItems: 0 };
      this.state.set(binding.id, state);
      try {
        const library = Zotero.Libraries?.get(binding.nativeLibraryID);
        if (!library || library.libraryType !== binding.libraryType) throw Error("Source library unavailable");
        const identity = library.libraryType === "user" ? String(Zotero.Users?.getCurrentUserID() || "") || null : String(Zotero.Groups!.getGroupIDFromLibraryID(binding.nativeLibraryID));
        if (binding.externalID && identity && identity !== binding.externalID) throw Error("Source library identity changed");
        if (!library.getDataLoaded("collection")) await library.waitForDataLoad("collection");
        if (!library.getDataLoaded("item")) await library.waitForDataLoad("item");
        const root = await Zotero.Collections!.getByLibraryAndKeyAsync(binding.nativeLibraryID, binding.collectionKey);
        if (!root || root.deleted) {
          state.removedItems = await this.repository.prune(binding.id, new Set());
          await this.repository.db.updateTable("zotero_bindings").set({ enabled: 0, updated_at: Date.now() }).where("id", "=", binding.id).execute();
          state.error = true; await this.saveState(binding.id); continue;
        }
        state.title = root.name;
        const seen = new Set<string>(), visited = new Set<number>(); let added = 0, parsingFailed = false;
        const visit = async (collection: ZoteroCollection, target: KnowledgeTarget, depth: number): Promise<void> => {
          if (this.closed) throw Error("Synchronization closing");
          if (depth > 64 || visited.has(collection.id)) throw Error("Invalid source collection tree");
          visited.add(collection.id);
          if (binding.mode !== "mirror" && await this.repository.db.selectFrom("sync_collection_exclusions").select("collection_key").where("binding_id", "=", binding.id).where("collection_key", "=", collection.key).executeTakeFirst()) return;
          const nodeID = await this.repository.folder(binding.id, collection, target);
          if (!nodeID) return;
          const destination = { libraryID: target.libraryID, nodeID };
          const ids: number[] = [];
          for (const id of collection.getChildItems(true, false)) {
            if (this.closed) throw Error("Synchronization closing");
            const item = await Zotero.Items.getAsync!(id);
            if (!item) throw Error("Source item unavailable during scan");
            if (item.deleted || (!item.isRegularItem() && !item.isAttachment())) continue;
            const input = await this.repository.native.capture(id);
            if (input.state !== "current") continue;
            if (binding.mode !== "mirror" && await this.repository.excluded(binding.id, nodeID, input.key)) continue;
            const resourceID = await this.repository.knowledge.save(input, destination, undefined, binding.id);
            if (!resourceID) continue;
            const origin = await this.repository.db.selectFrom("membership_origins").select("id").where("binding_id", "=", binding.id).where("resource_id", "=", resourceID)
              .where("library_item_id", "in", this.repository.db.selectFrom("library_items").select("id").where("node_id", "=", nodeID)).where("deleted_at", "is", null).executeTakeFirst();
            if (!origin) continue;
            seen.add(origin.id); ids.push(id);
          }
          // PDF preparation failures do not invalidate the complete native
          // membership scan. Continue descendants and prune only after traversal.
          try { await this.parsing.enqueue(ids, destination, { id: `sync-${binding.id}`, title: root.name, sourceCollection: root.name }, false, true); }
          catch { parsingFailed = true; }
          for (const childID of collection.getChildCollections(true)) {
            const child = Zotero.Collections!.get(childID); if (!child || child.deleted) throw Error("Source tree changed during scan");
            await visit(child, destination, depth + 1);
          }
        };
        const previous = await this.repository.db.selectFrom("membership_origins").select("id").where("binding_id", "=", binding.id).where("deleted_at", "is", null).execute();
        const previousIDs = new Set(previous.map(row => row.id));
        await visit(root, binding.target, 0);
        if (this.closed) return;
        for (const id of seen) if (!previousIDs.has(id)) added++;
        state.added = added; state.removedItems = await this.repository.prune(binding.id, seen); state.error = parsingFailed;
        if (added || state.removedItems || parsingFailed) state.hidden = false;
        await this.repository.db.updateTable("zotero_bindings").set({ last_reconciled_at: Date.now(), updated_at: Date.now() }).where("id", "=", binding.id).execute();
      } catch { if (this.closed) return; state.error = true; Zotero.debug("[ZoteroKnowledgeMCP] A collection binding needs reconciliation."); }
      await this.saveState(binding.id);
    }
    if (!this.closed) { await this.knowledge.refresh(); await this.parsing.refresh(); await this.publish(); }
  }); }
  async close(): Promise<void> { this.closed = true; clearTimeout(this.timer); clearTimeout(this.interval); if (this.observer) Zotero.Notifier?.unregisterObserver(this.observer); this.listeners.clear(); const results = await Promise.allSettled([this.operations, this.starting]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason; }
}
