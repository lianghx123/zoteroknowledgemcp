# worker/runtime

The first durable runtime is implemented by `worker/parse-worker/runner.ts` and `repositories/processing.ts`: bounded asynchronous slots, atomic claims, lease fencing, delayed retries and restart recovery. This directory remains reserved for extracting genuinely shared behavior when another worker family is implemented; there is no separate in-memory queue.

See the [implementation overview](../../../docs/development/implementation-overview.md) and [delivery status](../../../docs/development/project-status.md) for implemented behavior and acceptance limits.
