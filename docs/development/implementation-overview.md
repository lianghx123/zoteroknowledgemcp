# Implementation Overview

Maintainer reference for implemented behavior and runtime boundaries. These
detailed notes were moved from the repository homepage so that
[README](../../README.md) can focus on installation and user workflows.
Use the [development guide](getting-started.md) for contributor setup and the
documentation map. See the [delivery status](project-status.md) for acceptance priorities and
the linked feature documents for current evidence and limits.

## Structured Content

Current parsing infers numbered heading conventions separately for each article
and explicit chapter/appendix scope. It accepts opposite Chinese numbering
orders when supported by repeated structure, tolerates width/bracket/spacing
differences in numbering prefixes, and publishes matching Markdown levels and
section parents. Original title text and source coordinates survive. Ambiguous
headings retain provider formatting for review; existing generations adopt the
new rules only when explicitly reprocessed. See
[heading hierarchy behavior and limits](parsing.md#article-specific-heading-hierarchy).

The content model gives authorized AI clients several levels of access to a paper:

- **Document:** bibliographic metadata, attachment identity, and document-level text.
- **Section:** the document hierarchy used to navigate and read a specific part of a paper.
- **Content block:** an addressable unit of text associated with its section, reading order, content type, and available source location.
- **Search match:** a relevant passage associated with its source document and content location.

Markdown provides a readable representation of the extracted text. Structured identifiers and metadata let clients select the content they need, request bounded reads, and retain its relationship to the source.

## AI Client Workflow

The intended workflow is:

1. Organize literature and attachments in Zotero.
2. Process document attachments into structured text.
3. Build text and vector indexes for the processed content.
4. Let an authorized AI client discover literature and search for relevant passages through MCP.
5. Read the selected documents, sections, or content blocks through structured tool calls.
6. Carry source identifiers and locations into subsequent research tasks.

## Development Status

The Markdown companion has a compact floating reading bar for toggling Contents,
adjusting body text size and returning to the top. Markdown visibility, split
ratio, directory visibility/depth and text size persist across new PDFs and restarts.
The directory follows the current section and emphasizes its ancestor headings.
Its controls are scoped to the companion and leave Zotero's PDF toolbar unchanged.
The companion also has an independent document-search sidebar with text,
semantic, enhanced semantic and fusion modes. It searches the displayed PDF's
content generation, ranks passages within that attachment and navigates to
source blocks; closing search restores Contents. Text search works without a
semantic index, while model-backed modes reuse the configured index/providers. See the
[Markdown reader guide](markdown-reader.md).

Block editing is available from the companion's pencil icon
or its text-block context menu. It offers inline Markdown/preview switching,
expanded editing, a saved editor height limit, formula-source editing, block type
changes, insertion below and confirmed deletion for unambiguously mapped blocks.
Applying a block updates the current preview, its directory and local text search.
Undo/redo history remains in memory and survives hiding the Markdown pane.
**Save document** publishes one immutable edit generation with conflict detection,
transactional full-text indexing and reuse of unchanged blocks' matching vectors.
Changed text follows the configured background embedding policy. Unsaved work is
lost when its PDF reader closes or the plugin/application restarts.

Local MCP application contract 2.4.0 keeps all 16 tools and now separates concise
literature discovery from bibliographic detail defaults. Document/section reads
preserve scientific footnotes, exact blocks and annotation text/quotes can be
read completely through per-target cursors, and content availability follows
current source generations. Field expansions are discoverable and validated
before querying, including empty results. Initialization reports schema and
build fingerprints. See [MCP reading and compatibility](mcp.md)
and the [implementation audit](mcp-implementation-audit.md).
Reference-type filters preserve document-wide structured-reference availability;
rerank score thresholds require an explicit rerank request and fail argument
validation when reranking was not requested.

Retrieval reuses vector mappings within each request and reads selected segment
bodies after ranking. Small exact-search scopes are exhausted once when the
requested document budget exceeds the entire scope, retaining complete evidence.
Coverage reuses transactionally validated sources; MCP builds evidence only for
the requested page and preserves complete ranked continuations. Diversification
reuses title sets and incremental similarities. The vector engine, concurrency
settings and single database connection remain unchanged. See
[retrieval optimization and verification](retrieval-performance.md).

Vector startup, WASM loading, request timers and background controllers no longer
depend on a main window. Local index recovery has two bounded automatic retries
and retains safe failure diagnostics. Hybrid search uses whichever local channel
is ready and reports degradation explicitly. The populated-index recovery repair
is verified through real MCP queries with every main window closed; see
[vector initialization audit and remediation](mcp-vector-initialization-audit.md).

Migration 0014 adds thirteen lookup indexes to reduce full-table foreign-key and
ownership probes during permanent Knowledge Trash deletion. Existing databases
use the validated pre-upgrade snapshot and transactional migration path. Deletion
and shared-content protection rules remain unchanged. SQLite-copy measurements
and their native-runtime/write-cost limits are documented in
[permanent deletion](permanent-deletion.md#lookup-indexes).

Parser bibliography records store original numeric labels separately from their
number-free Markdown bodies. Numbered continuation fragments merge locally;
unnumbered entries also join across consecutive pages when text indicates a
continuation, including a split hyphenated title. Projection v2 upgrades existing
automatic records locally while preserving manual corrections and tombstones.
Packed numbered entries split, retaining all source blocks and locations.
Migration 0013 and startup projection backfill upgrade existing parser records
without OCR calls. The reader renders original numbers, or sequential numbers
for unnumbered entries. Canonical source text and manual reference work remain
intact. MCP `list_references` exposes `referenceNumber` and full source provenance;
bibliographic field extraction and target matching are not inferred.
See [reference ingestion](parsing.md#reference-ingestion).

The Markdown reader links recognized in-text citations to the current document's
bibliography. Hover or focus a citation to read complete reference entries in a
scrollable preview, with source-entry navigation, safe links and retained math.
Citation text wraps with the paragraph while retaining color and dotted
underlining; Enter or Space opens its preview from the keyboard.
Numeric lists/ranges use original labels only; author-year citations support
English and Chinese names, multiple years and suffixes. Ambiguous matches show
candidates and partial matches report missing entries. Matching is local to the
loaded view, with no provider requests, PDF modification or database migration.
Latin bibliography author fields preserve dotted/compact initials and mixed
surname-first/initials-first coauthors, stopping before titles and later editors.
HTML and Markdown table cells render literal `\n` markers as line breaks while
retaining code, math and explicitly escaped backslashes.
Consecutive abstract paragraphs share one shaded section, preserving paragraph
spacing and source pages without including intervening body or metadata blocks.
Bracketed numeric superscripts retain their MathML/HTML formatting and show full
range entries. Component enumerations such as `(1)…(2)…(3)` stay ordinary text.
For parsed attachments, the view also reads Zotero's existing PDF citation
evidence in the background, checks page/context correspondence and supplements
local matches; native-only reference text is identified in the preview.
Shared context checks exclude numeric intervals, table-column locators and
prose enumeration runs from both local and native citation matches. Round
numeric fallback requires a dominant bibliography style and is suppressed for
a predominantly matched author-year body.

The plugin settings pane places horizontal **Document parsing**, **Models and
retrieval** and **MCP connection** tabs below the plugin title. Switching tabs
preserves unsaved inputs and returns to the top of the new section; each section
keeps its existing save or apply action.
The tabs stay visible while scrolling, support arrow keys, Home and End and use
all seven interface locales.
Forms use left-aligned checkbox labels, compact controls sized for their content
and stacked labels in narrow panes. MCP connection settings and token editing
have separate forms.
Time controls display seconds and size limits display MB (1 MB = 1,048,576
bytes); saved configuration retains integer milliseconds and bytes. Selects
have a separate chevron area, and numeric controls omit spinner buttons.
MCP token management uses wrapping records with names, authorized knowledge
libraries, permissions, creation/expiry times and status visible without
horizontal scrolling. Editing opens inside its record, creation opens on demand,
and switching editors retains drafts until explicit cancellation. Saved edits
preserve secrets and expiry; revocation requires an inline confirmation and
hides the record without deleting it. New one-time secrets appear below their
own token's dates. Connection settings and client instructions remain expanded.
The local MCP checkbox shows its running status inline, in green when running
and red when stopped or unavailable.
The MCP address and Codex connection command use matching code blocks with
copy buttons and inline clipboard feedback.

Lifecycle queues, configuration save locks and database ownership now use a
process-lived Gecko system-module global. They continue draining after the last
main window closes. Shutdown cancels parsing, synchronization and vector work
before waiting, interrupts the index Worker and drains accepted database writes.
See the [startup/shutdown diagnosis](plugin-lifecycle.md)
for native evidence and the distinction from Zotero's own update prompts.

Plugin retrieval groups results using a configurable relevance threshold (default
0.5), retaining lower scores after one compact relevance notice. Use Zotero's
native disclosure arrow to read highlighted passages, matching metadata fields
and source locations inline. The relevance notice has its own line above the
first lower-scoring result, outside the title. Native attachment expansion returns
when the submitted search is cleared. See [retrieval behavior](vector-retrieval.md).

Import Tasks groups each document workflow into **Add to knowledge base → Extract
document content → Prepare semantic search**. Stage checklists stay expanded
within the progress section, distinguishing local capacity waits, service preparation, page extraction,
result retrieval, content organization and saving. Page percentages describe only
reported extraction progress. Task information, progress and processing details
use three collapsible Zotero sections beneath a separate native title, with plugin
icons, the native sidebar and collapse controls. Parser/model
settings stay in Processing details. Optional and paused semantic work remain explicit.
Folder grouping is retained, and vector-stage retry does not resubmit the PDF. My Knowledge Base
supports plugin search across all active knowledge libraries; Trash supports an
explicit recovery-owned document search scope. See [task behavior](import-tasks.md)
and [retrieval scopes](vector-retrieval.md).

Clearing synchronization history hides terminal parse and vector phases together,
while visible pending, running and paused vector workflows retain their folder
grouping. Snapshot activation reclaims retired index builds and label mappings;
startup also removes accumulated unreferenced builds. Retained snapshots and
canonical vectors remain available for local recovery.

The project is a development preview with an implemented local knowledge workflow: native literature admission and collection synchronization, durable PDF parsing, structured publication, vector ingestion, retrieval and a Markdown companion pane in the native PDF reader. All 16 MCP tools are available through an opt-in local SSE endpoint at http://127.0.0.1:23126/mcp/knowledge; the port is configurable. See [MCP setup, authorization and validation](mcp.md). The native search dropdown includes **Knowledge Base: Text**, **Knowledge Base: Semantic**, **Knowledge Base: Enhanced Semantic** and **Knowledge Base: Fusion**. Plugin search mode selection preserves the current list; full-text and semantic searches apply only after a nonempty Enter submission. Empty Enter clears the plugin result filter without a model request. Model settings distinguish saved/pending/shared keys, saved versus applied configuration, and independent connection verification. Tests show immediate feedback, support cancel and do not save changes. Vectorization and local index repair have separate explanations under maintenance. See [vector settings and verification](vector-retrieval.md). Model HTTP requests already use Gecko's shared connection pool; see the [native HTTP/2 reuse measurements](model-http-reuse.md).

Startup keeps database migration and integrity checks on the required path, then attaches the knowledge/search UI from the persisted snapshot. Metadata reconciliation, file recovery, task restoration, full-text projection and local index restoration run after native UI readiness. Search-box hints, task notices and maintenance controls show recovery progress, with recovery retry in Settings; full-text becomes available before semantic search. Local index recovery never submits embedding or rerank requests, and shutdown cancels pending stages before draining persistence. See the [startup measurements and native checks](startup-optimization.md).

Background task progress updates only the visible task panel; an active-count change updates its navigation badge without reloading literature rows. Unchanged knowledge/task snapshots do not notify the UI, idle vector ticks skip task/index projection, and native attachment sorting/expansion does not receive retrieval row-height updates outside submitted results. See the [idle refresh and expansion verification](idle-refresh.md).

An enabled/disabled native comparison on 2026-10-29 used six alternating process-restart pairs with nine papers and 1,989 vectors. Enabling the plugin added approximately 79 MiB of median process-tree private memory and 0.67 seconds to the common addon-startup checkpoint; native list population and idle CPU showed no demonstrated increase. Attachment toggles added approximately 1–1.5 ms; explicit list refresh had a higher, variable median. See [methods, ranges and limits](plugin-runtime-overhead.md). These small-library measurements do not establish large-library or PDF-reader performance.

Embedding execution binds each job to one configuration snapshot and matching profile, including across hot reload of model settings. Queries reject an index from another embedding space. Snapshot publication and reclamation share a file lock, and shutdown drains accepted manual embedding actions before releasing storage. See [concurrency guarantees and native verification](vector-retrieval.md#concurrency-and-shutdown).
Clearing an old vector space pauses its scheduling through settings publication
and runtime reload, so the polling interval cannot regenerate cleared vectors.
Configuration reads use generation guards to reject obsolete polling results,
and closing an owner drains every accepted read and save.
Retrieval rechecks current knowledge/Trash ownership before returning results,
including after delayed reranking.

Submitted retrieval results expand the native document row with a bounded,
scrollable evidence area. Only the toggled row is rendered again; retained rows
move to their new positions without a whole-list redraw or synthetic child rows. See the
[native timing comparison](retrieval-toggle-performance.md).
Viewport lookup uses actual row boundaries so scrolling through expanded evidence
keeps every partially visible document mounted.

Legacy uncertain uploads remain recoverable even when a newer retry already exists. Recovery fences unsubmitted duplicates before restoring their predecessor and preserves already accepted successor tracking. Unresolved attempts remain visible independently of the latest-attempt filter; intentional history clearing is still respected.

Audit corrections protect replacement Markdown caches across interrupted writes and cleanup, recheck sync exclusions within both folder-mapping and admission transactions, and retain an empty knowledge tree after the final library is permanently deleted. Purged sync destinations invalidate their old relationships and require an explicit new link. Accepted OCR submissions retain their recovery route through local checkpoint failures or unavailable credentials; batch retry continues past an unavailable attachment and reports failures after refreshing eligible work. Publication cleanup preserves database-owned artifacts even after a lost commit acknowledgement, and concurrent preference windows serialize their saves. Parse admission checks current source/content versions before reusing history, and task-view failures cannot fabricate an uncertain upload. Partial window initialization rolls back adapters; window cleanup continues through detached surfaces and retains failed menu/section registrations for retry. See [deletion](permanent-deletion.md), [synchronization](collection-sync.md), [parsing](parsing.md) and the [comprehensive code audit](code-audit.md) for the persistence and verification boundaries.

The plugin interface follows Zotero's language setting and supports English, Simplified Chinese, German, French, Spanish, Japanese and Traditional Chinese, with English fallback for other languages. Menus, knowledge details, prompts, accessibility labels and the Markdown reader share Fluent resources. Add a language by copying and translating `addon/locale/en-US/knowledgemcp.ftl` into a new locale directory; no language list or code change is required. See [localization and extension instructions](localization.md).

Select items and choose **Add to Knowledge Base** to save bibliographic metadata and attachment identities in the plugin database. **My Knowledge Base** provides independent knowledge libraries/folders, hierarchical add targets and membership removal. Admitted native titles receive an inline status icon; the peer **Knowledge Base Information** section shows memberships, attachments and refresh actions. Zotero metadata edits synchronize one way, including startup reconciliation after missed notifications. Collection menus offer both one-time admission and explicit continuous synchronization. See [usage, approved metadata/tables, update policy and verification](knowledge-membership-metadata.md).

Knowledge libraries use the project's original purple **Book K** logo, combining open pages and a K letterform. The same locally drawn SVG identifies plugin commands in item/folder context menus, the knowledge information pane and the addon manager; it uses no third-party icon paths. Knowledge libraries display all their items directly, without an automatic Unfiled entry or sample folders/items. Their context menu supports deletion with confirmation and an optional removal of exclusive knowledge data; shared resources and Zotero originals are preserved. The right-pane information uses labeled fields in a two-column layout. Deleting the last library does not recreate it on restart.

**Trash** appears below the knowledge libraries as a single entry. Like Zotero's native Trash, its middle list shows deleted folders/libraries and removed literature together as selectable rows. Select rows and use **Restore to Original Location** from the context menu or the right-pane restore button; the Trash context menu also restores all entries. Restores retain original identities, folder hierarchy and memberships, and report name conflicts without overwriting existing locations. Knowledge tree expansion, including nested folders and nondefault libraries, is saved in plugin preferences and restored on startup.

The knowledge item menu offers **Move to Knowledge Trash** in library, folder and combined knowledge views. This removes the selected literature from all placements in the displayed knowledge libraries; **Remove from This Knowledge Folder** affects only that folder placement. In Trash, **Delete Permanently…** works for selected literature, folders and libraries, with confirmation. The right pane also has a delete button, and the left Trash menu offers **Empty Knowledge Trash…**. These actions physically remove discarded ownership records. When no active knowledge membership, Trash recovery right or incoming literature reference remains, they delete the resource, native mappings, parse history, published content, revisions and managed artifacts. Shared content and Zotero originals remain intact. File cleanup is durable and retries after restart; see [permanent deletion](permanent-deletion.md).

Trash operations process large reference lists in bounded batches within one transaction. Metadata reads and readmission checks use recovery-table queries, so cumulative Trash size does not expand their SQL parameter lists. Knowledge/Trash list scopes use native temporary searches to avoid one expression per item. Large legacy recovery JSON is imported without repeating the entire document for each sorted reference. See [storage scale verification](trash-scale-verification.md) for tested sizes, rollback coverage and development-database compatibility.

Folder trees, admission menus and folder deletion use parent indexes, and unrelated native item notifications skip knowledge database/UI refreshes. Metadata snapshots resolve folder placements in one joined query and load Trash summaries without the internal recovery graph. Trash rows carry their display type, and list filtering normalizes search terms once per refresh. Permanent deletion checks active ownership, recovery rights, incoming literature references and shared artifact ownership before deleting data. Library deletion reads member versions and sharing state together while preserving recovery and audit records. The [native timing audit](performance-measurements.md) records measured gains, limitations and five withdrawn candidates. The earlier [performance and redundancy review](performance-review.md) retains the implementation and correctness-verification history.

Multi-item drags can add literature to knowledge locations, copy between knowledge locations, or copy original item identities into Zotero collections. Fully duplicate copy drops are refused and mixed batches are deduplicated; copies retain their source memberships. Native target copying and permissions are handled by Zotero. Drag knowledge items or folders onto **Trash** in the left tree or its open middle pane to delete them recoverably. Item drops remove all placements in the dragged source knowledge libraries while preserving other libraries. Folder drops retain their literature in the knowledge library, support multi-selection and deduplicate selected parent/child subtrees; a folder batch succeeds or rolls back together. The folder context menu retains its confirmed subtree-delete action. Zotero originals and attachments are preserved.

Creating a knowledge library/folder reveals and selects the new node, expanding its ancestors. Disclosure arrows render after the native component commits its callbacks, including initial window loading and addon reload, without requiring a click or row movement. Refresh preserves native folder multi-selection, focus and the keyboard range-selection anchor. Arrows and keyboard callbacks share the same expansion state; collapsing an ancestor retains visible selections and selects that ancestor if all selected descendants become hidden. Duplicate names produce a readable prompt instead of a database exception. Expected validation prompts remain specific; unexpected failures hide SQL and parameters.

Knowledge folders and library roots support Ctrl/Shift multi-selection, with a deduplicated union in the item list. Ctrl+A selects visible siblings. Single-target actions such as creating a child folder, deleting a location or removing its item memberships require one selected location. **Add to Knowledge Base** item menus appear in Zotero literature views and are hidden in knowledge views, including combined views and Trash. Drag copies between knowledge locations and outgoing item copies remain available from the combined view.

The **M** button immediately follows the PDF reader's sidebar toggle. It opens rendered Markdown with a clickable heading directory on the left and keeps the native PDF on the right. The directory omits the first heading and all explicitly labeled document titles, including translated titles later in parsed papers, and starts the remaining section hierarchy at its outermost indentation; titles stay visible in the document body. Body text uses justified alignment with character spacing for CJK prose and automatic script-appropriate spacing elsewhere; all body paragraphs have a half-line trailing gap regardless of language. TeX equations, including those in OCR HTML table cells, render locally as native MathML. Text can be selected with the mouse. The native PDF-style right-click menu offers **Copy as text** and **Copy as Markdown** for the selected text only; both entries remain visible and disabled without a selection. Markdown retains the selected formatting, and clipboard failures provide localized retry feedback. The companion has no redundant title/status toolbar, import control or refresh control. A persistent gray divider has compact arrow buttons styled with Zotero toolbar colors. They align the target view on demand: right aligns the PDF to the visible Markdown source page, and left aligns Markdown to the current PDF page. Content without source page metadata disables the arrows; cross-page blocks align at their beginning. Reopen M to read the latest saved content, drag the divider, or click M again to return to the regular PDF view. See [Markdown reader usage and verification](markdown-reader.md).

Inline and display equations wider than the reading column scroll horizontally
within their own equation area, including long inline formulas in algorithm lists.
The article width and saved equation text remain unchanged.

The reader now uses canonical block types and persisted visual relationships.
Figure/table titles use their own compact centered styling and render TeX;
associated notes use a smaller collapsible panel, and abstracts have a separate
shaded section. Local backfill links existing titles/notes to their visual block
UUIDs using explicit provider structure or unambiguous nearby layout, without
rewriting document text or uploading PDFs. Ambiguous relationships stay unlinked.
MCP full block metadata exposes these generation-scoped links. See
[visual associations](parsing.md#visual-associations) and
[typed reader rendering](markdown-reader.md#typed-content).

PaddleOCR normalization treats keyword lists as standalone paragraph boundaries,
preventing an unpunctuated list at a page end from absorbing the next page's
introduction. The correction preserves raw results and source locations; existing
published content is rebuilt only explicitly. See [parsing behavior and verification](parsing.md).

PaddleOCR also rejoins unfinished body paragraphs interrupted by independent
notes, image/chart groups or tables, including their labeled captions and notes. A
sentence-ending stop remains a hard boundary. The merged paragraph stays
at its first fragment; visual blocks keep their relative order after it. Original
page/source coordinates remain available, and completed sentences, headings,
keywords, equations, empty tables and missing pages prevent merging. Page, image,
table and note interruptions compose in one reading-order scan, including mixed
groups; tables and notes remain independent blocks in storage and MCP reads.

Numbered PaddleOCR reference entries also rejoin unnumbered continuation blocks
on the same page, across consecutive pages and through image/table/note groups.
Unnumbered cross-page entries can join using incomplete-text evidence without an
original numeric label. New author/year openings and complete citations stay
separate; a retained terminal hyphen joins directly to the following word.
An explicit new reference number or a change to a body/heading label stops the
join. Author initials and journal periods do not stop reference continuation;
body prose keeps its sentence-stop policy. Raw text and source coordinates are
retained, and bounded MCP block/document reads use the resulting canonical entries.

Reader headings retain spacing before the following body text. Tables fill the
available reading width and scroll locally when their content cannot fit. Notes
use smaller text on a pale background and are collapsed by default; expand their
native disclosure to read the original content. Consecutive notes share one
disclosure with internal separators. Images are centered, and numbered references
use compact internal paragraphs with a uniform half-line gap between entries.

**Import Tasks** appears inside **My Knowledge Base**, at the same level as knowledge libraries and immediately before Trash. Its toolbar contains counted filters, search and a settings icon opening the plugin's native Zotero Settings pane. Resizable Title, Location and Processing Progress columns remember widths; completed rows show Completed without a page bar. Native item icons, expandable folders, Ctrl/Shift selection and context menus support retry, cancel and history deletion. Deleting terminal history retains parsed content; running tasks must be cancelled first. No development samples or reset controls ship. See [panel behavior](import-tasks.md).

**Collection synchronization** is configured through **Sync Settings…** on source or mapped destination folders. Choose Mirror sync (source-controlled, destination membership read-only), Flexible sync (independent local additions/removals) or Append sync (retain source removals). Local exclusions prevent deliberate knowledge-side removals from returning. Only the linked source root and its corresponding destination root display the transparent sync badge and Sync Settings entry. Descendant folders synchronize through their parent relationship. Existing links default to Flexible sync. No mode writes to the Zotero library. See [collection synchronization](collection-sync.md).

**PDF parsing** supports **PaddleOCR** (only **PaddleOCR-VL-1.6**) and **MinerU** (only `vlm`). A single parser selector in **Zotero Settings → Knowledge MCP** retains independent API/key/options configurations; the selector includes each fixed model in its label. Queue and limits are configured in a separate shared section. Task details show the persisted parser/model; processing-progress cells remain compact. Knowledge Base Information lists the parser/model of each attachment's published content. Settings are validated and atomically saved to `<Zotero data directory>/knowledgemcp/parsing.json`; valid edits reload every two seconds. New installations start disabled with empty keys. Knowledge admission queues PDF attachments; existing knowledge items also expose **Parse attachments**. Jobs survive restart, retain accepted provider identities, fence stale/cancelled results and publish structured generations with ordered sections/blocks and local artifacts. PaddleOCR's current normalizer applies versioned content-quality rules and restores empty image/chart blocks through exact page-local crop matching; compatible earlier task identities remain supported. PaddleOCR and MinerU are peer parsers under src/parsers/, each owning submission, download, validation, normalization and local images; a registry matches the task identity and the shared queue publishes the same structured contract. MinerU preserves source geometry, HTML tables, charts, notes, references and equations; legitimate empty OCR text/table placeholders remain in raw diagnostics without failing the document. Detached table notes remain reviewable structured blocks. Both parsers remove strongly repeated consecutive/alternating page-edge boilerplate before paragraph merging and section creation: independent headers within the top 15%, footers, and narrow side labels/download notices, including stable local runs that corroborate disconnected matches at the same position/cadence; global coverage requires 60%. Raw data, substantive sidebars and ordinary headings/body text remain protected. Existing published generations require explicit reprocessing to adopt the cleanup. Retrying a failed result download/publication reuses the accepted remote task when source/content versions still match. Both current parsers infer article-specific numbered heading conventions and publish matching levels and exact section parents; original provider levels remain the fallback and inferred changes remain reviewable. New content records its actual output-normalizer version independently of the accepted task identity. Continuous paragraphs can span more than two pages with all source locations retained, and Markdown/HTML images resolve through exact local references. The Markdown companion reads published content and local images alongside its separate manual-import cache, including safe HTML tables with merged cells. Vector ingestion, USearch persistence, full-text/semantic/fusion retrieval and Bailian reranking are implemented. All 16 local MCP tools are implemented; see the MCP setup and verification guide. See [vector configuration, search behavior and verification](vector-retrieval.md). See [configuration, recovery and verification](parsing.md).

**Continuous collection synchronization** mirrors a selected Zotero collection and descendants into a chosen knowledge location. Native notifications and startup/periodic reconciliation admit new items and PDFs and remove only membership origins owned by that binding. Manual and other binding memberships remain. Linked native folders show a sync overlay with a destination tooltip and context-menu entry; the task panel offers pause/resume. Stopping a link preserves imported items. See [synchronization ownership and recovery](collection-sync.md).

Sync overlays use horizontal arrows and follow native selection colors. Unavailable PDFs surface as sync attention while complete native membership scans still traverse descendants and prune removed origins. Clearing sync history hides finished records while active and future tasks remain visible. Failed child parses surface on the sync task with an explicit retry action; unchanged failed PDFs are not automatically reuploaded on every scan. Task history shows the latest matching attempt, and HTTP rejection messages include the status code.

The database schema is implemented through Kysely Migrator 0.29.7 with a native asynchronous Zotero SQLite adapter. Startup creates or upgrades `<Zotero data directory>/knowledgemcp/knowledge.sqlite`; shutdown closes it. Sixteen bundled migrations maintain 55 ordinary tables (including Kysely's two metadata tables) and one FTS5 virtual table, with indexes, constraints and triggers. Migration 0004 adds parent-cycle protection; 0005 promotes `publication_title`, `volume`, `issue` and `doi` from metadata JSON into nullable resource columns and backfills existing rows. Migration 0006 moves existing Trash recovery JSON into six dedicated entry/link tables with foreign keys, preserving recovery identities and original locations; new operations use these tables directly. Migrations 0007–0008 add sync modes, local item/folder exclusions, transaction-scoped purge authorization and durable file cleanup. Migration 0010 adds derived Unicode search offsets and an atomic index revision; existing projections rebuild locally without provider calls. Upgrades preserve historical migration checksums and take a validated pre-upgrade snapshot. The main connection uses NORMAL locking with WAL so external read-only viewers can inspect it while Zotero runs. A separate `knowledge.sqlite.owner.sqlite` lock and an in-process registry prevent duplicate plugin writers through initialization, migration and normal use. See [database runtime, usage and verification](database-runtime.md).

Ordinary Zotero logout preserves local literature and knowledge data. Confirming a Zotero account switch or removal of local account data resets the data directory, including the plugin database and its local upgrade snapshots; the plugin then starts with an empty knowledge database. See [account and data-directory lifecycle](knowledge-membership-metadata.md#zotero-account-and-data-directory-lifecycle).

Shutdown rejects new Markdown cache saves and waits for accepted writes before allowing a restart, preventing an old import from outliving its application instance. Failed saves still reject to their callers and do not prevent cleanup. VM regressions and developer-driven native Zotero 10.0.6 checks cover the shutdown behavior; native checks also cover the migration upgrade and bulk cycle rejection. The runtime documents distinguish these checks from manual UI verification.

Database close calls share an in-flight operation and retain successful completion. A failed main/owner close can be retried while ownership remains reserved and new database work stays rejected. The application retains its database handle until cleanup succeeds; a later plugin bundle can retry a recorded failed cleanup before opening the same path, without displacing an active owner.

Owner cleanup is registered before acquisition SQL starts, so even an acquisition failure followed by a close failure retains its retry path. Initialization reports both failures and leaves the path reserved until cleanup succeeds.

| Delivery step | Current status |
| --- | --- |
| Database design | Implemented through migration 0016: 56 typed tables, including Kysely metadata and FTS5; current snapshots, types and field dictionary agree. |
| Database foundation | Initialization, transactions, upgrade snapshots, metadata/membership, durable task recovery, Trash restore and immutable document-edit publication are implemented. Complete external backup/restore tooling remains pending. |
| Item processing pipeline | Metadata admission, durable PDF parsing, structured publication and profile-bound vector ingestion are implemented. Manual Markdown import retains a separate JSON cache. |
| Internal structured reading/retrieval | Attachment-specific Markdown reading/editing, document search, scoped full-text/semantic/fusion search, persistent USearch and Bailian reranking are implemented. MCP provides bounded document/section/block reads; approximately 1,000-paper end-to-end acceptance remains pending. |
| MCP and connections | All 16 local SSE tools and scoped personal-token administration are implemented. Public HTTPS and tunnel connectivity are deferred. |

Background embedding checks current content and active knowledge membership before HTTP dispatch, including rate-queued requests and retries, and again when committing vectors. Removing the last active membership pauses pending work; restoring membership reuses committed vectors. Search validates evidence generations, memberships and coverage in one final local transaction, omitting candidates whose ranking used replaced content. Deleted workflow history remains hidden across reconciliation and restart while retaining deduplication and cancellation state; explicit vectorization can create visible work again. See [retrieval integrity and history](vector-retrieval.md#membership-content-and-history-integrity).

### Implementation Direction

The runtime is a pure Zotero plugin, with local persistence and API-based parsing and embedding. Local MCP uses Streamable HTTP with SSE responses. Listener-lived client identities isolate request IDs and cancellation for clients sharing a token; there is no persisted session or legacy HTTP+SSE endpoint. Bounded readers fetch SQL substrings after block headers, and search snippets preserve the actual hit before adding context. See [the MCP contract](mcp.md).

The current parsing scope uploads Zotero PDF attachments through either PaddleOCR multipart jobs or MinerU v4 signed-upload allocation, binary PUT and batch polling. Each parser retains an independent compatible endpoint, token and options; models are fixed to `PaddleOCR-VL-1.6` and `vlm` and appear in the single parser selector. Direct import of user-generated parsing results is deferred. Custom services must implement the selected parser's documented protocol and result format or receive a separate adapter; arbitrary endpoints are not implicitly compatible.

Parsing/model requests, timers and vector workers use the process-lived Gecko runtime and remain independent of an open main window. Regression coverage includes the bootstrap sandbox and setup failures before task claims; see [parsing verification](parsing.md#verification) and [window-independent vector recovery](mcp-vector-initialization-audit.md).

Connection targets are same-machine HTTP, direct public-IP HTTPS, and account-based remote access through existing account and relay services when no public IP is available. Remote accounts, relay connectivity, and future opt-in content synchronization are separate capabilities. Zotero must remain running for access to local content. The first usable version will be benchmarked with approximately 1,000 papers; this is a validation target, not a hard size limit or demonstrated capacity.

See the [migration assessment](migration-assessment.md) for the runtime constraints, local data ownership, authorization boundaries and remaining acceptance gates. Local vector-search measurements are recorded in the [acceptance report](vector-retrieval-acceptance.md); plugin-hosted TLS and remote connection modes remain unverified and unavailable.

The [migration plan](migration-plan.md) maps the five delivery areas, remaining implementation work and acceptance gates. Local processing, retrieval, document editing and authorized MCP client access are implemented. MCP dispatch, bounded content formatting, search snapshots and transactional writes have separate modules under `src/mcp/tools/`; the split preserves existing contracts and is a maintainability change, not a measured runtime speedup. The 100,000-vector index benchmark does not establish approximately 1,000-paper end-to-end acceptance or independent human relevance quality.

The accepted implementation order is database design, database foundation, the item processing pipeline, internal reading/retrieval, and finally MCP. Step 1 is recorded in the [database design](database-design.md), with SQL review fixtures and a [complete field dictionary](database-field-dictionary.md). Step 2 includes schema initialization, migrations, transactions, pre-upgrade snapshots and the metadata/membership repository. Subsequent delivery implements durable parse scheduling/recovery, structured publication, generation-backed attachment reading/editing, vector ingestion and internal retrieval. Broader editing parity and complete backup/restore tooling remain pending; local MCP discovery, reading and annotation/summary writes are implemented. The [vector acceptance report](vector-retrieval-acceptance.md) separates Node, native Zotero, real model calls and measured performance.

The [source architecture](src-architecture.md) defines `schemas`, `services`, `repositories`, shared code and three worker families. Zotero-native UI, MCP tools, authorization and connection adapters share those services. The reader, database/migrations, knowledge membership, native settings, one-way collection synchronization, durable parse worker, vector worker and internal retrieval are implemented. Unimplemented directories retain boundary/status READMEs. Local SSE-only MCP transport and personal-token authorization are implemented; HTTPS and relay adapters remain planned.

The [native database concurrency comparison](database-concurrency-performance.md)
measures the earlier application baseline's FIFO connection against four/eight read-only connections
and one writer, including actual MCP read handlers and small concurrent writes.
It records throughput, latency, variability and event-loop scheduling costs;
the connection-pool experiment is not enabled in the production plugin.
The implemented [MCP read optimizations](mcp-read-performance.md)
use correlated authorization checks, projection-aware batches, SQL resource
pagination and transactional library revisions. Migrations 0015–0016 preserve
permission/content invalidation while replacing whole-library consistency scans.
MCP admits up to 16 active requests per token and 64 globally, with a 128-request
pending HTTP guard. Execution overflow returns 429; pending overflow returns 503.

### Project Identity and Compatibility

| Setting | Value |
| --- | --- |
| Display name | `Zotero Knowledge MCP` |
| Package name | `zotero-knowledge-mcp` |
| Plugin ID | `zotero-knowledge-mcp@local.dev` |
| Namespace | `knowledgemcp` |
| Preferences prefix | `extensions.zotero.knowledgemcp` |
| Runtime global | `ZoteroKnowledgeMCP` |

Authorized AI clients use the plugin's knowledge base through MCP. The manifest currently targets Zotero `10.0` through `10.0.*`; broader compatibility requires separate validation.
