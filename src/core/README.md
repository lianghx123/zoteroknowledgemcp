# core

Small runtime primitives, errors and resource cleanup.

`host-runtime.ts` obtains Promise, Map and AbortController from the process-lived
Gecko system-module global through the exported Timer function. Shared registries
must not use preference-window, main-window or unloadable plugin globals. This
does not create a hidden browser window. Bootstrap uses the same boundary before
the TypeScript bundle is loaded.

See the [implementation overview](../../docs/development/implementation-overview.md) and [delivery status](../../docs/development/project-status.md) for implemented behavior and acceptance limits.
