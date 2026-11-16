-- Migration 0006: normalize local knowledge Trash recovery records.
-- Apply after 0001-0005. All statements and legacy cleanup run in one transaction.
-- Reject malformed records instead of silently losing recovery rights.
SELECT 'INVALID_TRASH_RECORD' AS problem
WHERE EXISTS (
  SELECT 1 FROM plugin_state
  WHERE key GLOB 'knowledge-trash:*' AND (
    coalesce(json_type(value_json), '') <> 'object'
    OR coalesce(json_type(value_json, '$.id'), '') <> 'text'
    OR json_extract(value_json, '$.id') <> substr(key, 17)
    OR length(trim(json_extract(value_json, '$.id'))) = 0
    OR coalesce(json_extract(value_json, '$.kind'), '') NOT IN ('item', 'folder', 'library')
    OR coalesce(json_type(value_json, '$.name'), '') <> 'text'
    OR coalesce(json_type(value_json, '$.location'), '') <> 'text'
    OR coalesce(json_type(value_json, '$.target'), '') <> 'object'
    OR coalesce(json_type(value_json, '$.target.libraryID'), '') <> 'text'
    OR coalesce(json_type(value_json, '$.target.nodeID'), '') NOT IN ('text', 'null')
    OR coalesce(json_type(value_json, '$.deletedAt'), '') <> 'integer'
    OR json_extract(value_json, '$.deletedAt') < 0
    OR coalesce(json_type(value_json, '$.resourceIDs'), '') <> 'array'
    OR coalesce(json_type(value_json, '$.folderIDs'), '') <> 'array'
    OR coalesce(json_type(value_json, '$.relationIDs'), '') <> 'array'
    OR coalesce(json_type(value_json, '$.placementIDs'), '') <> 'array'
    OR coalesce(json_type(value_json, '$.originIDs'), '') <> 'array'
    OR coalesce(json_type(value_json, '$.deletedResourceIDs'), '') <> 'array'
  )
);

SELECT 'INVALID_TRASH_REFERENCE_LIST' AS problem
WHERE EXISTS (
  SELECT 1 FROM plugin_state AS p, json_each(p.value_json, '$.resourceIDs') AS j WHERE p.key GLOB 'knowledge-trash:*' AND (j.type <> 'text' OR length(trim(j.value)) = 0)
  UNION ALL
  SELECT 1 FROM plugin_state AS p, json_each(p.value_json, '$.folderIDs') AS j WHERE p.key GLOB 'knowledge-trash:*' AND (j.type <> 'text' OR length(trim(j.value)) = 0)
  UNION ALL
  SELECT 1 FROM plugin_state AS p, json_each(p.value_json, '$.relationIDs') AS j WHERE p.key GLOB 'knowledge-trash:*' AND (j.type <> 'text' OR length(trim(j.value)) = 0)
  UNION ALL
  SELECT 1 FROM plugin_state AS p, json_each(p.value_json, '$.placementIDs') AS j WHERE p.key GLOB 'knowledge-trash:*' AND (j.type <> 'text' OR length(trim(j.value)) = 0)
  UNION ALL
  SELECT 1 FROM plugin_state AS p, json_each(p.value_json, '$.originIDs') AS j WHERE p.key GLOB 'knowledge-trash:*' AND (j.type <> 'text' OR length(trim(j.value)) = 0)
  UNION ALL
  SELECT 1 FROM plugin_state AS p, json_each(p.value_json, '$.deletedResourceIDs') AS j WHERE p.key GLOB 'knowledge-trash:*' AND (j.type <> 'text' OR length(trim(j.value)) = 0)
);

