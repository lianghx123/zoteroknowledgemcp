import { FOLDER_PATH_SEPARATOR, displayStoredFolderPath } from "../shared/folder-path";
import { t } from "../shared/localization";
import type { DatabaseContext } from "../database/unit-of-work";
import { forEachBatch, queryInBatches } from "../database/batches";
import type { NativeKnowledgePort } from "../integrations/zotero/knowledge-items";
import type { KnowledgeTarget, KnowledgeTrashEntry } from "../shared/contracts/knowledge-library";
import { KnowledgeUserError } from "../shared/knowledge-errors";

interface TrashRecord extends KnowledgeTrashEntry {
  folderIDs: string[];
  relationIDs: string[];
  placementIDs: string[];
  originIDs: string[];
  deletedResourceIDs: string[];
}

async function insertLinkBatches(ids: string[], insert: (rows: Array<{ id: string; position: number }>) => Promise<unknown>): Promise<void> {
  await forEachBatch([...new Set(ids)], (batch, offset) => insert(batch.map((id, index) => ({ id, position: offset + index }))));
}

/** Operation-owned tombstones keep later removals separate from earlier restores. */
export class KnowledgeTrashRepository {
  constructor(private readonly native: NativeKnowledgePort) {}

  private async entries(tx: DatabaseContext): Promise<KnowledgeTrashEntry[]> {
    const rows = await tx.selectFrom("knowledge_trash_entries").selectAll().orderBy("deleted_at", "desc").orderBy("id").execute();
    return rows.map(row => ({
      id: row.id, kind: row.kind as KnowledgeTrashEntry["kind"], name: row.name,
      target: { libraryID: row.library_id, nodeID: row.node_id }, location: row.location, deletedAt: row.deleted_at,
      resourceIDs: []
    }));
  }

  /** UI snapshots need resource identities, not the recovery graph used by mutations. */
  async listSummary(tx: DatabaseContext): Promise<KnowledgeTrashEntry[]> {
    const result = await this.entries(tx);
    if (!result.length) return result;
    for (const entry of result) entry.location = displayStoredFolderPath(entry.location);
    const entries = new Map(result.map(entry => [entry.id, entry]));
    const resources = await tx.selectFrom("knowledge_trash_resources").select(["entry_id", "resource_id"]).orderBy("position").execute();
    for (const row of resources) entries.get(row.entry_id)!.resourceIDs.push(row.resource_id);
    return result;
  }

  async list(tx: DatabaseContext): Promise<TrashRecord[]> {
    const summaries = await this.entries(tx);
    if (!summaries.length) return [];
    const entries = new Map<string, TrashRecord>(summaries.map(entry => [entry.id, {
      ...entry, folderIDs: [], relationIDs: [], placementIDs: [], originIDs: [], deletedResourceIDs: []
    }]));
    const [resources, folders, relations, placements, origins] = await Promise.all([
      tx.selectFrom("knowledge_trash_resources").selectAll().orderBy("position").execute(),
      tx.selectFrom("knowledge_trash_folders").selectAll().orderBy("position").execute(),
      tx.selectFrom("knowledge_trash_relations").selectAll().orderBy("position").execute(),
      tx.selectFrom("knowledge_trash_placements").selectAll().orderBy("position").execute(),
      tx.selectFrom("knowledge_trash_origins").selectAll().orderBy("position").execute()
    ]);
    for (const row of resources) {
      const entry = entries.get(row.entry_id)!;
      entry.resourceIDs.push(row.resource_id);
      if (row.was_deleted) entry.deletedResourceIDs.push(row.resource_id);
    }
    for (const row of folders) entries.get(row.entry_id)!.folderIDs.push(row.node_id);
    for (const row of relations) entries.get(row.entry_id)!.relationIDs.push(row.library_resource_id);
    for (const row of placements) entries.get(row.entry_id)!.placementIDs.push(row.library_item_id);
    for (const row of origins) entries.get(row.entry_id)!.originIDs.push(row.origin_id);
    return [...entries.values()];
  }

  private async insertLinks(tx: DatabaseContext, entry: TrashRecord): Promise<void> {
    const scope = { entry_id: entry.id, library_id: entry.target.libraryID };
    const deleted = new Set(entry.deletedResourceIDs);
    await insertLinkBatches(entry.resourceIDs, rows => tx.insertInto("knowledge_trash_resources").values(rows.map(({ id, position }) =>
      ({ entry_id: entry.id, resource_id: id, position, was_deleted: deleted.has(id) ? 1 : 0 }))).execute());
    await insertLinkBatches(entry.folderIDs, rows => tx.insertInto("knowledge_trash_folders").values(rows.map(({ id, position }) =>
      ({ ...scope, node_id: id, position }))).execute());
    await insertLinkBatches(entry.relationIDs, rows => tx.insertInto("knowledge_trash_relations").values(rows.map(({ id, position }) =>
      ({ ...scope, library_resource_id: id, position }))).execute());
    await insertLinkBatches(entry.placementIDs, rows => tx.insertInto("knowledge_trash_placements").values(rows.map(({ id, position }) =>
      ({ ...scope, library_item_id: id, position }))).execute());
    await insertLinkBatches(entry.originIDs, rows => tx.insertInto("knowledge_trash_origins").values(rows.map(({ id, position }) =>
      ({ ...scope, origin_id: id, position }))).execute());
  }

