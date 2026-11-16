# Database Field Dictionary

Design revision 4, 2026-10-21. Generated from the SQL design fixtures after all migrations; no plugin database is created.

See [database-design.md](database-design.md) for ownership, field semantics, transactions, source mapping, and runtime limitations.

Regenerate with `node scripts/generate-database-dictionary.mjs`; verify without writing with `node scripts/generate-database-dictionary.mjs --check`.

`Required` includes primary-key columns. `PK position` describes composite key order. Defaults are SQL literals. CHECK constraints, partial indexes, and triggers are specified in the linked SQL.

## Local data and task foundation (35 ordinary tables)

Source: [database-schema.sql](database-schema.sql).

### kysely_migration

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| name | VARCHAR(255) | Yes | — | 1 |
| timestamp | VARCHAR(255) | Yes | — | — |

### kysely_migration_lock

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | VARCHAR(255) | Yes | — | 1 |
| is_locked | INTEGER | Yes | 0 | — |

### plugin_state

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| key | TEXT | Yes | — | 1 |
| value_json | TEXT | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |

### knowledge_libraries

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| name | TEXT | Yes | — | — |
| description | TEXT | No | — | — |
| is_default | INTEGER | Yes | 0 | — |
| status | TEXT | Yes | 'active' | — |
| version | INTEGER | Yes | 1 | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |
| deleted_at | INTEGER | No | — | — |

Allowed category/boolean values (enforced by CHECK):

- `is_default`: `0, 1`.
- `status`: `'active', 'archived', 'deleted'`.

Explicit indexes:

- `uq_default_library`: `CREATE UNIQUE INDEX uq_default_library ON knowledge_libraries(is_default) WHERE is_default = 1 AND deleted_at IS NULL`.
- `uq_library_name`: `CREATE UNIQUE INDEX uq_library_name ON knowledge_libraries(name) WHERE deleted_at IS NULL`.

### library_nodes

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| library_id | TEXT | Yes | — | — |
| parent_id | TEXT | No | — | — |
| node_type | TEXT | Yes | — | — |
| name | TEXT | Yes | — | — |
| description | TEXT | No | — | — |
| sort_order | INTEGER | Yes | — | — |
| query_json | TEXT | No | — | — |
| version | INTEGER | Yes | 1 | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |
| deleted_at | INTEGER | No | — | — |

Allowed category/boolean values (enforced by CHECK):

- `node_type`: `'folder', 'collection', 'smart_collection'`.

Foreign-key groups:

- (parent_id, library_id) -> library_nodes(id, library_id).
- (library_id) -> knowledge_libraries(id).

Explicit indexes:

- `ix_node_tree`: `CREATE INDEX ix_node_tree ON library_nodes(library_id, parent_id, sort_order)`.
- `uq_node_child_name`: `CREATE UNIQUE INDEX uq_node_child_name ON library_nodes(library_id, parent_id, name) WHERE parent_id IS NOT NULL AND deleted_at IS NULL`.
- `uq_node_root_name`: `CREATE UNIQUE INDEX uq_node_root_name ON library_nodes(library_id, name) WHERE parent_id IS NULL AND deleted_at IS NULL`.

### knowledge_resources

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| title | TEXT | Yes | — | — |
| subtitle | TEXT | No | — | — |
| resource_type | TEXT | Yes | — | — |
| language | TEXT | No | — | — |
| abstract | TEXT | No | — | — |
| summary | TEXT | No | — | — |
| publication_date | TEXT | No | — | — |
| contributors_json | TEXT | Yes | '[]' | — |
| metadata_json | TEXT | Yes | '{}' | — |
| metadata_authority | TEXT | Yes | — | — |
| status | TEXT | Yes | 'active' | — |
| canonical_source_id | TEXT | No | — | — |
| version | INTEGER | Yes | 1 | — |
| metadata_version | INTEGER | Yes | 1 | — |
| metadata_fingerprint | TEXT | No | — | — |
| metadata_schema_version | INTEGER | Yes | 1 | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |
| deleted_at | INTEGER | No | — | — |
| publication_title | TEXT | No | — | — |
| volume | TEXT | No | — | — |
| issue | TEXT | No | — | — |
| doi | TEXT | No | — | — |

Allowed category/boolean values (enforced by CHECK):

- `metadata_authority`: `'zotero', 'local', 'import'`.
- `status`: `'active', 'archived', 'deleted'`.

Foreign-key groups:

- (canonical_source_id, id) -> resource_sources(id, resource_id).

Explicit indexes:

- `ix_resource_status`: `CREATE INDEX ix_resource_status ON knowledge_resources(status, updated_at)`.

### resource_identifiers

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| resource_id | TEXT | Yes | — | — |
| identifier_type | TEXT | Yes | — | — |
| identifier_value | TEXT | Yes | — | — |
| normalized_value | TEXT | Yes | — | — |
| is_primary | INTEGER | Yes | 0 | — |
| metadata_json | TEXT | Yes | '{}' | — |
| created_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `is_primary`: `0, 1`.

Foreign-key groups:

- (resource_id) -> knowledge_resources(id).

Explicit indexes:

- `ix_identifier_lookup`: `CREATE INDEX ix_identifier_lookup ON resource_identifiers(identifier_type, normalized_value)`.
- `uq_primary_identifier`: `CREATE UNIQUE INDEX uq_primary_identifier ON resource_identifiers(resource_id, identifier_type) WHERE is_primary = 1`.

### stored_files

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| relative_path | TEXT | Yes | — | — |
| original_name | TEXT | No | — | — |
| media_type | TEXT | Yes | — | — |
| byte_length | INTEGER | Yes | — | — |
| sha256 | TEXT | Yes | — | — |
| state | TEXT | Yes | — | — |
| created_at | INTEGER | Yes | — | — |
| verified_at | INTEGER | No | — | — |

Allowed category/boolean values (enforced by CHECK):

- `state`: `'staged', 'available', 'missing', 'deleting'`.

Explicit indexes:

- `ix_file_hash`: `CREATE INDEX ix_file_hash ON stored_files(sha256, byte_length)`.

### resource_sources

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| resource_id | TEXT | Yes | — | — |
| source_type | TEXT | Yes | — | — |
| source_role | TEXT | Yes | — | — |
| availability | TEXT | Yes | 'pending' | — |
| stored_file_id | TEXT | No | — | — |
| uri | TEXT | No | — | — |
| text_content | TEXT | No | — | — |
| media_type | TEXT | No | — | — |
| version_label | TEXT | No | — | — |
| source_version | INTEGER | Yes | 1 | — |
| content_version | INTEGER | Yes | 0 | — |
| source_fingerprint | TEXT | No | — | — |
| fingerprint_algorithm | TEXT | No | — | — |
| active_generation_id | TEXT | No | — | — |
| last_checked_at | INTEGER | No | — | — |
| error_code | TEXT | No | — | — |
| metadata_json | TEXT | Yes | '{}' | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |
| deleted_at | INTEGER | No | — | — |

