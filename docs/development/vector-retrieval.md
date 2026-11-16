# Vector ingestion and retrieval

Settings display request timeouts in seconds with up to three decimal places;
configuration files and runtime requests retain integer milliseconds. Validation
feedback uses the displayed range of 1–600 seconds.

## Runtime and ownership

The plugin embeds published `ready` and `partial` generations using Bailian,
stores canonical L2-normalized Float32 BLOBs in its independent SQLite database,
and maintains a replaceable USearch index in a privileged ChromeWorker.
There is no Node, Python, SQLite extension, or external search process at runtime.
Native UI and local MCP share this retrieval engine; transport and token behavior
are documented in [local MCP access](mcp.md).

Migration 0009 appends `embedding_segments` and `vector_snapshot_state` to the
existing embedding, provider, job, FTS and index-build tables. Historical migration
checksums remain unchanged. Segment offsets refer to UTF-16 positions in the
block's normalized input, with original block, generation, attachment and overlap
identities retained. Original published blocks are never rewritten by embedding.
Admission records preserve explicit skip reasons, including short fragments,
boilerplate, references and formula-only blocks. Compare corpus composition, counts and skip reasons before interpreting
semantic-quality results from different fixtures.

## Configuration and providers

New installations keep native Zotero search active. Model services start disabled.
The default embedding endpoint is Bailian's compatible embeddings API; the same
adapter also supports its native text-embedding endpoint. The default reranker uses
the native text-rerank endpoint. Models default to `qwen3.7-text-embedding` and
`qwen3.7-text-rerank`. Keys are stored in Gecko Login Manager, while
`<data directory>/knowledgemcp/retrieval.json` stores credential references only.
Parser credentials keep their existing configuration contract.

| Setting | Default |
| --- | --- |
| Dimensions | 768; options 512, 768, 1024, 2048 |
| Index scalar | Float32 (high precision); optional Int8 (lightweight) |
| Candidate documents / results / evidence per document | 100 / 20 / 3 |
| Minimum relevance threshold | 0.5; configurable from 0 through 1 |
| Background concurrency / embedding batch size | 2 / 10 |
| Request timeout / provider rate | 60 seconds / 60 requests per minute |
| HNSW M / construction expansion / search expansion | 16 / 100 / 200 |
| Vector arena / output chunk | 32 MiB / 4 MiB |

`ProviderRegistry` owns provider definitions and separate embedding/rerank
adapters. Definitions expose limits, dimensions, endpoints, model defaults and
optional typed configuration fields. Generic settings render those fields;
orchestration and scheduling do not contain provider protocol branches.
The Bailian adapter validates the entire batch, restores response order, rejects
duplicate/missing indices and invalid vectors, and validates rerank mappings.
Tests exercise a second protocol without adding it to the shipped registry.

The full vector-space identity contains provider, endpoint, model, dimensions,
normalization, input/admission versions and sorted provider options. Credentials,
rerank settings and index precision do not change this identity. A space change
requires Keep old vectors, Clear the previous configuration's vectors, or Cancel.
Configuration files are atomically replaced; concurrent stale edits are rejected.
Keep preserves isolated profiles; clear schedules owned snapshot cleanup.

The native form shows whether each key is saved, missing, unreadable, pending or
shared with embedding. Saved secrets are not copied into the input; leaving it
empty retains the stored key. Save and apply validates and focuses invalid fields,
then stages key changes under the same writer lock as the configuration. A failed
publication rolls keys back; a lost write acknowledgement is checked against the
published file before rollback. Concurrent edits are rejected before touching keys.
Saved configuration, runtime application and connection verification are separate
states. A revision-only runtime projection reports when saved settings are loaded.

Connection tests immediately show progress beside the service and support cancel.
They use the values currently entered, do not save them, validate only the selected
service, use a 15-second timeout and skip automatic retries. Authentication,
network, HTTP status and response validation failures remain visible locally.
Editing the form invalidates pending tests and their late responses. Normal
retrieval and background requests retain their existing three-retry policy.

Advanced limits and maintenance are collapsed initially. Vectorize existing
documents calls the embedding API only for missing matching content; Repair search
index rebuilds locally from saved vectors without API calls. Their descriptions
explain the distinction and task progress. Restore saved settings discards unsaved
form edits without resetting providers or deleting vectors. Maintenance is disabled
until services are saved, enabled and applied. Status text occupies its own row.

