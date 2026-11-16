-- Design revision 2, 2026-10-19. Review/validation DDL, not an installed migration.
-- Execute only against a new disposable database. No Zotero tables are accessed.
-- IDs are application-generated UUIDs; timestamps are UTC Unix milliseconds.
-- Requires STRICT tables and JSON functions; verify both in Zotero before use.
PRAGMA foreign_keys = ON;

-- Reserve Kysely Migrator's metadata shapes; fixtures record no applied migrations.
-- Runtime creation belongs to Migrator, not the initial business-schema migration.
CREATE TABLE kysely_migration (
  name VARCHAR(255) NOT NULL PRIMARY KEY,
  timestamp VARCHAR(255) NOT NULL
);

CREATE TABLE kysely_migration_lock (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  is_locked INTEGER DEFAULT 0 NOT NULL
);

CREATE TABLE plugin_state (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE knowledge_libraries (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 255),
  description TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX uq_library_name ON knowledge_libraries(name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_default_library ON knowledge_libraries(is_default) WHERE is_default = 1 AND deleted_at IS NULL;

CREATE TABLE library_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES knowledge_libraries(id),
  parent_id TEXT,
  node_type TEXT NOT NULL CHECK (node_type IN ('folder', 'collection', 'smart_collection')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 255),
  description TEXT,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  query_json TEXT CHECK (query_json IS NULL OR (json_valid(query_json) AND json_type(query_json) = 'object')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (id, library_id),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK ((node_type = 'smart_collection') = (query_json IS NOT NULL)),
  FOREIGN KEY (parent_id, library_id) REFERENCES library_nodes(id, library_id)
) STRICT;
CREATE UNIQUE INDEX uq_node_root_name ON library_nodes(library_id, name) WHERE parent_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_node_child_name ON library_nodes(library_id, parent_id, name) WHERE parent_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_node_tree ON library_nodes(library_id, parent_id, sort_order);

CREATE TABLE knowledge_resources (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 1000),
  subtitle TEXT,
  resource_type TEXT NOT NULL,
  language TEXT,
  abstract TEXT,
  summary TEXT,
  publication_date TEXT,
  contributors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(contributors_json) AND json_type(contributors_json) = 'array'),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  metadata_authority TEXT NOT NULL CHECK (metadata_authority IN ('zotero', 'local', 'import')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  canonical_source_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  metadata_version INTEGER NOT NULL DEFAULT 1 CHECK (metadata_version > 0),
  metadata_fingerprint TEXT CHECK (metadata_fingerprint IS NULL OR length(metadata_fingerprint) = 64),
  metadata_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (metadata_schema_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  FOREIGN KEY (canonical_source_id, id) REFERENCES resource_sources(id, resource_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX ix_resource_status ON knowledge_resources(status, updated_at);

CREATE TABLE resource_identifiers (
  id TEXT PRIMARY KEY NOT NULL,
  resource_id TEXT NOT NULL REFERENCES knowledge_resources(id),
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at INTEGER NOT NULL,
  UNIQUE (resource_id, identifier_type, normalized_value)
) STRICT;
CREATE INDEX ix_identifier_lookup ON resource_identifiers(identifier_type, normalized_value);
CREATE UNIQUE INDEX uq_primary_identifier ON resource_identifiers(resource_id, identifier_type) WHERE is_primary = 1;

CREATE TABLE stored_files (
  id TEXT PRIMARY KEY NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  original_name TEXT,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('staged', 'available', 'missing', 'deleting')),
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  CHECK (relative_path <> '' AND substr(relative_path, 1, 1) <> '/'),
  CHECK (instr(relative_path, char(92)) = 0 AND instr(relative_path, ':') = 0),
  CHECK (instr('/' || relative_path || '/', '/../') = 0 AND instr('/' || relative_path || '/', '/./') = 0)
) STRICT;
CREATE INDEX ix_file_hash ON stored_files(sha256, byte_length);

CREATE TABLE resource_sources (
  id TEXT PRIMARY KEY NOT NULL,
  resource_id TEXT NOT NULL REFERENCES knowledge_resources(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('zotero_attachment', 'file', 'url', 'manual', 'external_api', 'imported_text', 'zotero_note')),
  source_role TEXT NOT NULL CHECK (source_role IN ('primary_document', 'metadata_record', 'supplementary', 'attachment', 'web_snapshot', 'cover_image', 'other')),
  availability TEXT NOT NULL DEFAULT 'pending' CHECK (availability IN ('pending', 'fetching', 'available', 'failed', 'missing', 'deleted')),
  stored_file_id TEXT REFERENCES stored_files(id),
  uri TEXT,
  text_content TEXT,
  media_type TEXT,
  version_label TEXT,
  source_version INTEGER NOT NULL DEFAULT 1 CHECK (source_version > 0),
  content_version INTEGER NOT NULL DEFAULT 0 CHECK (content_version >= 0),
  source_fingerprint TEXT CHECK (source_fingerprint IS NULL OR length(source_fingerprint) = 64),
  fingerprint_algorithm TEXT,
  active_generation_id TEXT,
  last_checked_at INTEGER,
  error_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (id, resource_id),
  CHECK ((availability = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK (source_type <> 'file' OR stored_file_id IS NOT NULL),
  CHECK (source_type <> 'zotero_attachment' OR stored_file_id IS NULL),
  CHECK (source_type NOT IN ('url', 'external_api') OR uri IS NOT NULL),
  CHECK (source_type NOT IN ('manual', 'imported_text', 'zotero_note') OR text_content IS NOT NULL),
  CHECK ((active_generation_id IS NULL AND content_version = 0) OR (active_generation_id IS NOT NULL AND content_version > 0)),
  FOREIGN KEY (active_generation_id, id, resource_id) REFERENCES content_generations(id, source_id, resource_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX ix_source_resource ON resource_sources(resource_id, availability);

CREATE TABLE zotero_libraries (
  id TEXT PRIMARY KEY NOT NULL,
  library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group')),
  local_library_id INTEGER NOT NULL UNIQUE,
  external_library_id TEXT,
  display_name TEXT NOT NULL,
  is_editable INTEGER NOT NULL CHECK (is_editable IN (0, 1)),
  files_editable INTEGER NOT NULL CHECK (files_editable IN (0, 1)),
  availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable', 'removed')),
  last_checked_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE zotero_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  zotero_library_id TEXT NOT NULL REFERENCES zotero_libraries(id),
  knowledge_library_id TEXT NOT NULL REFERENCES knowledge_libraries(id),
  target_node_id TEXT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('library', 'collection')),
  collection_key TEXT,
  include_descendants INTEGER NOT NULL DEFAULT 1 CHECK (include_descendants IN (0, 1)),
  processing_policy TEXT NOT NULL DEFAULT 'manual' CHECK (processing_policy IN ('manual', 'automatic')),
  parser_profile_id TEXT REFERENCES provider_profiles(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  last_completed_scan_id TEXT REFERENCES processing_jobs(id),
  last_reconciled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, zotero_library_id),
  UNIQUE (id, knowledge_library_id),
  CHECK ((scope_type = 'collection') = (collection_key IS NOT NULL)),
  FOREIGN KEY (target_node_id, knowledge_library_id) REFERENCES library_nodes(id, library_id)
) STRICT;

CREATE TABLE zotero_item_links (
  id TEXT PRIMARY KEY NOT NULL,
  zotero_library_id TEXT NOT NULL REFERENCES zotero_libraries(id),
  item_key TEXT NOT NULL,
  local_item_id INTEGER,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('regular', 'attachment', 'note')),
  parent_item_key TEXT,
  resource_id TEXT NOT NULL REFERENCES knowledge_resources(id),
  source_id TEXT,
  is_anchor INTEGER NOT NULL DEFAULT 0 CHECK (is_anchor IN (0, 1)),
  native_version INTEGER,
  native_modified_at TEXT,
  metadata_fingerprint TEXT CHECK (metadata_fingerprint IS NULL OR length(metadata_fingerprint) = 64),
  cached_file_path TEXT,
  file_size INTEGER CHECK (file_size IS NULL OR file_size >= 0),
  file_modified_at INTEGER,
  state TEXT NOT NULL CHECK (state IN ('current', 'trashed', 'deleted', 'unavailable')),
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (zotero_library_id, item_key),
  UNIQUE (id, resource_id),
  CHECK ((item_kind = 'regular' AND source_id IS NULL AND is_anchor = 1) OR (item_kind IN ('attachment', 'note') AND source_id IS NOT NULL)),
  FOREIGN KEY (source_id, resource_id) REFERENCES resource_sources(id, resource_id)
) STRICT;
CREATE UNIQUE INDEX uq_item_source ON zotero_item_links(source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX uq_resource_anchor ON zotero_item_links(resource_id) WHERE is_anchor = 1;
CREATE INDEX ix_item_resource ON zotero_item_links(resource_id);

CREATE TABLE zotero_collection_links (
  id TEXT PRIMARY KEY NOT NULL,
  binding_id TEXT NOT NULL,
  zotero_library_id TEXT NOT NULL,
  collection_key TEXT NOT NULL,
  parent_collection_key TEXT,
  local_collection_id INTEGER,
  knowledge_library_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  last_seen_scan_id TEXT REFERENCES processing_jobs(id),
  state TEXT NOT NULL CHECK (state IN ('current', 'removed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (binding_id, collection_key),
  UNIQUE (binding_id, node_id),
  FOREIGN KEY (binding_id, zotero_library_id) REFERENCES zotero_bindings(id, zotero_library_id),
  FOREIGN KEY (binding_id, knowledge_library_id) REFERENCES zotero_bindings(id, knowledge_library_id),
  FOREIGN KEY (node_id, knowledge_library_id) REFERENCES library_nodes(id, library_id)
) STRICT;

CREATE TABLE library_resources (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES knowledge_libraries(id),
  resource_id TEXT NOT NULL REFERENCES knowledge_resources(id),
  added_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (library_id, resource_id),
  UNIQUE (id, library_id, resource_id),
  UNIQUE (id, library_id)
) STRICT;
CREATE INDEX ix_membership_resource ON library_resources(resource_id, deleted_at);

CREATE TABLE library_items (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  library_resource_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  added_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (node_id, library_resource_id),
  UNIQUE (id, library_resource_id),
  FOREIGN KEY (node_id, library_id) REFERENCES library_nodes(id, library_id),
  FOREIGN KEY (library_resource_id, library_id) REFERENCES library_resources(id, library_id)
) STRICT;
CREATE INDEX ix_placement_order ON library_items(node_id, sort_order);

CREATE TABLE membership_origins (
  id TEXT PRIMARY KEY NOT NULL,
  origin_key TEXT NOT NULL UNIQUE,
  library_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  library_resource_id TEXT NOT NULL,
  library_item_id TEXT,
  origin_type TEXT NOT NULL CHECK (origin_type IN ('manual', 'zotero')),
  binding_id TEXT,
  item_link_id TEXT,
  last_seen_scan_id TEXT REFERENCES processing_jobs(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK ((origin_type = 'zotero' AND binding_id IS NOT NULL AND item_link_id IS NOT NULL) OR (origin_type = 'manual' AND binding_id IS NULL AND item_link_id IS NULL)),
  FOREIGN KEY (library_resource_id, library_id, resource_id) REFERENCES library_resources(id, library_id, resource_id),
  FOREIGN KEY (library_item_id, library_resource_id) REFERENCES library_items(id, library_resource_id),
  FOREIGN KEY (binding_id, library_id) REFERENCES zotero_bindings(id, knowledge_library_id),
  FOREIGN KEY (item_link_id, resource_id) REFERENCES zotero_item_links(id, resource_id)
) STRICT;
CREATE INDEX ix_origin_scan ON membership_origins(binding_id, last_seen_scan_id, deleted_at);

CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('parse', 'embedding', 'rerank')),
  adapter_key TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  credential_ref TEXT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
  configuration_hash TEXT NOT NULL CHECK (length(configuration_hash) = 64),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (id, kind)
) STRICT;

CREATE TABLE processing_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reconcile', 'parse', 'embed', 'index', 'maintenance')),
  dedup_key TEXT NOT NULL,
  resource_id TEXT REFERENCES knowledge_resources(id),
  source_id TEXT,
  generation_id TEXT,
  binding_id TEXT REFERENCES zotero_bindings(id),
  embedding_profile_id TEXT REFERENCES embedding_profiles(id),
  expected_source_version INTEGER CHECK (expected_source_version IS NULL OR expected_source_version > 0),
  expected_content_version INTEGER CHECK (expected_content_version IS NULL OR expected_content_version >= 0),
  input_fingerprint TEXT CHECK (input_fingerprint IS NULL OR length(input_fingerprint) = 64),
  payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version > 0),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  checkpoint_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checkpoint_json) AND json_type(checkpoint_json) = 'object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'waiting', 'retry_wait', 'needs_attention', 'succeeded', 'partially_succeeded', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  max_failures INTEGER NOT NULL DEFAULT 5 CHECK (max_failures > 0),
  lease_owner TEXT,
  execution_token TEXT,
  lease_expires_at INTEGER,
  heartbeat_at INTEGER,
  cancel_requested_at INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (id, source_id, resource_id),
  CHECK (source_id IS NULL OR resource_id IS NOT NULL),
  CHECK (generation_id IS NULL OR source_id IS NOT NULL),
  CHECK (kind <> 'reconcile' OR binding_id IS NOT NULL),
  CHECK (kind <> 'parse' OR source_id IS NOT NULL),
  CHECK (kind <> 'embed' OR (generation_id IS NOT NULL AND embedding_profile_id IS NOT NULL)),
  CHECK ((state = 'running' AND lease_owner IS NOT NULL AND execution_token IS NOT NULL AND lease_expires_at IS NOT NULL AND started_at IS NOT NULL) OR (state <> 'running' AND lease_owner IS NULL AND execution_token IS NULL AND lease_expires_at IS NULL)),
  CHECK ((state IN ('succeeded', 'partially_succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  FOREIGN KEY (source_id, resource_id) REFERENCES resource_sources(id, resource_id),
  FOREIGN KEY (generation_id, source_id, resource_id) REFERENCES content_generations(id, source_id, resource_id)
) STRICT;
CREATE UNIQUE INDEX uq_live_job ON processing_jobs(kind, dedup_key) WHERE state IN ('pending', 'running', 'waiting', 'retry_wait', 'needs_attention');
CREATE INDEX ix_job_due ON processing_jobs(state, next_run_at, priority DESC, created_at);
CREATE INDEX ix_job_lease ON processing_jobs(state, lease_expires_at);
CREATE INDEX ix_job_resource ON processing_jobs(resource_id, created_at);

CREATE TABLE parse_runs (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  resource_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('service', 'import', 'local_text')),
  provider_profile_id TEXT REFERENCES provider_profiles(id),
  parser_name TEXT NOT NULL,
  parser_version TEXT,
  normalizer_version TEXT NOT NULL,
  result_schema_version TEXT,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
  base_content_version INTEGER NOT NULL CHECK (base_content_version >= 0),
  base_generation_id TEXT,
  submission_key TEXT NOT NULL UNIQUE,
  submission_state TEXT NOT NULL CHECK (submission_state IN ('not_applicable', 'not_submitted', 'submitting', 'confirmed', 'ambiguous')),
  external_job_id TEXT,
  stage TEXT NOT NULL,
  progress_current INTEGER CHECK (progress_current IS NULL OR progress_current >= 0),
  progress_total INTEGER CHECK (progress_total IS NULL OR progress_total >= 0),
  result_fingerprint TEXT CHECK (result_fingerprint IS NULL OR length(result_fingerprint) = 64),
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, source_id, resource_id),
  CHECK ((mode = 'service') = (provider_profile_id IS NOT NULL)),
  CHECK (mode = 'service' OR (external_job_id IS NULL AND submission_state = 'not_applicable')),
  CHECK (submission_state <> 'confirmed' OR external_job_id IS NOT NULL),
  CHECK (progress_current IS NULL OR progress_total IS NULL OR progress_current <= progress_total),
  FOREIGN KEY (job_id, source_id, resource_id) REFERENCES processing_jobs(id, source_id, resource_id),
  FOREIGN KEY (source_id, resource_id) REFERENCES resource_sources(id, resource_id),
  FOREIGN KEY (base_generation_id, source_id, resource_id) REFERENCES content_generations(id, source_id, resource_id)
) STRICT;
CREATE UNIQUE INDEX uq_remote_parse_job ON parse_runs(provider_profile_id, external_job_id) WHERE external_job_id IS NOT NULL;

CREATE TABLE parse_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  parse_run_id TEXT NOT NULL REFERENCES parse_runs(id),
  artifact_key TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  stored_file_id TEXT NOT NULL REFERENCES stored_files(id),
  page_number INTEGER CHECK (page_number IS NULL OR page_number > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at INTEGER NOT NULL,
  UNIQUE (parse_run_id, artifact_key)
) STRICT;

CREATE TABLE content_generations (
  id TEXT PRIMARY KEY NOT NULL,
  resource_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  parse_run_id TEXT,
  base_generation_id TEXT,
  base_content_version INTEGER NOT NULL CHECK (base_content_version >= 0),
  content_version INTEGER NOT NULL CHECK (content_version = base_content_version + 1),
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
  origin TEXT NOT NULL CHECK (origin IN ('parse', 'import', 'manual', 'edit')),
  state TEXT NOT NULL DEFAULT 'staging' CHECK (state IN ('staging', 'ready', 'partial', 'superseded', 'failed')),
  content_fingerprint TEXT CHECK (content_fingerprint IS NULL OR length(content_fingerprint) = 64),
  normalizer_version TEXT NOT NULL,
  page_manifest_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(page_manifest_json) AND json_type(page_manifest_json) = 'array'),
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array'),
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (id, source_id, resource_id),
  CHECK ((state IN ('ready', 'partial', 'superseded')) = (published_at IS NOT NULL)),
  CHECK (state NOT IN ('ready', 'partial', 'superseded') OR content_fingerprint IS NOT NULL),
  FOREIGN KEY (source_id, resource_id) REFERENCES resource_sources(id, resource_id),
  FOREIGN KEY (parse_run_id, source_id, resource_id) REFERENCES parse_runs(id, source_id, resource_id),
  FOREIGN KEY (base_generation_id, source_id, resource_id) REFERENCES content_generations(id, source_id, resource_id)
) STRICT;
CREATE UNIQUE INDEX uq_published_content_version ON content_generations(source_id, content_version) WHERE state IN ('ready', 'partial', 'superseded');
CREATE INDEX ix_generation_source ON content_generations(source_id, created_at);

CREATE TABLE generation_files (
  generation_id TEXT NOT NULL REFERENCES content_generations(id),
  asset_key TEXT NOT NULL,
  stored_file_id TEXT NOT NULL REFERENCES stored_files(id),
  role TEXT NOT NULL,
  PRIMARY KEY (generation_id, asset_key)
) STRICT;

CREATE TABLE structure_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  generation_id TEXT NOT NULL REFERENCES content_generations(id),
  parent_id TEXT,
  node_type TEXT NOT NULL,
  label TEXT,
  path TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  canonical_order_start INTEGER CHECK (canonical_order_start IS NULL OR canonical_order_start >= 0),
  canonical_order_end INTEGER CHECK (canonical_order_end IS NULL OR canonical_order_end >= 0),
  page_start INTEGER CHECK (page_start IS NULL OR page_start > 0),
  page_end INTEGER CHECK (page_end IS NULL OR page_end > 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('ocr', 'parser', 'manual', 'agent', 'import')),
  source_ref_id TEXT,
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  review_status TEXT NOT NULL DEFAULT 'auto' CHECK (review_status IN ('auto', 'needs_review', 'reviewed', 'corrected', 'rejected')),
  is_user_modified INTEGER NOT NULL DEFAULT 0 CHECK (is_user_modified IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at INTEGER NOT NULL,
  UNIQUE (id, generation_id),
  UNIQUE (generation_id, path),
  CHECK ((depth = 0 AND node_type = 'root' AND parent_id IS NULL) OR (depth > 0 AND node_type <> 'root' AND parent_id IS NOT NULL)),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (canonical_order_start IS NULL OR canonical_order_end IS NULL OR canonical_order_start <= canonical_order_end),
  CHECK (page_start IS NULL OR page_end IS NULL OR page_start <= page_end),
  FOREIGN KEY (parent_id, generation_id) REFERENCES structure_nodes(id, generation_id)
) STRICT;
CREATE UNIQUE INDEX uq_generation_root ON structure_nodes(generation_id) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX uq_section_sibling_order ON structure_nodes(generation_id, parent_id, sort_order) WHERE parent_id IS NOT NULL;
CREATE INDEX ix_structure_read ON structure_nodes(generation_id, canonical_order_start);

CREATE TABLE content_blocks (
  id TEXT PRIMARY KEY NOT NULL,
  generation_id TEXT NOT NULL REFERENCES content_generations(id),
  structure_node_id TEXT,
  parent_block_id TEXT,
  supersedes_block_id TEXT REFERENCES content_blocks(id),
  block_type TEXT NOT NULL,
  content_role TEXT NOT NULL DEFAULT 'body' CHECK (content_role IN ('body', 'note')),
  canonical_order INTEGER NOT NULL CHECK (canonical_order >= 0),
  local_order INTEGER CHECK (local_order IS NULL OR local_order >= 0),
  content_markdown TEXT NOT NULL CHECK (length(trim(content_markdown)) > 0),
  content_normalized TEXT,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  source_type TEXT NOT NULL CHECK (source_type IN ('ocr', 'parser', 'manual', 'agent', 'import')),
  source_block_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_block_ids_json) AND json_type(source_block_ids_json) = 'array'),
  page_start INTEGER CHECK (page_start IS NULL OR page_start > 0),
  page_end INTEGER CHECK (page_end IS NULL OR page_end > 0),
  locations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(locations_json) AND json_type(locations_json) = 'array'),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  review_status TEXT NOT NULL DEFAULT 'auto' CHECK (review_status IN ('auto', 'needs_review', 'reviewed', 'corrected', 'rejected')),
  is_user_modified INTEGER NOT NULL DEFAULT 0 CHECK (is_user_modified IN (0, 1)),
  quality_flags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(quality_flags_json) AND json_type(quality_flags_json) = 'array'),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at INTEGER NOT NULL,
  UNIQUE (id, generation_id),
  UNIQUE (generation_id, canonical_order),
  UNIQUE (structure_node_id, local_order),
  CHECK ((structure_node_id IS NULL) = (local_order IS NULL)),
  CHECK (parent_block_id IS NULL OR parent_block_id <> id),
  CHECK (page_start IS NULL OR page_end IS NULL OR page_start <= page_end),
  FOREIGN KEY (structure_node_id, generation_id) REFERENCES structure_nodes(id, generation_id),
  FOREIGN KEY (parent_block_id, generation_id) REFERENCES content_blocks(id, generation_id)
) STRICT;
CREATE INDEX ix_block_section ON content_blocks(structure_node_id, local_order);
CREATE INDEX ix_block_filter ON content_blocks(generation_id, block_type, content_role, review_status);