Allowed category/boolean values (enforced by CHECK):

- `source_type`: `'zotero_attachment', 'file', 'url', 'manual', 'external_api', 'imported_text', 'zotero_note'`.
- `source_role`: `'primary_document', 'metadata_record', 'supplementary', 'attachment', 'web_snapshot', 'cover_image', 'other'`.
- `availability`: `'pending', 'fetching', 'available', 'failed', 'missing', 'deleted'`.

Foreign-key groups:

- (active_generation_id, id, resource_id) -> content_generations(id, source_id, resource_id).
- (stored_file_id) -> stored_files(id).
- (resource_id) -> knowledge_resources(id).

Explicit indexes:

- `ix_source_file`: `CREATE INDEX ix_source_file ON resource_sources(stored_file_id)`.
- `ix_source_resource`: `CREATE INDEX ix_source_resource ON resource_sources(resource_id, availability)`.

### zotero_libraries

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| library_type | TEXT | Yes | — | — |
| local_library_id | INTEGER | Yes | — | — |
| external_library_id | TEXT | No | — | — |
| display_name | TEXT | Yes | — | — |
| is_editable | INTEGER | Yes | — | — |
| files_editable | INTEGER | Yes | — | — |
| availability | TEXT | Yes | — | — |
| last_checked_at | INTEGER | Yes | — | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `library_type`: `'user', 'group'`.
- `is_editable`: `0, 1`.
- `files_editable`: `0, 1`.
- `availability`: `'available', 'unavailable', 'removed'`.

### zotero_bindings

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| zotero_library_id | TEXT | Yes | — | — |
| knowledge_library_id | TEXT | Yes | — | — |
| target_node_id | TEXT | No | — | — |
| scope_type | TEXT | Yes | — | — |
| collection_key | TEXT | No | — | — |
| include_descendants | INTEGER | Yes | 1 | — |
| processing_policy | TEXT | Yes | 'manual' | — |
| parser_profile_id | TEXT | No | — | — |
| enabled | INTEGER | Yes | 1 | — |
| version | INTEGER | Yes | 1 | — |
| last_completed_scan_id | TEXT | No | — | — |
| last_reconciled_at | INTEGER | No | — | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |
| sync_mode | TEXT | Yes | 'flexible' | — |

Allowed category/boolean values (enforced by CHECK):

- `scope_type`: `'library', 'collection'`.
- `include_descendants`: `0, 1`.
- `processing_policy`: `'manual', 'automatic'`.
- `enabled`: `0, 1`.
- `sync_mode`: `'mirror', 'flexible', 'append'`.

Foreign-key groups:

- (target_node_id, knowledge_library_id) -> library_nodes(id, library_id).
- (last_completed_scan_id) -> processing_jobs(id).
- (parser_profile_id) -> provider_profiles(id).
- (knowledge_library_id) -> knowledge_libraries(id).
- (zotero_library_id) -> zotero_libraries(id).

### zotero_item_links

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| zotero_library_id | TEXT | Yes | — | — |
| item_key | TEXT | Yes | — | — |
| local_item_id | INTEGER | No | — | — |
| item_kind | TEXT | Yes | — | — |
| parent_item_key | TEXT | No | — | — |
| resource_id | TEXT | Yes | — | — |
| source_id | TEXT | No | — | — |
| is_anchor | INTEGER | Yes | 0 | — |
| native_version | INTEGER | No | — | — |
| native_modified_at | TEXT | No | — | — |
| metadata_fingerprint | TEXT | No | — | — |
| cached_file_path | TEXT | No | — | — |
| file_size | INTEGER | No | — | — |
| file_modified_at | INTEGER | No | — | — |
| state | TEXT | Yes | — | — |
| last_seen_at | INTEGER | Yes | — | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `item_kind`: `'regular', 'attachment', 'note'`.
- `is_anchor`: `0, 1`.
- `state`: `'current', 'trashed', 'deleted', 'unavailable'`.

Foreign-key groups:

- (source_id, resource_id) -> resource_sources(id, resource_id).
- (resource_id) -> knowledge_resources(id).
- (zotero_library_id) -> zotero_libraries(id).

Explicit indexes:

- `ix_item_resource`: `CREATE INDEX ix_item_resource ON zotero_item_links(resource_id)`.
- `uq_item_source`: `CREATE UNIQUE INDEX uq_item_source ON zotero_item_links(source_id) WHERE source_id IS NOT NULL`.
- `uq_resource_anchor`: `CREATE UNIQUE INDEX uq_resource_anchor ON zotero_item_links(resource_id) WHERE is_anchor = 1`.

### zotero_collection_links

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| binding_id | TEXT | Yes | — | — |
| zotero_library_id | TEXT | Yes | — | — |
| collection_key | TEXT | Yes | — | — |
| parent_collection_key | TEXT | No | — | — |
| local_collection_id | INTEGER | No | — | — |
| knowledge_library_id | TEXT | Yes | — | — |
| node_id | TEXT | Yes | — | — |
| last_seen_scan_id | TEXT | No | — | — |
| state | TEXT | Yes | — | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `state`: `'current', 'removed'`.

Foreign-key groups:

- (node_id, knowledge_library_id) -> library_nodes(id, library_id).
- (binding_id, knowledge_library_id) -> zotero_bindings(id, knowledge_library_id).
- (binding_id, zotero_library_id) -> zotero_bindings(id, zotero_library_id).
- (last_seen_scan_id) -> processing_jobs(id).

### library_resources

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| library_id | TEXT | Yes | — | — |
| resource_id | TEXT | Yes | — | — |
| added_at | INTEGER | Yes | — | — |
| deleted_at | INTEGER | No | — | — |

Foreign-key groups:

- (resource_id) -> knowledge_resources(id).
- (library_id) -> knowledge_libraries(id).

Explicit indexes:

- `ix_membership_resource`: `CREATE INDEX ix_membership_resource ON library_resources(resource_id, deleted_at)`.

### library_items

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| library_id | TEXT | Yes | — | — |
| node_id | TEXT | Yes | — | — |
| library_resource_id | TEXT | Yes | — | — |
| sort_order | INTEGER | Yes | — | — |
| added_at | INTEGER | Yes | — | — |
| deleted_at | INTEGER | No | — | — |

