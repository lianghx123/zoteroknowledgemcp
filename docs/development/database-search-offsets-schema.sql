-- Search projection offsets and an atomic index revision. No canonical content changes.
ALTER TABLE search_documents ADD COLUMN body_offsets_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(body_offsets_json) AND json_type(body_offsets_json) = 'array');

INSERT INTO plugin_state(key, value_json, updated_at) VALUES ('fulltext-revision', '0', 0);

CREATE TRIGGER search_projection_revision_insert AFTER INSERT ON search_documents
BEGIN
  UPDATE plugin_state SET value_json = CAST(CAST(value_json AS INTEGER) + 1 AS TEXT)
    WHERE key = 'fulltext-revision';
END;

CREATE TRIGGER search_projection_revision_update AFTER UPDATE ON search_documents
BEGIN
  UPDATE plugin_state SET value_json = CAST(CAST(value_json AS INTEGER) + 1 AS TEXT)
    WHERE key = 'fulltext-revision';
END;

CREATE TRIGGER search_projection_revision_delete AFTER DELETE ON search_documents
BEGIN
  UPDATE plugin_state SET value_json = CAST(CAST(value_json AS INTEGER) + 1 AS TEXT)
    WHERE key = 'fulltext-revision';
END;
