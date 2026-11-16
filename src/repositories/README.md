# repositories

Persistence interfaces and aggregate queries. `knowledge-library.ts` implements transactional native metadata and membership, including binding-owned origins. `collection-sync.ts` persists collection bindings/mappings and prunes only their origins. `processing.ts` owns the SQLite queue, fenced checkpoints and atomic structured publication, revisions and outbox events. `processed-content.ts` reads published attachment generations and verified local assets. Manual reader imports retain their separate cache. Repositories do not dispatch worker loops; the sync service owns reconciliation.

`reference-content.ts` publishes numbered bibliography projections in the content
transaction and backfills missing projections at startup. Original numbers and
entry order are separate from number-free bodies; source links retain merged
fragment provenance and packed-entry splits. Migration 0013 supplies these fields
and tables after the original 0011 block backfill. Manual records and tombstones
are preserved. Reads use current authorized generation anchors and source order;
no bibliographic fields or matches are inferred.
See [reference ingestion](../../docs/development/parsing.md#reference-ingestion).

`embeddings.ts` persists immutable vector-space profiles, traced segments,
normalized Float32 BLOBs, durable embedding job checkpoints and native text/metadata
search projections. Snapshot publication and recovery metadata belong to the
plugin database; canonical vectors can rebuild the index without provider calls.
Block full-text projections retain original Unicode offsets and a database-triggered
revision. Profile upgrades rebuild derived rows locally without altering literature
versions. `mcp.ts` uses authorized, transactionally read source/generation state for
cursor binding and bounded SQL substring reads.
Retired vector builds and their labels are reclaimed transactionally after
activation and during startup, with every referenced snapshot protected.
`processing.ts` clears terminal batch history across parse/vector phases in one
transaction while retaining visible live workflows for current generations.

Library deletion logically removes its tree/memberships, optionally deletes exclusive knowledge resources and preserves shared resources and native originals. Default replacement and intentionally empty startup are handled transactionally; revision history remains intact.

The resource projection writes publication title, volume, issue and raw DOI to dedicated columns. Other native fields/tags remain in metadata JSON; normalized DOI identifiers remain in `resource_identifiers`. Refresh clears removed fields without overwriting plugin-owned metadata or summaries.

Folder deletion removes descendant placements and retains any folder-only resources through a root membership, with versions/history committed atomically. Admission remains idempotent for multi-item drag copies.

Creation returns the new node UUID and validates trimmed names and duplicate libraries/sibling folders within the transaction, with user-facing expected errors rather than raw uniqueness violations.

See [metadata ownership and update policy](../../docs/development/knowledge-membership-metadata.md).

See the [implementation overview](../../docs/development/implementation-overview.md) and [delivery status](../../docs/development/project-status.md) for implemented behavior and acceptance limits.

`permanent-delete.ts` performs reference-aware physical purge inside the Trash transaction. `sync-policy.ts` enforces mirror mutation restrictions and persists local exclusions.