Foreign-key groups:

- (library_resource_id, library_id) -> library_resources(id, library_id).
- (node_id, library_id) -> library_nodes(id, library_id).

Explicit indexes:

- `ix_placement_order`: `CREATE INDEX ix_placement_order ON library_items(node_id, sort_order)`.
- `uq_placement_trash_scope`: `CREATE UNIQUE INDEX uq_placement_trash_scope ON library_items(id, library_id)`.

### membership_origins

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| origin_key | TEXT | Yes | — | — |
| library_id | TEXT | Yes | — | — |
| resource_id | TEXT | Yes | — | — |
| library_resource_id | TEXT | Yes | — | — |
| library_item_id | TEXT | No | — | — |
| origin_type | TEXT | Yes | — | — |
| binding_id | TEXT | No | — | — |
| item_link_id | TEXT | No | — | — |
| last_seen_scan_id | TEXT | No | — | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |
| deleted_at | INTEGER | No | — | — |

Allowed category/boolean values (enforced by CHECK):

- `origin_type`: `'manual', 'zotero'`.

Foreign-key groups:

- (item_link_id, resource_id) -> zotero_item_links(id, resource_id).
- (binding_id, library_id) -> zotero_bindings(id, knowledge_library_id).
- (library_item_id, library_resource_id) -> library_items(id, library_resource_id).
- (library_resource_id, library_id, resource_id) -> library_resources(id, library_id, resource_id).
- (last_seen_scan_id) -> processing_jobs(id).

Explicit indexes:

- `ix_origin_scan`: `CREATE INDEX ix_origin_scan ON membership_origins(binding_id, last_seen_scan_id, deleted_at)`.
- `uq_origin_trash_scope`: `CREATE UNIQUE INDEX uq_origin_trash_scope ON membership_origins(id, library_id)`.

### provider_profiles

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| name | TEXT | Yes | — | — |
| kind | TEXT | Yes | — | — |
| adapter_key | TEXT | Yes | — | — |
| adapter_version | TEXT | Yes | — | — |
| endpoint_url | TEXT | Yes | — | — |
| credential_ref | TEXT | No | — | — |
| config_json | TEXT | Yes | '{}' | — |
| configuration_hash | TEXT | Yes | — | — |
| enabled | INTEGER | Yes | 1 | — |
| created_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `kind`: `'parse', 'embedding', 'rerank'`.
- `enabled`: `0, 1`.

### processing_jobs

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| kind | TEXT | Yes | — | — |
| dedup_key | TEXT | Yes | — | — |
| resource_id | TEXT | No | — | — |
| source_id | TEXT | No | — | — |
| generation_id | TEXT | No | — | — |
| binding_id | TEXT | No | — | — |
| embedding_profile_id | TEXT | No | — | — |
| expected_source_version | INTEGER | No | — | — |
| expected_content_version | INTEGER | No | — | — |
| input_fingerprint | TEXT | No | — | — |
| payload_version | INTEGER | Yes | 1 | — |
| payload_json | TEXT | Yes | '{}' | — |
| checkpoint_json | TEXT | Yes | '{}' | — |
| state | TEXT | Yes | 'pending' | — |
| priority | INTEGER | Yes | 0 | — |
| next_run_at | INTEGER | Yes | — | — |
| attempt_count | INTEGER | Yes | 0 | — |
| failure_count | INTEGER | Yes | 0 | — |
| max_failures | INTEGER | Yes | 5 | — |
| lease_owner | TEXT | No | — | — |
| execution_token | TEXT | No | — | — |
| lease_expires_at | INTEGER | No | — | — |
| heartbeat_at | INTEGER | No | — | — |
| cancel_requested_at | INTEGER | No | — | — |
| error_code | TEXT | No | — | — |
| error_message | TEXT | No | — | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |
| started_at | INTEGER | No | — | — |
| finished_at | INTEGER | No | — | — |

Allowed category/boolean values (enforced by CHECK):

- `kind`: `'reconcile', 'parse', 'embed', 'index', 'maintenance'`.
- `state`: `'pending', 'running', 'waiting', 'retry_wait', 'needs_attention', 'succeeded', 'partially_succeeded', 'failed', 'cancelled'`.

Foreign-key groups:

- (generation_id, source_id, resource_id) -> content_generations(id, source_id, resource_id).
- (source_id, resource_id) -> resource_sources(id, resource_id).
- (embedding_profile_id) -> embedding_profiles(id).
- (binding_id) -> zotero_bindings(id).
- (resource_id) -> knowledge_resources(id).

Explicit indexes:

- `ix_job_due`: `CREATE INDEX ix_job_due ON processing_jobs(state, next_run_at, priority DESC, created_at)`.
- `ix_job_lease`: `CREATE INDEX ix_job_lease ON processing_jobs(state, lease_expires_at)`.
- `ix_job_resource`: `CREATE INDEX ix_job_resource ON processing_jobs(resource_id, created_at)`.
- `uq_live_job`: `CREATE UNIQUE INDEX uq_live_job ON processing_jobs(kind, dedup_key) WHERE state IN ('pending', 'running', 'waiting', 'retry_wait', 'needs_attention')`.

### parse_runs

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| job_id | TEXT | Yes | — | — |
| resource_id | TEXT | Yes | — | — |
| source_id | TEXT | Yes | — | — |
| mode | TEXT | Yes | — | — |
| provider_profile_id | TEXT | No | — | — |
| parser_name | TEXT | Yes | — | — |
| parser_version | TEXT | No | — | — |
| normalizer_version | TEXT | Yes | — | — |
| result_schema_version | TEXT | No | — | — |
| source_version | INTEGER | Yes | — | — |
| source_fingerprint | TEXT | Yes | — | — |
| base_content_version | INTEGER | Yes | — | — |
| base_generation_id | TEXT | No | — | — |
| submission_key | TEXT | Yes | — | — |
| submission_state | TEXT | Yes | — | — |
| external_job_id | TEXT | No | — | — |
| stage | TEXT | Yes | — | — |
| progress_current | INTEGER | No | — | — |
| progress_total | INTEGER | No | — | — |
| result_fingerprint | TEXT | No | — | — |
| warnings_json | TEXT | Yes | '[]' | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `mode`: `'service', 'import', 'local_text'`.
- `submission_state`: `'not_applicable', 'not_submitted', 'submitting', 'confirmed', 'ambiguous'`.

Foreign-key groups:

- (base_generation_id, source_id, resource_id) -> content_generations(id, source_id, resource_id).
- (source_id, resource_id) -> resource_sources(id, resource_id).
- (job_id, source_id, resource_id) -> processing_jobs(id, source_id, resource_id).
- (provider_profile_id) -> provider_profiles(id).

