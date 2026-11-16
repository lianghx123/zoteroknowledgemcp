// Frozen schema baseline. Append migrations after release; do not edit history.
import { sql, type Kysely } from "kysely";

export const checksum = "1ac634c337c4163b6899b5ec743cc16fce0bea7851cdbf80185347e40b6f46f7";
export const statements: readonly string[] = [
  "CREATE TABLE content_visual_projections (\n  generation_id TEXT PRIMARY KEY NOT NULL REFERENCES content_generations(id) ON DELETE CASCADE,\n  version INTEGER NOT NULL CHECK (version > 0),\n  completed_at INTEGER NOT NULL\n) STRICT;",
  "CREATE TABLE content_visual_links (\n  id TEXT PRIMARY KEY NOT NULL,\n  generation_id TEXT NOT NULL REFERENCES content_generations(id) ON DELETE CASCADE,\n  visual_block_id TEXT NOT NULL,\n  related_block_id TEXT,\n  role TEXT NOT NULL CHECK (role IN ('caption', 'note', 'body')),\n  position TEXT NOT NULL CHECK (position IN ('before', 'after', 'content')),\n  evidence TEXT NOT NULL CHECK (evidence IN ('provider', 'layout', 'adjacency')),\n  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),\n  content_markdown TEXT,\n  created_at INTEGER NOT NULL,\n  CHECK ((related_block_id IS NOT NULL AND content_markdown IS NULL AND role <> 'body') OR\n         (related_block_id IS NULL AND content_markdown IS NOT NULL AND evidence = 'provider')),\n  CHECK ((role = 'body' AND position = 'content') OR (role <> 'body' AND position <> 'content')),\n  CHECK (related_block_id IS NULL OR related_block_id <> visual_block_id),\n  UNIQUE (related_block_id),\n  UNIQUE (visual_block_id, role, ordinal),\n  FOREIGN KEY (visual_block_id, generation_id) REFERENCES content_blocks(id, generation_id) ON DELETE CASCADE,\n  FOREIGN KEY (related_block_id, generation_id) REFERENCES content_blocks(id, generation_id) ON DELETE CASCADE\n) STRICT;",
  "CREATE INDEX ix_visual_link_generation ON content_visual_links(generation_id, visual_block_id);"
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
  await sql`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (${"migration-checksum:0012-visual-links"}, ${JSON.stringify(checksum)}, ${Date.now()})`.execute(db);
}
