# connections

`mcp-http.ts` owns a dedicated loopback Gecko listener with SSE-only Streamable
HTTP responses, HTTP/Origin/Host checks, request limits, cancellation and cleanup.
`mcp-client-identity.ts` signs token-bound client identities with a listener-lived
in-memory key, isolating request IDs and cancellation across shared-token clients.
Authentication and identity checks are fenced against listener shutdown.
Default endpoint: `http://127.0.0.1:23126/mcp/knowledge`, disabled initially.
TLS and existing-service relay adapters remain planned. See
[local MCP transport](../../docs/development/mcp.md).

See the [implementation overview](../../docs/development/implementation-overview.md) and [delivery status](../../docs/development/project-status.md) for implemented behavior and acceptance limits.