Explicit indexes:

- `ix_parse_resource`: `CREATE INDEX ix_parse_resource ON parse_runs(resource_id)`.
- `uq_remote_parse_job`: `CREATE UNIQUE INDEX uq_remote_parse_job ON parse_runs(provider_profile_id, external_job_id) WHERE external_job_id IS NOT NULL`.

### parse_artifacts

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| parse_run_id | TEXT | Yes | — | — |
| artifact_key | TEXT | Yes | — | — |
| artifact_type | TEXT | Yes | — | — |
| stored_file_id | TEXT | Yes | — | — |
| page_number | INTEGER | No | — | — |
| metadata_json | TEXT | Yes | '{}' | — |
| created_at | INTEGER | Yes | — | — |

Foreign-key groups:

- (stored_file_id) -> stored_files(id).
- (parse_run_id) -> parse_runs(id).

Explicit indexes:

- `ix_artifact_file_owner`: `CREATE INDEX ix_artifact_file_owner ON parse_artifacts(stored_file_id)`.

### content_generations

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| resource_id | TEXT | Yes | — | — |
| source_id | TEXT | Yes | — | — |
| parse_run_id | TEXT | No | — | — |
| base_generation_id | TEXT | No | — | — |
| base_content_version | INTEGER | Yes | — | — |
| content_version | INTEGER | Yes | — | — |
| source_version | INTEGER | Yes | — | — |
| source_fingerprint | TEXT | Yes | — | — |
| origin | TEXT | Yes | — | — |
| state | TEXT | Yes | 'staging' | — |
| content_fingerprint | TEXT | No | — | — |
| normalizer_version | TEXT | Yes | — | — |
| page_manifest_json | TEXT | Yes | '[]' | — |
| warnings_json | TEXT | Yes | '[]' | — |
| created_by_type | TEXT | Yes | — | — |
| created_by | TEXT | No | — | — |
| created_at | INTEGER | Yes | — | — |
| published_at | INTEGER | No | — | — |

Allowed category/boolean values (enforced by CHECK):

- `origin`: `'parse', 'import', 'manual', 'edit'`.
- `state`: `'staging', 'ready', 'partial', 'superseded', 'failed'`.
- `created_by_type`: `'user', 'agent', 'system'`.

Foreign-key groups:

- (base_generation_id, source_id, resource_id) -> content_generations(id, source_id, resource_id).
- (parse_run_id, source_id, resource_id) -> parse_runs(id, source_id, resource_id).
- (source_id, resource_id) -> resource_sources(id, resource_id).

Explicit indexes:

- `ix_generation_resource`: `CREATE INDEX ix_generation_resource ON content_generations(resource_id)`.
- `ix_generation_source`: `CREATE INDEX ix_generation_source ON content_generations(source_id, created_at)`.
- `uq_published_content_version`: `CREATE UNIQUE INDEX uq_published_content_version ON content_generations(source_id, content_version) WHERE state IN ('ready', 'partial', 'superseded')`.

### generation_files

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| generation_id | TEXT | Yes | — | 1 |
| asset_key | TEXT | Yes | — | 2 |
| stored_file_id | TEXT | Yes | — | — |
| role | TEXT | Yes | — | — |

Foreign-key groups:

- (stored_file_id) -> stored_files(id).
- (generation_id) -> content_generations(id).

Explicit indexes:

- `ix_generation_file_owner`: `CREATE INDEX ix_generation_file_owner ON generation_files(stored_file_id)`.

### structure_nodes

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| generation_id | TEXT | Yes | — | — |
| parent_id | TEXT | No | — | — |
| node_type | TEXT | Yes | — | — |
| label | TEXT | No | — | — |
| path | TEXT | Yes | — | — |
| depth | INTEGER | Yes | — | — |
| sort_order | INTEGER | Yes | — | — |
| canonical_order_start | INTEGER | No | — | — |
| canonical_order_end | INTEGER | No | — | — |
| page_start | INTEGER | No | — | — |
| page_end | INTEGER | No | — | — |
| source_type | TEXT | Yes | — | — |
| source_ref_id | TEXT | No | — | — |
| confidence | REAL | No | — | — |
| review_status | TEXT | Yes | 'auto' | — |
| is_user_modified | INTEGER | Yes | 0 | — |
| metadata_json | TEXT | Yes | '{}' | — |
| created_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `source_type`: `'ocr', 'parser', 'manual', 'agent', 'import'`.
- `review_status`: `'auto', 'needs_review', 'reviewed', 'corrected', 'rejected'`.
- `is_user_modified`: `0, 1`.

Foreign-key groups:

- (parent_id, generation_id) -> structure_nodes(id, generation_id).
- (generation_id) -> content_generations(id).

Explicit indexes:

- `ix_structure_read`: `CREATE INDEX ix_structure_read ON structure_nodes(generation_id, canonical_order_start)`.
- `uq_generation_root`: `CREATE UNIQUE INDEX uq_generation_root ON structure_nodes(generation_id) WHERE parent_id IS NULL`.
- `uq_section_sibling_order`: `CREATE UNIQUE INDEX uq_section_sibling_order ON structure_nodes(generation_id, parent_id, sort_order) WHERE parent_id IS NOT NULL`.

### content_blocks

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| generation_id | TEXT | Yes | — | — |
| structure_node_id | TEXT | No | — | — |
| parent_block_id | TEXT | No | — | — |
| supersedes_block_id | TEXT | No | — | — |
| block_type | TEXT | Yes | — | — |
| content_role | TEXT | Yes | 'body' | — |
| canonical_order | INTEGER | Yes | — | — |
| local_order | INTEGER | No | — | — |
| content_markdown | TEXT | Yes | — | — |
| content_normalized | TEXT | No | — | — |
| content_hash | TEXT | Yes | — | — |
| source_type | TEXT | Yes | — | — |
| source_block_ids_json | TEXT | Yes | '[]' | — |
| page_start | INTEGER | No | — | — |
| page_end | INTEGER | No | — | — |
| locations_json | TEXT | Yes | '[]' | — |
| confidence | REAL | No | — | — |
| review_status | TEXT | Yes | 'auto' | — |
| is_user_modified | INTEGER | Yes | 0 | — |
| quality_flags_json | TEXT | Yes | '[]' | — |
| metadata_json | TEXT | Yes | '{}' | — |
| created_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `content_role`: `'body', 'note'`.
- `source_type`: `'ocr', 'parser', 'manual', 'agent', 'import'`.
- `review_status`: `'auto', 'needs_review', 'reviewed', 'corrected', 'rejected'`.
- `is_user_modified`: `0, 1`.

