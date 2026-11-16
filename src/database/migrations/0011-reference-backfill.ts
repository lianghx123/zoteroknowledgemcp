// Frozen schema baseline. Append migrations after release; do not edit history.
import { sql, type Kysely } from "kysely";

export const checksum = "07a1944f0f4b352f93b4caa4b007fcee2f56c2a21d6e10af50b31681ecad8442";
export const statements: readonly string[] = [
  "INSERT INTO resource_references (\n  id, resource_id, source_id, generation_id, source_block_id, reference_type,\n  raw_text, created_at, updated_at\n)\nSELECT b.id, g.resource_id, g.source_id, g.id, b.id, 'bibliography',\n  b.content_markdown, b.created_at, b.created_at\nFROM content_blocks AS b\nJOIN content_generations AS g ON g.id = b.generation_id\nWHERE g.origin = 'parse' AND g.state IN ('ready', 'partial', 'superseded')\n  AND b.block_type IN ('reference', 'reference_entry', 'bibliography')\n  AND length(trim(b.content_markdown)) > 0\n  AND NOT EXISTS (SELECT 1 FROM resource_references AS r WHERE r.id = b.id)\n  AND NOT EXISTS (\n    SELECT 1 FROM resource_references AS r\n    WHERE r.source_block_id = b.id AND r.reference_type = 'bibliography'\n  );"
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
  await sql`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (${"migration-checksum:0011-reference-backfill"}, ${JSON.stringify(checksum)}, ${Date.now()})`.execute(db);
}
