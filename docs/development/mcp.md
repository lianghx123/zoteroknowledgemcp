# Local MCP Access

The plugin implements 16 local literature tools over authenticated Streamable
HTTP. The default endpoint is `http://127.0.0.1:23126/mcp/knowledge`. Change the
port in **Zotero Settings → Knowledge MCP → MCP connection**. The listener starts
disabled and binds loopback only. Zotero must remain running and the computer
must be awake. No Python, Node server or external helper runs in production.

## Visual Relationship Metadata

Full `list_content_blocks` and `get_content_blocks_text` responses (or explicit
`includeFields: ["metadata"]`) expose persisted relationships when available.
A title/note block has `metadata.visualRelation` with `visualBlockId`, `role`,
`position` and `evidence`. A visual block has `metadata.visualGroup` with
`captionBlockIds`, `noteBlockIds`, embedded provider-part counts and a truncation
flag. Relationship targets are block UUIDs within the same generation and authorized
resource. Rejected targets are not exposed. Metadata contains at most 200 link
summaries and never embeds unbudgeted caption/note text; use the normal bounded
block-text tool to read referenced content. Whole-document full responses include
the same information in `blockMetadata`. Active projection changes invalidate
existing cursors. Imported content without a visual projection stays readable.

## Connect a Client

1. Enable local MCP and apply the connection settings.
2. Create a named personal token, select 1–100 explicit knowledge libraries and
   grant the required permissions. Search and read are selected initially;
   annotation and summary permissions are separate opt-ins.
3. Copy the secret before leaving the settings page. It is displayed only after
   creation and cannot be recovered. The database stores its SHA-256 hash.
4. Set `ZOTERO_KNOWLEDGE_MCP_TOKEN` in the environment used to launch Codex, then
   add the server with the actual configured URL. The settings page provides
   matching code blocks for **MCP address** and the Codex command, each with a
   copy button and inline success or failure feedback:

```sh
codex mcp add zotero-knowledge --url http://127.0.0.1:23126/mcp/knowledge --bearer-token-env-var ZOTERO_KNOWLEDGE_MCP_TOKEN
```

The equivalent Codex configuration is:

```toml
[mcp_servers.zotero-knowledge]
url = "http://127.0.0.1:23126/mcp/knowledge"
bearer_token_env_var = "ZOTERO_KNOWLEDGE_MCP_TOKEN"
```

Token lifetimes are 30, 90, 180 or 365 days, defaulting to 180. Editing a token's
name, libraries or scopes preserves its expiry and invalidates its earlier
continuation context. Revocation applies to subsequent requests, including on
an existing client connection. Only tokens issued by this installation are valid for its local authority.

## Manage Tokens

The MCP connection tab provides a compact list of token records. Each record
shows the name, status, authorized knowledge-library names, permissions,
creation time and expiry without horizontal scrolling. Authorization fields and
dates wrap in narrow panes. Hovering over the name shows its last-use time, or
Never. Connection settings and Codex instructions are always displayed, and the
horizontal settings navigation stays visible while scrolling. One-time secrets
appear inside their own token record, below its dates; they are not recovered
when reopening settings.

Choose **Edit permissions** to expand that token's editor inside its own record.
Editing opens immediately without a list reload. **New token** expands the
creation form above the list; no empty form occupies the initial screen.
Switching editors keeps drafts, while **Cancel editing** discards that draft.
Its actual expiry is read-only;
editing keeps the same secret, creation time and expiry. Unavailable libraries
are explicit in the list and cannot silently become access to another library.
Select at least one available library and permission before saving. Connection
edits remain independent of token edits.

Choose **Revoke token**, then confirm inside the same record. Cancel retains
the token and editor draft. Revoked records are hidden from the management list
and retained in storage; expired tokens stay marked expired when their
permissions change.
Duplicate submissions are blocked while an action is pending. Failed writes
retain the draft; if the write succeeds but list refresh fails, the page reports
that distinction and retains a newly created one-time secret for copying.

## Transport and Tool Contract