Foreign-key groups:

- (parent_block_id, generation_id) -> content_blocks(id, generation_id).
- (structure_node_id, generation_id) -> structure_nodes(id, generation_id).
- (supersedes_block_id) -> content_blocks(id).
- (generation_id) -> content_generations(id).

Explicit indexes:

- `ix_block_filter`: `CREATE INDEX ix_block_filter ON content_blocks(generation_id, block_type, content_role, review_status)`.
- `ix_block_parent`: `CREATE INDEX ix_block_parent ON content_blocks(parent_block_id, generation_id)`.
- `ix_block_section`: `CREATE INDEX ix_block_section ON content_blocks(structure_node_id, local_order)`.
- `ix_block_supersedes`: `CREATE INDEX ix_block_supersedes ON content_blocks(supersedes_block_id)`.

### resource_references

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| resource_id | TEXT | Yes | — | — |
| source_id | TEXT | No | — | — |
| generation_id | TEXT | No | — | — |
| source_block_id | TEXT | No | — | — |
| target_resource_id | TEXT | No | — | — |
| target_source_id | TEXT | No | — | — |
| target_generation_id | TEXT | No | — | — |
| target_block_id | TEXT | No | — | — |
| reference_type | TEXT | Yes | — | — |
| label | TEXT | No | — | — |
| raw_text | TEXT | No | — | — |
| parsed_json | TEXT | Yes | '{}' | — |
| match_status | TEXT | Yes | 'unmatched' | — |
| confidence | REAL | No | — | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |
| deleted_at | INTEGER | No | — | — |
| reference_number | INTEGER | No | — | — |
| entry_order | INTEGER | No | — | — |

Allowed category/boolean values (enforced by CHECK):

- `reference_type`: `'bibliography', 'citation', 'url', 'footnote', 'cross_reference', 'table_reference', 'figure_reference', 'formula_reference'`.
- `match_status`: `'unmatched', 'matched', 'ambiguous', 'manual'`.

Foreign-key groups:

- (target_block_id, target_generation_id) -> content_blocks(id, generation_id).
- (target_generation_id, target_source_id, target_resource_id) -> content_generations(id, source_id, resource_id).
- (target_source_id, target_resource_id) -> resource_sources(id, resource_id).
- (source_block_id, generation_id) -> content_blocks(id, generation_id).
- (generation_id, source_id, resource_id) -> content_generations(id, source_id, resource_id).
- (source_id, resource_id) -> resource_sources(id, resource_id).
- (target_resource_id) -> knowledge_resources(id).
- (resource_id) -> knowledge_resources(id).

Explicit indexes:

- `ix_reference_resource`: `CREATE INDEX ix_reference_resource ON resource_references(resource_id, deleted_at, created_at)`.
- `ix_reference_source_block`: `CREATE INDEX ix_reference_source_block ON resource_references(source_block_id, generation_id)`.
- `ix_reference_target`: `CREATE INDEX ix_reference_target ON resource_references(target_resource_id)`.
- `ix_reference_target_block`: `CREATE INDEX ix_reference_target_block ON resource_references(target_block_id, target_generation_id)`.
- `uq_reference_generation`: `CREATE UNIQUE INDEX uq_reference_generation ON resource_references(id, generation_id)`.

### resource_annotations

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| resource_id | TEXT | Yes | — | — |
| source_id | TEXT | No | — | — |
| generation_id | TEXT | No | — | — |
| structure_node_id | TEXT | No | — | — |
| content_block_id | TEXT | No | — | — |
| resource_version | INTEGER | Yes | — | — |
| annotation_type | TEXT | Yes | — | — |
| text | TEXT | Yes | — | — |
| quote | TEXT | No | — | — |
| anchor_state | TEXT | Yes | 'current' | — |
| confidence | REAL | No | — | — |
| created_by_type | TEXT | Yes | — | — |
| created_by | TEXT | No | — | — |
| metadata_json | TEXT | Yes | '{}' | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |
| deleted_at | INTEGER | No | — | — |

Allowed category/boolean values (enforced by CHECK):

- `annotation_type`: `'claim', 'method', 'assumption', 'limitation', 'evidence', 'question', 'contradiction', 'important', 'todo', 'summary'`.
- `anchor_state`: `'current', 'historical', 'needs_review', 'unresolved'`.
- `created_by_type`: `'user', 'agent'`.

Foreign-key groups:

- (content_block_id, generation_id) -> content_blocks(id, generation_id).
- (structure_node_id, generation_id) -> structure_nodes(id, generation_id).
- (generation_id, source_id, resource_id) -> content_generations(id, source_id, resource_id).
- (source_id, resource_id) -> resource_sources(id, resource_id).
- (resource_id) -> knowledge_resources(id).

Explicit indexes:

- `ix_annotation_block`: `CREATE INDEX ix_annotation_block ON resource_annotations(content_block_id, generation_id)`.
- `ix_annotation_resource`: `CREATE INDEX ix_annotation_resource ON resource_annotations(resource_id, deleted_at, created_at)`.

### resource_revisions

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| resource_id | TEXT | Yes | — | — |
| operation_id | TEXT | Yes | — | — |
| base_version | INTEGER | Yes | — | — |
| result_version | INTEGER | Yes | — | — |
| change_type | TEXT | Yes | — | — |
| target_type | TEXT | Yes | — | — |
| target_id | TEXT | No | — | — |
| before_json | TEXT | No | — | — |
| after_json | TEXT | No | — | — |
| changes_json | TEXT | Yes | '{}' | — |
| created_by_type | TEXT | Yes | — | — |
| created_by | TEXT | No | — | — |
| agent_run_id | TEXT | No | — | — |
| created_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `created_by_type`: `'user', 'agent', 'system'`.

Foreign-key groups:

- (resource_id) -> knowledge_resources(id).

### mutation_receipts

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| authority_key | TEXT | Yes | — | 1 |
| operation_id | TEXT | Yes | — | 2 |
| operation_kind | TEXT | Yes | — | — |
| target_key | TEXT | Yes | — | — |
| request_hash | TEXT | Yes | — | — |
| result_json | TEXT | Yes | — | — |
| created_at | INTEGER | Yes | — | — |