CREATE TABLE resource_references (
  id TEXT PRIMARY KEY NOT NULL,
  resource_id TEXT NOT NULL REFERENCES knowledge_resources(id),
  source_id TEXT,
  generation_id TEXT,
  source_block_id TEXT,
  target_resource_id TEXT REFERENCES knowledge_resources(id),
  target_source_id TEXT,
  target_generation_id TEXT,
  target_block_id TEXT,
  reference_type TEXT NOT NULL CHECK (reference_type IN ('bibliography', 'citation', 'url', 'footnote', 'cross_reference', 'table_reference', 'figure_reference', 'formula_reference')),
  label TEXT,
  raw_text TEXT,
  parsed_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(parsed_json) AND json_type(parsed_json) = 'object'),
  match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched', 'matched', 'ambiguous', 'manual')),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (generation_id IS NULL OR source_id IS NOT NULL),
  CHECK (source_block_id IS NULL OR generation_id IS NOT NULL),
  CHECK (target_source_id IS NULL OR target_resource_id IS NOT NULL),
  CHECK (target_generation_id IS NULL OR target_source_id IS NOT NULL),
  CHECK (target_block_id IS NULL OR target_generation_id IS NOT NULL),
  CHECK (source_block_id IS NOT NULL OR target_resource_id IS NOT NULL OR raw_text IS NOT NULL),
  FOREIGN KEY (source_id, resource_id) REFERENCES resource_sources(id, resource_id),
  FOREIGN KEY (generation_id, source_id, resource_id) REFERENCES content_generations(id, source_id, resource_id),
  FOREIGN KEY (source_block_id, generation_id) REFERENCES content_blocks(id, generation_id),
  FOREIGN KEY (target_source_id, target_resource_id) REFERENCES resource_sources(id, resource_id),
  FOREIGN KEY (target_generation_id, target_source_id, target_resource_id) REFERENCES content_generations(id, source_id, resource_id),
  FOREIGN KEY (target_block_id, target_generation_id) REFERENCES content_blocks(id, generation_id)
) STRICT;
CREATE INDEX ix_reference_resource ON resource_references(resource_id, deleted_at, created_at);
CREATE INDEX ix_reference_target ON resource_references(target_resource_id);

