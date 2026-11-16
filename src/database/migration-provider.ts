import type { MigrationProvider } from "kysely/migration";
import * as foundation from "./migrations/0001-local-foundation";
import * as search from "./migrations/0002-full-text-index";
import * as mcp from "./migrations/0003-mcp-storage";
import * as treeIntegrity from "./migrations/0004-tree-integrity";
import * as bibliographic from "./migrations/0005-bibliographic-fields";
import * as trash from "./migrations/0006-knowledge-trash";

import * as syncPurge from "./migrations/0007-sync-purge";

import * as folderExclusions from "./migrations/0008-sync-folder-exclusions";
import * as vectors from "./migrations/0009-vector-retrieval";
import * as searchOffsets from "./migrations/0010-search-offsets";
import * as referenceBackfill from "./migrations/0011-reference-backfill";
import * as visualLinks from "./migrations/0012-visual-links";
import * as referenceNumbering from "./migrations/0013-reference-numbering";
import * as purgeIndexes from "./migrations/0014-purge-indexes";
import * as mcpRevisions from "./migrations/0015-mcp-revisions";
import * as mcpRevisionHotpaths from "./migrations/0016-mcp-revision-hotpaths";

export const migrations = {
  "0001-local-foundation": foundation,
  "0002-full-text-index": search,
  "0003-mcp-storage": mcp,
  "0004-tree-integrity": treeIntegrity,
  "0005-bibliographic-fields": bibliographic,
  "0006-knowledge-trash": trash,
  "0007-sync-purge": syncPurge,
  "0008-sync-folder-exclusions": folderExclusions,
  "0009-vector-retrieval": vectors,
  "0010-search-offsets": searchOffsets,
  "0011-reference-backfill": referenceBackfill,
  "0012-visual-links": visualLinks,
  "0013-reference-numbering": referenceNumbering,
  "0014-purge-indexes": purgeIndexes,
  "0015-mcp-revisions": mcpRevisions,
  "0016-mcp-revision-hotpaths": mcpRevisionHotpaths,
} as const;

export const migrationProvider: MigrationProvider = {
  async getMigrations() { return migrations; },
};
