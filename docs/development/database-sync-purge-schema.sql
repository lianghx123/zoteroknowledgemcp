-- Sync policy, local exclusions and recoverable plugin-owned file cleanup.
ALTER TABLE zotero_bindings ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'flexible' CHECK (sync_mode IN ('mirror', 'flexible', 'append'));

CREATE TABLE sync_exclusions (
  binding_id TEXT NOT NULL REFERENCES zotero_bindings(id),
  node_id TEXT NOT NULL REFERENCES library_nodes(id),
  item_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (binding_id, node_id, item_key)
) STRICT;

CREATE TABLE file_cleanup (
  relative_path TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- Transaction-local authorization, emptied before commit. Never used by publication.
CREATE TABLE resource_purge_scope (
  resource_id TEXT PRIMARY KEY NOT NULL
) STRICT;

DROP TRIGGER node_staging_delete;
DROP TRIGGER block_staging_delete;
DROP TRIGGER asset_staging_delete;
DROP TRIGGER revision_append_only_delete;

CREATE TRIGGER node_staging_delete BEFORE DELETE ON structure_nodes
WHEN NOT EXISTS (SELECT 1 FROM content_generations g WHERE g.id = OLD.generation_id
  AND (g.state = 'staging' OR EXISTS (SELECT 1 FROM resource_purge_scope p WHERE p.resource_id = g.resource_id)))
BEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;

CREATE TRIGGER block_staging_delete BEFORE DELETE ON content_blocks
WHEN NOT EXISTS (SELECT 1 FROM content_generations g WHERE g.id = OLD.generation_id
  AND (g.state = 'staging' OR EXISTS (SELECT 1 FROM resource_purge_scope p WHERE p.resource_id = g.resource_id)))
BEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;

CREATE TRIGGER asset_staging_delete BEFORE DELETE ON generation_files
WHEN NOT EXISTS (SELECT 1 FROM content_generations g WHERE g.id = OLD.generation_id
  AND (g.state = 'staging' OR EXISTS (SELECT 1 FROM resource_purge_scope p WHERE p.resource_id = g.resource_id)))
BEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;

CREATE TRIGGER revision_append_only_delete BEFORE DELETE ON resource_revisions
WHEN NOT EXISTS (SELECT 1 FROM resource_purge_scope WHERE resource_id = OLD.resource_id)
BEGIN SELECT RAISE(ABORT, 'REVISION_APPEND_ONLY'); END;
