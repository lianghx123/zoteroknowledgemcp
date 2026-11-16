# Knowledge Trash Scale Audit and Verification

Native scale checks on 2026-10-21 used Node.js 22.23.1 on Windows and isolated Zotero 10.0.6. This reference describes bounded SQL, relational recovery and legacy import validation; see [membership](knowledge-membership-metadata.md) and [database runtime](database-runtime.md) for current contracts.

## Complete Query Audit

All runtime array-driven SQL predicates are in the knowledge/Trash repositories. Sixteen predicate/update sites now receive ID batches from `database/batches.ts`; all five recovery-link inserts use the same batching policy. Each batch contains at most 200 elements. Link rows bind four values each (at most 800); predicates leave room for fixed scope and SET values. The helpers never start, commit or replace the caller's transaction.

| Operation | Final handling | Important invariants |
| --- | --- | --- |
| Capture library/folder/item recovery | Deduplicated resource/origin reads and five link inserts in batches | First-occurrence reference order, global positions, deletion flags and original identities |
| Folder subtree deletion | Batched origin discovery, origin tombstones, placements and node updates | Validate all selected folders first; deduplicate selected ancestors/descendants; retain literature at root |
| Re-admission | Join persisted recovery origins to membership origins | Consume recovery only when every original origin is active; no ID-array parameters |
| Restore | Batch all folder/relation/placement/origin/resource reads and updates | Same transaction; parent recovery/root fallback; shared resources; conflicts preserve current rows |
| Restore hierarchy/name checks | Folder-ID sets, cached parent availability and an active sibling map | No placement-by-folder array scan or per-folder sibling query; incoming root fallbacks are checked together |
| Selective permanent deletion | Batch overlap reads and recovery rewrites | Preserve relative reference order, unrelated locations and other libraries' recovery rights |
| Empty Trash | Same confirmed permanent-deletion service | Preserve shared content and recovery rights; purge unreferenced plugin records according to the permanent-deletion contract |
| Aggregate Trash snapshot | Indexed relational `EXISTS` | One source anchor per resource regardless of overlapping recovery records; no cumulative ID binding |
| Snapshot memberships | Placement-ID and active-library maps | Preserve exact folder IDs without scanning every placement for every membership |
| Selection, confirmation and audit scopes | Identity/resource/entry maps and sets | Preserve selection scope and audit entry IDs without repeated whole-list scans |
| Native item-list search scopes | Official `idsToTempTable(..., { idColumn: "id" })` and one `tempTable` condition | Avoid a native OR expression per item; keep the complete scope for advanced filters; release the owned `temp` table in `finally` |
| Legacy JSON upgrade | Materialize scalar reference columns before grouping | Avoid copying an entire JSON document into each sort record; preserve first source positions and deletion flags |

The remaining SQL `IN` in the migration is a relational subquery, not an interpolated/bound ID list. Native search scope construction is also covered: the prior per-item OR search fails at 1,501 conditions in Zotero with `Expression tree is too large (maximum depth 1000)`. The final helper uses Zotero's temporary-table API. Its `tempTable` condition requires the `id` column; default `itemID` tables remain used for result tables handed to native views. Cleanup validates the generated name and targets only `temp.<owned-name>` with `noCache`. No plugin business tables or columns are added to Zotero's own database.

## Automated Regression Matrix

Scale tests impose a **999-parameter ceiling on every plugin-database statement**, including fixed predicates and SET values. Native search simulations separately cap expression conditions and check temporary-table ownership. These are regression constraints, not claims about universal host limits.

| Dataset/scenario | Checks |
| --- | --- |
| 32,770 references in each of the five recovery-link tables | Capture, cross-batch duplicate removal, ordering/deletion flags, large overlap rewrite, restoration and identity retention |
| 4,000 synthetic mapped papers, each in 10 folders | 40,000 membership/placement mappings; library deletion, refresh, service restart, restoration, exclusive-resource deletion and empty Trash |
| More than 32,767 cumulative Trash resources across independent records | Refresh/startup and metadata reconciliation; shared anchor deduplication; active-only exclusion |
| 1,201 child folders plus their parent | Subtree batching, parent/child selection deduplication, original-folder recovery and retained root memberships after permanent deletion |
| One item with 1,201 recovery origins | A missing origin at the end preserves recovery; complete re-admission consumes it |
| Later-batch failure during capture, subtree deletion, restore and overlap rewriting | Complete model/recovery/audit rollback, followed by a successful retry; relevant scale tests compare full row-set digests |
| Five-to-six-migration legacy JSON containing 40,000 origins and 4,000 deleted-resource flags | One backup-hook request, exact flags, successful import/cleanup, service startup and original membership/resource recovery |
| 32,770-item native search simulation | Normal/title/tag/unfiltered scopes, outside-result rejection and immediate scope-table cleanup |
| Failed native search and disposal during an in-flight search | Propagate errors, return no stale disposed-view items and release owned scope tables |
| Both explicitly accepted compatible checksums | Identical DDL fingerprint, unchanged applied history, no rerun; reject unknown checksums and use of those checksums for another migration |

Failure injection simulates native query errors; it is not an actual storage-device failure. Large source mappings and most scale data are synthetic. Tests validate parameter bounds, business behavior and integrity, rather than asserting a universal latency or memory limit.

## Native Zotero Evidence

All writes use dedicated synthetic databases or the separate `.scaffold/trash-profile` / `.scaffold/trash-data` fixture. The normal development/production library is not used for these mutations.

Native SQLite checks cover a 40,000-origin legacy import, restoration,
injected late failures, rollback/retry, folder deletion/root retention,
43,989 surviving overlap origins, empty Trash and a 32,771-node subtree.
Separate fixtures cover 1,001 source anchors with 2,002 folder memberships,
all 4,000 deleted-resource flags, and re-admission with a missing final origin
among 32,771 records. Integrity and foreign keys are checked; the maximum
observed SQL bindings are **800**.

Native scope checks use 32,771 IDs with title/tag filters, error cleanup and
concurrent independent scopes. Event/command checks separately exercise Trash
drops, restoration, addon reload, selection scope and preservation of native
Zotero originals.

These are developer-driven native API/DOM-event checks. They do not establish physical-pointer acceptance or visible-tree rendering performance at those fixture sizes.

## Migration Compatibility

The six recovery tables and their indexes are unchanged. Migrations 0001-0005 are unchanged. Only the compatible 0006 import implementation was optimized: scalar projection prevents the large-JSON sorter expansion found by the new legacy test, and a scalar-pair EXCEPT check validates deleted-resource subsets without scanning the whole resource array for every flag, while grouping still preserves each reference's first source position. The importer keeps validation, transaction-wide rollback and cleanup-last behavior.

For databases already upgraded with compatible importer checksums, `inspectHistory` recognizes exactly the known preceding 0006 checksums `9be1daf18124bce33b286616f2fa08381cc9410330bfba64a00d98f49a6c1c97` and `fed21552d1b87c6635b8616cf272083d291c0a4b7d28da38473033d196ebb060` in addition to the current generated checksum. It does not rewrite that record, rerun the importer or waive other history checks. A regression pins the predecessor's DDL fingerprint; existing migration tests verify identities, positions, flags, invalid-data refusal and rollback. This compatibility case is specific to the compatible importer and does not permit editing released migration history.
