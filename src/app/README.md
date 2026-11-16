# app

Plugin composition, readiness and lifecycle ownership. Opens the knowledge database, starts native metadata admission/reconciliation and its UI, and wires the Markdown reader. Shutdown removes UI/observers, drains accepted work and closes persistence.

Disposal retains the database handle until close succeeds. A failed shutdown can therefore retry on the next lifecycle operation; database ownership also retains failed cleanup across bundle replacement. New startup waits for that cleanup instead of abandoning the old connection or displacing a live owner.

All producer close calls start before any one is awaited. Parsing requests and
the vector Worker are interrupted immediately; in-flight task projections and
accepted writes drain before the knowledge service/cache and database close.
This also applies when preference or UI unregistration fails. See
[lifecycle and shutdown contract](../../docs/development/plugin-lifecycle.md).

Startup retains database migration/integrity validation and a stored knowledge snapshot before registering UI. `StartupRecovery` defers reconciliation, file/task restoration, full-text preparation and local index recovery until after native UI readiness. Capability gates protect searches and queued actions; disposal cancels scheduled recovery and drains an active stage before storage closes.

See the [implementation overview](../../docs/development/implementation-overview.md) and [delivery status](../../docs/development/project-status.md) for implemented behavior and acceptance limits.
