# Connect an AI client

MCP lets an authorized client discover papers, search passages, read structured
content and perform explicitly permitted annotation or summary writes.
The plugin implements 16 tools over authenticated Streamable HTTP with SSE
responses only. It does not provide a legacy separate HTTP+SSE endpoint.

## Enable access

1. Open **Zotero Settings → Knowledge MCP → MCP connection**.
2. Enable local MCP and apply settings. The default address is
   `http://127.0.0.1:23126/mcp/knowledge`; use the address shown in your settings.
3. Create a named token, select explicit knowledge libraries and grant the
   permissions needed by that client. Search/read and annotation/summary writes
   have separate permissions.
4. Copy the token secret immediately. It is displayed once and cannot be recovered.
5. Configure your client's remote/HTTP MCP server with that address and a
   Bearer token. Keep Zotero running and the computer awake.

Tokens can expire after 30, 90, 180 or 365 days. Edit a token to change its name,
libraries or permissions; its secret and expiry remain unchanged. Revoke it
when access is no longer needed. Revocation applies to subsequent requests,
including requests on an already open connection.

## Codex example

Make the token available as `ZOTERO_KNOWLEDGE_MCP_TOKEN` in the environment that
launches the client, then run:

```sh
codex mcp add zotero-knowledge --url http://127.0.0.1:23126/mcp/knowledge --bearer-token-env-var ZOTERO_KNOWLEDGE_MCP_TOKEN
```

The plugin settings also provide the address and matching command with copy
buttons. Adjust the URL if you changed the port. Follow the client's own
instructions for setting environment variables; do not put the token into
screenshots, source control or support reports.

## Connection boundaries

The listener accepts same-machine loopback access while Zotero is running.
Public HTTPS, account-based remote access and relay/cloud connections are not
available. A remote cloud client cannot reach your computer's loopback address
directly. Authorizing a client grants it access to data within its token scope;
that client may send retrieved content to its own model service.

For tool schemas and application compatibility details, see the
[developer MCP reference](https://github.com/lianghx123/zoteroknowledgemcp/blob/main/docs/development/mcp.md).