CREATE TABLE resource_annotations (
  id TEXT PRIMARY KEY NOT NULL,
  resource_id TEXT NOT NULL REFERENCES knowledge_resources(id),
  source_id TEXT,
  generation_id TEXT,
  structure_node_id TEXT,
  content_block_id TEXT,
  resource_version INTEGER NOT NULL CHECK (resource_version > 0),
  annotation_type TEXT NOT NULL CHECK (annotation_type IN ('claim', 'method', 'assumption', 'limitation', 'evidence', 'question', 'contradiction', 'important', 'todo', 'summary')),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  quote TEXT,
  anchor_state TEXT NOT NULL DEFAULT 'current' CHECK (anchor_state IN ('current', 'historical', 'needs_review', 'unresolved')),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent')),
  created_by TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (generation_id IS NULL OR source_id IS NOT NULL),
  CHECK ((structure_node_id IS NULL OR content_block_id IS NULL) AND (structure_node_id IS NULL AND content_block_id IS NULL OR generation_id IS NOT NULL)),
  CHECK (quote IS NULL OR content_block_id IS NOT NULL),
  FOREIGN KEY (source_id, resource_id) REFERENCES resource_sources(id, resource_id),
  FOREIGN KEY (generation_id, source_id, resource_id) REFERENCES content_generations(id, source_id, resource_id),
  FOREIGN KEY (structure_node_id, generation_id) REFERENCES structure_nodes(id, generation_id),
  FOREIGN KEY (content_block_id, generation_id) REFERENCES content_blocks(id, generation_id)
) STRICT;
CREATE INDEX ix_annotation_resource ON resource_annotations(resource_id, deleted_at, created_at);