The protocol target is MCP `2025-11-25`; `2025-06-18` is also negotiated for
compatible clients. The local application contract is `2.4.0`, not an MCP
protocol revision. It defines this plugin's tool behavior independently of other implementations; identical tool names do not establish identical behavior. Tool schemas
are published by `tools/list`. Initialization exposes
`_meta["zotero-knowledge-mcp/identity"]` with the application contract, a SHA-256
fingerprint of the published tool definitions, and build commit/dirty/source
fingerprint metadata. Source archives without Git retain a source fingerprint
and report a null commit. Unbundled test code reports null build metadata.

All JSON-RPC responses, including initialization, discovery and errors, use
`text/event-stream`. There is no HTTP `application/json` response mode. Requests
remain JSON-RPC encoded as `application/json`. Clients accept SSE; standard
clients normally send `Accept: application/json, text/event-stream`. Include
`Authorization: Bearer <local-token>` and the negotiated `MCP-Protocol-Version`
on subsequent requests. Unsupported protocol headers return HTTP 400.

Initialization returns a token-bound, signed `Mcp-Session-Id`. Echo this header
on subsequent requests; standard Streamable HTTP clients manage it automatically.
The signing key exists only for the listener lifetime, with no session records or
secrets persisted. Separate initializations isolate active request IDs and
cancellation even when clients share a token. Missing identities return HTTP 400;
invalid identities or identities from a previous listener return 404, requiring
reinitialization. Concurrency limits still apply per token across clients.

There is no legacy `/sse` or `/messages` endpoint, persistent session, GET
subscription, event replay or resumability.
Notifications receive HTTP 202. GET and DELETE receive 405. HTTP access/input
rejections use plain text; successful protocol processing uses SSE. A stream
disconnect does not itself cancel a write. Send `notifications/cancelled` to
cancel a request; retry uncertain writes with their original operation ID.

| Permission | Tools |
| --- | --- |
| `knowledge:search` | `list_libraries`, `list_folders`, `list_resources`, `list_block_types`, `search_content` |
| `knowledge:read` | `get_resources`, `get_resource_content`, `list_resource_nodes`, `get_resource_nodes`, `list_content_blocks`, `get_content_blocks_text`, `list_references`, `list_annotations`, `list_revisions` |
| `knowledge:annotate` | `add_annotation` |
| `knowledge:update-summary` | `update_summary` |

Arguments use camelCase. `responseMode` supports compact, standard and full
projections; supported `includeFields` expand a projection. Hard boolean gates
such as `includePreview: false` suppress their fields in every mode. Structured
results are delivered inside the SSE JSON-RPC message as `structuredContent`,
with a consistent text representation. Tool failures set `isError` and carry a
stable error code, English message, retryability and safe details.

Each tool publishes its allowed `includeFields` values as an enum. Invalid fields
fail before protected queries, including empty results. Fixed-shape tools accept
only an empty field expansion. Null and empty selected values remain explicit;
protocol identities, continuation and missing/omitted-item envelopes survive every
mode. `includeResourceCount: true` and `includePreview: true` return their bounded
fields even in compact mode; false remains authoritative in full mode and over
explicit field expansions.

`list_resources` standard returns identifying bibliography: contributors,
identifiers, journal/date/DOI under `metadata`, language and availability.
`get_resources` standard additionally returns subtitle, the published `abstract`,
and plugin-maintained `summary`. Missing values are null/empty. Statistics,
sources and membership details require full mode or explicit field expansion.
`capabilities.content` and `structure` use current readable generation/version
boundaries; `annotations` and `references` indicate stored, accessible records.
`contentState` distinguishes unavailable, processing, ready and partial content.
`capabilities.supportedOperations` separately reports the token's read, annotation
and summary permissions. A retained older generation is marked stale in source
details after attachment replacement; its ready state does not imply readable
current content. Block-type diagnostics count stored embeddings across profiles,
not guaranteed coverage of the currently configured vector model.

Page size defaults to 20 and is limited to 100; search defaults to 10 and is
limited to 50. Document reading defaults to 12,000 Unicode characters, with a
50,000-character maximum. Node reads have independent per-node/block and
aggregate budgets; block reads have per-block and aggregate budgets. Returned
IDs, truncation flags, missing/omitted IDs and continuation remain explicit.
Readers fetch block identities and Unicode lengths first, then load only the
requested SQLite text substrings. Small output budgets therefore also bound
body text materialized in the plugin. Folder resource counts include the full
descendant subtree; an explicit listing depth still bounds listing traversal.

