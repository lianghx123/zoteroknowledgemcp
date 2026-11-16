# worker/vector-worker

`runtime.ts` runs the packaged USearch WASM in a privileged Zotero ChromeWorker.
It owns filtered queries, incremental mutations, bounded snapshot serialization
and JS-source restoration. `services/embedding.ts` schedules profile-bound API
jobs, while `services/vector-store.ts` reconciles durable local vectors and
snapshots. No external helper process is used.

See the [implementation overview](../../../docs/development/implementation-overview.md) and [delivery status](../../../docs/development/project-status.md) for implemented behavior and acceptance limits.