CREATE TABLE resource_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  resource_id TEXT NOT NULL REFERENCES knowledge_resources(id),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  result_version INTEGER NOT NULL CHECK (result_version = base_version + 1),
  change_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  changes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(changes_json) AND json_type(changes_json) = 'object'),
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by TEXT,
  agent_run_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (resource_id, result_version),
  UNIQUE (resource_id, operation_id),
  CHECK (created_by_type <> 'agent' OR agent_run_id IS NOT NULL)
) STRICT;

CREATE TABLE mutation_receipts (
  authority_key TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  operation_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (authority_key, operation_id)
) STRICT;

CREATE TABLE embedding_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  profile_key TEXT NOT NULL UNIQUE,
  provider_profile_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL DEFAULT 'embedding' CHECK (provider_kind = 'embedding'),
  model TEXT NOT NULL,
  model_revision TEXT,
  dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 65536),
  distance_metric TEXT NOT NULL DEFAULT 'cosine' CHECK (distance_metric = 'cosine'),
  normalization TEXT NOT NULL DEFAULT 'none' CHECK (normalization IN ('none', 'l2')),
  embedding_type TEXT NOT NULL DEFAULT 'text',
  input_template_version TEXT NOT NULL,
  admission_version TEXT NOT NULL,
  configuration_hash TEXT NOT NULL CHECK (length(configuration_hash) = 64),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (id, dimensions),
  FOREIGN KEY (provider_profile_id, provider_kind) REFERENCES provider_profiles(id, kind)
) STRICT;
CREATE UNIQUE INDEX uq_active_embedding_profile ON embedding_profiles(is_active) WHERE is_active = 1;