## Processing and durability

Startup and outbox reconciliation discover current published sources. An enabled
configuration with a usable credential backfills missing generations. User
cancellation is durable for the generation/profile pair, including after task
history deletion; an explicit retry or manual backfill releases that suppression.
Parsing success is independent of embedding success.

Inputs split at paragraph, sentence and Unicode code-point boundaries, with
overlap and complete tail coverage. Each validated batch commits atomically with
its checkpoint. Execution token, cancellation, source version, content version,
active generation and configuration revision fence stale results. Startup releases
interrupted embedding leases; committed segments are not requested again.
Authentication/protocol failures stop retries. Temporary failures retry at most
three times; `Retry-After` affects the shared provider rate queue. Foreground work
takes precedence over queued background work.

Tasks expose embedding/index stages and completed/skipped/failed segment counts,
plus pause/resume, cancel and retry. Settings can enqueue missing historical data
and rebuild the index; individual knowledge information panes can enqueue a paper.

USearch sources, Apache license, arena patch and compiler wrapper are in
`vendor/usearch/`. XPI assets include the compiled WASM, worker and license.
`npm run build` verifies source/binary hashes against `vendor/usearch/build.json`.
To rebuild the binary, use `scripts/build-usearch.ps1 -Emsdk <SDK directory>`.
Python only drives Emscripten during development.

The index tracks durable embedding labels and corpus identity. Corruption,
incompatible scalar/dimensions and hash/size mismatch rebuild from canonical local
vectors. A mode change rebuilds locally. Deletions/replacements trigger compaction
at `max(1000, active count * 0.2)` accumulated removals. Index snapshots publish
only after chunk writes, incremental SHA-256 and atomic rename complete; database
activation follows successful disk publication. Mutations freeze during a save,
while queries can run between chunks. Restore streams from JS into final native
allocations, transfers ownership of the input buffer and explicitly releases that
source after loading. Incomplete temporary files never activate a snapshot.

Successful snapshot activation removes the same profile's retired build records
and label mappings in the activation transaction. Any build still referenced by
`vector_snapshot_state` is protected, including retained vector spaces. Startup
also reclaims accumulated unreferenced retired builds across profiles; clearing a
profile reclaims its retired builds after removing its snapshot reference.
Canonical embeddings remain unchanged. Failed activation rolls reclamation back
with the snapshot pointer, and lost commit acknowledgements retain the newly
activated file. SQLite can reuse the freed pages; this does not promise that the
database file immediately shrinks or claim a measured speedup.

## Search and native integration

The native search dropdown retains its original modes and adds **Knowledge Base:
Text**, **Knowledge Base: Semantic**, **Knowledge Base: Enhanced Semantic** and
**Knowledge Base: Fusion** as radio menu entries. Plugin selection uses its own
preference, and never writes a custom value to Zotero's native search-mode
preference. Searches submit on Enter,
respect IME composition and invalidate old requests on submit, mode/scope change
or window close. Native advanced search remains available.

Selecting a plugin mode or restoring a saved mode only changes the next search;
it preserves the displayed items and existing native text filter. Typing does not
filter the list. A nonempty Enter submission activates the plugin result filter;
switching plugin modes keeps the last submitted result until the next submission.
An empty Enter removes the plugin filter without calling a provider, while a
submitted query with no matches correctly shows an empty result. Scope changes
discard the previous result filter. Native temporary search tables are regenerated
when the submitted results arrive, rather than retaining a pending empty table.

Native row searches resolve library, collection, knowledge-folder and tag scopes
before retrieval; only admitted knowledge resources participate. My Knowledge Base
searches the union of its active knowledge libraries. Knowledge Trash is an explicit
recovery-owned scope, including retained document content under deleted containers;
normal searches never add those resources implicitly. Native Trash can search its
admitted knowledge items. Document search results omit container recovery rows;
leaving plugin retrieval restores the ordinary mixed Trash view. Import tasks and
advanced-search editing disable plugin modes. The native item objects
remain responsible for selection, opening, dragging and column sorting. A
relevance overlay yields to an explicit column sort. Exiting plugin mode restores
the original native filtering and sorting implementation.

`RetrievalService` accepts a resolved resource scope and returns deduplicated
documents, evidence, executed channels, coverage and explicit degradation:

