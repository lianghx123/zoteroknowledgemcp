# worker/parse-worker

`runner.ts` owns durable claims, lease renewal, source/version fencing, submission acknowledgement, retry/cancellation and shared atomic publication. It resolves a `DocumentParser` through `src/parsers/registry.ts`; it contains no provider-specific upload, polling, decoding or normalization branches. A parser returns a shared `ParsedDocument` with managed artifacts or yields the lease while waiting.

`artifact-staging.ts` owns generated filenames, the aggregate artifact budget, prewritten cleanup manifests and rollback that preserves database-owned files after uncertain commit acknowledgement. Provider implementations are peers under `src/parsers/paddleocr/` and `src/parsers/mineru/`. See `src/parsers/README.md` and `docs/development/parsing.md`. No vector work starts here.

See the [implementation overview](../../../docs/development/implementation-overview.md) and [delivery status](../../../docs/development/project-status.md) for implemented behavior and acceptance limits.
