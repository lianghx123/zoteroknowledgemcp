import type { CollectionSyncMode } from "../shared/contracts/collection-sync";
import { sql, type Kysely } from "kysely";
import type { Database } from "../database/types";
import type { KnowledgeTarget } from "../shared/contracts/knowledge-library";
import { KnowledgeLibraryRepository } from "./knowledge-library";
import { ZoteroKnowledgeItems } from "../integrations/zotero/knowledge-items";
import { NativeLibraryIdentityError } from "../integrations/zotero/knowledge-items";
import { t } from "../shared/localization";
import { canSyncFolder, assertSyncDestination } from "./sync-policy";

export class CollectionSyncRepository {
  readonly knowledge: KnowledgeLibraryRepository;
  constructor(readonly db: Kysely<Database>, readonly native = new ZoteroKnowledgeItems()) { this.knowledge = new KnowledgeLibraryRepository(db, native); }
  async list() {
    const rows = await this.db.selectFrom("zotero_bindings as b").innerJoin("zotero_libraries as l", "l.id", "b.zotero_library_id")
      .select(["b.id", "b.collection_key", "b.knowledge_library_id", "b.target_node_id", "b.enabled", "b.sync_mode", "l.local_library_id", "l.external_library_id", "l.library_type"])
      .where("b.scope_type", "=", "collection")
      .where(eb => eb.not(eb.exists(eb.selectFrom("plugin_state").select("key")
        .where("key", "=", sql<string>`'collection-sync-invalid-target:' || b.id`)))).execute();
    return rows.map(row => ({ id: row.id, collectionKey: row.collection_key!, nativeLibraryID: row.local_library_id,
      target: { libraryID: row.knowledge_library_id, nodeID: row.target_node_id }, enabled: row.enabled === 1,
      mode: row.sync_mode as CollectionSyncMode, externalID: row.external_library_id, libraryType: row.library_type }));
  }
  async bind(collection: ZoteroCollection, target: KnowledgeTarget, mode: CollectionSyncMode = "flexible"): Promise<string> {
    const library = Zotero.Libraries!.get(collection.libraryID);
    if (!library || !["user", "group"].includes(library.libraryType)) throw new NativeLibraryIdentityError(t("error-source-library"));
    const externalID = library.libraryType === "user" ? String(Zotero.Users?.getCurrentUserID() || "") || null : String(Zotero.Groups!.getGroupIDFromLibraryID(collection.libraryID));
    return this.db.transaction().execute(async tx => {
      const destination = await tx.selectFrom("knowledge_libraries").select("id").where("id", "=", target.libraryID).where("status", "=", "active").executeTakeFirstOrThrow();
      if (target.nodeID) await tx.selectFrom("library_nodes").select("id").where("id", "=", target.nodeID).where("library_id", "=", destination.id).where("deleted_at", "is", null).executeTakeFirstOrThrow();
      let stored = await tx.selectFrom("zotero_libraries").selectAll().where("local_library_id", "=", collection.libraryID).executeTakeFirst();
      if (stored && (stored.library_type !== library.libraryType || (stored.external_library_id && externalID && stored.external_library_id !== externalID))) throw new NativeLibraryIdentityError(t("error-identity"));
      if (!stored) {
        const id = this.native.uuid(), now = Date.now();
        await tx.insertInto("zotero_libraries").values({ id, library_type: library.libraryType, local_library_id: collection.libraryID, external_library_id: externalID,
          display_name: library.name, is_editable: Number(library.editable), files_editable: Number(library.filesEditable), availability: "available", last_checked_at: now, created_at: now, updated_at: now }).execute();
        stored = await tx.selectFrom("zotero_libraries").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      }
      let existing = tx.selectFrom("zotero_bindings").select("id").where("zotero_library_id", "=", stored.id).where("collection_key", "=", collection.key).where("knowledge_library_id", "=", target.libraryID);
      existing = existing.where(eb => eb.not(eb.exists(eb.selectFrom("plugin_state").select("key")
        .where("key", "=", sql<string>`'collection-sync-invalid-target:' || zotero_bindings.id`))));
      existing = target.nodeID ? existing.where("target_node_id", "=", target.nodeID) : existing.where("target_node_id", "is", null);
      const prior = await existing.executeTakeFirst();
      if (prior) { await tx.updateTable("zotero_bindings").set({ enabled: 1, sync_mode: mode, updated_at: Date.now() }).where("id", "=", prior.id).execute(); return prior.id; }
      const id = this.native.uuid(), now = Date.now();
      await tx.insertInto("zotero_bindings").values({ id, zotero_library_id: stored.id, knowledge_library_id: target.libraryID, target_node_id: target.nodeID,
        sync_mode: mode, scope_type: "collection", collection_key: collection.key, include_descendants: 1, processing_policy: "automatic", parser_profile_id: null,
        last_completed_scan_id: null, last_reconciled_at: null, created_at: now, updated_at: now }).execute(); return id;
    });
  }
  async folder(bindingID: string, collection: ZoteroCollection, target: KnowledgeTarget): Promise<string | null> {
    return this.db.transaction().execute(async tx => {
      if (!await canSyncFolder(tx, bindingID, target, collection.key)) return null;
      const link = await tx.selectFrom("zotero_collection_links").select(["id", "node_id"]).where("binding_id", "=", bindingID).where("collection_key", "=", collection.key).executeTakeFirst();
      if (link) {
        const node = await tx.selectFrom("library_nodes").select(["deleted_at", "name", "parent_id"]).where("id", "=", link.node_id).executeTakeFirstOrThrow();
        // Only an explicit exclusion reset permits replacing a deleted folder;
        // the fresh check and both writes remain in this transaction.
        if (node.deleted_at) {
          const replacement = await this.knowledge.createInTransaction(tx, collection.name, target, true);
          await tx.updateTable("zotero_collection_links").set({ node_id: replacement, updated_at: Date.now() }).where("id", "=", link.id).execute();
          return replacement;
        }
        if (node.name !== collection.name || node.parent_id !== target.nodeID) await tx.updateTable("library_nodes").set({ name: collection.name, parent_id: target.nodeID, updated_at: Date.now() }).where("id", "=", link.node_id).execute();
        return link.node_id;
      }
      // Reuse a matching destination folder, preserving any manual memberships.
      let same = tx.selectFrom("library_nodes").select("id").where("library_id", "=", target.libraryID).where("name", "=", collection.name).where("deleted_at", "is", null);
      same = target.nodeID ? same.where("parent_id", "=", target.nodeID) : same.where("parent_id", "is", null);
      const nodeID = (await same.executeTakeFirst())?.id ?? await this.knowledge.createInTransaction(tx, collection.name, target, true);
      const binding = await tx.selectFrom("zotero_bindings").select("zotero_library_id").where("id", "=", bindingID).executeTakeFirstOrThrow();
      const now = Date.now();
      await tx.insertInto("zotero_collection_links").values({ id: this.native.uuid(), binding_id: bindingID, zotero_library_id: binding.zotero_library_id,
        collection_key: collection.key, parent_collection_key: null, local_collection_id: collection.id, knowledge_library_id: target.libraryID,
        node_id: nodeID, last_seen_scan_id: null, state: "current", created_at: now, updated_at: now }).execute();
      return nodeID;
    });
  }
  async prune(bindingID: string, seen: Set<string>): Promise<number> {
    return this.db.transaction().execute(async tx => {
      await assertSyncDestination(tx, bindingID);
      const binding = await tx.selectFrom("zotero_bindings").select("sync_mode").where("id", "=", bindingID).executeTakeFirstOrThrow();
      if (binding.sync_mode === "append") return 0;
      const origins = await tx.selectFrom("membership_origins").select(["id", "resource_id", "library_item_id", "library_resource_id"])
        .where("binding_id", "=", bindingID).where("deleted_at", "is", null).execute();
      let removed = 0; const affected = new Set<string>();
      for (const origin of origins) {
        if (seen.has(origin.id)) continue;
        removed++; const now = Date.now();
        affected.add(origin.resource_id);
        await tx.updateTable("membership_origins").set({ deleted_at: now, updated_at: now }).where("id", "=", origin.id).execute();
        if (origin.library_item_id && !(await tx.selectFrom("membership_origins").select("id").where("library_item_id", "=", origin.library_item_id).where("deleted_at", "is", null).executeTakeFirst())) {
          await tx.updateTable("library_items").set({ deleted_at: now }).where("id", "=", origin.library_item_id).execute();
        }
        if (!(await tx.selectFrom("membership_origins").select("id").where("library_resource_id", "=", origin.library_resource_id).where("deleted_at", "is", null).executeTakeFirst())) {
          await tx.updateTable("library_resources").set({ deleted_at: now }).where("id", "=", origin.library_resource_id).execute();
        }
      }
      for (const id of affected) {
        const resource = await tx.selectFrom("knowledge_resources").select("version").where("id", "=", id).executeTakeFirstOrThrow(), now = Date.now();
        await tx.updateTable("knowledge_resources").set({ version: resource.version + 1, updated_at: now }).where("id", "=", id).execute();
        await tx.insertInto("resource_revisions").values({ id: this.native.uuid(), resource_id: id, operation_id: this.native.uuid(), base_version: resource.version,
          result_version: resource.version + 1, change_type: "membership_removed", target_type: "resource", target_id: id, before_json: null,
          after_json: JSON.stringify({ bindingID, reason: "collection_sync" }), created_by_type: "system", created_by: null, agent_run_id: null, created_at: now }).execute();
        await tx.insertInto("change_outbox").values({ event_id: this.native.uuid(), aggregate_type: "resource", aggregate_id: id, aggregate_version: resource.version + 1,
          event_type: "membership_removed", payload_json: JSON.stringify({ bindingID }), created_at: now }).execute();
      }
      return removed;
    });
  }
  async excluded(bindingID: string, nodeID: string, itemKey: string): Promise<boolean> {
    return Boolean(await this.db.selectFrom("sync_exclusions").select("item_key").where("binding_id", "=", bindingID).where("node_id", "=", nodeID).where("item_key", "=", itemKey).executeTakeFirst());
  }
  async preserveAndDisable(id: string): Promise<void> {
    await this.db.transaction().execute(async tx => {
      const origins = await tx.selectFrom("membership_origins as o").leftJoin("library_items as p", "p.id", "o.library_item_id")
        .select(["o.id", "o.library_id", "o.resource_id", "p.node_id"]).where("o.binding_id", "=", id).where("o.deleted_at", "is", null).execute();
      for (const origin of origins) {
        const key = `manual:${origin.library_id}:${origin.node_id ?? "root"}:${origin.resource_id}`;
        const prior = await tx.selectFrom("membership_origins").select("id").where("origin_key", "=", key).executeTakeFirst();
        if (prior) {
          await tx.updateTable("membership_origins").set({ deleted_at: null, updated_at: Date.now() }).where("id", "=", prior.id).execute();
          await tx.updateTable("membership_origins").set({ deleted_at: Date.now() }).where("id", "=", origin.id).execute();
        } else await tx.updateTable("membership_origins").set({ origin_key: key, origin_type: "manual", binding_id: null, item_link_id: null }).where("id", "=", origin.id).execute();
      }
      await tx.deleteFrom("zotero_collection_links").where("binding_id", "=", id).execute();
      await tx.deleteFrom("sync_collection_exclusions").where("binding_id", "=", id).execute();
      await tx.deleteFrom("sync_exclusions").where("binding_id", "=", id).execute();
      await tx.updateTable("zotero_bindings").set({ enabled: 0, updated_at: Date.now() }).where("id", "=", id).execute();
    });
  }
}
