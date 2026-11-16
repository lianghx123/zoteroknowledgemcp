# worker

The durable parse worker dispatches registered peer parsers through a shared contract, with SQLite leases/checkpoints, source fencing and structured local publication. Complete provider workflows live under `src/parsers/`; the worker owns scheduling and persistence safety. Collection metadata admission is owned by its synchronization service. `vector-worker/runtime.ts` runs packaged USearch WASM in a Zotero ChromeWorker for filtered queries, incremental mutations and snapshot persistence. `services/embedding.ts` owns durable profile-bound embedding jobs; `services/vector-store.ts` reconciles local vectors and snapshots. A separate native-ingestion worker remains planned; current native admission/reconciliation runs through application services and Zotero APIs.

See the [implementation overview](../../docs/development/implementation-overview.md) and [delivery status](../../docs/development/project-status.md) for implemented behavior and acceptance limits.
