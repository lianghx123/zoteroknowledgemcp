# Permanent Knowledge Deletion

Moving an item, folder or library to Knowledge Trash remains recoverable. Permanent deletion removes the selected operation's recovery rights and physically removes deleted ownership rows no longer needed by another recovery operation. Deleting one location never deletes shared literature content while another location or recovery right still needs it.

## Lookup Indexes

Migration 0014 adds thirteen nonunique B-tree indexes for block-parent and
supersession checks, source/target reference blocks, annotations, search blocks,
generation embeddings, vector labels, resource generations and parse runs, and
stored-file owners. They contain identities rather than copies of document text
or vector payloads. Foreign-key checks remain enabled. Deletion order, recovery
rights, incoming-reference checks, transaction rollback and deferred file cleanup
keep their existing behavior. Older migrations are unchanged; versioned databases
receive the normal validated pre-upgrade snapshot before index creation.

A 2026-11-07 SQLite-copy experiment used the current isolated library snapshot:
18 resources, 22 generations, 5,817 blocks, 3,965 embeddings and 1,383 stored files.
Each sample started from a separate copy of the same prepared Trash database.
Node.js 22.23.1 SQLite used the project's SQL adapter and native-port test double,
with foreign keys, FTS5, WAL and FULL synchronous mode enabled. Original and
candidate variants alternated order, with two discarded warmup rounds and five
retained samples. Only the complete database purge transaction was timed;
preparation, index creation, snapshots, validation and physical file removal were
excluded. Logical rows and cleanup journals matched after timestamp normalization.

These are Node SQLite component measurements, not native Zotero or end-to-end
UI timings. Native verification of the migration and purge behavior is separate
from these elapsed-time samples.

| Deleted resources / blocks | Original median seconds (range) | Index-only median seconds (range) |
| --- | ---: | ---: |
| 1 / 717 | 6.105 (5.863–6.331) | 0.380 (0.359–0.407) |
| 5 / 2,888 | 23.426 (23.118–24.055) | 1.462 (1.426–1.523) |
| 18 / 5,817 | 30.973 (28.020–31.217) | 2.584 (2.492–2.656) |

Allocated database size increased by approximately 1.94 MiB in this fixture.
Index creation, ongoing inserts, indexed-key updates, WAL/checkpoint writes and
cache pressure have costs. Representative native startup, import, reparse,
embedding-write and memory costs remain unmeasured; neither a 1,000-paper benefit
nor a universal UI speedup is established. These figures measure the lookup indexes with the same deletion order.

## Reference Boundary

A resource survives while any active library membership, Trash recovery right or incoming `resource_references` record exists. Otherwise the purge transaction removes its identifiers, Zotero identity links, sources, jobs, parse runs, parse artifacts, generations, sections, blocks, annotations, references, revisions, receipts, resource and resource-source outbox events and search/embedding rows. The original Zotero items, collections and attachment files remain outside this boundary. Deleting the final referencing resource also checks targets previously retained only through its references.

Stored files are deleted only after their final source, generation or parse-artifact owner disappears. Shared files can remain in an older job directory until their last owner is deleted. Unreferenced deleted folder/library records are removed when their remaining foreign-key references allow it. Independent recovery operations may require retaining a deleted folder record for restoration at the library root.

## Transaction and Worker Safety

SQLite foreign keys are deferred for the purge transaction so mutually dependent resource/source/generation/job records can be removed atomically. Migration 0007 adds `resource_purge_scope`; published structural rows and append-only revisions permit deletion only for resources explicitly present in this transaction-owned scope. Insert/update immutability remains unchanged. Scope rows are removed before commit and every database mutation rolls back together on failure.

Deleted jobs cannot pass the publication lease guard. After commit, the application aborts and drains local executions whose jobs were deleted, waits for accepted manual-cache writes, then processes `file_cleanup`. Database transactions never wait for worker shutdown. This ordering avoids a worker refresh waiting on the same serialized knowledge operation.

Cleanup accepts only generated parse job/artifact paths and native-identity manual Markdown cache filenames below the plugin data directory. It removes unreferenced attempt files, manifests, temporary files and empty directories, preserving shared stored files. Failed removal stays in the durable queue; startup retries it before the parser starts. The user-visible import-task history deletion action remains separate and preserves content.

## Reimport and Verification

The persistent `plugin_state.installation` identity doubles as the initialization marker. Only a database without that marker can bootstrap its default library; an intentionally emptied database, including an older installation with no separate bootstrap flag, stays empty after restart.

Manual Markdown replacement and cleanup share a per-path lock. When deletion is pending, the writer first persists a random replacement token in `plugin_state` while retaining both cleanup records. Its atomic file write embeds the same private `cacheWriteToken`; successful finalization cancels the old cleanup and token together. Failure before the atomic rename leaves the old cache queued for deletion. A crash after the rename leaves evidence that lets startup retain the completed replacement and clear the obsolete journal. Readers hide caches pending deletion unless their token confirms a completed replacement. The private token is excluded from the reader service's content projection; existing version-1 cache files remain supported.

A later permanent deletion invalidates any previous replacement token in the same transaction that queues its files. An older writer therefore cannot cancel the new deletion. Cleanup rechecks the journal and token inside its transaction after acquiring the path lock. Failed directory creation, writes, finalization, or removals retain sufficient evidence for retry. Accepted saves serialize an immutable copy of their input, and reads share the lock with replacement and reclamation.

Reimporting a fully purged item creates a new resource and source without an active generation, so parsing must run again. If another ownership/reference preserved the content, reimport reuses it. Flexible/append synchronization exclusions survive item purges so a deliberate local removal does not immediately reimport the item.

Automated cases cover shared memberships and files, other Trash recovery rights, incoming literature references, reimport, stale workers, failed file cleanup/retry, transaction rollback, large recovery operations and foreign-key integrity. Disposable native Zotero checks exercise the actual SQLite adapter and sync policies. No live OCR provider is needed.

This is physical deletion of active database records and managed files. Existing database migration snapshots and external backups are not rewritten, and SQLite free-page secure erasure is not promised.

Source publication events are deleted using the resource's source IDs before source rows are removed in the same transaction. Other live memberships/recovery rights preserve both the content and its events. Regression checks cover both cases.
