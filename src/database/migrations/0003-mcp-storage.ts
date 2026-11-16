// Frozen schema baseline. Append migrations after release; do not edit history.
import { sql, type Kysely } from "kysely";

export const checksum = "6638247b0013d82a7bfdd56e7476bdfe5155e457f33bbffc00f5eb5c4014431f";
export const statements: readonly string[] = [
  "CREATE TABLE mcp_tokens (\n  id TEXT PRIMARY KEY NOT NULL,\n  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),\n  selector TEXT NOT NULL UNIQUE,\n  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),\n  hash_algorithm TEXT NOT NULL DEFAULT 'sha256' CHECK (hash_algorithm = 'sha256'),\n  authorization_version INTEGER NOT NULL DEFAULT 1 CHECK (authorization_version > 0),\n  created_at INTEGER NOT NULL,\n  expires_at INTEGER NOT NULL,\n  last_used_at INTEGER,\n  revoked_at INTEGER,\n  CHECK (expires_at > created_at)\n) STRICT;",
  "CREATE TABLE mcp_token_libraries (\n  token_id TEXT NOT NULL REFERENCES mcp_tokens(id),\n  library_id TEXT NOT NULL REFERENCES knowledge_libraries(id),\n  PRIMARY KEY (token_id, library_id)\n) STRICT;",
  "CREATE TABLE mcp_token_scopes (\n  token_id TEXT NOT NULL REFERENCES mcp_tokens(id),\n  scope TEXT NOT NULL CHECK (scope IN ('knowledge:search', 'knowledge:read', 'knowledge:annotate', 'knowledge:update-summary')),\n  PRIMARY KEY (token_id, scope)\n) STRICT;"
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
  await sql`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (${"migration-checksum:0003-mcp-storage"}, ${JSON.stringify(checksum)}, ${Date.now()})`.execute(db);
}