### embedding_profiles

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| profile_key | TEXT | Yes | — | — |
| provider_profile_id | TEXT | Yes | — | — |
| provider_kind | TEXT | Yes | 'embedding' | — |
| model | TEXT | Yes | — | — |
| model_revision | TEXT | No | — | — |
| dimensions | INTEGER | Yes | — | — |
| distance_metric | TEXT | Yes | 'cosine' | — |
| normalization | TEXT | Yes | 'none' | — |
| embedding_type | TEXT | Yes | 'text' | — |
| input_template_version | TEXT | Yes | — | — |
| admission_version | TEXT | Yes | — | — |
| configuration_hash | TEXT | Yes | — | — |
| is_active | INTEGER | Yes | 0 | — |
| created_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `normalization`: `'none', 'l2'`.
- `is_active`: `0, 1`.

Foreign-key groups:

- (provider_profile_id, provider_kind) -> provider_profiles(id, kind).

Explicit indexes:

- `uq_active_embedding_profile`: `CREATE UNIQUE INDEX uq_active_embedding_profile ON embedding_profiles(is_active) WHERE is_active = 1`.

### block_embeddings

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| generation_id | TEXT | Yes | — | — |
| content_block_id | TEXT | Yes | — | — |
| profile_id | TEXT | Yes | — | — |
| dimensions | INTEGER | Yes | — | — |
| input_text_hash | TEXT | Yes | — | — |
| vector | BLOB | Yes | — | — |
| state | TEXT | Yes | 'active' | — |
| created_at | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `state`: `'active', 'stale', 'deleted'`.

Foreign-key groups:

- (profile_id, dimensions) -> embedding_profiles(id, dimensions).
- (content_block_id, generation_id) -> content_blocks(id, generation_id).
- (generation_id) -> content_generations(id).

Explicit indexes:

- `ix_embedding_generation`: `CREATE INDEX ix_embedding_generation ON block_embeddings(generation_id)`.
- `ix_embedding_profile`: `CREATE INDEX ix_embedding_profile ON block_embeddings(profile_id, state, generation_id)`.
- `ix_embedding_reuse`: `CREATE INDEX ix_embedding_reuse ON block_embeddings(profile_id, input_text_hash)`.

### search_index_builds

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| kind | TEXT | Yes | — | — |
| profile_id | TEXT | No | — | — |
| engine_key | TEXT | Yes | — | — |
| engine_version | TEXT | Yes | — | — |
| configuration_hash | TEXT | Yes | — | — |
| corpus_fingerprint | TEXT | No | — | — |
| state | TEXT | Yes | — | — |
| manifest_json | TEXT | Yes | '{}' | — |
| snapshot_event_seq | INTEGER | Yes | 0 | — |
| last_applied_event_seq | INTEGER | Yes | 0 | — |
| created_at | INTEGER | Yes | — | — |
| activated_at | INTEGER | No | — | — |
| error_code | TEXT | No | — | — |

Allowed category/boolean values (enforced by CHECK):

- `kind`: `'fulltext', 'vector'`.
- `state`: `'building', 'ready', 'active', 'failed', 'retired'`.

Foreign-key groups:

- (profile_id) -> embedding_profiles(id).

Explicit indexes:

- `uq_active_index`: `CREATE UNIQUE INDEX uq_active_index ON search_index_builds(kind, ifnull(profile_id, '')) WHERE state = 'active'`.

### vector_index_entries

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| build_id | TEXT | Yes | — | 1 |
| engine_label | TEXT | Yes | — | 2 |
| embedding_id | TEXT | Yes | — | — |
| profile_id | TEXT | Yes | — | — |
| state | TEXT | Yes | — | — |
| indexed_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `state`: `'indexed', 'removed'`.

Foreign-key groups:

- (embedding_id, profile_id) -> block_embeddings(id, profile_id).
- (build_id, profile_id) -> search_index_builds(id, profile_id).

Explicit indexes:

- `ix_vector_entry_embedding`: `CREATE INDEX ix_vector_entry_embedding ON vector_index_entries(embedding_id, profile_id)`.

### search_documents

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| rowid | INTEGER | Yes | — | 1 |
| document_kind | TEXT | Yes | — | — |
| resource_id | TEXT | Yes | — | — |
| source_id | TEXT | No | — | — |
| generation_id | TEXT | No | — | — |
| block_id | TEXT | No | — | — |
| title | TEXT | Yes | '' | — |
| contributors | TEXT | Yes | '' | — |
| body | TEXT | Yes | '' | — |
| search_text | TEXT | Yes | '' | — |
| tokenizer_profile | TEXT | Yes | — | — |
| indexed_version | INTEGER | Yes | — | — |
| updated_at | INTEGER | Yes | — | — |
| body_offsets_json | TEXT | Yes | '[]' | — |

Allowed category/boolean values (enforced by CHECK):

- `document_kind`: `'metadata', 'block'`.

Foreign-key groups:

- (block_id, generation_id) -> content_blocks(id, generation_id).
- (generation_id, source_id, resource_id) -> content_generations(id, source_id, resource_id).
- (resource_id) -> knowledge_resources(id).

Explicit indexes:

- `ix_search_block_fk`: `CREATE INDEX ix_search_block_fk ON search_documents(block_id, generation_id)`.
- `ix_search_scope`: `CREATE INDEX ix_search_scope ON search_documents(resource_id, generation_id)`.
- `uq_search_block`: `CREATE UNIQUE INDEX uq_search_block ON search_documents(block_id) WHERE document_kind = 'block'`.
- `uq_search_metadata`: `CREATE UNIQUE INDEX uq_search_metadata ON search_documents(resource_id) WHERE document_kind = 'metadata'`.

### change_outbox

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| event_seq | INTEGER | Yes | — | 1 |
| event_id | TEXT | Yes | — | — |
| aggregate_type | TEXT | Yes | — | — |
| aggregate_id | TEXT | Yes | — | — |
| aggregate_version | INTEGER | Yes | — | — |
| event_type | TEXT | Yes | — | — |
| payload_version | INTEGER | Yes | 1 | — |
| payload_json | TEXT | Yes | '{}' | — |
| created_at | INTEGER | Yes | — | — |

Explicit indexes:

- `ix_outbox_aggregate`: `CREATE INDEX ix_outbox_aggregate ON change_outbox(aggregate_type, aggregate_id, aggregate_version)`.

### consumer_checkpoints

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| consumer_key | TEXT | Yes | — | 1 |
| last_event_seq | INTEGER | Yes | 0 | — |
| state_json | TEXT | Yes | '{}' | — |
| updated_at | INTEGER | Yes | — | — |

## Step 4 full-text index (1 virtual table)

Source: [database-search-schema.sql](database-search-schema.sql).

### search_fts

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| title | TEXT (FTS) | No | — | — |
| contributors | TEXT (FTS) | No | — | — |
| body | TEXT (FTS) | No | — | — |
| search_text | TEXT (FTS) | No | — | — |

