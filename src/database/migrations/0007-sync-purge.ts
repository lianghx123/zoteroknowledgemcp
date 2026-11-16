// Frozen schema baseline. Append migrations after release; do not edit history.
import { sql, type Kysely } from "kysely";

export const checksum = "be158af860518cc1de7aed7c277a3dd421687b32190ceda66453d145d3519942";
export const statements: readonly string[] = [
  "ALTER TABLE zotero_bindings ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'flexible' CHECK (sync_mode IN ('mirror', 'flexible', 'append'));",
  "CREATE TABLE sync_exclusions (\n  binding_id TEXT NOT NULL REFERENCES zotero_bindings(id),\n  node_id TEXT NOT NULL REFERENCES library_nodes(id),\n  item_key TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY (binding_id, node_id, item_key)\n) STRICT;",
  "CREATE TABLE file_cleanup (\n  relative_path TEXT PRIMARY KEY NOT NULL,\n  created_at INTEGER NOT NULL\n) STRICT;",
  "CREATE TABLE resource_purge_scope (\n  resource_id TEXT PRIMARY KEY NOT NULL\n) STRICT;",
  "DROP TRIGGER node_staging_delete;",
  "DROP TRIGGER block_staging_delete;",
  "DROP TRIGGER asset_staging_delete;",
  "DROP TRIGGER revision_append_only_delete;",
  "CREATE TRIGGER node_staging_delete BEFORE DELETE ON structure_nodes\nWHEN NOT EXISTS (SELECT 1 FROM content_generations g WHERE g.id = OLD.generation_id\n  AND (g.state = 'staging' OR EXISTS (SELECT 1 FROM resource_purge_scope p WHERE p.resource_id = g.resource_id)))\nBEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;",
  "CREATE TRIGGER block_staging_delete BEFORE DELETE ON content_blocks\nWHEN NOT EXISTS (SELECT 1 FROM content_generations g WHERE g.id = OLD.generation_id\n  AND (g.state = 'staging' OR EXISTS (SELECT 1 FROM resource_purge_scope p WHERE p.resource_id = g.resource_id)))\nBEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;",
  "CREATE TRIGGER asset_staging_delete BEFORE DELETE ON generation_files\nWHEN NOT EXISTS (SELECT 1 FROM content_generations g WHERE g.id = OLD.generation_id\n  AND (g.state = 'staging' OR EXISTS (SELECT 1 FROM resource_purge_scope p WHERE p.resource_id = g.resource_id)))\nBEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;",
  "CREATE TRIGGER revision_append_only_delete BEFORE DELETE ON resource_revisions\nWHEN NOT EXISTS (SELECT 1 FROM resource_purge_scope WHERE resource_id = OLD.resource_id)\nBEGIN SELECT RAISE(ABORT, 'REVISION_APPEND_ONLY'); END;"
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
  await sql`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (${"migration-checksum:0007-sync-purge"}, ${JSON.stringify(checksum)}, ${Date.now()})`.execute(db);
}