Document and section reading include original scientific footnotes (`note` role)
by default. `includeAnnotations` appends human/agent annotations separately;
`includeBoilerplate` only restores selected page-furniture/boilerplate flags.
Rejected blocks remain unavailable. The `selection` object reports available,
selected and excluded original-block counts and counts by exclusion reason.
One block can carry multiple reasons; reason counts need not sum to the excluded
count. Rejected blocks are excluded before this readable selection and are not
counted as available. `originalNotesIncluded` makes the note policy explicit.

Text offsets and budgets count Unicode code points. Document/node responses
always return `textOffset` and `segments`: each segment identifies a block or
annotation Markdown stream, source/generation versions where applicable,
`blockOffset`, `outputOffset` within this response, and `charCount`. Separators
between blocks are part of returned Markdown and budgets, not source segments.
Annotation Markdown streams include their `> ` prefix. Original block handles
and exact block reads always retain source/generation/version identity.

`get_content_blocks_text` returns `textOffset`, `charCountReturned`, and
`nextCursor` per block. Place each cursor in `cursors[blockId]` to continue a
truncated block, even beyond 10,000 characters. The 10,000 limit applies per
block per call. Node reads use `cursors[nodeId]` similarly. Budgets and response
projections may change on continuation, and completed targets may be removed
from the retry batch. Omitted targets have not been read; request them again
without a cursor. Filters such as `includeChildren`/`includeBoilerplate` still bind
node continuation. Changes to content, authorization or the contract invalidate
old continuations. Restart reading on stale cursors.

`list_annotations` serves both discovery and detail reads via `annotationIds`.
Every annotation returns bounded `text` and `quote`, original character counts,
stream offsets, truncation flags, source/generation and current/historical anchor
identity. `textMaxChars` limits each stream to at most 5,000 characters per call;
`maxTotalChars` limits text plus quotes across the page (default 10,000, maximum
50,000). Full mode does not bypass budgets. Use `nextCursor` for text and
`quoteNextCursor` for the quote independently. In the next request, pass
`cursors[annotationId]: {text: nextCursor, quote: quoteNextCursor}` together with
`annotationIds`. A null stream cursor skips an already completed stream; an
omitted stream starts at zero. This allows a long quote to finish after text has
finished without rereading that text. Missing and unauthorized requested IDs are
combined in `missingAnnotationIds`. The page's `nextCursor` is independent and
continues the annotation list, not an item's text.

For example, after discovering an annotation, continue both bounded streams:

```json
{
  "resourceId": "<resource UUID>",
  "annotationIds": ["<annotation UUID>"],
  "textMaxChars": 1000,
  "maxTotalChars": 2000,
  "cursors": {
    "<annotation UUID>": {"text": "<item.nextCursor>", "quote": null}
  }
}
```

The example's null quote cursor means its quote is already complete. Use the
returned `quoteNextCursor` instead when quote text remains.

Resource UUIDs are plugin identities, not Zotero numeric item IDs. Knowledge
folder nodes and resource structure nodes are distinct. Resource reads assemble
current source generations, canonical source first, followed by stable source
order and source-local block order. Block metadata retains source/generation
identity and available page positions. Images retain managed Markdown references;
the endpoint does not expose an arbitrary file/download service.

`search_content` supports metadata/fulltext/vector/hybrid, folder/library/resource
or all-authorized scope, candidate/evidence budgets, block/role/quality filters,
diversification and optional reranking. Its request settings do not change or
inherit the UI result-count limit. Vector and rerank failures are explicit;
required reranking fails rather than silently substituting another ranking
when candidates exist. An empty candidate set returns an empty success. Under
best-effort reranking, an unavailable rerank threshold retains candidates and
reports `RERANK_MIN_SCORE_NOT_APPLIED` with `minScoreApplied: false`. Reranking
preserves cosine scores for vector-based thresholds. Evidence snippets retain
the actual hit segment before spending remaining characters on neighbor context;
bounded full-text windows center on a matched query term.
`minScoreBasis: "rerank"` requires an explicit `rerank: true`, including when
`minScore` is zero. With false or omitted reranking, argument validation returns
non-retryable `INVALID_ARGUMENT` explaining that reranking was not requested;
retrieval/provider work does not start. Service-availability warnings are reserved
for requested reranking that actually fails or degrades.

