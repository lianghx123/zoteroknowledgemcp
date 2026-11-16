# MCP Vector Readiness and Recovery

MCP and native search share the application-owned retrieval service. Successful
tool discovery or text reading does not establish that its populated vector
snapshot has recovered. See [startup readiness](startup-optimization.md) and
[retrieval](vector-retrieval.md).

## Recovery Guarantees

- WASM loading, worker RPC deadlines, retry timers and per-job cancellation use process-lived primitives rather than a main-window lifetime.
- A partially failed worker open terminates its owned worker. Late messages/errors cannot close a newer worker.
- Canonical vectors and persisted snapshot formats remain recovery sources; local repair does not regenerate embeddings.
- Index-stage failures retain private exception details but expose only safe stage/code/type information.
- Automatic local retries occur after 500 and 2,000 ms. Exhaustion exposes failed recovery and leaves an explicit manual retry; shutdown cancels future retries and drains current work.
- `INDEX_RECOVERY_FAILED` distinguishes terminal recovery failure from ongoing initialization.
- Fusion gates each channel independently. Ready text can serve an explicit degraded result without query-embedding requests while vectors recover; ready vectors can serve a vector fallback when text is unavailable.
- Authorization, cancellation, source/content and model-profile guards remain active during degraded reads.

## Acceptance Requirements

Use the built plugin with an isolated populated snapshot and verify startup,
reload and local retry. Then close every main window and exercise actual MCP
vector/fusion calls. Check ready-channel availability, safe terminal failure,
revocation during a degraded read, worker replacement races and shutdown.

Mocked `store.sync` success is not native snapshot-restoration evidence. Provider
availability, search quality and approximately 1,000-paper end-to-end performance
need their own acceptance. Fixtures, diagnostic controls and temporary data must
be removed or restored after a native check.
