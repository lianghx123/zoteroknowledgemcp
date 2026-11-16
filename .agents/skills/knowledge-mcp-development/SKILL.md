---
name: knowledge-mcp-development
description: Design or implement MCP tools and protocol integration for AI-Scientist literature discovery, retrieval, and structured reading in this Zotero plugin. Use for tool schemas, responses, pagination, access boundaries, and MCP interoperability.
---

# Knowledge MCP Development

## Confirm the Integration Boundary

Read `AGENTS.md`, the [implementation overview](../../../docs/development/implementation-overview.md), [delivery status](../../../docs/development/project-status.md), and the affected content or retrieval contracts. Use the [development guide](../../../docs/development/getting-started.md) for setup; the root `README.md` introduces user workflows. The repository implements an opt-in local SSE-only Streamable HTTP endpoint and 16 literature tools. Read [the MCP contract](../../../docs/development/mcp.md) and inspect the affected services; preserve the distinction between verified local access and deferred remote adapters.

For a requested MCP feature, establish the client, operation, transport, and runtime constraints that affect implementation. Do not assume a Node.js server SDK runs inside Zotero, or introduce a helper process without resolving that architecture choice.

Zotero's local HTTP ports and Scaffold's debugging port do not define an MCP endpoint. A plain JSON REST handler is insufficient to establish MCP interoperability. Follow the selected official MCP protocol revision for initialization, capability negotiation, tool discovery, invocation, and errors.

## Define Structured Tools

- Start from the requested workflow: discover documents, search evidence, inspect structure, or read selected content. Avoid adding unrelated mutations.
- Specify typed input schemas, defaults, limits, mutually exclusive fields, and stable identifiers. Reject invalid arguments before expensive processing.
- Return machine-readable results through the selected protocol's structured output mechanism. Keep any text fallback consistent with those results.
- Preserve source identity, available locations, and content versions in reading and retrieval results so clients can follow evidence back to the document.
- Bound document, section, and block reads by explicit content budgets. Specify truncation, continuation, and missing-item behavior, including batch requests.
- Bind continuation state to the relevant scope, filters, and content version; define how changed content invalidates continuation.

## Keep Access Explicit

Expose only the literature operations and scopes supported by the feature. Keep read access separate from any future import, annotation, or summary writes. Do not expose arbitrary paths, URLs, or unrestricted Zotero operations through tool inputs.

When adding HTTP access, define binding, client authorization, and request-origin handling for that deployment. Validate requested library/item/attachment scope before reading content. Keep credentials and document bodies out of diagnostic logs by default.

Use stable error codes and actionable messages; distinguish validation, missing content, unavailable processing/indexes, access denial, and transient failures. Return English project-generated messages while preserving source document text.

## Verify the Contract

Use protocol-level tests for initialization, tool discovery, invocation, schema validation, and structured responses as applicable. Add focused tests for content limits, continuation, source mapping, and access rejection when introduced.

Run the repository type checks and tests for code changes. Confirm interoperability with the intended MCP client when available; report mocked tests and real client checks separately. Document only the tool names, endpoint, and configuration actually implemented.