CREATE TABLE block_embeddings (
  id TEXT PRIMARY KEY NOT NULL,
  generation_id TEXT NOT NULL REFERENCES content_generations(id),
  content_block_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  input_text_hash TEXT NOT NULL CHECK (length(input_text_hash) = 64),
  vector BLOB NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'stale', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (content_block_id, profile_id, input_text_hash),
  UNIQUE (id, profile_id),
  CHECK (length(vector) = 4 * dimensions),
  FOREIGN KEY (content_block_id, generation_id) REFERENCES content_blocks(id, generation_id),
  FOREIGN KEY (profile_id, dimensions) REFERENCES embedding_profiles(id, dimensions)
) STRICT;
CREATE INDEX ix_embedding_profile ON block_embeddings(profile_id, state, generation_id);
CREATE INDEX ix_embedding_reuse ON block_embeddings(profile_id, input_text_hash);

CREATE TABLE search_index_builds (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fulltext', 'vector')),
  profile_id TEXT REFERENCES embedding_profiles(id),
  engine_key TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  configuration_hash TEXT NOT NULL CHECK (length(configuration_hash) = 64),
  corpus_fingerprint TEXT CHECK (corpus_fingerprint IS NULL OR length(corpus_fingerprint) = 64),
  state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'active', 'failed', 'retired')),
  manifest_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(manifest_json) AND json_type(manifest_json) = 'object'),
  snapshot_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_event_seq >= 0),
  last_applied_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_applied_event_seq >= 0),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  error_code TEXT,
  UNIQUE (id, profile_id),
  CHECK ((kind = 'vector') = (profile_id IS NOT NULL)),
  CHECK (state <> 'active' OR activated_at IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX uq_active_index ON search_index_builds(kind, ifnull(profile_id, '')) WHERE state = 'active';

CREATE TABLE vector_index_entries (
  build_id TEXT NOT NULL,
  engine_label TEXT NOT NULL,
  embedding_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('indexed', 'removed')),
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (build_id, engine_label),
  UNIQUE (build_id, embedding_id),
  FOREIGN KEY (build_id, profile_id) REFERENCES search_index_builds(id, profile_id),
  FOREIGN KEY (embedding_id, profile_id) REFERENCES block_embeddings(id, profile_id)
) STRICT;

