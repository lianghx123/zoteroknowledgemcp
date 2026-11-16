# database/migrations

Migrations are statically bundled and applied by Kysely Migrator:

- `0001-local-foundation`: 33 application tables, indexes, invariant triggers and checksum metadata.
- `0002-full-text-index`: FTS5 external-content index and projection-maintenance triggers.
- `0003-mcp-storage`: three token/library/scope tables, now used by opt-in local MCP access.
- `0004-tree-integrity`: reject existing parent cycles and add AFTER INSERT cycle guards for all three trees, including multi-row inserts. The original three migrations/checksums remain unchanged.
- `0005-bibliographic-fields`: backfill nullable publication title, volume, issue and DOI columns, remove their old metadata JSON keys, and set metadata schema version 2. Nontext legacy values reject the migration before any removal. Resource identity, logical versions, timestamps and fingerprints are preserved; the original four migration snapshots/checksums remain unchanged.
- `0006-knowledge-trash`: import legacy Trash JSON into six foreign-keyed recovery tables, retaining identities, first-occurrence positions and deletion flags. Scalar-reference materialization avoids duplicating complete JSON documents during grouping. Cleanup remains in the same transaction after import. Its known earlier unreleased development checksums are accepted only for already-applied 0006 with identical DDL/semantics; history is not rewritten. Migrations 0001-0005 are unchanged.

- `0007-sync-purge`: sync modes, item exclusions, durable file cleanup and transaction-scoped physical purge authorization.
- `0008-sync-folder-exclusions`: collection-key exclusions independent of mapped-folder lifetime.
- `0009-vector-retrieval`: traced embedding segments and replaceable vector snapshot state.
- `0010-search-offsets`: derived full-text Unicode positions and atomic projection revision triggers. Existing projections rebuild locally; historical statements/checksums are preserved.
- `0011-reference-backfill`: derive bibliography records from published parser reference blocks, preserving existing records and tombstones. No table changes or provider requests; source blocks, literature versions and historical migration checksums remain unchanged.
- `0012-visual-links`: generation-scoped, foreign-keyed title/note associations and explicit embedded provider parts. A versioned derived projection supplements immutable canonical content; local startup backfill needs no OCR upload and keeps uncertain blocks independent.
- `0013-reference-numbering`: nullable original number and entry order, generation projection checkpoints and composite foreign-keyed source links for merged/split bibliography entries. Startup derives number-free bodies locally without rewriting canonical blocks or manual reference work.
- `0014-purge-indexes`: thirteen nonunique identity indexes for permanent-deletion lookups and foreign-key child probes. It changes no business rows or deletion order and keeps shared-resource, file-ownership and immutable-content protections. Existing databases use the validated pre-upgrade backup and transactional migration path.

Migrator creates its two metadata tables itself. All pending migrations and history writes share one transaction; failures roll back the pending set. No destructive `down()` is offered.

The migration adapter requires an active separate database-owner lease, acquired before history inspection, backup and Kysely metadata bootstrap. It no longer requires exclusive locking of the main knowledge database. Ordinary main-file transactions coordinate with external SQLite readers.

These unreleased snapshots were promoted from reviewed SQL fixtures using `scripts/promote-database-schema.mjs`. `--check` normalizes CRLF to LF before verifying agreement and never rewrites files; other content changes still fail validation. After release freeze historical fixtures/snapshots and append migrations in lexical order; never regenerate released history to implement a schema change.

See the [implementation overview](../../../docs/development/implementation-overview.md) and [delivery status](../../../docs/development/project-status.md) for implemented behavior and acceptance limits.
