# Knowledge Plugin Runtime Assessment

This reference describes the runtime constraints for Zotero Knowledge MCP.
Implemented behavior and acceptance limits are recorded in [project status](project-status.md).
The [development plan](migration-plan.md) separates delivered local capabilities
from future integrations.

## Runtime Boundary

The plugin executes inside privileged Gecko. Node.js runs build/tests only;
production needs no Node/Python server or helper process. Any proposed helper
requires a demonstrated native runtime limitation and a separately reviewed design.
Native Zotero APIs remain authoritative for bibliography and attachments.

## Local Storage and Ownership

- Use a plugin-owned SQLite database and managed-file directory under Zotero's data directory; never add business tables to Zotero's schema.
- Acquire the separate owner lease before main-file preflight, capability checks, backup or migration bootstrap. Retain it until database work drains and storage closes.
- Use static Kysely migrations, schema/history validation, transactions and integrity checks. Upgrade snapshots do not replace a complete external backup.
- Keep canonical content and vectors separate from rebuildable full-text/vector projections. Stable identities distinguish resources, individual sources, generations, sections and blocks.
- Validate managed paths, archive sizes, source association and available page coordinates. Missing positions remain explicit.

`Zotero.DBConnection` supports independent plugin storage and bundled FTS5.
This does not establish support for arbitrary native SQLite extensions. See
[database runtime](database-runtime.md) and [database design](database-design.md).

## Processing and Credentials

The implemented input is a locally available native PDF attachment. PaddleOCR
and MinerU adapters implement their documented upload/job/result protocols;
arbitrary endpoints require compatible contracts. Direct import of user-generated
results remains deferred. Cloud parsers cannot fetch local filesystem URLs.

Persist submission intent, accepted provider identity, checkpoints, retry timing
and ownership fences. Ambiguous submissions require recovery rather than blind
resubmission. Validate and stage artifacts before transactional publication;
late results cannot replace changed, removed or manually edited content.

External parsing sends selected PDF bytes; embedding and reranking send configured
text/query inputs. Parser keys currently reside in local plaintext `parsing.json`,
model keys use Gecko Login Manager, and local MCP token records contain hashes.
Protect the data directory and backups, and keep credentials/body text out of logs.
See [parsing](parsing.md) and the [privacy guide](../user/privacy.md).

## Retrieval Constraints

SQLite availability alone does not establish vector-search support. The plugin
uses USearch in a privileged worker and profile-bound canonical vectors.
Equal dimensions do not imply compatible vector spaces. Model, endpoint,
normalization and input definitions participate in compatibility.

Measure candidate changes in the applicable native runtime using representative
fixtures, warmups and repeated alternating samples. Report variability and keep
provider/network latency separate from local queries. Query counts or Node-only
timings do not prove a Zotero speedup. The approximately 1,000-paper target is an
acceptance workload, not an established capacity or a hard size limit.

For scale planning, 100 blocks per paper at 2,048 Float32 dimensions require
approximately 0.82 GB for 1,000 papers before metadata/index overhead. This is a
storage calculation, not a measured processing workload. Verify multilingual
full-text quality and independent relevance judgments separately from index recall.

## MCP Contract and Authorization

The local endpoint implements 16 tools over SSE-only Streamable HTTP. Request
bodies are JSON-RPC `application/json`; protocol responses use `text/event-stream`.
There is no JSON-response mode, GET subscription, legacy separate SSE endpoint,
event replay or resumability. See the [current MCP contract](mcp.md) for exact
protocol versions, methods, request headers and limits.

Local personal tokens select 1–100 knowledge libraries, default to search/read
permissions, and support 30/90/180/365-day expiry. Access must be checked before
protected reads, counts and candidate selection. Signed expiring continuations
bind scope, filters, authorization and current content. Mutations require
`operationId`, `expectedVersion` and transactional replay protection.

## Connection Modes and Future Scope

| Mode | Current boundary |
| --- | --- |
| Same-machine HTTP | Implemented opt-in loopback endpoint with Host/Origin, token, size and concurrency checks. |
| Public-IP HTTPS | Deferred; requires verified native TLS, certificate lifecycle and independent acceptance. |
| Account/relay access | Deferred; requires documented remote identity/tunnel contracts, streaming, device isolation and revocation. |

Remote login must not imply access to local literature. Local processing and token
management stay usable without an account service. Zotero must remain running and
the computer awake. Future content synchronization requires separate opt-in,
ownership, retention and conflict rules; a relay is not an offline content replica.

## Verification Requirements

Validate storage, parsing, retrieval, reader/native UI and MCP boundaries independently.
Use disposable libraries and synthetic providers for routine checks, and distinguish
Node simulations, native API/DOM probes, manual interaction and live provider results.
For performance work, record accessibility state and exclude computer-use interference
according to [repository guidelines](../../AGENTS.md).

Official references: [Zotero developer API](https://www.zotero.org/support/dev/client_coding/javascript_api),
[MCP specification](https://modelcontextprotocol.io/specification/2025-11-25),
and the provider references in [parsing](parsing.md).