WITH resource_refs AS MATERIALIZED (
  SELECT substr(p.key, 17) AS entry_id, j.value AS resource_id
  FROM plugin_state AS p, json_each(p.value_json, '$.resourceIDs') AS j
  WHERE p.key GLOB 'knowledge-trash:*'
), deleted_refs AS MATERIALIZED (
  SELECT substr(p.key, 17) AS entry_id, j.value AS resource_id
  FROM plugin_state AS p, json_each(p.value_json, '$.deletedResourceIDs') AS j
  WHERE p.key GLOB 'knowledge-trash:*'
)
SELECT 'INVALID_TRASH_DELETED_RESOURCE_SET' AS problem
WHERE EXISTS (
  SELECT entry_id, resource_id FROM deleted_refs
  EXCEPT
  SELECT entry_id, resource_id FROM resource_refs
);

CREATE TABLE knowledge_trash_entries (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('item', 'folder', 'library')),
  name TEXT NOT NULL,
  library_id TEXT NOT NULL REFERENCES knowledge_libraries(id),
  node_id TEXT,
  location TEXT NOT NULL,
  deleted_at INTEGER NOT NULL CHECK (deleted_at >= 0),
  UNIQUE (id, library_id),
  CHECK (kind <> 'folder' OR node_id IS NOT NULL),
  CHECK (kind <> 'library' OR node_id IS NULL),
  FOREIGN KEY (node_id, library_id) REFERENCES library_nodes(id, library_id)
) STRICT;
CREATE INDEX ix_trash_deleted ON knowledge_trash_entries(deleted_at DESC, id);
CREATE INDEX ix_trash_location ON knowledge_trash_entries(library_id, node_id);