CREATE TABLE search_documents (
  rowid INTEGER PRIMARY KEY,
  document_kind TEXT NOT NULL CHECK (document_kind IN ('metadata', 'block')),
  resource_id TEXT NOT NULL REFERENCES knowledge_resources(id),
  source_id TEXT,
  generation_id TEXT,
  block_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  contributors TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  tokenizer_profile TEXT NOT NULL,
  indexed_version INTEGER NOT NULL CHECK (indexed_version > 0),
  updated_at INTEGER NOT NULL,
  CHECK ((document_kind = 'metadata' AND source_id IS NULL AND generation_id IS NULL AND block_id IS NULL) OR (document_kind = 'block' AND source_id IS NOT NULL AND generation_id IS NOT NULL AND block_id IS NOT NULL)),
  FOREIGN KEY (generation_id, source_id, resource_id) REFERENCES content_generations(id, source_id, resource_id),
  FOREIGN KEY (block_id, generation_id) REFERENCES content_blocks(id, generation_id)
) STRICT;
CREATE UNIQUE INDEX uq_search_metadata ON search_documents(resource_id) WHERE document_kind = 'metadata';
CREATE UNIQUE INDEX uq_search_block ON search_documents(block_id) WHERE document_kind = 'block';
CREATE INDEX ix_search_scope ON search_documents(resource_id, generation_id);

