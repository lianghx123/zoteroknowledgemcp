-- Step 5 storage reservation only; no MCP endpoint or credentials are created.
-- Apply after database-schema.sql in a new disposable database for validation.
CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  selector TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  hash_algorithm TEXT NOT NULL DEFAULT 'sha256' CHECK (hash_algorithm = 'sha256'),
  authorization_version INTEGER NOT NULL DEFAULT 1 CHECK (authorization_version > 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  CHECK (expires_at > created_at)
) STRICT;

CREATE TABLE mcp_token_libraries (
  token_id TEXT NOT NULL REFERENCES mcp_tokens(id),
  library_id TEXT NOT NULL REFERENCES knowledge_libraries(id),
  PRIMARY KEY (token_id, library_id)
) STRICT;

CREATE TABLE mcp_token_scopes (
  token_id TEXT NOT NULL REFERENCES mcp_tokens(id),
  scope TEXT NOT NULL CHECK (scope IN ('knowledge:search', 'knowledge:read', 'knowledge:annotate', 'knowledge:update-summary')),
  PRIMARY KEY (token_id, scope)
) STRICT;
