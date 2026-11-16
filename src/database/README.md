# database

Failed closes clear only their rejected promise, retain ownership and permit retry. Successful closes remain idempotent; owner-close retry skips an already closed main connection. Once closing starts, neither the driver nor the lease can authorize new work. A failed cleanup callback stays in the shared host registry so a later bundle can finish cleanup before acquiring ownership; active owners cannot be displaced.

`createDatabaseOwner()` returns cleanup before `lease.acquire()` runs any SQL. The client retains that handle before awaiting acquisition and owns failure cleanup; the leaf acquisition method never hides or discards it. Acquisition plus cleanup failure retains the registry retry entry and reports both errors. Concurrent close drains in-flight acquisition before closing the native connection.

Implemented independent SQLite connection, native asynchronous driver/dialect, static Kysely migrations, typed tables, shared transactions and validated pre-upgrade snapshots.

`client.ts` is the sole production write connection entry. Startup opens `<Zotero data directory>/knowledgemcp/knowledge.sqlite`; shutdown closes it. The main connection uses NORMAL locking with WAL and permits external read-only viewers. `owner-lease.ts` holds an OS-backed SQLite exclusive lock on the separate `knowledge.sqlite.owner.sqlite` file; a host-owned registry also covers duplicate bundles in Gecko's shared cache. Acquire ownership before initialization and release it only after the main connection drains/closes. Never unlink the owner file; connection/process termination releases its lock without stale-file cleanup. Never substitute `Zotero.DB` or create a second production plugin writer.

Native result rows expose named getters. Repositories must explicitly map projected fields into application records; do not spread or JSON-serialize raw database rows. Use bounded queries; database streaming is unsupported. Named bindings preserve SQL NULL semantics and support a BLOB in the first parameter position.

`batches.ts` provides sequential 200-element query/mutation batches on the caller's context. It does not own a connection or transaction. Use it for array-driven predicates and inserts, account for fixed SET/scope bindings, and prefer relational subqueries for persisted scopes. Knowledge/Trash tests enforce a 999-parameter ceiling, including all fixed values, and cover later-batch rollback. Recovery arrays preserve ordering when rewritten.

See [database runtime and verification](../../docs/development/database-runtime.md). The knowledge-library repository persists metadata, identities, memberships, history and recoverable Trash operations. Processing repositories implement durable jobs and structured publication; local MCP repositories provide bounded authorized reads and transactional writes. `repositories/reader-edit.ts` publishes immutable edit generations with conflict checks, full-text updates and compatible vector reuse. Broader editing parity and external database restore tooling remain future work.

Knowledge snapshots use `KnowledgeTrashRepository.listSummary()` to read only public entry fields and ordered resource IDs. Full `list()` recovery records, including folder, relation, placement, origin and deletion-state links, remain available to restore and permanent-delete transactions. Keep these projections separate so UI refreshes do not materialize the recovery graph.

Migration 0005 backfills nullable `publication_title`, `volume`, `issue` and `doi` columns, removes their old JSON field keys and advances `metadata_schema_version` to 2 without changing logical metadata/resource versions. The original four migration snapshots remain unchanged. The generated field dictionary includes enforced category/boolean values as well as column types.

See the [implementation overview](../../docs/development/implementation-overview.md) and [delivery status](../../docs/development/project-status.md) for implemented behavior and acceptance limits.

Migration 0010 appends a derived full-text position column and projection revision
triggers while preserving the first nine migration checksums. Rebuilding legacy
projection rows is local and leaves canonical literature versions untouched.

Migration 0014 adds thirteen identity lookup indexes for physical deletion and
foreign-key child checks. Prior migration checksums, stored content, deletion
order and ownership rules remain unchanged. See
[deletion measurements and limits](../../docs/development/permanent-deletion.md#lookup-indexes).
