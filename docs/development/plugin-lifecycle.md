# Plugin Lifecycle and Cleanup

The application owns shared storage, processing, synchronization, retrieval and
MCP services. Each window owns its UI registrations, adapters and view requests.
Closing the final main window must not strand durable work or prevent shutdown.

## Runtime Ownership

Bootstrap lifecycle serialization, configuration/database registries, worker
deadlines and background cancellation use process-lived Gecko primitives.
No hidden window is required to keep promises, timers or vector work alive.
UI registrations handle both existing and newly opened windows/readers once.

Startup acquires database ownership, validates/migrates storage, registers UI and
then performs staged recovery. See [database runtime](database-runtime.md),
[startup readiness](startup-optimization.md) and [vector recovery](mcp-vector-initialization-audit.md#recovery-guarantees).

## Shutdown Contract

Stop accepting new work, signal parsing/embedding/synchronization together and
cancel future retries. Terminate vector workers before awaiting their unfinished
RPC queues. Drain accepted writes, recovery, task refreshes and in-flight service
work before closing the database and releasing ownership.

Incomplete closing scans must not prune missing members. Detached windows must
not receive forced redraws. Partial startup/shutdown failures retain safe cleanup
retry paths rather than allowing duplicate owners or losing committed data.
Canonical vectors and the last valid index snapshot remain recovery sources.

## Verification

Test ordinary shutdown, early shutdown, addon disable/enable, replacement with
existing windows, closing all main windows and cleanup failures. Check actual
process exit independently from a shutdown-complete event. Native Zotero prompts
and other-plugin/background activity must be identified separately from plugin
cleanup behavior.

Use `scripts/verify-plugin-lifecycle.mjs` only with its documented isolated
profile. Diagnostic packages are temporary; restore the ordinary package and
verify fixture cleanup. Node/VM checks and native API checks do not replace the
remaining manual or cross-platform acceptance in [project status](project-status.md).
