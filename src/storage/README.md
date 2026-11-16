# storage

Plugin-managed files and import cache. `parse-files.ts` validates generated artifact paths and recovers unreferenced generated attempt files without removing published file references, including legacy attempts whose manifest is missing. Locked attempts retain recovery evidence and do not block recovery of other attempts. Never modify Zotero originals.

See the [implementation overview](../../docs/development/implementation-overview.md) and [delivery status](../../docs/development/project-status.md) for implemented behavior and acceptance limits.

`file-cleanup.ts` retries database-journaled deletion of generated parse files, manual Markdown cache files and vector snapshots, preserving referenced artifacts. Native originals are outside its accepted path grammar. `vector-snapshot-lock.ts` gives publication and reclamation the same per-path lock for final and temporary files. Cleanup rechecks its journal after waiting, so it cannot remove an in-flight snapshot or an already activated replacement. Interrupted/failed publication retains durable cleanup intent for recovery.

`reader-cache-cleanup.ts` coordinates durable replacement tokens with `reader-cache-lock.ts`, so restart can distinguish an interrupted old-cache deletion from a completed replacement. A later purge invalidates old tokens, and pending deleted text is not exposed by cache reads. This protocol uses existing plugin-state storage without changing migration history.