* Full text uses published block FTS with shared Unicode/CJK bigram preprocessing.
* Semantic embeds the query and searches inside the allowed vector-label set.
  Up to 5000 labels uses exhaustive filtered search; larger scopes use filtered
  ANN with a scoped exhaustive fallback when candidates are insufficient.
* Enhanced semantic reranks candidate document titles and representative passages.
* Fusion combines metadata, parsed text and vectors at document level using RRF
  (`k=60`), then reranks. Metadata includes admitted unparsed documents.

Rerank failure retains the incoming order; vector failure in Fusion retains
metadata/full-text channels. Pure semantic embedding failure returns an error.
An LRU caches 128 query embeddings for ten minutes, keyed by full vector space.
Within one retrieval, a separate request-owned search session resolves the scoped
vector-label mapping once, applies the same block filters before search and
retains only that scope's reverse mapping. It is never a cross-request cache.
When the document candidate budget exceeds the entire resource scope and at most
5,000 labels qualify, the existing exact engine visits that scope once. Larger
scopes retain the existing candidate expansion and filtered ANN behavior. Merely
finding every document is not treated as evidence completion. Ranking reads light
segment metadata first; only selected segment bodies are hydrated. Final source,
membership, generation and configuration fences remain authoritative.

Coverage reuses the sources validated inside the final transaction. Its segment
aggregation still runs for every request, so embedding publication, skipped
segments and source replacement do not depend on a persistent cache invalidation
scheme. Source-first joins use the existing indexes without schema changes.
See [the native comparisons](retrieval-performance.md).

The threshold groups the returned candidate documents rather than discarding
lower-scoring results. Documents meeting the threshold appear first without a
group heading; one compact “The following content may be relevant” separator
precedes lower scores. Both groups together respect the configured final document
limit. When all scores are below the threshold, the separator appears first, with
no empty primary group or threshold/count explanation. Group order takes precedence over manual column
sorting, which continues within each group.

Semantic search uses cosine similarity; successful reranking uses the final
rerank score. Full-text and metadata-only keyword matches are direct results,
because BM25 and RRF are not calibrated to a 0–1 scale. If Fusion reranking fails,
a document with vector provenance uses its best cosine score; a keyword-only
document remains a direct result. RRF is never compared numerically with 0.5.
Channel provenance and the grouping basis survive fusion and degradation. Scores
are not relevance probabilities. Legacy configuration files acquire the default
without changing embedding-space identity or regenerating vectors.

Submitted results retain native Zotero document rows and disclosure icons,
including the host's mouse handling and arrow animation. Expansion adds a
224 CSS pixel independently scrollable evidence area inside the document row;
there is no popup or synthetic child reference. A height-map update and one
targeted native row render update that row. Existing visible rows move using
the native virtual list's offsets, without rebuilding their cells or restoring
selection through a whole-list update. The scroll extent is corrected after
native offset recalculation. Folding passages does not change the outer height.
Panels are built on first use and cached for the current result. Sorting retains
open evidence; changing the result clears it. Source links, literal highlighting
and metadata evidence retain the same contract. The possible-relevance notice
uses its own 24 CSS pixel line above the first lower-scoring title, outside all
title cells. It belongs to that real item's geometry rather than a synthetic row,
so native programmatic selection and item details always receive native items.
Clearing the query,
changing scope or returning to native search restores attachment expansion.
Native internals used by this adapter require revalidation after Zotero updates.

The first passage opens by default. Literal query terms are highlighted with safe
text nodes, while semantic relevance does not fabricate a keyword match. Long
passages provide an excerpt near the first literal match and can expand in full.
Metadata matches identify their fields. Attachment names are blue underlined
links that open the source through Zotero Reader at the available page. Source,
section/page availability and processing warnings remain visible. Channel badges,
per-passage channel names and detailed numeric scores are omitted from this UI;
score provenance remains in the service result for internal use. Missing positions and unavailable
source actions are explicit. No generated explanation or additional model call is
used to produce evidence.

## Reproduction and evidence

Run `npm run typecheck`, `npm test` and `npm run database:check` with Node 22.23.1.
Developer controllers below require an already running isolated Zotero 10 instance
with its debugger enabled. They reject a data directory outside `.scaffold`.
Set `ZOTERO_DEBUG_PORT` if the debugger is not on port 5399.