CREATE TABLE change_outbox (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version > 0),
  event_type TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version > 0),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_outbox_aggregate ON change_outbox(aggregate_type, aggregate_id, aggregate_version);

CREATE TABLE consumer_checkpoints (
  consumer_key TEXT PRIMARY KEY NOT NULL,
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  state_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(state_json) AND json_type(state_json) = 'object'),
  updated_at INTEGER NOT NULL
) STRICT;

-- A source can point only to its published generation at the same content version.
CREATE TRIGGER source_content_version_advance BEFORE UPDATE OF active_generation_id, content_version ON resource_sources
WHEN (NEW.active_generation_id IS NOT OLD.active_generation_id AND NEW.content_version <> OLD.content_version + 1)
  OR (NEW.active_generation_id IS OLD.active_generation_id AND NEW.content_version <> OLD.content_version)
BEGIN SELECT RAISE(ABORT, 'INVALID_CONTENT_VERSION_ADVANCE'); END;

CREATE TRIGGER source_active_generation_insert BEFORE INSERT ON resource_sources
WHEN NEW.active_generation_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ACTIVE_GENERATION') WHERE NOT EXISTS (
    SELECT 1 FROM content_generations g WHERE g.id = NEW.active_generation_id
      AND g.source_id = NEW.id AND g.resource_id = NEW.resource_id
      AND g.content_version = NEW.content_version AND g.state IN ('ready', 'partial')
  );
END;
CREATE TRIGGER source_active_generation_update BEFORE UPDATE OF active_generation_id, content_version ON resource_sources
WHEN NEW.active_generation_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ACTIVE_GENERATION') WHERE NOT EXISTS (
    SELECT 1 FROM content_generations g WHERE g.id = NEW.active_generation_id
      AND g.source_id = NEW.id AND g.resource_id = NEW.resource_id
      AND g.content_version = NEW.content_version AND g.state IN ('ready', 'partial')
  );
END;
CREATE TRIGGER generation_active_state BEFORE UPDATE OF state ON content_generations
WHEN NEW.state NOT IN ('ready', 'partial') AND EXISTS (
  SELECT 1 FROM resource_sources s WHERE s.active_generation_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'ACTIVE_GENERATION_MUST_REMAIN_READABLE');
END;

CREATE TRIGGER generation_state_transition BEFORE UPDATE OF state ON content_generations
WHEN NOT (
  NEW.state = OLD.state
  OR OLD.state = 'staging' AND NEW.state IN ('ready', 'partial', 'failed')
  OR OLD.state IN ('ready', 'partial') AND NEW.state = 'superseded'
)
BEGIN SELECT RAISE(ABORT, 'INVALID_GENERATION_TRANSITION'); END;

CREATE TRIGGER generation_published_metadata BEFORE UPDATE ON content_generations
WHEN OLD.state <> 'staging' AND (
  NEW.id IS NOT OLD.id OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.source_id IS NOT OLD.source_id OR NEW.parse_run_id IS NOT OLD.parse_run_id
  OR NEW.base_generation_id IS NOT OLD.base_generation_id
  OR NEW.base_content_version IS NOT OLD.base_content_version
  OR NEW.content_version IS NOT OLD.content_version OR NEW.source_version IS NOT OLD.source_version
  OR NEW.source_fingerprint IS NOT OLD.source_fingerprint OR NEW.origin IS NOT OLD.origin
  OR NEW.content_fingerprint IS NOT OLD.content_fingerprint OR NEW.normalizer_version IS NOT OLD.normalizer_version
  OR NEW.page_manifest_json IS NOT OLD.page_manifest_json OR NEW.warnings_json IS NOT OLD.warnings_json
  OR NEW.created_by_type IS NOT OLD.created_by_type OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at OR NEW.published_at IS NOT OLD.published_at
)
BEGIN SELECT RAISE(ABORT, 'PUBLISHED_GENERATION_IMMUTABLE'); END;

CREATE TRIGGER library_node_cycle BEFORE UPDATE OF parent_id ON library_nodes
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'LIBRARY_NODE_CYCLE') WHERE EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM library_nodes WHERE id = NEW.parent_id
      UNION SELECT n.id, n.parent_id FROM library_nodes n JOIN ancestors a ON n.id = a.parent_id
    ) SELECT 1 FROM ancestors WHERE id = OLD.id
  );
