// Frozen schema baseline. Append migrations after release; do not edit history.
import { sql, type Kysely } from "kysely";

export const checksum = "c86d76e2389766bea587099a3ad18f10e4e41414789fad0e57f8dea1d74ed055";
export const statements: readonly string[] = [
  "CREATE TABLE embedding_segments (\n  id TEXT PRIMARY KEY NOT NULL,\n  block_id TEXT NOT NULL REFERENCES content_blocks(id) ON DELETE CASCADE,\n  profile_id TEXT NOT NULL REFERENCES embedding_profiles(id),\n  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),\n  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),\n  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),\n  overlap INTEGER NOT NULL CHECK (overlap >= 0),\n  input_text TEXT NOT NULL,\n  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),\n  skip_reason TEXT,\n  embedding_id TEXT REFERENCES block_embeddings(id) ON DELETE SET NULL,\n  created_at INTEGER NOT NULL,\n  UNIQUE (block_id, profile_id, ordinal)\n) STRICT;",
  "CREATE INDEX ix_segment_embedding ON embedding_segments(embedding_id);",
  "CREATE INDEX ix_segment_profile ON embedding_segments(profile_id, block_id);",
  "CREATE TABLE vector_snapshot_state (\n  profile_id TEXT PRIMARY KEY NOT NULL REFERENCES embedding_profiles(id),\n  build_id TEXT REFERENCES search_index_builds(id) ON DELETE SET NULL,\n  format_version INTEGER NOT NULL DEFAULT 1,\n  mode TEXT NOT NULL CHECK (mode IN ('f32', 'i8')),\n  snapshot_path TEXT,\n  snapshot_hash TEXT,\n  snapshot_bytes INTEGER,\n  corpus_hash TEXT,\n  mutations INTEGER NOT NULL DEFAULT 0,\n  updated_at INTEGER NOT NULL\n) STRICT;"
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
  await sql`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (${"migration-checksum:0009-vector-retrieval"}, ${JSON.stringify(checksum)}, ${Date.now()})`.execute(db);
}
