# Database Validation Scope

The schema is implemented through sixteen static migrations and 56 typed tables.
Use [database design](database-design.md) for invariants and [database runtime](database-runtime.md)
for native ownership, initialization and upgrade behavior.

## Automated Checks

`npm run database:check` compares migration snapshots, generated row types and the
field dictionary with the reviewed SQL fixtures. `npm test` additionally exercises
SQLite-backed service/repository behavior and the native-adapter test doubles.

The regression boundary includes independent attachment/source identity, scoped
content generations, immutable publication, rollback, tree integrity, stale attempts,
leases/checkpoints, vector dimensions and profile identity, full-text updates,
mutation receipts, recovery rights, artifact ownership and token scope integrity.

SQL fixtures are validation inputs, not installers to execute against Zotero's
database. `node:sqlite` runs only in development tests. Bundle loading without Node
globals is distinct from successful native database execution.

## Native Acceptance

Use a new disposable Zotero data root and plugin-owned database. Verify ownership
exclusion, native binding/BLOB behavior, JSON/STRICT/FTS support, transactional DDL,
initial creation, supported upgrades, failure rollback, validated snapshots and
cleanup/restart. Inject failures only into fixture-owned resources.

Node simulations do not establish native locking, filesystem crash behavior,
multilingual quality or approximately 1,000-paper capacity. Full external
backup/restore and broader reliability acceptance remain in [project status](project-status.md).
