// Frozen schema baseline. Append migrations after release; do not edit history.
import { sql, type Kysely } from "kysely";

export const checksum = "4358d10234471422054497df757d14ff9028cff0ecc75f14ed434250208dfd16";
export const statements: readonly string[] = [
  "ALTER TABLE resource_references ADD COLUMN reference_number INTEGER\n  CHECK (reference_number IS NULL OR reference_number >= 0);",
  "ALTER TABLE resource_references ADD COLUMN entry_order INTEGER\n  CHECK (entry_order IS NULL OR entry_order >= 0);",
  "CREATE UNIQUE INDEX uq_reference_generation ON resource_references(id, generation_id);",
  "CREATE TABLE content_reference_projections (\n  generation_id TEXT PRIMARY KEY NOT NULL REFERENCES content_generations(id) ON DELETE CASCADE,\n  version INTEGER NOT NULL CHECK (version > 0),\n  completed_at INTEGER NOT NULL\n) STRICT;",
  "CREATE TABLE reference_source_blocks (\n  reference_id TEXT NOT NULL,\n  generation_id TEXT NOT NULL,\n  block_id TEXT NOT NULL,\n  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),\n  PRIMARY KEY (reference_id, block_id),\n  UNIQUE (reference_id, ordinal),\n  FOREIGN KEY (reference_id, generation_id) REFERENCES resource_references(id, generation_id) ON DELETE CASCADE,\n  FOREIGN KEY (block_id, generation_id) REFERENCES content_blocks(id, generation_id) ON DELETE CASCADE\n) STRICT;",
  "CREATE INDEX ix_reference_source_generation ON reference_source_blocks(generation_id, block_id);"
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
  await sql`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (${"migration-checksum:0013-reference-numbering"}, ${JSON.stringify(checksum)}, ${Date.now()})`.execute(db);
}
