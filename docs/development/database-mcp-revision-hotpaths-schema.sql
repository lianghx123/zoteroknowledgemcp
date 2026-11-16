-- Preserve revision semantics while avoiding duplicate membership probes and inactive block work.
-- Existing library creation and migration 0015 guarantee revision rows before memberships.
DROP TRIGGER mcp_revision_knowledge_resources_update;

CREATE TRIGGER mcp_revision_knowledge_resources_update AFTER UPDATE OF id, title, subtitle, resource_type, language, abstract, summary, publication_date, contributors_json, metadata_json, metadata_authority, status, canonical_source_id, version, metadata_version, metadata_fingerprint, metadata_schema_version, created_at, updated_at, deleted_at, publication_title, volume, issue, doi ON knowledge_resources
WHEN OLD.id IS NOT NEW.id OR OLD.title IS NOT NEW.title OR OLD.subtitle IS NOT NEW.subtitle OR OLD.resource_type IS NOT NEW.resource_type OR OLD.language IS NOT NEW.language OR OLD.abstract IS NOT NEW.abstract OR OLD.summary IS NOT NEW.summary OR OLD.publication_date IS NOT NEW.publication_date OR OLD.contributors_json IS NOT NEW.contributors_json OR OLD.metadata_json IS NOT NEW.metadata_json OR OLD.metadata_authority IS NOT NEW.metadata_authority OR OLD.status IS NOT NEW.status OR OLD.canonical_source_id IS NOT NEW.canonical_source_id OR OLD.version IS NOT NEW.version OR OLD.metadata_version IS NOT NEW.metadata_version OR OLD.metadata_fingerprint IS NOT NEW.metadata_fingerprint OR OLD.metadata_schema_version IS NOT NEW.metadata_schema_version OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.publication_title IS NOT NEW.publication_title OR OLD.volume IS NOT NEW.volume OR OLD.issue IS NOT NEW.issue OR OLD.doi IS NOT NEW.doi
BEGIN
  UPDATE mcp_library_revisions SET revision = revision + 1
  WHERE library_id IN (SELECT library_id FROM library_resources
    WHERE deleted_at IS NULL AND resource_id IN (OLD.id, NEW.id));
END;

DROP TRIGGER mcp_revision_content_blocks_insert;

CREATE TRIGGER mcp_revision_content_blocks_insert AFTER INSERT ON content_blocks
WHEN EXISTS (SELECT 1 FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

DROP TRIGGER mcp_revision_content_blocks_update;

CREATE TRIGGER mcp_revision_content_blocks_update AFTER UPDATE OF id, generation_id, structure_node_id, parent_block_id, supersedes_block_id, block_type, content_role, canonical_order, local_order, content_markdown, content_normalized, content_hash, source_type, source_block_ids_json, page_start, page_end, locations_json, confidence, review_status, is_user_modified, quality_flags_json, metadata_json, created_at ON content_blocks
WHEN (OLD.id IS NOT NEW.id OR OLD.generation_id IS NOT NEW.generation_id OR OLD.structure_node_id IS NOT NEW.structure_node_id OR OLD.parent_block_id IS NOT NEW.parent_block_id OR OLD.supersedes_block_id IS NOT NEW.supersedes_block_id OR OLD.block_type IS NOT NEW.block_type OR OLD.content_role IS NOT NEW.content_role OR OLD.canonical_order IS NOT NEW.canonical_order OR OLD.local_order IS NOT NEW.local_order OR OLD.content_markdown IS NOT NEW.content_markdown OR OLD.content_normalized IS NOT NEW.content_normalized OR OLD.content_hash IS NOT NEW.content_hash OR OLD.source_type IS NOT NEW.source_type OR OLD.source_block_ids_json IS NOT NEW.source_block_ids_json OR OLD.page_start IS NOT NEW.page_start OR OLD.page_end IS NOT NEW.page_end OR OLD.locations_json IS NOT NEW.locations_json OR OLD.confidence IS NOT NEW.confidence OR OLD.review_status IS NOT NEW.review_status OR OLD.is_user_modified IS NOT NEW.is_user_modified OR OLD.quality_flags_json IS NOT NEW.quality_flags_json OR OLD.metadata_json IS NOT NEW.metadata_json OR OLD.created_at IS NOT NEW.created_at) AND (EXISTS (SELECT 1 FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id) OR EXISTS (SELECT 1 FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id))
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id) UNION SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = NEW.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;

DROP TRIGGER mcp_revision_content_blocks_delete;

CREATE TRIGGER mcp_revision_content_blocks_delete AFTER DELETE ON content_blocks
WHEN EXISTS (SELECT 1 FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id)
BEGIN
  INSERT INTO mcp_library_revisions(library_id, revision)
  SELECT library_id, 1 FROM (SELECT library_id FROM library_resources WHERE deleted_at IS NULL AND resource_id IN (SELECT g.resource_id FROM content_generations g JOIN resource_sources s ON s.id = g.source_id AND s.active_generation_id = g.id WHERE g.id = OLD.generation_id)) WHERE library_id IS NOT NULL
  ON CONFLICT(library_id) DO UPDATE SET revision = revision + 1;
END;
