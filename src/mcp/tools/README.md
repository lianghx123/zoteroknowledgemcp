# mcp/tools

Implemented 16 discovery/read/search/mutation tools. `registry.ts` declares input
schemas/defaults and validates arguments; `output-schemas.ts` describes structured
results. The dispatcher and focused handlers share repositories and the existing
retrieval engine. See
[local MCP access](../../../docs/development/mcp.md).

`service.ts` owns validated dispatch, authorization rechecks, discovery and related-record projections.
`annotations.ts` lists annotation handles and reads independent, budgeted text/quote streams by ID.
`content.ts` formats authorized block headers and budgeted SQL substrings within Unicode/cursor budgets.
`search.ts` owns scoped retrieval and process-local search snapshots; `evidence.ts` preserves hit text
before adding budgeted neighboring context. `mutations.ts` keeps annotation/summary authorization,
version checks, revisions, outbox events and replay receipts together in the original transaction.
All handlers share the dispatcher's repository and existing token/cursor services; they add no worker or connection.
Search ranking uses a fixed evidence budget independent of displayed snippets.
The shared presentation catalog drives allowed-field discovery and early validation.
Block/node/annotation continuations bind each target rather than batch composition;
document and node reads retain original scientific notes and report selection.
Snapshots bind source versions, active generations and index revisions; projection
and field expansion run separately on every returned page. Retrieval and queued
provider dispatch share a live authorization/content guard.

See the [implementation overview](../../../docs/development/implementation-overview.md) and [delivery status](../../../docs/development/project-status.md) for implemented behavior and acceptance limits.
