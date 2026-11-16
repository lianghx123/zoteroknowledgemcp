# services

Application operations shared by plugin UI and local MCP tools.

`knowledge-library.ts` owns native metadata and membership commands/reconciliation. `parsing.ts` owns PDF admission, authoritative task projections and worker lifecycle; `parsing-config.ts` validates and hot-reloads private JSON configuration. `content-read.ts` combines manual Markdown cache reads with attachment-specific published generations. `embedding.ts` owns profile-bound ingestion, `vector-store.ts` reconciles persistent USearch indexes, and `retrieval.ts` orchestrates scoped text/semantic/fusion search and reranking. `mcp.ts` owns the implemented scoped local endpoint; remote HTTPS/relay adapters remain deferred. See [parsing](../../docs/development/parsing.md), [retrieval](../../docs/development/vector-retrieval.md) and [MCP access](../../docs/development/mcp.md).

Parsing injects a registry of peer `DocumentParser` implementations rather than a preferred provider client. Profile defaults, option validation and settings choices use the shared parser catalog. Failed result downloads/publications reuse confirmed remote work when source/content versions still match; parser failures and explicit reparses remain distinct.

`collection-sync.ts` owns native one-way collection bindings and serialized reconciliation. `import-tasks.ts` combines live bindings and durable parser history for all task views. Native settings edit the same validated configuration without requiring file editing. See `docs/development/collection-sync.md`.

Synchronization history cleanup refreshes parsing and embedding projections after
their shared transactional history update. Visible current vector workflows keep
their parse/batch grouping while pending, running or paused. Snapshot activation
and embedding startup reclaim unreferenced retired index metadata without
changing canonical vectors or migration history.

`startup-recovery.ts` owns ordered, retryable startup stages and separate full-text/index readiness. It yields between stages, rejects waiting actions on failure/close, and drains the active stage during disposal. Parsing primes already reconciled historical publications so it does not repeat a full metadata pass. Embedding recovery restores only local data before enabling its ordinary background scheduler.

Embedding jobs and requests share an immutable configuration snapshot and an explicitly matching profile. Stale profile activations roll back; stale responses cannot enter vector storage or the query cache. Vector searches validate embedding-space identity against the loaded index. Accepted manual actions and direct recovery/tick operations drain before embedding shutdown returns; new work is rejected once shutdown starts.

See the [implementation overview](../../docs/development/implementation-overview.md) and [delivery status](../../docs/development/project-status.md) for implemented behavior and acceptance limits.

`search-text.ts` shares Unicode token normalization and original-text position
mapping between full-text projection and bounded evidence. Retrieval keeps model
passage budgets separate from displayed snippet budgets, and forwards live MCP
authorization/content guards to queued/retried model dispatch.
Network deadlines, rate/retry queues and startup-recovery yields use the shared
process timer exports, so closing all main windows does not strand accepted MCP
network work or index recovery.

`mcp.ts` owns local listener configuration, token administration and lifecycle
draining. Its settings bridge exposes no token secrets after creation. MCP uses
the shared retrieval service with request-local limits and block filters; UI
result settings and model configuration snapshots retain their own identities.

Knowledge snapshots include Map entries in their equality key and publish only when UI data changes. Collection synchronization with no enabled binding still refreshes its binding projection to detect removed destinations, without a full metadata or parser pass. Idle vector ticks continue checking events and pending jobs but skip index/task projection and completion writes; explicit actions, new events, configuration changes and executed jobs retain their update paths.