END;

CREATE TRIGGER structure_node_cycle BEFORE UPDATE OF parent_id ON structure_nodes
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'STRUCTURE_NODE_CYCLE') WHERE EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM structure_nodes WHERE id = NEW.parent_id
      UNION SELECT n.id, n.parent_id FROM structure_nodes n JOIN ancestors a ON n.id = a.parent_id
    ) SELECT 1 FROM ancestors WHERE id = OLD.id
  );
END;

CREATE TRIGGER block_parent_cycle BEFORE UPDATE OF parent_block_id ON content_blocks
WHEN NEW.parent_block_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'BLOCK_PARENT_CYCLE') WHERE EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_block_id FROM content_blocks WHERE id = NEW.parent_block_id
      UNION SELECT b.id, b.parent_block_id FROM content_blocks b JOIN ancestors a ON b.id = a.parent_id
    ) SELECT 1 FROM ancestors WHERE id = OLD.id
  );
END;

CREATE TRIGGER provider_configuration_immutable BEFORE UPDATE ON provider_profiles
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.adapter_key IS NOT OLD.adapter_key
  OR NEW.adapter_version IS NOT OLD.adapter_version OR NEW.endpoint_url IS NOT OLD.endpoint_url
  OR NEW.config_json IS NOT OLD.config_json OR NEW.configuration_hash IS NOT OLD.configuration_hash
BEGIN SELECT RAISE(ABORT, 'PROVIDER_CONFIGURATION_IMMUTABLE'); END;

CREATE TRIGGER embedding_configuration_immutable BEFORE UPDATE ON embedding_profiles
WHEN NEW.id IS NOT OLD.id OR NEW.profile_key IS NOT OLD.profile_key
  OR NEW.provider_profile_id IS NOT OLD.provider_profile_id OR NEW.provider_kind IS NOT OLD.provider_kind
  OR NEW.model IS NOT OLD.model OR NEW.model_revision IS NOT OLD.model_revision
  OR NEW.dimensions IS NOT OLD.dimensions OR NEW.distance_metric IS NOT OLD.distance_metric
  OR NEW.normalization IS NOT OLD.normalization OR NEW.embedding_type IS NOT OLD.embedding_type
  OR NEW.input_template_version IS NOT OLD.input_template_version OR NEW.admission_version IS NOT OLD.admission_version
  OR NEW.configuration_hash IS NOT OLD.configuration_hash
BEGIN SELECT RAISE(ABORT, 'EMBEDDING_CONFIGURATION_IMMUTABLE'); END;

-- Content edits create a new staging generation. Published structural rows are immutable.
CREATE TRIGGER node_staging_insert BEFORE INSERT ON structure_nodes
WHEN NOT EXISTS (SELECT 1 FROM content_generations WHERE id = NEW.generation_id AND state = 'staging')
BEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;
CREATE TRIGGER node_staging_update BEFORE UPDATE ON structure_nodes
WHEN NOT EXISTS (SELECT 1 FROM content_generations WHERE id = OLD.generation_id AND state = 'staging')
  OR NEW.generation_id <> OLD.generation_id
BEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;
CREATE TRIGGER node_staging_delete BEFORE DELETE ON structure_nodes
WHEN NOT EXISTS (SELECT 1 FROM content_generations WHERE id = OLD.generation_id AND state = 'staging')
BEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;
CREATE TRIGGER block_staging_insert BEFORE INSERT ON content_blocks
WHEN NOT EXISTS (SELECT 1 FROM content_generations WHERE id = NEW.generation_id AND state = 'staging')
BEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;
CREATE TRIGGER block_staging_update BEFORE UPDATE ON content_blocks
WHEN NOT EXISTS (SELECT 1 FROM content_generations WHERE id = OLD.generation_id AND state = 'staging')
  OR NEW.generation_id <> OLD.generation_id
BEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;
CREATE TRIGGER block_staging_delete BEFORE DELETE ON content_blocks
WHEN NOT EXISTS (SELECT 1 FROM content_generations WHERE id = OLD.generation_id AND state = 'staging')
BEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;
CREATE TRIGGER asset_staging_insert BEFORE INSERT ON generation_files
WHEN NOT EXISTS (SELECT 1 FROM content_generations WHERE id = NEW.generation_id AND state = 'staging')
BEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;
CREATE TRIGGER asset_staging_update BEFORE UPDATE ON generation_files
WHEN NOT EXISTS (SELECT 1 FROM content_generations WHERE id = OLD.generation_id AND state = 'staging')
  OR NEW.generation_id <> OLD.generation_id
BEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;
CREATE TRIGGER asset_staging_delete BEFORE DELETE ON generation_files
WHEN NOT EXISTS (SELECT 1 FROM content_generations WHERE id = OLD.generation_id AND state = 'staging')
BEGIN SELECT RAISE(ABORT, 'GENERATION_NOT_STAGING'); END;

CREATE TRIGGER revision_append_only_update BEFORE UPDATE ON resource_revisions
BEGIN SELECT RAISE(ABORT, 'REVISION_APPEND_ONLY'); END;
CREATE TRIGGER revision_append_only_delete BEFORE DELETE ON resource_revisions
BEGIN SELECT RAISE(ABORT, 'REVISION_APPEND_ONLY'); END;
