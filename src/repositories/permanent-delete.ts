import { sql } from "kysely";
import type { DatabaseContext } from "../database/unit-of-work";
import { readerCacheJournalKey } from "../storage/reader-cache-cleanup";

/** Caller owns the Trash transaction. All constraints are checked at commit. */
export async function purgeResource(tx: DatabaseContext, id: string): Promise<boolean> {
  const membership = await tx.selectFrom("library_resources").select("id").where("resource_id", "=", id).where("deleted_at", "is", null).executeTakeFirst();
  const recovery = await tx.selectFrom("knowledge_trash_resources").select("entry_id").where("resource_id", "=", id).executeTakeFirst();
  const reference = await tx.selectFrom("resource_references").select("id").where("target_resource_id", "=", id).where("resource_id", "!=", id).executeTakeFirst();
  if (membership || recovery || reference) return false;
  const targets = await tx.selectFrom("resource_references").select("target_resource_id").where("resource_id", "=", id).where("target_resource_id", "is not", null).execute();
  await sql`PRAGMA defer_foreign_keys = ON`.execute(tx);
  await tx.insertInto("resource_purge_scope").values({ resource_id: id }).execute();
  const files = await sql<{ id: string; relative_path: string }>`SELECT DISTINCT f.id, f.relative_path FROM stored_files f WHERE
    f.id IN (SELECT stored_file_id FROM resource_sources WHERE resource_id = ${id}) OR
    f.id IN (SELECT stored_file_id FROM generation_files WHERE generation_id IN (SELECT id FROM content_generations WHERE resource_id = ${id})) OR
    f.id IN (SELECT stored_file_id FROM parse_artifacts WHERE parse_run_id IN (SELECT id FROM parse_runs WHERE resource_id = ${id}))`.execute(tx);
  const jobs = await tx.selectFrom("processing_jobs").select("id").where("resource_id", "=", id).execute();
  const attachments = await tx.selectFrom("zotero_item_links as i").innerJoin("zotero_libraries as l", "l.id", "i.zotero_library_id")
    .select(["i.item_key", "l.local_library_id"]).where("i.resource_id", "=", id).where("i.item_kind", "=", "attachment").execute();
  const queue = async (path: string) => {
    if (path.startsWith("reader-content/")) await tx.deleteFrom("plugin_state").where("key", "=", readerCacheJournalKey(path)).execute();
    await tx.insertInto("file_cleanup").values({ relative_path: path, created_at: Date.now() }).onConflict(c => c.column("relative_path").doNothing()).execute();
  };
  for (const job of jobs) await queue(`parse/${job.id}`);
  for (const item of attachments) { await queue(`reader-content/${item.local_library_id}-${item.item_key}.json`); await queue(`reader-content/${item.local_library_id}-${item.item_key}.json.tmp`); }
  // Deferred constraints permit the resource/source/generation/job cycles to be removed atomically.
  await sql`DELETE FROM vector_index_entries WHERE embedding_id IN (SELECT id FROM block_embeddings WHERE generation_id IN (SELECT id FROM content_generations WHERE resource_id = ${id}))`.execute(tx);
  for (const table of ["block_embeddings", "generation_files", "content_blocks", "structure_nodes"] as const) {
    await tx.deleteFrom(table).where("generation_id", "in", tx.selectFrom("content_generations").select("id").where("resource_id", "=", id)).execute();
  }
  await tx.deleteFrom("parse_artifacts").where("parse_run_id", "in", tx.selectFrom("parse_runs").select("id").where("resource_id", "=", id)).execute();
  for (const table of ["resource_references", "resource_annotations", "resource_identifiers", "resource_revisions", "search_documents", "membership_origins"] as const) {
    await tx.deleteFrom(table).where("resource_id", "=", id).execute();
  }
  await tx.deleteFrom("library_items").where("library_resource_id", "in", tx.selectFrom("library_resources").select("id").where("resource_id", "=", id)).execute();
  await tx.deleteFrom("library_resources").where("resource_id", "=", id).execute();
  await tx.updateTable("zotero_bindings").set({ last_completed_scan_id: null }).where("last_completed_scan_id", "in", tx.selectFrom("processing_jobs").select("id").where("resource_id", "=", id)).execute();
  await tx.updateTable("zotero_collection_links").set({ last_seen_scan_id: null }).where("last_seen_scan_id", "in", tx.selectFrom("processing_jobs").select("id").where("resource_id", "=", id)).execute();
  await tx.deleteFrom("change_outbox").where("aggregate_type", "=", "resource_source")
    .where("aggregate_id", "in", tx.selectFrom("resource_sources").select("id").where("resource_id", "=", id)).execute();
  await sql`DELETE FROM plugin_state WHERE key IN (
    SELECT 'embedding-cancel:' || p.id || ':' || g.id FROM embedding_profiles p
    CROSS JOIN content_generations g WHERE g.resource_id = ${id})`.execute(tx);
  for (const table of ["zotero_item_links", "parse_runs", "processing_jobs", "content_generations", "resource_sources"] as const) {
    await tx.deleteFrom(table).where("resource_id", "=", id).execute();
  }
  await tx.deleteFrom("mutation_receipts").where("target_key", "=", id).execute();
  await tx.deleteFrom("change_outbox").where("aggregate_type", "=", "resource").where("aggregate_id", "=", id).execute();
  await tx.deleteFrom("knowledge_resources").where("id", "=", id).execute();
  for (const file of files.rows) {
    const used = await sql`SELECT id FROM resource_sources WHERE stored_file_id = ${file.id}
      UNION ALL SELECT generation_id FROM generation_files WHERE stored_file_id = ${file.id}
      UNION ALL SELECT id FROM parse_artifacts WHERE stored_file_id = ${file.id} LIMIT 1`.execute(tx);
    if (!used.rows.length) { await queue(file.relative_path); await tx.deleteFrom("stored_files").where("id", "=", file.id).execute(); }
  }
  await tx.deleteFrom("resource_purge_scope").where("resource_id", "=", id).execute();
  for (const target of targets) if (target.target_resource_id && target.target_resource_id !== id) {
    const retained = await tx.selectFrom("knowledge_resources").select("id").where("id", "=", target.target_resource_id).executeTakeFirst();
    if (retained) await purgeResource(tx, retained.id);
  }
  return true;
}

