import type { DatabaseContext } from "../database/unit-of-work";
import type { KnowledgeTarget } from "../shared/contracts/knowledge-library";
import { KnowledgeUserError } from "../shared/knowledge-errors";
import { t } from "../shared/localization";

/** Folder creation/moves and exclusion checks must share the caller's transaction. */
export async function canSyncFolder(tx: DatabaseContext, bindingID: string, target: KnowledgeTarget, collectionKey: string): Promise<boolean> {
  const binding = await tx.selectFrom("zotero_bindings").selectAll().where("id", "=", bindingID).where("enabled", "=", 1)
    .where("knowledge_library_id", "=", target.libraryID).executeTakeFirst();
  if (!binding || await tx.selectFrom("plugin_state").select("key").where("key", "=", `collection-sync-invalid-target:${bindingID}`).executeTakeFirst()) return false;
  const library = await tx.selectFrom("knowledge_libraries").select("id").where("id", "=", target.libraryID).where("status", "=", "active").executeTakeFirst();
  if (!library) return false;
  const links = await tx.selectFrom("zotero_collection_links").select(["node_id", "collection_key"]).where("binding_id", "=", bindingID).execute();
  const nodes = await tx.selectFrom("library_nodes").select(["id", "parent_id", "deleted_at"]).where("library_id", "=", target.libraryID).execute();
  const parents = new Map(nodes.map(node => [node.id, node])), ancestors = new Set<string>();
  for (let id = target.nodeID; id && !ancestors.has(id);) {
    const node = parents.get(id); if (!node || node.deleted_at !== null) return false;
    ancestors.add(id); id = node.parent_id;
  }
  if (collectionKey === binding.collection_key) {
    if (target.nodeID !== binding.target_node_id) return false;
  } else if (!target.nodeID || !links.some(link => link.node_id === target.nodeID)
    || (binding.target_node_id && !ancestors.has(binding.target_node_id))) return false;
  if (binding.sync_mode === "mirror") return true;
  const excluded = await tx.selectFrom("sync_collection_exclusions").select("collection_key").where("binding_id", "=", bindingID).execute();
  return !excluded.some(folder => folder.collection_key === collectionKey
    || links.some(link => link.collection_key === folder.collection_key && ancestors.has(link.node_id)));
}

/** Recheck local intent inside the admission transaction before any writes. */
export async function canSyncAdmit(tx: DatabaseContext, bindingID: string, target: KnowledgeTarget, itemKey: string): Promise<boolean> {
  const binding = await tx.selectFrom("zotero_bindings").selectAll().where("id", "=", bindingID).where("enabled", "=", 1)
    .where("knowledge_library_id", "=", target.libraryID).executeTakeFirst();
  if (!binding || !target.nodeID || await tx.selectFrom("plugin_state").select("key")
    .where("key", "=", `collection-sync-invalid-target:${bindingID}`).executeTakeFirst()) return false;
  const links = await tx.selectFrom("zotero_collection_links").select(["node_id", "collection_key"]).where("binding_id", "=", bindingID).execute();
  const nodes = await tx.selectFrom("library_nodes").select(["id", "parent_id", "deleted_at"]).where("library_id", "=", target.libraryID).execute();
  const parents = new Map(nodes.map(node => [node.id, node]));
  const ancestors = new Set<string>();
  for (let id: string | null = target.nodeID; id && !ancestors.has(id);) {
    const node = parents.get(id); if (!node || node.deleted_at !== null) return false;
    ancestors.add(id); id = node.parent_id;
  }
  if (!links.some(link => link.node_id === target.nodeID) || (binding.target_node_id && !ancestors.has(binding.target_node_id))) return false;
  if (binding.sync_mode === "mirror") return true;
  const excluded = await tx.selectFrom("sync_exclusions").select("item_key").where("binding_id", "=", bindingID)
    .where("node_id", "=", target.nodeID).where("item_key", "=", itemKey).executeTakeFirst();
  if (excluded) return false;
  const folders = await tx.selectFrom("sync_collection_exclusions").select("collection_key").where("binding_id", "=", bindingID).execute();
  return !folders.some(folder => links.some(link => link.collection_key === folder.collection_key && ancestors.has(link.node_id)));
}

export async function assertSyncDestination(tx: DatabaseContext, id: string): Promise<void> {
  const binding = await tx.selectFrom("zotero_bindings").selectAll().where("id", "=", id).executeTakeFirst();
  if (!binding || await tx.selectFrom("plugin_state").select("key").where("key", "=", `collection-sync-invalid-target:${id}`).executeTakeFirst()) {
    throw new KnowledgeUserError(t("error-target-folder"));
  }
  const library = await tx.selectFrom("knowledge_libraries").select("id").where("id", "=", binding.knowledge_library_id).where("status", "=", "active").executeTakeFirst();
  if (!library) throw new KnowledgeUserError(t("error-target-library"));
  if (binding.target_node_id && !await tx.selectFrom("library_nodes").select("id").where("id", "=", binding.target_node_id)
    .where("deleted_at", "is", null).executeTakeFirst()) throw new KnowledgeUserError(t("error-target-folder"));
}

/** Mirror restrictions apply to every mutation path, including drag and drop. */
export async function assertEditable(tx: DatabaseContext, target: KnowledgeTarget, subtree = false): Promise<void> {
  const links = await tx.selectFrom("zotero_collection_links as c").innerJoin("zotero_bindings as b", "b.id", "c.binding_id")
    .select("c.node_id").where("c.knowledge_library_id", "=", target.libraryID).where("b.sync_mode", "=", "mirror").execute();
  if (!links.length) return;
  const folders = await tx.selectFrom("library_nodes").select(["id", "parent_id"]).where("library_id", "=", target.libraryID).execute();
  const parents = new Map(folders.map(row => [row.id, row.parent_id]));
  const ancestors = (node: string | null): Set<string> => { const ids = new Set<string>(); for (; node && !ids.has(node); node = parents.get(node) ?? null) ids.add(node); return ids; };
  const selected = ancestors(target.nodeID);
  if (links.some(link => selected.has(link.node_id) || (subtree && (!target.nodeID || ancestors(link.node_id).has(target.nodeID))))) throw new KnowledgeUserError(t("sync-mirror-readonly"));
}

export async function excludeOrigin(tx: DatabaseContext, originID: string): Promise<void> {
  const row = await tx.selectFrom("membership_origins as o").innerJoin("library_items as p", "p.id", "o.library_item_id")
    .innerJoin("zotero_item_links as i", "i.id", "o.item_link_id").select(["o.binding_id", "p.node_id", "i.item_key"]).where("o.id", "=", originID).executeTakeFirst();
  if (!row?.binding_id) return;
  await tx.insertInto("sync_exclusions").values({ binding_id: row.binding_id, node_id: row.node_id, item_key: row.item_key, created_at: Date.now() })
    .onConflict(c => c.columns(["binding_id", "node_id", "item_key"]).doNothing()).execute();
}