* `node scripts/verify-vector-native.mjs`: all dimensions/scalars, disk snapshot,
  restore identity, insertion/deletion and result consistency.
* `node scripts/verify-vector-xpi.mjs`: installs an actual packaged XPI in the
  isolated instance, verifies active-Worker disable/enable cleanup twice and
  restores previous model settings and temporary Login Manager credentials.
  `--replace-active` additionally replaces the running instance directly and
  checks that only one database owner and one set of four search menu entries remain.
* `node scripts/verify-vector-ui.mjs`: explicitly formats and mounts settings in
  all seven native Fluent locales without changing Zotero's interface language.
* `node scripts/verify-vector-settings.mjs`: verifies secure native save/reopen,
  shared/separate keys, field validation and restore, plus two live Bailian tests
  with immediate feedback and no implicit save. Temporary credential references
  and settings are restored afterward; this consumes model API quota.
* `node scripts/verify-vector-search-ui.mjs`: uses the existing acceptance library
  to verify full-text results, evidence reactivation, a 1000-pixel window and
  second-window lifecycle, then restores its input, mode, selection and size.
* `node scripts/verify-vector-result-ui.mjs`: current inline full-text evidence,
  native arrows, highlighting, targeted row updates, scroll geometry, sorting, clearing and attachment
  restoration; deterministic score fixtures additionally verify both result
  groups and the all-below-threshold case in the native list. These fixtures do
  not establish new model quality measurements. No provider calls are made.
* `node scripts/verify-vector-pipeline-ui.mjs`: verifies the knowledge overview and
  Trash search controls/scopes, a single seven-stage document workflow and native
  pending-stage messages in all seven locales. It uses a disposable window and
  verifies that existing windows retain their query, selection, expanded rows and
  scroll position. Search completion is observed through the textbox's full
  `aria-busy` transition, including requests that complete between polling ticks.
  Empty results, failure feedback and successful resubmission are checked in both
  scopes. The controller does not call providers or mutate library content. It
  requires an existing document task in the isolated development library to
  inspect the seven-stage workflow. `test/native-search-feedback.test.mjs` covers
  fast completion, failure recovery, unhandled submissions and window teardown.
* `node scripts/verify-vector-scopes.mjs <completed-live-run-id>`: copies that
  completed corpus and exercises native SQLite/FTS/USearch recovery ownership,
  Trash retrieval, restore and deleted-library content. Query vectors and rerank
  results are local fixtures; this is scope correctness, not a semantic quality
  evaluation or a live model call.
* `node scripts/verify-model-http.mjs`: records live Bailian request timings and
  Gecko connection metadata, alternating retained/new transport objects without
  changing application configuration. See the [connection reuse report](model-http-reuse.md):
  the existing transport already shares HTTP/2 connections; object persistence
  does not provide an additional handshake saving. The optional fresh-connection
  flag diagnostic must be validated against actual connection evidence.
* `node scripts/verify-vector-live.mjs`: live Bailian ingestion and 60 queries in
  a new independent acceptance database. It reads the isolated plugin's saved
  model configuration and Login Manager credentials, uses temporary credential
  references and removes them afterward. It never returns credentials to the controller.
* `node scripts/verify-vector-recovery.mjs <completed-live-run-id>`: copies that
  completed database into a new fixture, then verifies restart, corruption,
  interrupted publication, cancellation, scalar switching and compaction.
* `node scripts/verify-vector-performance.mjs --compare`: three alternating rounds
  at 1k/10k/100k, 500 fixed queries, disk persistence and sampled process RSS. The
  comparison disables transfer reuse/source release/scope caching; both paths use
  compact query buffers and the same C++ binary. Report the reference protocol's
  extra slice round-trip when interpreting saving costs.

Bootstrap serializes resources across loader scopes and captures each instance's
API for proactive replacement cleanup. A dedicated complete native Fluent source
survives the host's delayed unified-source cleanup. Central result adapters release
their inline evidence, methods, listeners and styles during window/plugin
cleanup. Native lifecycle findings have corresponding VM regression tests.

## Concurrency and shutdown

