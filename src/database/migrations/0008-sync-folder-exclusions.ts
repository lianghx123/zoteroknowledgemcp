// Frozen schema baseline. Append migrations after release; do not edit history.
import { sql, type Kysely } from "kysely";

export const checksum = "127af5976bac4bd4346403839414d24979703284a3155cc4eda0cf78df986b38";
export const statements: readonly string[] = [
  "CREATE TABLE sync_collection_exclusions (\n  binding_id TEXT NOT NULL REFERENCES zotero_bindings(id),\n  collection_key TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY (binding_id, collection_key)\n) STRICT;"
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
  await sql`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (${"migration-checksum:0008-sync-folder-exclusions"}, ${JSON.stringify(checksum)}, ${Date.now()})`.execute(db);
}