Hybrid readiness is evaluated per channel. When fulltext/metadata are ready but
the vector index is still restoring or has failed, hybrid returns those available
results with `VECTOR_UNAVAILABLE` and safe recovery details, without requesting a
query embedding. A vector-only fallback reports `FULLTEXT_UNAVAILABLE` if the
text channel is unready. Authorization, cancellation and source/model guards
still apply to degraded results. An entirely unready search remains an error.

Vector-only requests distinguish ongoing initialization (`INDEX_UNAVAILABLE`,
`reason: initializing`) from failed startup recovery (`INDEX_RECOVERY_FAILED`,
`reason: recovery-failed`). Failure details identify the recovery stage and a
sanitized failure code/type; arbitrary exception messages, paths and credentials
are never included. Local index restoration retries twice after 500 and 2,000 ms,
without embedding/reranking requests. Exhausted recovery remains retryable through
plugin Settings. WASM loading, worker deadlines and background vector scheduling
use process-lived primitives and survive main-window closure.
The derived full-text projection stores original Markdown Unicode positions using
the same normalized tokens as indexing. This covers accent/case variants, combining
characters, compatibility forms and CJK bigrams without loading whole blocks during
a bounded read. Retrieval/rerank passages have a fixed 7,000-character evidence
window; rerank inputs, including titles, are capped at 7,000 Unicode characters
without splitting surrogate pairs. `snippetMaxChars` controls only presentation
after ranking and thresholds.
Search pagination uses bounded, process-local ranked candidate snapshots (up to
64, one-hour TTL); restarting/reloading the plugin invalidates these snapshots.
Only the requested page materializes block headers, context and resource versions.
All candidates retain their ranking and evidence identities for later pages;
continuation does not repeat embedding, retrieval, reranking or diversification.
Permission, content/configuration and index guards run before and after page
assembly. Replayed pages receive the same guards and independent projections.
Retained text has an additional approximate 16 MiB budget. The newest snapshot is
kept even when it alone exceeds that budget, so its first cursor remains usable;
older snapshots may be evicted and then return the existing `CURSOR_STALE` result.
The byte estimate bounds retained payloads rather than measuring JavaScript heap.
Snapshot contexts include source/content versions, active generations, canonical
source order and the applicable full-text projection revision and vector snapshot.
Replacing an attachment invalidates continuation even before reparse publication.
General read/cursor consistency uses transactionally maintained library revisions
instead of whole-library row snapshots. Token authorization is checked again
before returning. Shared-resource changes invalidate all live member libraries;
inactive staging work and source-check timestamps do not. Invalidation remains
conservative within each authorized library. Revision tombstones prevent library
delete/recreate ABA; the revised state format makes older cursors stale.
Resource lists use SQL pagination and projection-dependent batched relations;
`includeTotal` adds a COUNT query. Get-by-ID queries only requested authorized IDs.
See [native read measurements and write costs](mcp-read-performance.md).
Every page applies its own compact/standard/full projection and `includeFields`
expansions to the requested ranked candidates; changing projection never reuses a prior
page's field selection. Invalid search fields fail before retrieval, including for
empty results.

Personal tokens support `authorized`, `library`, `resource` and `node`; search
`node` means a knowledge folder. Discovery excludes unsupported `run` scope;
legacy callers still receive `KNOWLEDGE_RUN_SCOPE_UNAVAILABLE`.
Reference reads report whether structured references exist separately from
reference-text blocks. Source/target generation anchors must remain current and
authorized; resource-level references remain available across reparse. Only
annotations explicitly expose historical anchors. Plugin lifecycle revision names are retained locally;
private membership graphs, native paths and processing internals are excluded
from revision changes returned through MCP.
`structuredReferencesAvailable` describes the whole current authorized document,
independently of `referenceType` and pagination. `items`, `returnedCount` and
optional `total` describe the filtered selection. For example, a paper with 32
bibliography records and no URL records returns an empty URL selection with
`structuredReferencesAvailable: true` and no unavailable warning. The
`STRUCTURED_REFERENCES_UNAVAILABLE` warning is reserved for documents with no
current accessible structured references of any type.