CREATE TABLE knowledge_trash_resources (
  entry_id TEXT NOT NULL REFERENCES knowledge_trash_entries(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES knowledge_resources(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  was_deleted INTEGER NOT NULL CHECK (was_deleted IN (0, 1)),
  PRIMARY KEY (entry_id, resource_id),
  UNIQUE (entry_id, position)
) STRICT;
CREATE INDEX ix_trash_resource ON knowledge_trash_resources(resource_id);

CREATE TABLE knowledge_trash_folders (
  entry_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (entry_id, node_id),
  UNIQUE (entry_id, position),
  FOREIGN KEY (entry_id, library_id) REFERENCES knowledge_trash_entries(id, library_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id, library_id) REFERENCES library_nodes(id, library_id)
) STRICT;
CREATE INDEX ix_trash_folder ON knowledge_trash_folders(node_id, library_id);

CREATE TABLE knowledge_trash_relations (
  entry_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  library_resource_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (entry_id, library_resource_id),
  UNIQUE (entry_id, position),
  FOREIGN KEY (entry_id, library_id) REFERENCES knowledge_trash_entries(id, library_id) ON DELETE CASCADE,
  FOREIGN KEY (library_resource_id, library_id) REFERENCES library_resources(id, library_id)
) STRICT;
CREATE INDEX ix_trash_relation ON knowledge_trash_relations(library_resource_id, library_id);

-- Supplementary unique keys permit library-scoped foreign keys without changing rows.
CREATE UNIQUE INDEX uq_placement_trash_scope ON library_items(id, library_id);
CREATE UNIQUE INDEX uq_origin_trash_scope ON membership_origins(id, library_id);

CREATE TABLE knowledge_trash_placements (
  entry_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  library_item_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (entry_id, library_item_id),
  UNIQUE (entry_id, position),
  FOREIGN KEY (entry_id, library_id) REFERENCES knowledge_trash_entries(id, library_id) ON DELETE CASCADE,
  FOREIGN KEY (library_item_id, library_id) REFERENCES library_items(id, library_id)
) STRICT;
CREATE INDEX ix_trash_placement ON knowledge_trash_placements(library_item_id, library_id);

CREATE TABLE knowledge_trash_origins (
  entry_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (entry_id, origin_id),
  UNIQUE (entry_id, position),
  FOREIGN KEY (entry_id, library_id) REFERENCES knowledge_trash_entries(id, library_id) ON DELETE CASCADE,
  FOREIGN KEY (origin_id, library_id) REFERENCES membership_origins(id, library_id)
) STRICT;
CREATE INDEX ix_trash_origin ON knowledge_trash_origins(origin_id, library_id);

INSERT INTO knowledge_trash_entries(id, kind, name, library_id, node_id, location, deleted_at)
  SELECT json_extract(value_json, '$.id'), json_extract(value_json, '$.kind'), json_extract(value_json, '$.name'),
  json_extract(value_json, '$.target.libraryID'), json_extract(value_json, '$.target.nodeID'),
  json_extract(value_json, '$.location'), json_extract(value_json, '$.deletedAt')
FROM plugin_state WHERE key GLOB 'knowledge-trash:*';

-- Materialize only scalar references before grouping. Carrying value_json into
-- a GROUP BY sorter would repeat the whole recovery document for every link.
WITH links AS MATERIALIZED (
  SELECT substr(p.key, 17) AS entry_id, j.value AS resource_id, j.key AS position
  FROM plugin_state AS p, json_each(p.value_json, '$.resourceIDs') AS j
  WHERE p.key GLOB 'knowledge-trash:*'
)
INSERT INTO knowledge_trash_resources(entry_id, resource_id, position, was_deleted)
  SELECT entry_id, resource_id, min(position), 0 FROM links GROUP BY entry_id, resource_id;

UPDATE knowledge_trash_resources SET was_deleted = 1
WHERE (entry_id, resource_id) IN (
  SELECT substr(p.key, 17), j.value
  FROM plugin_state AS p, json_each(p.value_json, '$.deletedResourceIDs') AS j
  WHERE p.key GLOB 'knowledge-trash:*'
);

WITH links AS MATERIALIZED (
  SELECT e.id AS entry_id, e.library_id, j.value AS node_id, j.key AS position
  FROM plugin_state AS p JOIN knowledge_trash_entries AS e ON e.id = substr(p.key, 17), json_each(p.value_json, '$.folderIDs') AS j
  WHERE p.key GLOB 'knowledge-trash:*'
)
INSERT INTO knowledge_trash_folders(entry_id, library_id, node_id, position)
  SELECT entry_id, library_id, node_id, min(position) FROM links GROUP BY entry_id, library_id, node_id;

WITH links AS MATERIALIZED (
  SELECT e.id AS entry_id, e.library_id, j.value AS library_resource_id, j.key AS position
  FROM plugin_state AS p JOIN knowledge_trash_entries AS e ON e.id = substr(p.key, 17), json_each(p.value_json, '$.relationIDs') AS j
  WHERE p.key GLOB 'knowledge-trash:*'
)
INSERT INTO knowledge_trash_relations(entry_id, library_id, library_resource_id, position)
  SELECT entry_id, library_id, library_resource_id, min(position) FROM links GROUP BY entry_id, library_id, library_resource_id;

WITH links AS MATERIALIZED (
  SELECT e.id AS entry_id, e.library_id, j.value AS library_item_id, j.key AS position
  FROM plugin_state AS p JOIN knowledge_trash_entries AS e ON e.id = substr(p.key, 17), json_each(p.value_json, '$.placementIDs') AS j
  WHERE p.key GLOB 'knowledge-trash:*'
)
INSERT INTO knowledge_trash_placements(entry_id, library_id, library_item_id, position)
  SELECT entry_id, library_id, library_item_id, min(position) FROM links GROUP BY entry_id, library_id, library_item_id;

WITH links AS MATERIALIZED (
  SELECT e.id AS entry_id, e.library_id, j.value AS origin_id, j.key AS position
  FROM plugin_state AS p JOIN knowledge_trash_entries AS e ON e.id = substr(p.key, 17), json_each(p.value_json, '$.originIDs') AS j
  WHERE p.key GLOB 'knowledge-trash:*'
)
INSERT INTO knowledge_trash_origins(entry_id, library_id, origin_id, position)
  SELECT entry_id, library_id, origin_id, min(position) FROM links GROUP BY entry_id, library_id, origin_id;

-- Cleanup is last: foreign-key or validation failures roll back all imported rows.
DELETE FROM plugin_state WHERE key GLOB 'knowledge-trash:*';
