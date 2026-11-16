// Frozen schema baseline. Append migrations after release; do not edit history.
import { sql, type Kysely } from "kysely";

export const checksum = "45c67dbf97a71ac8d39113bea8944e0f10bd104a623ae8e18c62cb75ec3072bc";
export const statements: readonly string[] = [
  "ALTER TABLE search_documents ADD COLUMN body_offsets_json TEXT NOT NULL DEFAULT '[]'\n  CHECK (json_valid(body_offsets_json) AND json_type(body_offsets_json) = 'array');",
  "INSERT INTO plugin_state(key, value_json, updated_at) VALUES ('fulltext-revision', '0', 0);",
  "CREATE TRIGGER search_projection_revision_insert AFTER INSERT ON search_documents\nBEGIN\n  UPDATE plugin_state SET value_json = CAST(CAST(value_json AS INTEGER) + 1 AS TEXT)\n    WHERE key = 'fulltext-revision';\nEND;",
  "CREATE TRIGGER search_projection_revision_update AFTER UPDATE ON search_documents\nBEGIN\n  UPDATE plugin_state SET value_json = CAST(CAST(value_json AS INTEGER) + 1 AS TEXT)\n    WHERE key = 'fulltext-revision';\nEND;",
  "CREATE TRIGGER search_projection_revision_delete AFTER DELETE ON search_documents\nBEGIN\n  UPDATE plugin_state SET value_json = CAST(CAST(value_json AS INTEGER) + 1 AS TEXT)\n    WHERE key = 'fulltext-revision';\nEND;"
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
  await sql`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (${"migration-checksum:0010-search-offsets"}, ${JSON.stringify(checksum)}, ${Date.now()})`.execute(db);
}
