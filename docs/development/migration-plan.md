# Knowledge Plugin Development Plan

This plan defines the plugin's implemented boundaries, remaining work and
acceptance gates. See [project status](project-status.md) for the delivery ledger
and [runtime assessment](migration-assessment.md) for platform constraints.

## Accepted Five-Step Execution Order

| Step | Responsibility | Current boundary |
| --- | --- | --- |
| 1. Database design | Stable entities, ownership, schema and migration contracts | Implemented local schema and documented invariants. |
| 2. Database foundation | Native driver, migrations, transactions, locks and upgrade snapshots | Implemented and verified in isolated Zotero. Complete external backup/restore remains pending. |
| 3. Item processing | Native admission, collection synchronization, PDF parsing, publication and embedding tasks | Native PDF path implemented; direct parse-result import and broader source adapters remain deferred. |
| 4. Internal reading and retrieval | Reader/edit-save, full text, vectors, fusion, evidence and reranking | Implemented local workflow; independent relevance and approximately 1,000-paper end-to-end acceptance remain open. |
| 5. MCP | Typed tools, scopes, budgets, continuations, mutations and protocol transport | All 16 local tools and SSE-only Streamable HTTP implemented; public HTTPS and relay adapters remain deferred. |

## Local Capability Boundaries

Native bibliography and attachments remain Zotero-owned. Plugin services share
one independent database, managed artifacts and explicit resource/source identities.
Native UI and MCP invoke the same application rules. Views own interaction state;
application services own durable jobs, recovery and shutdown. See the
[source architecture](src-architecture.md).

### Source and Membership

Preserve multi-membership, folder ancestry, binding-owned origins, local exclusions
and Trash rights. Metadata-only changes must not automatically upload PDFs or
regenerate embeddings. Incomplete scans cannot infer deletion. Folder batches
must deduplicate selected ancestors and descendants in one transaction.

### Processing and Publication

Native reconciliation, parsing and vector maintenance are separate task families
under bounded scheduling. Persist checkpoints and provider identities, reject
stale attempts and retain the last readable generation until replacement succeeds.
Network/model work stays outside write transactions. Raw artifacts and accepted
content have separate ownership and retention rules.

### Reader and Retrieval

Reading/editing preserves attachment identity, source locations and immutable
published generations. Explicit Save document performs version checks and updates
full-text/vector projections transactionally. Retrieval preserves complete selected
evidence, scoped authorization, compatible vector spaces and explicit degradation.

### MCP

Request bodies use JSON-RPC JSON and protocol responses use SSE only. Keep
initialization, headers, client identities, cancellation, access rejection and
listener cleanup aligned with [the MCP reference](mcp.md). Do not interpret JSON
request encoding as support for JSON-response mode.

Local resource pages default to 20 with a maximum of 100; search is limited to 50
papers and document reads to 50,000 Unicode characters. Apply each tool's own
budgets. Cursors have a one-hour TTL and bind tool/filter/scope/content and current
authorization. Mutations use operation IDs and expected versions for replay safety.

## Remaining Work Packages

| Package | Required result | Acceptance gate |
| --- | --- | --- |
| Representative corpus | Approximately 1,000 multilingual papers with independent relevance labels | Agreed latency, peak-memory, recall and UI-responsiveness budgets across admission, parsing, retrieval, restart and MCP reads. |
| Backup and restore | External backup/restore covering database, artifacts, indexes and compatible versions | Interrupted/failure recovery drills with storage and writers closed correctly; an old XPI alone must not be advertised as schema downgrade. |
| Additional sources | Separately defined manual/result-import or other source adapters | Versioned formats, source association, ordering, paths, locations and malformed-input/recovery checks before enabling an entry point. |
| Editing and management | Remaining reorder/merge/split/review and organization workflows | Conflict detection, annotation/reference preservation, transactional indexing and native UI/localization acceptance. |
| Cross-platform reliability | macOS/Linux, long-running and OS-level crash acceptance | Exact-package installation, native lifecycle/storage/worker checks, independent exit checks and explicit compatibility reporting. |
| Remote connectivity | Independently specified HTTPS and account/relay adapters | Streaming, certificate/identity lifecycle, current local authorization, device isolation, reconnect/replay protection and cleanup. |

## Regression and Release Gates

Run type checking, the production build/full Node suite, database consistency and
documentation/localization checks for the applicable candidate. Add native checks
when runtime storage, dependencies, windows, UI or transport change. Use isolated
libraries and shareable fixtures. Distinguish synthetic providers from live service
quality and automated DOM probes from manual UI acceptance.

Required failure cases include stale source/generation/profile, revoked permissions,
malformed artifacts, incomplete scans, ambiguous upload outcomes, failed cleanup,
partial startup and shutdown while accepted work is active. A retained performance
change requires measured native gains with representative alternating samples.

Each release uses its reviewed clean source, exact XPI, supported host range,
complete notices and checksum. Public source, public documentation and installer
reachability are separate checks. Follow the [release procedure](releases.md).

## Separate Future Scope

Cloud synchronization and offline replicas require independent consent, retention,
ownership and conflict contracts. They are not implied by remote relay access.
External authorization adapters must not replace installation-local token checks.
Importing another application's database requires a separately reviewed mapping.
Unrelated experiment execution and remote-service administration are outside this
plugin's implementation scope.
