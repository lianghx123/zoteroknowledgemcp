# security

Implemented installation-local personal tokens, explicit library/scope grants,
hashed secrets, expiry/revocation and signed continuation. Crypto uses a
process-lived Gecko global; no main window owns keys or cryptographic work.
Backend execution tokens and remote account adapters remain unimplemented.
See [local MCP authorization](../../docs/development/mcp.md).

See the [implementation overview](../../docs/development/implementation-overview.md) and [delivery status](../../docs/development/project-status.md) for implemented behavior and acceptance limits.
