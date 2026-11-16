// Frozen schema baseline. Append migrations after release; do not edit history.
import { sql, type Kysely } from "kysely";

export const checksum = "ff91959206585c3704d6941ca06b55858f86d63b1767a78341298b261718f0b5";
export const statements: readonly string[] = [
  "WITH RECURSIVE ancestors(origin_id, id, parent_id) AS (\n  SELECT id, id, parent_id FROM library_nodes WHERE parent_id IS NOT NULL\n  UNION\n  SELECT a.origin_id, n.id, n.parent_id FROM library_nodes n JOIN ancestors a ON n.id = a.parent_id\n)\nSELECT 'LIBRARY_NODE_CYCLE' AS cycle WHERE EXISTS (SELECT 1 FROM ancestors WHERE parent_id = origin_id);",
  "WITH RECURSIVE ancestors(origin_id, id, parent_id) AS (\n  SELECT id, id, parent_id FROM structure_nodes WHERE parent_id IS NOT NULL\n  UNION\n  SELECT a.origin_id, n.id, n.parent_id FROM structure_nodes n JOIN ancestors a ON n.id = a.parent_id\n)\nSELECT 'STRUCTURE_NODE_CYCLE' AS cycle WHERE EXISTS (SELECT 1 FROM ancestors WHERE parent_id = origin_id);",
  "WITH RECURSIVE ancestors(origin_id, id, parent_id) AS (\n  SELECT id, id, parent_block_id FROM content_blocks WHERE parent_block_id IS NOT NULL\n  UNION\n  SELECT a.origin_id, n.id, n.parent_block_id FROM content_blocks n JOIN ancestors a ON n.id = a.parent_id\n)\nSELECT 'BLOCK_PARENT_CYCLE' AS cycle WHERE EXISTS (SELECT 1 FROM ancestors WHERE parent_id = origin_id);",
  "CREATE TRIGGER library_node_cycle_insert AFTER INSERT ON library_nodes\nWHEN NEW.parent_id IS NOT NULL\nBEGIN\n  SELECT RAISE(ABORT, 'LIBRARY_NODE_CYCLE') WHERE EXISTS (\n    WITH RECURSIVE ancestors(id, parent_id) AS (\n      SELECT id, parent_id FROM library_nodes WHERE id = NEW.parent_id\n      UNION SELECT n.id, n.parent_id FROM library_nodes n JOIN ancestors a ON n.id = a.parent_id\n    ) SELECT 1 FROM ancestors WHERE id = NEW.id\n  );\nEND;",
  "CREATE TRIGGER structure_node_cycle_insert AFTER INSERT ON structure_nodes\nWHEN NEW.parent_id IS NOT NULL\nBEGIN\n  SELECT RAISE(ABORT, 'STRUCTURE_NODE_CYCLE') WHERE EXISTS (\n    WITH RECURSIVE ancestors(id, parent_id) AS (\n      SELECT id, parent_id FROM structure_nodes WHERE id = NEW.parent_id\n      UNION SELECT n.id, n.parent_id FROM structure_nodes n JOIN ancestors a ON n.id = a.parent_id\n    ) SELECT 1 FROM ancestors WHERE id = NEW.id\n  );\nEND;",
  "CREATE TRIGGER block_parent_cycle_insert AFTER INSERT ON content_blocks\nWHEN NEW.parent_block_id IS NOT NULL\nBEGIN\n  SELECT RAISE(ABORT, 'BLOCK_PARENT_CYCLE') WHERE EXISTS (\n    WITH RECURSIVE ancestors(id, parent_id) AS (\n      SELECT id, parent_block_id FROM content_blocks WHERE id = NEW.parent_block_id\n      UNION SELECT b.id, b.parent_block_id FROM content_blocks b JOIN ancestors a ON b.id = a.parent_id\n    ) SELECT 1 FROM ancestors WHERE id = NEW.id\n  );\nEND;"
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const statement of statements) {
    const result = await sql.raw<{ cycle: string }>(statement).execute(db);
    if (result.rows.length) throw new Error(`Tree integrity migration refused existing parent cycles: ${result.rows[0].cycle}`);
  }
  await sql`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (${"migration-checksum:0004-tree-integrity"}, ${JSON.stringify(checksum)}, ${Date.now()})`.execute(db);
}