## Step 5 credential storage reservation (3 ordinary tables)

Source: [database-mcp-schema.sql](database-mcp-schema.sql).

### mcp_tokens

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| name | TEXT | Yes | — | — |
| selector | TEXT | Yes | — | — |
| token_hash | TEXT | Yes | — | — |
| hash_algorithm | TEXT | Yes | 'sha256' | — |
| authorization_version | INTEGER | Yes | 1 | — |
| created_at | INTEGER | Yes | — | — |
| expires_at | INTEGER | Yes | — | — |
| last_used_at | INTEGER | No | — | — |
| revoked_at | INTEGER | No | — | — |

### mcp_token_libraries

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| token_id | TEXT | Yes | — | 1 |
| library_id | TEXT | Yes | — | 2 |

Foreign-key groups:

- (library_id) -> knowledge_libraries(id).
- (token_id) -> mcp_tokens(id).

### mcp_token_scopes

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| token_id | TEXT | Yes | — | 1 |
| scope | TEXT | Yes | — | 2 |

Allowed category/boolean values (enforced by CHECK):

- `scope`: `'knowledge:search', 'knowledge:read', 'knowledge:annotate', 'knowledge:update-summary'`.

Foreign-key groups:

- (token_id) -> mcp_tokens(id).

## Tree integrity supplement (no new tables)

Source: [database-tree-integrity-schema.sql](database-tree-integrity-schema.sql).

Migration 0004 rejects diagnostic rows from existing-cycle checks, then installs three insert-time cycle guards. Table columns and relationships are unchanged.

## Bibliographic field supplement (no new tables)

Source: [database-bibliographic-schema.sql](database-bibliographic-schema.sql).

Migration 0005 promotes publication_title, volume, issue and doi into knowledge_resources and removes their old JSON keys. The tables above show the final schema after all supplements.

## Knowledge Trash recovery (6 ordinary tables)

Source: [database-trash-schema.sql](database-trash-schema.sql).

Migration 0006 imports legacy knowledge-trash JSON from plugin_state into typed entries and foreign-keyed recovery links, then removes only those legacy keys. Recovery links cascade only from Trash entries; business tombstones and audit history remain.

### knowledge_trash_entries

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| kind | TEXT | Yes | — | — |
| name | TEXT | Yes | — | — |
| library_id | TEXT | Yes | — | — |
| node_id | TEXT | No | — | — |
| location | TEXT | Yes | — | — |
| deleted_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `kind`: `'item', 'folder', 'library'`.

Foreign-key groups:

- (node_id, library_id) -> library_nodes(id, library_id).
- (library_id) -> knowledge_libraries(id).

Explicit indexes:

- `ix_trash_deleted`: `CREATE INDEX ix_trash_deleted ON knowledge_trash_entries(deleted_at DESC, id)`.
- `ix_trash_location`: `CREATE INDEX ix_trash_location ON knowledge_trash_entries(library_id, node_id)`.

### knowledge_trash_resources

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| entry_id | TEXT | Yes | — | 1 |
| resource_id | TEXT | Yes | — | 2 |
| position | INTEGER | Yes | — | — |
| was_deleted | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `was_deleted`: `0, 1`.

Foreign-key groups:

- (resource_id) -> knowledge_resources(id).
- (entry_id) -> knowledge_trash_entries(id).

Explicit indexes:

- `ix_trash_resource`: `CREATE INDEX ix_trash_resource ON knowledge_trash_resources(resource_id)`.

### knowledge_trash_folders

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| entry_id | TEXT | Yes | — | 1 |
| library_id | TEXT | Yes | — | — |
| node_id | TEXT | Yes | — | 2 |
| position | INTEGER | Yes | — | — |

Foreign-key groups:

- (node_id, library_id) -> library_nodes(id, library_id).
- (entry_id, library_id) -> knowledge_trash_entries(id, library_id).

Explicit indexes:

- `ix_trash_folder`: `CREATE INDEX ix_trash_folder ON knowledge_trash_folders(node_id, library_id)`.

### knowledge_trash_relations

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| entry_id | TEXT | Yes | — | 1 |
| library_id | TEXT | Yes | — | — |
| library_resource_id | TEXT | Yes | — | 2 |
| position | INTEGER | Yes | — | — |

Foreign-key groups:

- (library_resource_id, library_id) -> library_resources(id, library_id).
- (entry_id, library_id) -> knowledge_trash_entries(id, library_id).

Explicit indexes:

- `ix_trash_relation`: `CREATE INDEX ix_trash_relation ON knowledge_trash_relations(library_resource_id, library_id)`.

### knowledge_trash_placements

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| entry_id | TEXT | Yes | — | 1 |
| library_id | TEXT | Yes | — | — |
| library_item_id | TEXT | Yes | — | 2 |
| position | INTEGER | Yes | — | — |

Foreign-key groups:

- (library_item_id, library_id) -> library_items(id, library_id).
- (entry_id, library_id) -> knowledge_trash_entries(id, library_id).

Explicit indexes:

- `ix_trash_placement`: `CREATE INDEX ix_trash_placement ON knowledge_trash_placements(library_item_id, library_id)`.

### knowledge_trash_origins

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| entry_id | TEXT | Yes | — | 1 |
| library_id | TEXT | Yes | — | — |
| origin_id | TEXT | Yes | — | 2 |
| position | INTEGER | Yes | — | — |

Foreign-key groups:

- (origin_id, library_id) -> membership_origins(id, library_id).
- (entry_id, library_id) -> knowledge_trash_entries(id, library_id).

Explicit indexes:

- `ix_trash_origin`: `CREATE INDEX ix_trash_origin ON knowledge_trash_origins(origin_id, library_id)`.

## Sync modes and permanent deletion

Source: [database-sync-purge-schema.sql](database-sync-purge-schema.sql).

Migration 0007 stores sync modes, local exclusions and durable file cleanup. Explicit purge scopes permit deletion of otherwise immutable content only inside the purge transaction.

### sync_exclusions

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| binding_id | TEXT | Yes | — | 1 |
| node_id | TEXT | Yes | — | 2 |
| item_key | TEXT | Yes | — | 3 |
| created_at | INTEGER | Yes | — | — |

Foreign-key groups:

- (node_id) -> library_nodes(id).
- (binding_id) -> zotero_bindings(id).

### file_cleanup

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| relative_path | TEXT | Yes | — | 1 |
| created_at | INTEGER | Yes | — | — |

### resource_purge_scope

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| resource_id | TEXT | Yes | — | 1 |

## Local folder exclusions

Source: [database-sync-folder-exclusions-schema.sql](database-sync-folder-exclusions-schema.sql).