  async capture(tx: DatabaseContext, kind: KnowledgeTrashEntry["kind"], name: string, target: KnowledgeTarget,
    folderIDs: string[], resourceIDs: string[], originIDs: string[], deletedResourceIDs: string[] = []): Promise<void> {
    const relations = await queryInBatches(resourceIDs, ids => tx.selectFrom("library_resources").select("id").where("library_id", "=", target.libraryID)
      .where("resource_id", "in", ids).where("deleted_at", "is", null).execute());
    const origins = await queryInBatches(originIDs, ids => tx.selectFrom("membership_origins").select("library_item_id").where("id", "in", ids).execute());
    const library = await tx.selectFrom("knowledge_libraries").select("name").where("id", "=", target.libraryID).executeTakeFirstOrThrow();
    const path = [library.name];
    let parentID = target.nodeID;
    const seen = new Set<string>();
    while (parentID && !seen.has(parentID)) {
      seen.add(parentID);
      const folder = await tx.selectFrom("library_nodes").select(["name", "parent_id"]).where("id", "=", parentID).executeTakeFirstOrThrow();
      path.splice(1, 0, folder.name); parentID = folder.parent_id;
    }
    const entry: TrashRecord = { id: this.native.uuid(), kind, name, target, location: path.join(FOLDER_PATH_SEPARATOR), resourceIDs, deletedAt: Date.now(), folderIDs,
      relationIDs: relations.map(row => row.id), originIDs, placementIDs: origins.flatMap(row => row.library_item_id ? [row.library_item_id] : []), deletedResourceIDs };
    await tx.insertInto("knowledge_trash_entries").values({ id: entry.id, kind, name, library_id: target.libraryID,
      node_id: target.nodeID, location: entry.location, deleted_at: entry.deletedAt }).execute();
    await this.insertLinks(tx, entry);
  }

  async readmitted(tx: DatabaseContext, resourceID: string, target: KnowledgeTarget): Promise<void> {
    // A library-root removal may record many folder placements. Match only this
    // resource's item entries, without loading every Trash operation into memory.
    await tx.deleteFrom("knowledge_trash_entries").where("kind", "=", "item").where("library_id", "=", target.libraryID)
      .where(eb => eb.exists(eb.selectFrom("knowledge_trash_resources as r").select("r.entry_id")
        .whereRef("r.entry_id", "=", "knowledge_trash_entries.id").where("r.resource_id", "=", resourceID)))
      .where(eb => eb.not(eb.exists(eb.selectFrom("knowledge_trash_origins as t").innerJoin("membership_origins as o", "o.id", "t.origin_id")
        .select("t.entry_id").whereRef("t.entry_id", "=", "knowledge_trash_entries.id").where("o.deleted_at", "is not", null))))
      .execute();
  }

