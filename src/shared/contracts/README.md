# shared/contracts

Internal typed contracts. The initial reader contract is attachment-specific.

`retrieval.ts` defines independent embedding/rerank configuration, complete vector
space identities, scoped search modes, document hits, traceable passage evidence,
coverage and explicit channel degradation. It is shared by native UI and internal
services without adding an external MCP transport.

See the [implementation overview](../../../docs/development/implementation-overview.md) and [delivery status](../../../docs/development/project-status.md) for implemented behavior and acceptance limits.
