# Native Database Schema and Migrations

This reference covers plugin-owned storage, sixteen migrations, transactions, ownership and recovery boundaries.

## Implemented Storage

The plugin pins **Kysely 0.29.7** and uses its `Migrator` with an explicitly imported static provider. A custom asynchronous driver/dialect bridges to independent `Zotero.DBConnection` instances. No Node/Python database runtime or Redis service is used.

Startup opens `<Zotero data directory>/knowledgemcp/knowledge.sqlite` before registering the reader UI. It validates SQLite capabilities, checks installed history/checksums, migrates, and verifies integrity/foreign keys. Shutdown waits for initialization and closes storage; failed initialization closes its connection and releases ownership. Database readiness failure rejects startup.

Storage follows the Zotero data-directory lifecycle. In Zotero 10.0.6, ordinary logout retains the library, source user ID and plugin data. An accepted account switch or removal of local account data triggers a restart that clears the data directory, including `knowledgemcp/` and its pre-upgrade snapshots, before plugins start. The plugin then initializes fresh storage. Upgrade snapshots in the same directory do not protect against this reset; retaining data across it requires an external backup/export workflow, which is not implemented. See [account/reset source assessment](knowledge-membership-metadata.md#zotero-account-and-data-directory-lifecycle).

| Migration | Installed objects |
| --- | --- |
| Kysely bootstrap | `kysely_migration` and `kysely_migration_lock`, managed by Migrator |
| `0001-local-foundation` | 33 application tables for knowledge libraries, memberships, native mappings, resources/sources/files, jobs/parsing, immutable content generations, annotations/references/revisions, embeddings/index metadata and outbox/checkpoints; indexes and invariant triggers |
| `0002-full-text-index` | `search_fts` external-content FTS5 virtual table and insert/update/delete projection triggers |
| `0003-mcp-storage` | `mcp_tokens`, `mcp_token_libraries`, `mcp_token_scopes`; used by local MCP authorization |
| `0004-tree-integrity` | Preflight existing parent cycles; add three AFTER INSERT cycle guards for library nodes, structure nodes and content blocks; no new tables |
| `0005-bibliographic-fields` | Add nullable `publication_title`, `volume`, `issue` and `doi` resource columns, backfill old JSON values and remove those keys; no new tables |
| `0006-knowledge-trash` | Six dedicated Trash entry/recovery-link tables, scoped foreign keys and indexes; import existing `knowledge-trash:*` JSON and remove those keys atomically |
| `0007-sync-purge` | Binding sync mode, item exclusions, durable file cleanup and transaction-scoped authorization for physical content deletion |
| `0008-sync-folder-exclusions` | Collection-key exclusions that survive physical removal of a mapped folder |
| `0009-vector-retrieval` | `embedding_segments` for profile-bound split inputs/provenance and `vector_snapshot_state` for replaceable USearch snapshots; canonical vectors remain in `block_embeddings` |
| `0010-search-offsets` | Original Unicode position arrays in `search_documents.body_offsets_json` and transactional insert/update/delete revision triggers; no new tables or canonical content changes |
| `0011-reference-backfill` | Local bibliography backfill from published parser blocks; no new tables |
| `0012-visual-links` | Generation-scoped visual associations and projection checkpoints in two new tables |
| `0013-reference-numbering` | Original citation numbers, entry order, bibliography projection checkpoints and multi-block source links in two new tables |
| `0014-purge-indexes` | Thirteen identity lookup indexes for permanent deletion and foreign-key child probes; no new tables or business-row changes |
| `0015-mcp-revisions` | Monotonic library revision rows and 51 transactional invalidation triggers; seed existing libraries and retain deletion tombstones |
| `0016-mcp-revision-hotpaths` | Combine resource-update membership probes and skip inactive block trigger bodies; preserve existing revision values and migration checksums |

Total: **55 ordinary tables and 1 FTS5 virtual table**, including Kysely's two metadata tables and excluding SQLite/FTS internal tables: 56 typed tables. All application tables remain STRICT. Kysely's two metadata tables retain the manager's standard shapes. Complete fields and relationships are in the [field dictionary](database-field-dictionary.md).

Migrations create storage without seeding literature, processing tasks, vectors or MCP credentials. Application services now implement metadata/membership, collection synchronization, durable parsing, structured publication, vector ingestion and internal retrieval. The reader combines published attachment generations with a separate manual Markdown cache. The local MCP service uses the token tables, plugin_state for listener/signing settings, and mutation_receipts/revisions/outbox for transactional writes. Migration 0010 adds derived search positions and a full-text revision for correct bounded evidence and continuation. Old rows retain their body and gain an empty offset array; startup locally rebuilds block projections under tokenizer profile `unicode-cjk-bigram-2`, without model requests or literature version changes. Interrupted installation rolls back the column, triggers and revision together; the standard validated pre-upgrade snapshot remains required. See [MCP access](mcp.md).

## Transactions, Ownership and Recovery

Production queries and transactions share one FIFO connection. Transactions use
`BEGIN IMMEDIATE`; MCP consistency checks now read scoped revision rows with one
SELECT instead of opening a whole-library snapshot transaction. See the
[native concurrency experiment](database-concurrency-performance.md) for the
earlier connection comparisons and [MCP read measurements](mcp-read-performance.md)
for the implemented SQL, batching and revision changes. Connection ownership is unchanged.

MCP checks token authorization and library revisions before and after assembling
a read. Transactional triggers advance the revisions for visible resource,
membership, folder, annotation, revision, reference and active content changes.
Shared resources invalidate every live member library; private-library folder
changes do not invalidate another library. Staging generations remain invisible
until atomic source publication. Source-check timestamps and unchanged values
do not invalidate reads. Decimal revision strings retain SQLite integer precision;
overflow rejects and rolls back the write. Missing revision rows reject reads.
Revision tombstones survive physical library deletion to prevent delete/recreate
ABA. Invalidation is conservatively library-wide, including filtered resource
reads. The new state format invalidates cursors issued by the preceding version.

Resource listing applies stable `created_at, id` ordering, LIMIT/OFFSET and an
optional separate COUNT in SQL. Get-by-ID reads only the requested authorized IDs.
Required sources, memberships, identifiers and statistics are batched for the
selected page; unrequested fields/relations are not fetched. Deep OFFSET pages
still require SQLite to skip preceding matches, and folder descendants still use
the existing folder expansion. These changes do not add a connection pool.

- All pending migrations and their history/checksum writes execute in one Kysely transaction. Migration errors are checked explicitly. No destructive `down()` is offered.
- Closing storage waits for the active connection lease, including transaction commit or rollback. Requests already queued inside Kysely receive a rejecting connection that never executes native SQL. Rejecting at execution lets Kysely 0.29.7 release its single-connection mutex for every waiter; rejecting acquisition would leave later requests hung. New requests after destruction reject immediately.
- The main database uses NORMAL locking, WAL, foreign keys, FULL synchronous mode and a five-second busy timeout. External read-only SQLite viewers can read committed data while Zotero runs, including during a write transaction. A read transaction retains its own snapshot until it ends. External viewers should use normal WAL-aware read-only access, not immutable mode or a copied main file without its committed WAL state.
- `owner-lease.ts` exclusively locks the separate `knowledge.sqlite.owner.sqlite` SQLite file before main-file initialization/preflight/backup/bootstrap, retaining it until the main connection drains and closes. It contains no literature records. A zero busy timeout rejects competing plugin owners promptly. A host-object registry additionally excludes duplicate bundles within Gecko's shared cache. This is cooperative single-plugin-writer ownership; arbitrary external main-file writers do not honor it and are not supported as a business mutation API. SQLite still coordinates main-file transactions normally.
- Never delete/unlink the owner file to clear a busy state: another process could lock a replacement file while the first still holds the original. SQLite/OS connection close or process termination releases the actual lock; a leftover file is harmless and reusable. Failed startup closes both connections, including failures before Kysely acquires its first connection. Concurrent close calls share one in-flight drain/release promise; successful completion remains cached. A rejected close clears its promise for retry, retaining the owner lock/registry and rejecting new work. Retrying owner release skips an already closed main connection.
- Application disposal clears its database handle only after successful close. A recorded failed cleanup callback in the host registry survives bundle replacement: a later initializer retries that cleanup before claiming the same path, then rechecks the registry to exclude racing initializers. Active owners have no retry callback and cannot be displaced. Repeated failed cleanup still rejects initialization and closes the candidate connection.
- Owner acquisition uses two stages: create the native cleanup handle, then execute acquisition SQL. The client retains the handle before awaiting any SQL, including COMMIT. If acquisition and cleanup both fail, an AggregateError preserves both failures and the host registry retains its cleanup callback. A later initializer must complete that cleanup before opening a new owner. Close requested during acquisition drains the pending SQL before native close; it never authorizes new work afterwards.
- The custom migration adapter asserts that the separate owner lease is active, then updates Kysely's lock indicator. The indicator alone provides no exclusion. Kysely's bootstrap tables can survive interruption and retry; unversioned business tables, unknown/missing/out-of-order history and checksum mismatches block startup.
- Before a pending upgrade to an already versioned database, `VACUUM INTO` creates `<database>.pre-upgrade-<Unix milliseconds>.bak`. A separate native connection loads FTS5 and verifies snapshot integrity/history before migration. This includes committed WAL data. Backup failure prevents the upgrade. Fresh installation and unchanged schema do not create upgrade snapshots.
- Checksums are supplemental `plugin_state` records written by each migration in its transaction. Snapshot checks run in tests; Kysely itself does not implement checksums. Freeze released history and append new migrations.
- The compatible 0006 importer was optimized to group scalar references instead of carrying the full recovery JSON through the sorter. Tables/indexes, validation, first-position deduplication, deletion flags and transaction semantics are unchanged. `inspectHistory` also accepts its two explicitly accepted compatible checksums (`9be1daf18124bce33b286616f2fa08381cc9410330bfba64a00d98f49a6c1c97` and `fed21552d1b87c6635b8616cf272083d291c0a4b7d28da38473033d196ebb060`) for already-applied 0006 only. It neither rewrites history nor reruns that importer. Unknown checksums and use of that checksum on another migration still reject startup. Migrations 0001-0005 are unchanged; tests pin the predecessor's DDL fingerprint and exact imported data behavior.
- `database/batches.ts` limits array-driven repository statements to 200 elements; existing recovery inserts bind four values per row. The same transaction covers every batch. Metadata snapshots and readmission checks use recovery-table subqueries/joins. Regression tests enforce at most 999 bindings including scope and SET values, exercise all array-driven Trash operations and verify complete rollback/retry. The [scale verification report](trash-scale-verification.md) records current tested sizes and native evidence.
- Managed parse-artifact recovery, durable parse/vector task recovery, knowledge Trash restore, file-cleanup retries and local index rebuilding from canonical vectors are implemented. Complete database/artifact backup and restore tooling and restore drills remain pending. There is no automatic restore, deletion or recreation of an incompatible database. Database snapshots alone do not back up referenced document files. See [parsing recovery](parsing.md), [permanent deletion](permanent-deletion.md) and [vector recovery](vector-retrieval.md).

## Permanent-Deletion Lookup Upgrade

Migration 0014 adds thirteen nonunique indexes on resource, generation, block,
embedding and stored-file identities. Existing versioned databases receive the
standard validated `VACUUM INTO` snapshot before the migration. Index creation,
the migration history and its checksum commit atomically; an interrupted upgrade
rolls back every new index and can be retried. Fresh databases receive the same
indexes through the normal migration sequence. No business rows, published
content or earlier migration statements are rewritten. See
[deletion measurements and write-cost limits](permanent-deletion.md#lookup-indexes).

## Bibliographic Field Upgrade

Migration 0005 is a separate bibliographic supplement: nullable TEXT columns `publication_title`, `volume`, `issue` and `doi` replace `metadata_json.fields.publicationTitle`, `.volume`, `.issue` and `.DOI`. It checks that existing values are text/null before altering/removing them. Empty strings become NULL; unrelated JSON and Zotero-owned normalized identifier rows are preserved. `metadata_schema_version` becomes 2 without changing resource UUIDs, logical versions, fingerprints, timestamps or revision history. New admissions and native refreshes write/clear these columns directly. `doi` retains the raw native value; normalized DOI lookup remains in `resource_identifiers`.

## Trash Storage Upgrade

Migration 0006 stores Trash operations in `knowledge_trash_entries` and their ordered recovery references in `knowledge_trash_resources`, `knowledge_trash_folders`, `knowledge_trash_relations`, `knowledge_trash_placements` and `knowledge_trash_origins`. Resources carry a checked `was_deleted` flag for optional exclusive-data recovery. Composite foreign keys keep target folders and recovery links in the entry's knowledge library; reverse indexes support reference lookups. Deleting an entry cascades to its recovery links only. The permanent-deletion repository then removes unreferenced ownership records and resource content in the same transaction; see [permanent deletion](permanent-deletion.md). Zotero originals remain intact.

The migration validates legacy JSON shapes, item types, key/entry identity and deleted-resource subsets, then imports every reference with its original position. Duplicate array IDs become one association at their first position. Missing model references and wrong-library links fail foreign-key checks. Legacy keys are removed only after all inserts succeed, in the same migration transaction. Failure leaves the old records/history intact and blocks startup until the underlying issue is resolved; the pre-upgrade snapshot remains available. No old business rows, UUIDs, logical versions or timestamps are rewritten. Subsequent Trash operations never read or write recovery JSON in `plugin_state`. Tree expansion remains a profile preference.

## SQLite Types and Source Libraries

Application tables are STRICT. SQLite STRICT supports INTEGER, REAL, TEXT, BLOB and ANY, not native ENUM, BOOLEAN or DATETIME declarations. Plugin event timestamps use INTEGER UTC Unix milliseconds; versions/counts use INTEGER, confidence values use REAL, vectors use BLOB, and UUIDs/text/JSON use TEXT. Closed categories use `TEXT CHECK (column IN (...))`; booleans use `INTEGER CHECK (column IN (0, 1))`. Invalid categories and nonnumeric timestamps are rejected by SQLite itself. The generated field dictionary now includes these allowed category/boolean values.

Bibliographic dates are deliberately TEXT because native records can contain a year, season, range or incomplete date. Volume and issue also remain TEXT to preserve values such as `S1`, `3–4` or `Suppl. 2`. Open native item types are textual Zotero item-type names rather than a frozen plugin enum. These representations do not imply that all fields are unrestricted strings.

`zotero_libraries` records the source identity and last observed permissions for native libraries that supply admitted resources. It is not an independent knowledge library or a mirror of Zotero's folder tree. Its plugin UUID plus an item's native `item_key` identifies the mapped original; local numeric IDs are lookup hints. Group/user identity protects against adopting a different source after an account/library change. Reconciliation resolves originals through the native library/key and refreshes already admitted metadata one way. Continuous collection synchronization and MCP authorization remain separate features; this table does not grant either. Native operations still check current Zotero permissions.

## Tree Integrity Upgrade

Migration 0004 appends to the original three migrations without changing their statements or checksums. Before adding triggers it checks all three parent graphs using terminating recursive queries. Existing cycles reject the migration; its transaction leaves history/checksums and data unchanged. A versioned database receives the normal validated pre-upgrade snapshot before this check. There is no automatic repair or deletion: retain the backup and resolve the invalid relationships explicitly before retrying.

The new AFTER INSERT triggers see earlier rows of a multi-row INSERT and reject the statement if its final edge closes a cycle. SQLite rolls back every row of that statement. Existing update-time cycle guards remain in place. No table shapes or field types change.

## Native Adapter Details

Gecko treats an indexed parameter array beginning with a BLOB as a batch of parameter objects. The custom compiler therefore emits `:p1`, `:p2`, etc., with named bindings. Native execution bypasses Zotero's default NULL rewriting and uses `onRow` for SELECT, CTE and RETURNING statements. BLOBs are exposed as `Uint8Array`; writes require bytes such as little-endian Float32 vectors. A second serialized query returns `changes()` for affected-row counts.

Native rows expose named getters rather than enumerable plain records. Repositories must explicitly project/map fields before object spread, JSON serialization or returning application records. Streaming, savepoints and nonserializable transaction modes are unsupported; use bounded queries and the service-owned transaction context from `unit-of-work.ts`.

Generated row types map SQLite REAL columns to `number`, including all four nullable `confidence` fields. An independent TypeScript fixture checks that each public field is exactly `number | null`; the adapter tests verify numeric and NULL round trips. These type and shutdown fixes do not change SQL schema, frozen migrations or checksums.

The native API subset was inspected in installed Zotero 10.0.6 `xpcom/db.js` and Gecko `Sqlite.sys.mjs`. The runtime does not use the Node-only fixture/dictionary tools or a synchronous Node SQLite dialect.

## Verification

Run `npm run database:check`, `npm run typecheck` and `npm test`. The SQLite-backed
regressions cover ownership exclusion, failed acquisition/close retry, publication
rollback, schema/history checks, supported upgrades, Trash imports and cleanup.
Use isolated native databases to verify real connection locking, BLOB bindings,
WAL-aware snapshots, migration rollback and process restart. Node simulations do
not establish filesystem crash recovery or cross-platform behavior.

Complete external database/artifact backup and restore drills remain pending.
See [validation scope](database-design-validation.md) and [project status](project-status.md).