  async restore(tx: DatabaseContext, entryIDs: string[], membership: (resourceID: string, target: KnowledgeTarget, now: number) => Promise<unknown>): Promise<TrashRecord[]> {
    const entries = await this.list(tx);
    const entriesByID = new Map(entries.map(entry => [entry.id, entry]));
    const restored = new Set<string>();
    const restoring = new Set<string>();
    const now = Date.now();
    const restore = async (entry: TrashRecord): Promise<void> => {
      if (restored.has(entry.id)) return;
      if (restoring.has(entry.id)) throw new KnowledgeUserError(t("error-restore-location"));
      restoring.add(entry.id);
      const ownFolders = new Set(entry.folderIDs);
      const folderAvailability = new Map<string, boolean>();
      const library = await tx.selectFrom("knowledge_libraries").selectAll().where("id", "=", entry.target.libraryID).executeTakeFirstOrThrow();
      if (library.deleted_at !== null && entry.kind !== "library") {
        const parent = entries.find(candidate => candidate.kind === "library" && candidate.target.libraryID === library.id);
        if (!parent) throw new KnowledgeUserError(t("error-original-library"));
        await restore(parent);
      }
      const ensureFolder = async (id: string): Promise<boolean> => {
        if (folderAvailability.has(id)) return folderAvailability.get(id)!;
        const node = await tx.selectFrom("library_nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
        if (node.deleted_at === null) { folderAvailability.set(id, true); return true; }
        const owner = entries.find(candidate => candidate.id !== entry.id && candidate.folderIDs.includes(id));
        if (!owner) { folderAvailability.set(id, false); return false; }
        await restore(owner);
        folderAvailability.set(id, true);
        return true;
      };
      if (entry.kind === "library") {
        const conflict = await tx.selectFrom("knowledge_libraries").select("id").where("name", "=", library.name).where("deleted_at", "is", null).where("id", "!=", library.id).executeTakeFirst();
        if (conflict) throw new KnowledgeUserError(t("restore-library-conflict", { name: library.name }));
        const existingDefault = await tx.selectFrom("knowledge_libraries").select("id").where("is_default", "=", 1).where("deleted_at", "is", null).executeTakeFirst();
        await tx.updateTable("knowledge_libraries").set({ status: "active", deleted_at: null, is_default: existingDefault ? 0 : 1 }).where("id", "=", library.id).execute();
      }
      const blockedPlacements = new Set<string>();
      let restoreAtRoot = false;
      if (entry.kind === "item" && entry.target.nodeID && !await ensureFolder(entry.target.nodeID)) restoreAtRoot = true;
      if (entry.placementIDs.length) {
        const placements = await queryInBatches(entry.placementIDs, ids => tx.selectFrom("library_items").select(["id", "node_id"]).where("id", "in", ids).execute());
        for (const placement of placements) if (!ownFolders.has(placement.node_id) && !await ensureFolder(placement.node_id)) {
          blockedPlacements.add(placement.id); restoreAtRoot = true;
        }
      }
      const folders = await queryInBatches(entry.folderIDs, ids => tx.selectFrom("library_nodes").selectAll().where("id", "in", ids).execute());
      for (const folder of folders) {
        if (folder.parent_id && !ownFolders.has(folder.parent_id) && !await ensureFolder(folder.parent_id)) {
          folder.parent_id = null;
          await tx.updateTable("library_nodes").set({ parent_id: null }).where("id", "=", folder.id).execute();
        }
      }
      // Parents may have been restored above. Check their now-active children once,
      // and include incoming folders so root fallback cannot merge equal names.
      if (folders.length) {
        const active = await tx.selectFrom("library_nodes").select(["id", "parent_id", "name"]).where("library_id", "=", entry.target.libraryID).where("deleted_at", "is", null).execute();
        const siblings = new Map(active.map(folder => [JSON.stringify([folder.parent_id, folder.name]), folder.id]));
        for (const folder of folders) {
          const key = JSON.stringify([folder.parent_id, folder.name]);
          if (siblings.has(key) && siblings.get(key) !== folder.id) throw new KnowledgeUserError(t("restore-folder-conflict", { name: folder.name }));
          siblings.set(key, folder.id);
        }
      }
      for (const folder of folders) {
        const links = await tx.selectFrom("zotero_collection_links").select(["binding_id", "collection_key"]).where("node_id", "=", folder.id).execute();
        for (const link of links) await tx.deleteFrom("sync_collection_exclusions").where("binding_id", "=", link.binding_id).where("collection_key", "=", link.collection_key).execute();
      }
      await forEachBatch(entry.folderIDs, ids => tx.updateTable("library_nodes").set(eb => ({ deleted_at: null, updated_at: now, version: eb("version", "+", 1) })).where("id", "in", ids).execute());
      await forEachBatch(entry.relationIDs, ids => tx.updateTable("library_resources").set({ deleted_at: null }).where("id", "in", ids).execute());
      const placementIDs = entry.placementIDs.filter(id => !blockedPlacements.has(id));
      const origins = await queryInBatches(entry.originIDs, ids => tx.selectFrom("membership_origins").select(["id", "library_item_id", "binding_id"]).where("id", "in", ids).execute());
      for (const origin of origins.filter(row => row.binding_id)) {
        const row = await tx.selectFrom("membership_origins as o").innerJoin("library_items as p", "p.id", "o.library_item_id")
          .innerJoin("zotero_item_links as i", "i.id", "o.item_link_id").select(["o.binding_id", "p.node_id", "i.item_key"]).where("o.id", "=", origin.id).executeTakeFirst();
        if (row?.binding_id) await tx.deleteFrom("sync_exclusions").where("binding_id", "=", row.binding_id).where("node_id", "=", row.node_id).where("item_key", "=", row.item_key).execute();
      }
      const originIDs = origins.filter(origin => !origin.library_item_id || !blockedPlacements.has(origin.library_item_id)).map(origin => origin.id);
      await forEachBatch(placementIDs, ids => tx.updateTable("library_items").set({ deleted_at: null }).where("id", "in", ids).execute());
      await forEachBatch(originIDs, ids => tx.updateTable("membership_origins").set({ deleted_at: null, updated_at: now }).where("id", "in", ids).execute());
      if (restoreAtRoot) for (const resourceID of entry.resourceIDs) await membership(resourceID, { libraryID: entry.target.libraryID, nodeID: null }, now);
      // Another library may have deleted the shared resource while this location
      // remained recoverable. Restoring a surviving membership reactivates it.
      await forEachBatch(entry.resourceIDs, ids => tx.updateTable("knowledge_resources").set({ status: "active", deleted_at: null }).where("id", "in", ids).execute());
      await tx.deleteFrom("knowledge_trash_entries").where("id", "=", entry.id).execute();
      restoring.delete(entry.id); restored.add(entry.id);
    };
    for (const id of new Set(entryIDs)) {
      const entry = entriesByID.get(id);
      if (entry) await restore(entry);
    }
    return entries.filter(entry => restored.has(entry.id));
  }

  /** Discard recovery rights before reference-aware physical deletion. */
  async purge(tx: DatabaseContext, entryIDs: string[]): Promise<TrashRecord[]> {
    const entries = await this.list(tx);
    const selectedIDs = new Set(entryIDs);
    const selected = entries.filter(entry => selectedIDs.has(entry.id));
    const libraries = new Set(selected.filter(entry => entry.kind === "library").map(entry => entry.target.libraryID));
    const folders = new Set(selected.filter(entry => entry.kind === "folder").flatMap(entry => entry.folderIDs));
    if (folders.size) {
      const nodes = await tx.selectFrom("library_nodes").select(["id", "parent_id"]).execute();
      for (let size = -1; size !== folders.size;) {
        size = folders.size;
        for (const node of nodes) if (node.parent_id && folders.has(node.parent_id)) folders.add(node.id);
      }
    }
    const purged = entries.filter(entry => selectedIDs.has(entry.id) || libraries.has(entry.target.libraryID)
      || (entry.kind === "folder" && entry.target.nodeID && folders.has(entry.target.nodeID)));
    const removed = new Set(purged.map(entry => entry.id));
    const itemScopes = new Set(purged.filter(entry => entry.kind === "item").flatMap(entry => entry.resourceIDs.map(id => JSON.stringify([entry.target.libraryID, id]))));
    for (const entry of entries) {
      if (removed.has(entry.id)) {
        await tx.deleteFrom("knowledge_trash_entries").where("id", "=", entry.id).execute();
        continue;
      }
      const excluded = new Set(entry.resourceIDs.filter(id => itemScopes.has(JSON.stringify([entry.target.libraryID, id]))));
      if (!excluded.size) continue;
      if (entry.kind === "item") {
        await tx.deleteFrom("knowledge_trash_entries").where("id", "=", entry.id).execute();
        purged.push(entry);
        continue;
      }
      const origins = await queryInBatches(entry.originIDs, ids => tx.selectFrom("membership_origins").select(["id", "resource_id", "library_item_id"]).where("id", "in", ids).execute());
      const retained = origins.filter(origin => !excluded.has(origin.resource_id));
      const retainedOrigins = new Set(retained.map(origin => origin.id));
      const retainedPlacements = new Set(retained.flatMap(origin => origin.library_item_id ? [origin.library_item_id] : []));
      entry.originIDs = entry.originIDs.filter(id => retainedOrigins.has(id));
      entry.placementIDs = entry.placementIDs.filter(id => retainedPlacements.has(id));
      const relations = await queryInBatches(entry.relationIDs, ids => tx.selectFrom("library_resources").select(["id", "resource_id"]).where("id", "in", ids).execute());
      const retainedRelations = new Set(relations.filter(relation => !excluded.has(relation.resource_id)).map(relation => relation.id));
      entry.relationIDs = entry.relationIDs.filter(id => retainedRelations.has(id));
      entry.resourceIDs = entry.resourceIDs.filter(id => !excluded.has(id));
      entry.deletedResourceIDs = entry.deletedResourceIDs.filter(id => !excluded.has(id));
      await tx.deleteFrom("knowledge_trash_resources").where("entry_id", "=", entry.id).execute();
      await tx.deleteFrom("knowledge_trash_folders").where("entry_id", "=", entry.id).execute();
      await tx.deleteFrom("knowledge_trash_relations").where("entry_id", "=", entry.id).execute();
      await tx.deleteFrom("knowledge_trash_placements").where("entry_id", "=", entry.id).execute();
      await tx.deleteFrom("knowledge_trash_origins").where("entry_id", "=", entry.id).execute();
      await this.insertLinks(tx, entry);
    }
    return purged;
  }
}
