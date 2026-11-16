import { t } from "../shared/localization";
import type { Kysely } from "kysely";
import type { Database } from "../database/types";
import { NativeLibraryIdentityError, ZoteroKnowledgeItems, type NativeKnowledgePort } from "../integrations/zotero/knowledge-items";
import { KnowledgeLibraryRepository } from "../repositories/knowledge-library";
import { KnowledgeUserError, knowledgeErrorMessage } from "../shared/knowledge-errors";
import { emptyKnowledgeSnapshot, type AdmissionResult, type KnowledgeLibraryController, type KnowledgeTarget } from "../shared/contracts/knowledge-library";

export class KnowledgeLibraryService implements KnowledgeLibraryController {
  snapshot = emptyKnowledgeSnapshot();
  afterPurge: (() => Promise<void>) | undefined;
  private readonly repository: KnowledgeLibraryRepository;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private observer: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = new Set<number>();
  private dirtyAll = false;
  private snapshotKey = "";
  private readonly warnings = new Map<string, string>();

  constructor(db: Kysely<Database>, private readonly native: NativeKnowledgePort = new ZoteroKnowledgeItems()) {
    this.repository = new KnowledgeLibraryRepository(db, native);
  }

  async start(reconcile = true): Promise<void> {
    await this.repository.initialize();
    await this.publish();
    this.observer = Zotero.Notifier?.registerObserver({ notify: (action, type, ids) => this.notify(action, type, ids) },
      ["item", "item-tag", "tag", "group"], "knowledge-metadata", 80) ?? null;
    if (reconcile) await this.refresh();
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  refreshSnapshot(): Promise<void> { return this.schedule(() => this.publish()); }

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("The knowledge library is shutting down."));
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private async publish(): Promise<void> {
    const snapshot = await this.repository.snapshot();
    snapshot.warnings = new Map(this.warnings);
    const key = JSON.stringify(snapshot, (_name, value: unknown) => value instanceof Map ? [...value] : value);
    if (key === this.snapshotKey) return;
    this.snapshotKey = key; this.snapshot = snapshot;
    if (!this.closing) for (const listener of this.listeners) {
      try { listener(); } catch { Zotero.debug("[ZoteroKnowledgeMCP] Knowledge UI refresh failed."); }
    }
  }

  add(itemIDs: number[], target: KnowledgeTarget): Promise<AdmissionResult[]> {
    return this.schedule(async () => {
      const results: AdmissionResult[] = [];
      const seen = new Set<string>();
      try {
        for (const itemID of [...new Set(itemIDs)]) {
          try {
            const input = await this.native.capture(itemID);
            if (input.state !== "current") throw new KnowledgeUserError(t("error-restore-first"));
            const identity = `${input.library.localID}:${input.key}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            const resourceID = await this.repository.save(input, target);
            this.warnings.delete(resourceID);
            results.push({ itemID, resourceID });
          } catch (error) { results.push({ itemID, error: knowledgeErrorMessage(error) }); }
        }
        return results;
      } finally { await this.publish(); }
    });
  }

  remove(itemIDs: number[], target: KnowledgeTarget): Promise<void> {
    return this.schedule(async () => {
      const resourceIDs = new Set(itemIDs.map(id => this.snapshot.itemResources.get(id)).filter((id): id is string => Boolean(id)));
      try { for (const id of resourceIDs) await this.repository.remove(id, target); }
      finally { await this.publish(); }
    });
  }

  moveToTrash(itemIDs: number[], libraryIDs: string[]): Promise<void> {
    return this.schedule(async () => {
      const resourceIDs = [...new Set(itemIDs.map(id => this.snapshot.itemResources.get(id)).filter((id): id is string => Boolean(id)))];
      await this.repository.moveToTrash(resourceIDs, libraryIDs);
      await this.publish();
    });
  }

  createLibrary(name: string): Promise<string> { return this.schedule(async () => { const id = await this.repository.create(name); await this.publish(); return id; }); }
  createFolder(name: string, target: KnowledgeTarget): Promise<string> { return this.schedule(async () => { const id = await this.repository.create(name, target); await this.publish(); return id; }); }
  deleteLibrary(libraryID: string, deleteExclusiveResources: boolean): Promise<void> {
    return this.schedule(async () => {
      await this.repository.deleteLibrary(libraryID, deleteExclusiveResources);
      await this.publish();
    });
  }
  deleteFolder(target: KnowledgeTarget): Promise<void> {
    return this.deleteFolders([target]);
  }
  deleteFolders(targets: KnowledgeTarget[]): Promise<void> {
    return this.schedule(async () => { await this.repository.deleteFolders(targets); await this.publish(); });
  }
  restoreTrash(entryIDs: string[]): Promise<void> {
    return this.schedule(async () => { await this.repository.restoreTrash(entryIDs); await this.publish(); });
  }
  async purgeTrash(entryIDs: string[]): Promise<void> {
    await this.schedule(async () => { await this.repository.purgeTrash(entryIDs); await this.publish(); });
    await this.afterPurge?.();
  }

  refresh(): Promise<void> { return this.schedule(() => this.reconcile()); }

  private async reconcile(itemIDs?: Set<number>): Promise<void> {
    const changedResources = new Set(itemIDs ? [...itemIDs].map(id => this.snapshot.itemResources.get(id)) : []);
    const resources = [...new Map([...this.snapshot.resources, ...this.snapshot.trashedResources].map(resource => [resource.id, resource])).values()].filter(resource => !itemIDs || (resource.itemID !== null && itemIDs.has(resource.itemID))
      || changedResources.has(resource.id));
    // Unrelated native edits need neither a database snapshot nor a UI rebuild.
    if (itemIDs && !resources.length) return;
    try {
      for (const resource of resources) {
        if (this.closing) break;
        let item: ZoteroItem | false | null;
        try {
          item = await this.native.lookup(resource.nativeLibraryID, resource.itemKey);
        } catch { item = null; }
        if (!item) { await this.repository.markUnavailable(resource.id, item === false ? "deleted" : "unavailable"); continue; }
        try {
          await this.repository.save(await this.native.capture(item.id));
          this.warnings.delete(resource.id);
        } catch (error) {
          // A projection/write failure preserves the last valid metadata and membership.
          if (error instanceof NativeLibraryIdentityError) await this.repository.markUnavailable(resource.id, "unavailable");
          this.warnings.set(resource.id, knowledgeErrorMessage(error, t("error-refresh")));
          Zotero.debug("[ZoteroKnowledgeMCP] A selected knowledge source needs metadata reconciliation.");
        }
      }
    } finally { await this.publish(); }
  }

  private notify(action: string, type: string, ids: Array<string | number>): void {
    if (this.closing || action === "redraw") return;
    if (["group", "tag"].includes(type)) this.dirtyAll = true;
    else for (const value of ids) {
      const id = Number(String(value).split("-")[0]);
      if (!Number.isSafeInteger(id)) continue;
      this.dirty.add(id);
      const item = Zotero.Items.get(id);
      if (item && item.parentItemID) this.dirty.add(item.parentItemID);
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const changed = this.dirtyAll ? undefined : this.dirty;
      this.dirty = new Set(); this.dirtyAll = false;
      void this.schedule(() => this.reconcile(changed)).catch(() => { Zotero.debug("[ZoteroKnowledgeMCP] Deferred knowledge refresh failed."); });
    }, 150);
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.observer) Zotero.Notifier?.unregisterObserver(this.observer);
    this.observer = null; this.listeners.clear(); this.dirty.clear();
    await this.queue;
  }
}
