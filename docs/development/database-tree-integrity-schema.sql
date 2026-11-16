-- Migration 0004 supplement. Apply after the three original schema fixtures.
-- Preflight queries return a diagnostic row if existing data contains a cycle.
-- The migration rejects these rows before installing any new triggers.
WITH RECURSIVE ancestors(origin_id, id, parent_id) AS (
  SELECT id, id, parent_id FROM library_nodes WHERE parent_id IS NOT NULL
  UNION
  SELECT a.origin_id, n.id, n.parent_id FROM library_nodes n JOIN ancestors a ON n.id = a.parent_id
)
SELECT 'LIBRARY_NODE_CYCLE' AS cycle WHERE EXISTS (SELECT 1 FROM ancestors WHERE parent_id = origin_id);

WITH RECURSIVE ancestors(origin_id, id, parent_id) AS (
  SELECT id, id, parent_id FROM structure_nodes WHERE parent_id IS NOT NULL
  UNION
  SELECT a.origin_id, n.id, n.parent_id FROM structure_nodes n JOIN ancestors a ON n.id = a.parent_id
)
SELECT 'STRUCTURE_NODE_CYCLE' AS cycle WHERE EXISTS (SELECT 1 FROM ancestors WHERE parent_id = origin_id);

WITH RECURSIVE ancestors(origin_id, id, parent_id) AS (
  SELECT id, id, parent_block_id FROM content_blocks WHERE parent_block_id IS NOT NULL
  UNION
  SELECT a.origin_id, n.id, n.parent_block_id FROM content_blocks n JOIN ancestors a ON n.id = a.parent_id
)
SELECT 'BLOCK_PARENT_CYCLE' AS cycle WHERE EXISTS (SELECT 1 FROM ancestors WHERE parent_id = origin_id);

-- AFTER INSERT sees the new row and earlier rows of the same bulk statement.
-- RAISE(ABORT) rolls back the entire statement when its last edge closes a cycle.
CREATE TRIGGER library_node_cycle_insert AFTER INSERT ON library_nodes
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'LIBRARY_NODE_CYCLE') WHERE EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM library_nodes WHERE id = NEW.parent_id
      UNION SELECT n.id, n.parent_id FROM library_nodes n JOIN ancestors a ON n.id = a.parent_id
    ) SELECT 1 FROM ancestors WHERE id = NEW.id
  );
END;

CREATE TRIGGER structure_node_cycle_insert AFTER INSERT ON structure_nodes
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'STRUCTURE_NODE_CYCLE') WHERE EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM structure_nodes WHERE id = NEW.parent_id
      UNION SELECT n.id, n.parent_id FROM structure_nodes n JOIN ancestors a ON n.id = a.parent_id
    ) SELECT 1 FROM ancestors WHERE id = NEW.id
  );
END;

CREATE TRIGGER block_parent_cycle_insert AFTER INSERT ON content_blocks
WHEN NEW.parent_block_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'BLOCK_PARENT_CYCLE') WHERE EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_block_id FROM content_blocks WHERE id = NEW.parent_block_id
      UNION SELECT b.id, b.parent_block_id FROM content_blocks b JOIN ancestors a ON b.id = a.parent_id
    ) SELECT 1 FROM ancestors WHERE id = NEW.id
  );
END;