Each embedding tick captures its configuration and profile together, then passes
both to execution. Profile activation checks the captured configuration inside
its transaction; a stale manual admission cannot reactivate an earlier model.
Local startup retries a configuration change during activation without contacting
the provider. Claims and batch commits require the job's matching profile, and
provider requests use the captured configuration. Configuration changes cancel
existing executions and invalidate their late responses. Queries also capture
their provider configuration, refuse a loaded index from another embedding space
even when dimensions match, and never cache a response from a superseded space.
Application compares the loaded snapshot itself, so an external file edit that
retains its revision still activates the correct profile on the next tick.

For a clear-and-switch save, the configuration writer gives the runtime a
publication callback. The runtime pauses scheduling and aborts old executions
before clearing, then keeps that pause through the atomic configuration write
and immediate reload. It cannot regenerate the old space during the normal
polling gap. A failed write releases the pause under the unchanged configuration;
a successful write followed by a failed runtime reload keeps the old snapshot
fenced until reload succeeds. Local recovery waits for that boundary, and shutdown
releases its waiters. Lost write acknowledgements retain the existing read-back
check and do not restore obsolete credentials or vectors.

Configuration reloads carry per-owner generations. A later read or local
publication invalidates earlier results, including stale errors, so an older poll
cannot roll back a newly applied model even if an external edit retains its
revision. Publication invalidates reads both before and after atomic replacement
to cover polls started during the write. Queued saves compare the originally
observed file and configuration snapshot, preventing a second draft on the same
owner from overwriting the first save. Owners track every accepted initialization,
read and write; close invalidates reads, drains all work and suppresses callbacks
to detached views. A missing previously observed file reports the existing read
error until valid content is restored. Regression coverage is in
`test/retrieval-config-concurrency.test.mjs` and the delayed-poll embedding cases.

Search validates active knowledge membership or explicit Trash recovery ownership
at admission and again immediately before returning. Documents moved to Trash,
restored from Trash or removed from the last active knowledge library during
provider/local work are excluded from the response's original scope. Surviving
results retain their order; resource/parsed/embedded coverage is recomputed for
the still-permitted scope without another model request.

Snapshot publication owns a per-path lock from cleanup-journal registration
through file writing and database activation. Reclamation acquires the same lock
for both final and temporary files, then rechecks its journal and active snapshot
references. Successful publication consumes its journal; failed publication leaves
it recoverable. This preserves lost-commit-acknowledgement protection and canonical
Float32 recovery without a new migration.

Shutdown rejects new work and interrupts workers immediately, then drains accepted
manual enqueue, task actions, clear/rebuild operations, direct ticks/local recovery
and detached task refreshes before database ownership is released. A failed action
still rejects to its caller and does not prevent cleanup.

`test/embedding-concurrency.test.mjs` exercises configuration saves, matching-profile worker operations, concurrent lifecycle actions and cleanup with synthetic fixtures. `scripts/verify-embedding-concurrency.mjs` supplies the corresponding isolated native boundary. Use dedicated fixture state and restore configuration/credentials after checking.

`scripts/report-vector-acceptance.py` normalizes trailing SVG whitespace after
generation, so regenerating the maintained measurement figures preserves the
repository's whitespace checks. This changes formatting only, not measurements.

## Membership, content and history integrity

Background job admission, per-batch dispatch and transactional vector publication
share a repository eligibility check. It requires an active knowledge membership,
the claimed execution token, the active embedding profile and matching source and
content versions of the active readable generation. The HTTP gateway repeats the
check after rate/concurrency queue admission and before each retry. Moving a
document or its last active knowledge library to Trash prevents subsequent
uploads and rejects late vector responses. Jobs remain pending without increasing
their failure counts and appear paused until membership is restored. Other active
memberships continue to permit processing. Already accepted remote requests
cannot be recalled; restoration reuses successfully committed batches.

Retrieval checks source/content versions during evidence hydration. After all
provider work, one short local transaction reads current membership, active
readable generations, coverage and metadata. A candidate whose ranking used an
obsolete attachment generation is omitted before the final result limit, even if
another passage or metadata match remains valid. Its old rerank score is not
reassigned to surviving evidence. Other candidates keep their ordering and fill
the available result slots; resubmitting searches the new generation. Full-text,
semantic, enhanced and fusion search, including Trash retrieval and degraded
reranking, use this boundary. No database transaction spans a provider request.

