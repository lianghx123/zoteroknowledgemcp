-- Transactional scoped MCP revisions. Tombstones intentionally have no library FK.
-- Staging content does not invalidate readers until its source is published.
CREATE TABLE mcp_library_revisions (
  library_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0)
) STRICT;

INSERT INTO mcp_library_revisions(library_id, revision) SELECT id, 1 FROM knowledge_libraries;

CREATE TRIGGER mcp_revision_knowledge_libraries_insert AFTER INSERT ON knowledge_libraries
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT NEW.id AS library_id) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_knowledge_libraries_update AFTER UPDATE OF id, name, description, is_default, status, version, created_at, updated_at, deleted_at ON knowledge_libraries
WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description OR OLD.is_default IS NOT NEW.is_default OR OLD.status IS NOT NEW.status OR OLD.version IS NOT NEW.version OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT OLD.id AS library_id UNION SELECT NEW.id AS library_id) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_knowledge_libraries_delete AFTER DELETE ON knowledge_libraries
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT OLD.id AS library_id) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_library_resources_insert AFTER INSERT ON library_resources
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT NEW.library_id AS library_id) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_library_resources_update AFTER UPDATE OF id, library_id, resource_id, deleted_at ON library_resources
WHEN OLD.id IS NOT NEW.id OR OLD.library_id IS NOT NEW.library_id OR OLD.resource_id IS NOT NEW.resource_id OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT OLD.library_id AS library_id UNION SELECT NEW.library_id AS library_id) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_library_resources_delete AFTER DELETE ON library_resources
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT OLD.library_id AS library_id) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_library_nodes_insert AFTER INSERT ON library_nodes
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT NEW.library_id AS library_id) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_library_nodes_update AFTER UPDATE OF id, library_id, parent_id, node_type, name, description, sort_order, query_json, version, created_at, updated_at, deleted_at ON library_nodes
WHEN OLD.id IS NOT NEW.id OR OLD.library_id IS NOT NEW.library_id OR OLD.parent_id IS NOT NEW.parent_id OR OLD.node_type IS NOT NEW.node_type OR OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description OR OLD.sort_order IS NOT NEW.sort_order OR OLD.query_json IS NOT NEW.query_json OR OLD.version IS NOT NEW.version OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT OLD.library_id AS library_id UNION SELECT NEW.library_id AS library_id) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_library_nodes_delete AFTER DELETE ON library_nodes
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT OLD.library_id AS library_id) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_library_items_insert AFTER INSERT ON library_items
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT NEW.library_id AS library_id) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_library_items_update AFTER UPDATE OF id, library_id, node_id, library_resource_id, deleted_at ON library_items
WHEN OLD.id IS NOT NEW.id OR OLD.library_id IS NOT NEW.library_id OR OLD.node_id IS NOT NEW.node_id OR OLD.library_resource_id IS NOT NEW.library_resource_id OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT OLD.library_id AS library_id UNION SELECT NEW.library_id AS library_id) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_library_items_delete AFTER DELETE ON library_items
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT OLD.library_id AS library_id) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_knowledge_resources_insert AFTER INSERT ON knowledge_resources
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_knowledge_resources_update AFTER UPDATE OF id, title, subtitle, resource_type, language, abstract, summary, publication_date, contributors_json, metadata_json, metadata_authority, status, canonical_source_id, version, metadata_version, metadata_fingerprint, metadata_schema_version, created_at, updated_at, deleted_at, publication_title, volume, issue, doi ON knowledge_resources
WHEN OLD.id IS NOT NEW.id OR OLD.title IS NOT NEW.title OR OLD.subtitle IS NOT NEW.subtitle OR OLD.resource_type IS NOT NEW.resource_type OR OLD.language IS NOT NEW.language OR OLD.abstract IS NOT NEW.abstract OR OLD.summary IS NOT NEW.summary OR OLD.publication_date IS NOT NEW.publication_date OR OLD.contributors_json IS NOT NEW.contributors_json OR OLD.metadata_json IS NOT NEW.metadata_json OR OLD.metadata_authority IS NOT NEW.metadata_authority OR OLD.status IS NOT NEW.status OR OLD.canonical_source_id IS NOT NEW.canonical_source_id OR OLD.version IS NOT NEW.version OR OLD.metadata_version IS NOT NEW.metadata_version OR OLD.metadata_fingerprint IS NOT NEW.metadata_fingerprint OR OLD.metadata_schema_version IS NOT NEW.metadata_schema_version OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.publication_title IS NOT NEW.publication_title OR OLD.volume IS NOT NEW.volume OR OLD.issue IS NOT NEW.issue OR OLD.doi IS NOT NEW.doi
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.id AS resource_id) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_knowledge_resources_delete AFTER DELETE ON knowledge_resources
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_sources_insert AFTER INSERT ON resource_sources
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.resource_id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_sources_update AFTER UPDATE OF id, resource_id, source_type, source_role, media_type, availability, source_version, content_version, active_generation_id, source_fingerprint, created_at, deleted_at ON resource_sources
WHEN OLD.id IS NOT NEW.id OR OLD.resource_id IS NOT NEW.resource_id OR OLD.source_type IS NOT NEW.source_type OR OLD.source_role IS NOT NEW.source_role OR OLD.media_type IS NOT NEW.media_type OR OLD.availability IS NOT NEW.availability OR OLD.source_version IS NOT NEW.source_version OR OLD.content_version IS NOT NEW.content_version OR OLD.active_generation_id IS NOT NEW.active_generation_id OR OLD.source_fingerprint IS NOT NEW.source_fingerprint OR OLD.created_at IS NOT NEW.created_at OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.resource_id AS resource_id) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.resource_id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_sources_delete AFTER DELETE ON resource_sources
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.resource_id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_identifiers_insert AFTER INSERT ON resource_identifiers
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.resource_id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_identifiers_update AFTER UPDATE OF id, resource_id, identifier_type, identifier_value, normalized_value, is_primary, metadata_json, created_at ON resource_identifiers
WHEN OLD.id IS NOT NEW.id OR OLD.resource_id IS NOT NEW.resource_id OR OLD.identifier_type IS NOT NEW.identifier_type OR OLD.identifier_value IS NOT NEW.identifier_value OR OLD.normalized_value IS NOT NEW.normalized_value OR OLD.is_primary IS NOT NEW.is_primary OR OLD.metadata_json IS NOT NEW.metadata_json OR OLD.created_at IS NOT NEW.created_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.resource_id AS resource_id) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.resource_id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_identifiers_delete AFTER DELETE ON resource_identifiers
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.resource_id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_annotations_insert AFTER INSERT ON resource_annotations
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.resource_id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_annotations_update AFTER UPDATE OF id, resource_id, source_id, generation_id, structure_node_id, content_block_id, resource_version, annotation_type, text, quote, anchor_state, confidence, created_by_type, created_by, metadata_json, created_at, updated_at, deleted_at ON resource_annotations
WHEN OLD.id IS NOT NEW.id OR OLD.resource_id IS NOT NEW.resource_id OR OLD.source_id IS NOT NEW.source_id OR OLD.generation_id IS NOT NEW.generation_id OR OLD.structure_node_id IS NOT NEW.structure_node_id OR OLD.content_block_id IS NOT NEW.content_block_id OR OLD.resource_version IS NOT NEW.resource_version OR OLD.annotation_type IS NOT NEW.annotation_type OR OLD.text IS NOT NEW.text OR OLD.quote IS NOT NEW.quote OR OLD.anchor_state IS NOT NEW.anchor_state OR OLD.confidence IS NOT NEW.confidence OR OLD.created_by_type IS NOT NEW.created_by_type OR OLD.created_by IS NOT NEW.created_by OR OLD.metadata_json IS NOT NEW.metadata_json OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.resource_id AS resource_id) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.resource_id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_annotations_delete AFTER DELETE ON resource_annotations
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.resource_id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_revisions_insert AFTER INSERT ON resource_revisions
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.resource_id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_revisions_update AFTER UPDATE OF id, resource_id, operation_id, base_version, result_version, change_type, target_type, target_id, before_json, after_json, changes_json, created_by_type, created_by, agent_run_id, created_at ON resource_revisions
WHEN OLD.id IS NOT NEW.id OR OLD.resource_id IS NOT NEW.resource_id OR OLD.operation_id IS NOT NEW.operation_id OR OLD.base_version IS NOT NEW.base_version OR OLD.result_version IS NOT NEW.result_version OR OLD.change_type IS NOT NEW.change_type OR OLD.target_type IS NOT NEW.target_type OR OLD.target_id IS NOT NEW.target_id OR OLD.before_json IS NOT NEW.before_json OR OLD.after_json IS NOT NEW.after_json OR OLD.changes_json IS NOT NEW.changes_json OR OLD.created_by_type IS NOT NEW.created_by_type OR OLD.created_by IS NOT NEW.created_by OR OLD.agent_run_id IS NOT NEW.agent_run_id OR OLD.created_at IS NOT NEW.created_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.resource_id AS resource_id) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.resource_id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_revisions_delete AFTER DELETE ON resource_revisions
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.resource_id AS resource_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_references_insert AFTER INSERT ON resource_references
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.resource_id AS resource_id WHERE NEW.generation_id IS NULL OR EXISTS (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id))) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_references_update AFTER UPDATE OF id, resource_id, source_id, generation_id, source_block_id, target_resource_id, target_source_id, target_generation_id, target_block_id, reference_type, label, raw_text, parsed_json, match_status, confidence, created_at, updated_at, deleted_at, reference_number, entry_order ON resource_references
WHEN OLD.id IS NOT NEW.id OR OLD.resource_id IS NOT NEW.resource_id OR OLD.source_id IS NOT NEW.source_id OR OLD.generation_id IS NOT NEW.generation_id OR OLD.source_block_id IS NOT NEW.source_block_id OR OLD.target_resource_id IS NOT NEW.target_resource_id OR OLD.target_source_id IS NOT NEW.target_source_id OR OLD.target_generation_id IS NOT NEW.target_generation_id OR OLD.target_block_id IS NOT NEW.target_block_id OR OLD.reference_type IS NOT NEW.reference_type OR OLD.label IS NOT NEW.label OR OLD.raw_text IS NOT NEW.raw_text OR OLD.parsed_json IS NOT NEW.parsed_json OR OLD.match_status IS NOT NEW.match_status OR OLD.confidence IS NOT NEW.confidence OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.reference_number IS NOT NEW.reference_number OR OLD.entry_order IS NOT NEW.entry_order
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.resource_id AS resource_id WHERE OLD.generation_id IS NULL OR EXISTS (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id)) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.resource_id AS resource_id WHERE NEW.generation_id IS NULL OR EXISTS (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id))) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_resource_references_delete AFTER DELETE ON resource_references
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.resource_id AS resource_id WHERE OLD.generation_id IS NULL OR EXISTS (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id))) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_generations_insert AFTER INSERT ON content_generations
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.resource_id AS resource_id WHERE EXISTS (SELECT 1 FROM resource_sources s WHERE s.id = NEW.source_id AND s.active_generation_id = NEW.id))) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_generations_update AFTER UPDATE OF id, resource_id, source_id, parse_run_id, base_generation_id, base_content_version, content_version, source_version, source_fingerprint, origin, state, content_fingerprint, normalizer_version, page_manifest_json, warnings_json, created_by_type, created_by, created_at, published_at ON content_generations
WHEN OLD.id IS NOT NEW.id OR OLD.resource_id IS NOT NEW.resource_id OR OLD.source_id IS NOT NEW.source_id OR OLD.parse_run_id IS NOT NEW.parse_run_id OR OLD.base_generation_id IS NOT NEW.base_generation_id OR OLD.base_content_version IS NOT NEW.base_content_version OR OLD.content_version IS NOT NEW.content_version OR OLD.source_version IS NOT NEW.source_version OR OLD.source_fingerprint IS NOT NEW.source_fingerprint OR OLD.origin IS NOT NEW.origin OR OLD.state IS NOT NEW.state OR OLD.content_fingerprint IS NOT NEW.content_fingerprint OR OLD.normalizer_version IS NOT NEW.normalizer_version OR OLD.page_manifest_json IS NOT NEW.page_manifest_json OR OLD.warnings_json IS NOT NEW.warnings_json OR OLD.created_by_type IS NOT NEW.created_by_type OR OLD.created_by IS NOT NEW.created_by OR OLD.created_at IS NOT NEW.created_at OR OLD.published_at IS NOT NEW.published_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.resource_id AS resource_id WHERE EXISTS (SELECT 1 FROM resource_sources s WHERE s.id = OLD.source_id AND s.active_generation_id = OLD.id)) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT NEW.resource_id AS resource_id WHERE EXISTS (SELECT 1 FROM resource_sources s WHERE s.id = NEW.source_id AND s.active_generation_id = NEW.id))) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_generations_delete AFTER DELETE ON content_generations
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT OLD.resource_id AS resource_id WHERE EXISTS (SELECT 1 FROM resource_sources s WHERE s.id = OLD.source_id AND s.active_generation_id = OLD.id))) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_structure_nodes_insert AFTER INSERT ON structure_nodes
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_structure_nodes_update AFTER UPDATE OF id, generation_id, parent_id, node_type, label, path, depth, sort_order, canonical_order_start, canonical_order_end, page_start, page_end, source_type, source_ref_id, confidence, review_status, is_user_modified, metadata_json, created_at ON structure_nodes
WHEN OLD.id IS NOT NEW.id OR OLD.generation_id IS NOT NEW.generation_id OR OLD.parent_id IS NOT NEW.parent_id OR OLD.node_type IS NOT NEW.node_type OR OLD.label IS NOT NEW.label OR OLD.path IS NOT NEW.path OR OLD.depth IS NOT NEW.depth OR OLD.sort_order IS NOT NEW.sort_order OR OLD.canonical_order_start IS NOT NEW.canonical_order_start OR OLD.canonical_order_end IS NOT NEW.canonical_order_end OR OLD.page_start IS NOT NEW.page_start OR OLD.page_end IS NOT NEW.page_end OR OLD.source_type IS NOT NEW.source_type OR OLD.source_ref_id IS NOT NEW.source_ref_id OR OLD.confidence IS NOT NEW.confidence OR OLD.review_status IS NOT NEW.review_status OR OLD.is_user_modified IS NOT NEW.is_user_modified OR OLD.metadata_json IS NOT NEW.metadata_json OR OLD.created_at IS NOT NEW.created_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_structure_nodes_delete AFTER DELETE ON structure_nodes
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_blocks_insert AFTER INSERT ON content_blocks
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_blocks_update AFTER UPDATE OF id, generation_id, structure_node_id, parent_block_id, supersedes_block_id, block_type, content_role, canonical_order, local_order, content_markdown, content_normalized, content_hash, source_type, source_block_ids_json, page_start, page_end, locations_json, confidence, review_status, is_user_modified, quality_flags_json, metadata_json, created_at ON content_blocks
WHEN OLD.id IS NOT NEW.id OR OLD.generation_id IS NOT NEW.generation_id OR OLD.structure_node_id IS NOT NEW.structure_node_id OR OLD.parent_block_id IS NOT NEW.parent_block_id OR OLD.supersedes_block_id IS NOT NEW.supersedes_block_id OR OLD.block_type IS NOT NEW.block_type OR OLD.content_role IS NOT NEW.content_role OR OLD.canonical_order IS NOT NEW.canonical_order OR OLD.local_order IS NOT NEW.local_order OR OLD.content_markdown IS NOT NEW.content_markdown OR OLD.content_normalized IS NOT NEW.content_normalized OR OLD.content_hash IS NOT NEW.content_hash OR OLD.source_type IS NOT NEW.source_type OR OLD.source_block_ids_json IS NOT NEW.source_block_ids_json OR OLD.page_start IS NOT NEW.page_start OR OLD.page_end IS NOT NEW.page_end OR OLD.locations_json IS NOT NEW.locations_json OR OLD.confidence IS NOT NEW.confidence OR OLD.review_status IS NOT NEW.review_status OR OLD.is_user_modified IS NOT NEW.is_user_modified OR OLD.quality_flags_json IS NOT NEW.quality_flags_json OR OLD.metadata_json IS NOT NEW.metadata_json OR OLD.created_at IS NOT NEW.created_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_blocks_delete AFTER DELETE ON content_blocks
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_visual_projections_insert AFTER INSERT ON content_visual_projections
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_visual_projections_update AFTER UPDATE OF generation_id, version, completed_at ON content_visual_projections
WHEN OLD.generation_id IS NOT NEW.generation_id OR OLD.version IS NOT NEW.version OR OLD.completed_at IS NOT NEW.completed_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_visual_projections_delete AFTER DELETE ON content_visual_projections
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_visual_links_insert AFTER INSERT ON content_visual_links
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_visual_links_update AFTER UPDATE OF id, generation_id, visual_block_id, related_block_id, role, position, evidence, ordinal, content_markdown, created_at ON content_visual_links
WHEN OLD.id IS NOT NEW.id OR OLD.generation_id IS NOT NEW.generation_id OR OLD.visual_block_id IS NOT NEW.visual_block_id OR OLD.related_block_id IS NOT NEW.related_block_id OR OLD.role IS NOT NEW.role OR OLD.position IS NOT NEW.position OR OLD.evidence IS NOT NEW.evidence OR OLD.ordinal IS NOT NEW.ordinal OR OLD.content_markdown IS NOT NEW.content_markdown OR OLD.created_at IS NOT NEW.created_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_visual_links_delete AFTER DELETE ON content_visual_links
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_reference_projections_insert AFTER INSERT ON content_reference_projections
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_reference_projections_update AFTER UPDATE OF generation_id, version, completed_at ON content_reference_projections
WHEN OLD.generation_id IS NOT NEW.generation_id OR OLD.version IS NOT NEW.version OR OLD.completed_at IS NOT NEW.completed_at
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_content_reference_projections_delete AFTER DELETE ON content_reference_projections
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_reference_source_blocks_insert AFTER INSERT ON reference_source_blocks
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_reference_source_blocks_update AFTER UPDATE OF reference_id, generation_id, block_id, ordinal ON reference_source_blocks
WHEN OLD.reference_id IS NOT NEW.reference_id OR OLD.generation_id IS NOT NEW.generation_id OR OLD.block_id IS NOT NEW.block_id OR OLD.ordinal IS NOT NEW.ordinal
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER mcp_revision_reference_source_blocks_delete AFTER DELETE ON reference_source_blocks
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;