Parser bibliography entries have a separate nullable `referenceNumber` and
number-free `rawText`. Migration 0013 and startup projection backfill derive
merged/split entries after the original migration 0011 block ingestion.
`list_references` groups by source ID and orders anchored records by canonical
reading order and `entryOrder`. Standard responses expose `referenceNumber`.
Full responses, or the corresponding `includeFields`, expose `entryOrder`,
`sourceBlockIds`, `canonicalOrder`, `pageStart`, `pageEnd` and aggregated
`locations` (page, bbox and optional provider source ID).
Missing positions remain null/empty. The structured-reference availability flag
indicates stored records; it does not certify citation boundaries, parsed
bibliographic fields or target matches. Existing reference cursors are invalidated
by reference projection context version 4, including the local upgrade of
unnumbered cross-page entries. See [reference ingestion](parsing.md#reference-ingestion).

Annotation and summary mutations require `expectedVersion` and `operationId`.
Authorization, anchor validation, version advance, revision, outbox and receipt
are transactional. Matching retries replay the receipt; different arguments
with the same operation ID fail. Writes affect plugin-owned data only. Reparse
preserves annotations and marks anchors to replaced generations historical.
Quoted annotation writes validate an exact substring against a current,
non-rejected block using the native adapter's named getter. Matching replay
receipts remain valid after reparse because replay precedes new anchor and
resource-version validation.

## Boundaries and Lifecycle

Authorization is applied before protected reads, counts and retrieval candidate
selection, and checked again before publishing results. Empty library access
never means unrestricted access. Batches, reference targets and membership
projections share this boundary. Signed cursors bind the request, token scope,
membership/content state and applicable index/model state; expiry is one hour.
After provider responses and before further candidate reads or provider calls,
retrieval checks token expiry/revocation, permission/library edits and source/model
state. The model gateway repeats that check after rate queuing and on each retry,
before dispatching protected passages. Authorization failures cannot become a
best-effort provider fallback.

The request-body limit is 1 MiB, the response limit is 4 MiB, the global execution
limit is 64 and the per-token limit is 16, shared across clients using that token.
Exceeding an execution limit returns HTTP 429. The pending HTTP request limit is
128, including authentication and active work; exceeding it returns HTTP 503.
Requests time out after 120 seconds. These limits are fixed runtime defaults.
SSE heartbeats run through process-lived Gecko Timer APIs. Host and Origin are
validated; browser origins must match the configured loopback endpoint. Tokens,
document bodies and request arguments are not written to routine diagnostics.

Disable/reload/shutdown stops new work, cancels ongoing reads/provider work,
drains accepted database transactions and releases listener/timer resources
before database closure. A listener-generation fence rejects requests still
awaiting authentication or client-identity verification when shutdown begins.
Port conflicts produce a visible settings status.
Model HTTP primitives come from a process-lived Gecko global, so foreground MCP
network requests do not depend on an open main window. Network deadlines, model
rate/retry queues and startup-recovery scheduling/yields use process-lived timer
module exports, including when recovery is still progressing as a window closes.
Public HTTPS, account/relay connectivity and external execution grants remain
separate, unimplemented adapters.

## Verification

Run the Node MCP, token, read, projection and retrieval suites for schema and
permission rejection, Unicode budgets, complete continuation, source replacement,
revocation, transactional replay/rollback, cancellation and cleanup.

`scripts/verify-mcp-native.mjs` and `scripts/verify-mcp-codex.mjs` exercise isolated
native HTTP/SSE and real-client interoperability using synthetic literature and
temporary authority. Restore connection settings and remove tokens/records after
checks. Native/client acceptance does not certify manual UI or provider relevance.
See [contract guarantees](mcp-implementation-audit.md) and [project status](project-status.md).