Deleting terminal workflow history marks all vector attempts/profiles for that
source/generation hidden in their existing payloads. It preserves durable
deduplication, failure/cancellation history, vectors and content without adding a
migration. Automatic reconciliation and startup do not resurrect the workflow.
Explicit vectorization/retry can make new or existing work visible again;
vectorization preserves the intentional pause of existing paused jobs. Deleting
a running task is rejected without aborting its execution.
Clearing synchronization history hides terminal parse and vector phases in one
transaction, including retained vector profiles and attempts. A visible live
vector job for the current source generation preserves its parse row and batch
grouping. Previously hidden or superseded live records do not keep terminal
history visible. Work retained during a clear remains visible when it finishes;
new work is unaffected. The sync service refreshes both projections after clearing.
Overlapping task refreshes carry publication generations, so an older snapshot
cannot make hidden history visible after a newer deletion/refresh completes.

Vector shutdown checks closure/cancellation again after asynchronous corpus
discovery and before snapshot-rebuild fallbacks. Once shutdown starts those
branches cannot create a new Worker. Cleanup interrupts the current Worker
immediately, drains accepted index work and releases any remaining Worker again
before database ownership is relinquished. Deterministic regressions cover both
discovery and failed-restore shutdown boundaries in `test/shutdown.test.mjs`.

`test/vector-snapshot-retention.test.mjs` covers bounded snapshot metadata,
transaction rollback, lost commit acknowledgement, restart cleanup and protected
snapshot references. `test/sync-history.test.mjs` covers combined history cleanup,
retained vectors/cancellation/deduplication, visible live jobs, hidden/superseded
attempts, failed cleanup and batch isolation. The native concurrency controller
also repeats real Worker snapshot publication/restoration and mounts the task
view in a separate synthetic Gecko document backed by its isolated fixture.
These checks use synthetic responses and do not call model providers or edit the
application's library/configuration.

Regression coverage is in `test/embedding-admission.test.mjs` and
`test/retrieval-integrity.test.mjs`. The synthetic native controller
`scripts/verify-embedding-concurrency.mjs` also exercises real SQLite eligibility,
history hiding, restoration, late-response rejection and replacement during
reranking. It uses an independent database under `.scaffold`, fixed model
responses and zero external provider requests. These are developer-driven native
checks, separate from manual UI or live model-quality verification.

## Startup capability gates

Native search remains available while startup recovery runs. Full-text search waits for metadata/file/task recovery and FTS projection; semantic and enhanced search wait for local vector index recovery. Fusion uses available text and/or vector channels independently, with explicit degraded-channel feedback. Search-field hints and task notices show the current stage, and the settings maintenance section offers recovery retry after failure. Enter before any relevant channel is ready preserves the native list and makes no model request; becoming ready does not automatically submit that query. Maintenance and accepted processing actions wait for their relevant restoration checkpoint.

Vector WASM fetches, worker deadlines and background task scheduling/controllers
outlive main windows. A partial open failure closes its worker and permits a fresh
open without stale responses affecting the replacement. Index recovery retries
locally twice after 500 and 2,000 ms, without model calls, then retains a failed
state and manual retry. Safe stage/code/type details distinguish failure from
ongoing initialization; the original exception stays in privileged memory only.
See [vector readiness and recovery guarantees](mcp-vector-initialization-audit.md#recovery-guarantees).

Database migration and integrity checks still finish before UI registration. Recovery uses persisted Float32 vectors/snapshots without contacting the model provider. The ordinary scheduler starts only after recovery, then handles pending embedding jobs under the existing configuration. Shutdown prevents subsequent stages, rejects waiting actions and drains the active stage before closing storage. See [native startup measurements](startup-optimization.md).

## Idle UI behavior

Inline evidence bypasses the native container child-insertion and update-listener
pipeline. Each toggle updates the height map and repaints only its native document
row, then repositions retained visible rows. See [timing and verification](retrieval-toggle-performance.md).

Background task progress does not reload a selected knowledge scope or its inline evidence. Ordinary attachment sorting/toggling delegates directly to Zotero when no submitted result is active. Unchanged snapshots do not recreate the task panel. See the earlier [native idle and expansion measurements](idle-refresh.md).

The results list has no search summary/retry footer. Search progress, failure and degradation appear as search-field tooltips and accessibility descriptions, with `aria-busy` during a request; normal completion restores the original input attributes. Users resubmit with Enter, and startup recovery is retried from Settings. Result grouping and evidence remain in the middle list.