Migration 0008 preserves collection-key exclusions independently of deleted knowledge folders.

### sync_collection_exclusions

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| binding_id | TEXT | Yes | — | 1 |
| collection_key | TEXT | Yes | — | 2 |
| created_at | INTEGER | Yes | — | — |

Foreign-key groups:

- (binding_id) -> zotero_bindings(id).

## Embedding segments and vector recovery

Source: [database-vector-schema.sql](database-vector-schema.sql).

Migration 0009 adds traceable embedding inputs and replaceable index snapshot state without changing published blocks.

### embedding_segments

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| block_id | TEXT | Yes | — | — |
| profile_id | TEXT | Yes | — | — |
| ordinal | INTEGER | Yes | — | — |
| start_offset | INTEGER | Yes | — | — |
| end_offset | INTEGER | Yes | — | — |
| overlap | INTEGER | Yes | — | — |
| input_text | TEXT | Yes | — | — |
| input_hash | TEXT | Yes | — | — |
| skip_reason | TEXT | No | — | — |
| embedding_id | TEXT | No | — | — |
| created_at | INTEGER | Yes | — | — |

Foreign-key groups:

- (embedding_id) -> block_embeddings(id).
- (profile_id) -> embedding_profiles(id).
- (block_id) -> content_blocks(id).

Explicit indexes:

- `ix_segment_embedding`: `CREATE INDEX ix_segment_embedding ON embedding_segments(embedding_id)`.
- `ix_segment_profile`: `CREATE INDEX ix_segment_profile ON embedding_segments(profile_id, block_id)`.

### vector_snapshot_state

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| profile_id | TEXT | Yes | — | 1 |
| build_id | TEXT | No | — | — |
| format_version | INTEGER | Yes | 1 | — |
| mode | TEXT | Yes | — | — |
| snapshot_path | TEXT | No | — | — |
| snapshot_hash | TEXT | No | — | — |
| snapshot_bytes | INTEGER | No | — | — |
| corpus_hash | TEXT | No | — | — |
| mutations | INTEGER | Yes | 0 | — |
| updated_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `mode`: `'f32', 'i8'`.

Foreign-key groups:

- (build_id) -> search_index_builds(id).
- (profile_id) -> embedding_profiles(id).

## Search offsets and revision

Source: [database-search-offsets-schema.sql](database-search-offsets-schema.sql).

Migration 0010 adds original-text Unicode offsets to the derived search projection and transactionally advances its revision on insertion, update and deletion. Existing projections rebuild locally without provider calls.

## Parser reference backfill (no schema changes)

Source: [database-reference-backfill-schema.sql](database-reference-backfill-schema.sql).

Migration 0011 derives bibliography records from published parser reference blocks, retaining source/generation/block anchors and existing records, including tombstones. It performs no model calls, text correction or target matching.

## Visual title/note associations

Source: [database-visual-links-schema.sql](database-visual-links-schema.sql).

Migration 0012 adds generation-scoped derived relationships and explicit embedded provider parts; canonical content and source generations are unchanged.

### content_visual_projections

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| generation_id | TEXT | Yes | — | 1 |
| version | INTEGER | Yes | — | — |
| completed_at | INTEGER | Yes | — | — |

Foreign-key groups:

- (generation_id) -> content_generations(id).

### content_visual_links

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| id | TEXT | Yes | — | 1 |
| generation_id | TEXT | Yes | — | — |
| visual_block_id | TEXT | Yes | — | — |
| related_block_id | TEXT | No | — | — |
| role | TEXT | Yes | — | — |
| position | TEXT | Yes | — | — |
| evidence | TEXT | Yes | — | — |
| ordinal | INTEGER | Yes | — | — |
| content_markdown | TEXT | No | — | — |
| created_at | INTEGER | Yes | — | — |

Allowed category/boolean values (enforced by CHECK):

- `role`: `'caption', 'note', 'body'`.
- `position`: `'before', 'after', 'content'`.
- `evidence`: `'provider', 'layout', 'adjacency'`.

Foreign-key groups:

- (related_block_id, generation_id) -> content_blocks(id, generation_id).
- (visual_block_id, generation_id) -> content_blocks(id, generation_id).
- (generation_id) -> content_generations(id).

Explicit indexes:

- `ix_visual_link_generation`: `CREATE INDEX ix_visual_link_generation ON content_visual_links(generation_id, visual_block_id)`.

## Numbered reference entries

Source: [database-reference-numbering-schema.sql](database-reference-numbering-schema.sql).

Migration 0013 adds separate original citation numbers, entry order, generation projection checkpoints and multi-block source links. Derived bibliography text excludes its confirmed number prefix; original canonical blocks remain immutable.

### content_reference_projections

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| generation_id | TEXT | Yes | — | 1 |
| version | INTEGER | Yes | — | — |
| completed_at | INTEGER | Yes | — | — |

Foreign-key groups:

- (generation_id) -> content_generations(id).

### reference_source_blocks

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| reference_id | TEXT | Yes | — | 1 |
| generation_id | TEXT | Yes | — | — |
| block_id | TEXT | Yes | — | 2 |
| ordinal | INTEGER | Yes | — | — |

Foreign-key groups:

- (block_id, generation_id) -> content_blocks(id, generation_id).
- (reference_id, generation_id) -> resource_references(id, generation_id).

Explicit indexes:

- `ix_reference_source_generation`: `CREATE INDEX ix_reference_source_generation ON reference_source_blocks(generation_id, block_id)`.

## Permanent-deletion lookup indexes (no new tables)

Source: [database-purge-indexes-schema.sql](database-purge-indexes-schema.sql).

Migration 0014 adds thirteen identity indexes for foreign-key child probes, resource generations, vectors and stored-file ownership checks. It preserves business rows, deletion order, foreign keys and shared-content protections.

## Transactional MCP library revisions

Source: [database-mcp-revisions-schema.sql](database-mcp-revisions-schema.sql).

Migration 0015 maintains monotonic library-scoped revisions through transactional triggers. Revision tombstones survive library deletion; staging generations and source-check timestamps do not invalidate published reads.

### mcp_library_revisions

| Field | SQLite type | Required | Default | PK position |
| --- | --- | --- | --- | --- |
| library_id | TEXT | Yes | — | 1 |
| revision | INTEGER | Yes | — | — |

## MCP revision write costs

Source: [database-mcp-revision-hotpaths-schema.sql](database-mcp-revision-hotpaths-schema.sql).

Migration 0016 combines resource-update membership probes and skips inactive content-block trigger bodies. Revision semantics and historical migration checksums are preserved.