/** Remove unreferenced relational tombstones even when their shared resource survives. */
export async function purgeMemberships(tx: DatabaseContext): Promise<void> {
  await tx.deleteFrom("membership_origins").where("deleted_at", "is not", null)
    .where("id", "not in", tx.selectFrom("knowledge_trash_origins").select("origin_id")).execute();
  await tx.deleteFrom("library_items").where("deleted_at", "is not", null)
    .where("id", "not in", tx.selectFrom("knowledge_trash_placements").select("library_item_id"))
    .where("id", "not in", tx.selectFrom("membership_origins").select("library_item_id").where("library_item_id", "is not", null)).execute();
  await tx.deleteFrom("library_resources").where("deleted_at", "is not", null)
    .where("id", "not in", tx.selectFrom("knowledge_trash_relations").select("library_resource_id"))
    .where("id", "not in", tx.selectFrom("membership_origins").select("library_resource_id"))
    .where("id", "not in", tx.selectFrom("library_items").select("library_resource_id")).execute();
}

/** Container records survive only while another recovery or live record needs them. */
export async function purgeContainers(tx: DatabaseContext, folderIDs: Set<string>, libraryIDs: Set<string>): Promise<void> {
  for (const id of folderIDs) {
    const invalidated = await tx.selectFrom("zotero_bindings").select("id").where("target_node_id", "=", id).execute();
    for (const binding of invalidated) await tx.insertInto("plugin_state").values({ key: `collection-sync-invalid-target:${binding.id}`,
      value_json: JSON.stringify({ deletedNodeID: id }), updated_at: Date.now() }).onConflict(c => c.column("key").doNothing()).execute();
    await tx.deleteFrom("sync_exclusions").where("node_id", "=", id).execute();
    await tx.deleteFrom("zotero_collection_links").where("node_id", "=", id).execute();
    await tx.updateTable("zotero_bindings").set({ enabled: 0, target_node_id: null }).where("target_node_id", "=", id).execute();
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of folderIDs) {
      const result = await sql`DELETE FROM library_nodes WHERE id = ${id} AND deleted_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM library_nodes c WHERE c.parent_id = library_nodes.id)
        AND NOT EXISTS (SELECT 1 FROM library_items p WHERE p.node_id = library_nodes.id)
        AND NOT EXISTS (SELECT 1 FROM knowledge_trash_entries t WHERE t.node_id = library_nodes.id)
        AND NOT EXISTS (SELECT 1 FROM knowledge_trash_folders t WHERE t.node_id = library_nodes.id)`.execute(tx);
      if (Number(result.numAffectedRows)) { changed = true; folderIDs.delete(id); }
    }
  }
  for (const id of libraryIDs) {
    await tx.updateTable("zotero_bindings").set({ enabled: 0 }).where("knowledge_library_id", "=", id).execute();
    const bindings = await tx.selectFrom("zotero_bindings").select("id").where("knowledge_library_id", "=", id).execute();
    for (const binding of bindings) {
      const origin = await tx.selectFrom("membership_origins").select("id").where("binding_id", "=", binding.id).executeTakeFirst();
      const job = await tx.selectFrom("processing_jobs").select("id").where("binding_id", "=", binding.id).executeTakeFirst();
      if (origin || job) continue;
      await tx.deleteFrom("zotero_collection_links").where("binding_id", "=", binding.id).execute();
      await tx.deleteFrom("sync_exclusions").where("binding_id", "=", binding.id).execute();
      await tx.deleteFrom("sync_collection_exclusions").where("binding_id", "=", binding.id).execute();
      await tx.deleteFrom("plugin_state").where("key", "=", `collection-sync:${binding.id}`).execute();
      await tx.deleteFrom("plugin_state").where("key", "=", `collection-sync-invalid-target:${binding.id}`).execute();
      await tx.deleteFrom("zotero_bindings").where("id", "=", binding.id).execute();
    }
    await tx.deleteFrom("mcp_token_libraries").where("library_id", "=", id).execute();
    await sql`DELETE FROM knowledge_libraries WHERE id = ${id} AND deleted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM library_nodes n WHERE n.library_id = knowledge_libraries.id)
      AND NOT EXISTS (SELECT 1 FROM library_resources m WHERE m.library_id = knowledge_libraries.id)
      AND NOT EXISTS (SELECT 1 FROM knowledge_trash_entries t WHERE t.library_id = knowledge_libraries.id)
      AND NOT EXISTS (SELECT 1 FROM zotero_bindings b WHERE b.knowledge_library_id = knowledge_libraries.id)`.execute(tx);
  }
}
