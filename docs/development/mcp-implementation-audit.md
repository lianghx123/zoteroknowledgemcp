# MCP Contract Guarantees

This reference defines the review and regression boundary of the local tools.
For connection setup and exact schemas, use [local MCP access](mcp.md).

## Local Contract 2.4.0

| Area | Required behavior |
| --- | --- |
| Quoted annotations | Read the selected text column, validate available anchors and actual quote presence, and replay matching receipts without duplicating mutations. |
| Scientific footnotes | Document/section reads include original note-role content; human annotations remain a separate opt-in. Selection counts describe remaining exclusions. |
| Bibliography | Discovery returns identifying bibliography; detail additionally returns subtitle, published abstract and maintained summary, with explicit null/empty values. |
| Availability | Readability follows current generation ownership, source/content versions and non-rejected blocks; token operation permissions are separate from stored content availability. |
| Exact text continuation | Per-target signed cursors and independent Unicode budgets allow complete block, section, annotation and quote reads without requiring completed targets in retries. |
| Field selection | Published enums and early validation agree for empty and populated results. Fixed-shape tools reject unsupported field expansion. |
| Inclusion flags | Explicit true count/preview flags survive every response mode; explicit false gates remain authoritative. |

Application-contract version, package version and official MCP protocol revision
are independent. Discovery publishes schemas and initialization exposes schema/build
identity. Clients refresh discovery and restart affected continuations after an
incompatible contract/content/authorization change.

## Authorization and Mutations

Search/read/annotation/summary permissions are distinct. Apply current library
permissions before queries, counts, projection and candidate selection. Validate
scope again when completing a read or replaying a mutation receipt. No access is
granted by an empty scope, inaccessible identifier or a previous successful call.

Mutation receipts bind operation identity and arguments. Expected versions reject
stale changes; annotations, summaries, revisions and events commit together or
roll back together. Retrying an uncertain request uses the same operation ID.

## References and Retrieval

Reference availability describes the whole authorized current document,
independently of a requested reference-type filter. An empty filtered page is not
evidence that the document has no structured references. Validate projection fields
even when no reference rows are returned.

Query-local rerank thresholds override saved thresholds only when explicitly
supplied. An unrequested threshold must not affect vector-only or non-reranked
results. Partial provider/index failures remain explicit rather than silently
becoming empty search results.

## Verification

The Node suites exercise every tool and response mode, schemas, Unicode budgets,
continuation, quote matching, transactional replay/rollback, rejected anchors,
authorization changes and source replacement. Native/client acceptance separately
checks real HTTP/SSE initialization, discovery/calls, long-text completion,
revocation, lifecycle cleanup and interoperable tool execution.

Use synthetic literature and temporary tokens/databases for writes. Native and
client probes are not exhaustive manual UI or provider-quality acceptance; see
[project status](project-status.md).
