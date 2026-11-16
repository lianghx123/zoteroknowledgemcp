# Import Tasks

The **Import Tasks** entry is a child of My Knowledge Base, at the same level as knowledge libraries and immediately before Trash. It follows overview expansion and collapse. Selecting it replaces the middle list and right detail surface; selecting a library or folder restores the native surfaces.

The runtime panel consumes the shared persistent parsing service and starts empty when no jobs exist. Development sample records and the Reset Samples control have been removed. Synthetic records remain only in test fixtures and are not included in the plugin bundle. See [parsing configuration and recovery](parsing.md).

The document workflow has three user-facing groups: **Add to knowledge base →
Extract document content → Prepare semantic search**. Parse and vector jobs remain
separate durable records, joined for display by source attachment and published
generation. The row retains its parse identity, folder, original parser and model;
parser, model, embedding provider, dimensions and segment counts appear in the
native **Processing details** section rather than as primary progress information.
Current-profile vector work takes precedence over retained profiles, and obsolete
generations do not create extra vector rows. Semantic preparation without a job is
described using the actual configuration: disabled, on demand, automatic waiting,
or paused. Content-only completion does not leave optional steps permanently
pending. An existing paused job remains paused regardless of automatic settings.
Hidden parse history is not recreated; new vector work without a
visible parse record uses one stable unified workflow row.

All three groups and their substeps stay expanded inside the progress section,
with consistent markers and indentation. There are no phase disclosure controls
or repeated per-phase Completed labels. A successful requested workflow ends
with one compact checked Completed line, without the former reading/search-ready
sentence. Admission has a checked **Save item and attachment information** substep.
Task information, processing progress and processing details are separate native
right-pane sections beneath a standalone read-only native title. All three sections
can collapse and retain their native open state through task updates. Their headings
and sidebar shortcuts use the plugin logo. Semantic preparation uses the
concrete substeps **Generate semantic vectors**
and **Build search index**, highlights the current substep, and uses a compact
status under the group title without repeating the action below the checklist.
Section padding belongs to an inner body inside the native clipped child. This
lets native collapse remove the full padded content height and keeps closed
header geometry identical to native sections, including their transitions.
Extraction includes preparing/sending the PDF, waiting for the parsing
service, extracting pages, retrieving results, organizing/checking content and
atomic publication. Current action labels distinguish local capacity waits from
remote service queues and remote document preparation. Waiting durations and the
last progress observation are shown when supported by recorded timestamps; old
checkpoints do not invent remote waiting times.

Page counts describe the parser's aggregate extraction progress. A known positive
total enables a page percentage; count-only responses display the count without
a bar. Missing counts leave the current action visible. Reaching 100% parsing
does not finish extraction: retrieval, organization and saving still follow. No
overall equal-weight percentage, queue rank, ETA, individual page identity, or
save percentage is inferred. Content availability is announced only after
publication commits; semantic completion additionally requires local indexing.
Partial extraction remains identified when subsequent semantic work completes.

The progress contract uses existing task checkpoint JSON; no SQL migration or
database connection change is required. Main-item knowledge-information rendering
and its refresh behavior are outside this change.

Retry, pause/resume and cancel in a vector stage target that job, without submitting
the PDF again. Completed workflows can reparse through the original parse task.
Batch retries dispatch each affected phase. Terminal history deletion hides both
displayed phases and all retained vector attempts/profiles for that attachment
generation. Durable jobs keep their deduplication and cancellation state, so
automatic reconciliation and restart do not recreate deleted history or retry
hidden failures. Explicit vectorization can create visible work again; existing
paused work keeps its pause. Published content and vectors remain available.
Removing the last active knowledge membership leaves pending vector work paused;
restoration resumes missing batches and retains vectors already committed.
Clearing synchronization history hides terminal parser and vector records in one
transaction and refreshes both task projections. Visible pending, running and
paused vector workflows keep their original parse row and folder grouping; when
they finish afterward, they remain visible until a later clear. Hidden or
superseded vector attempts do not resurrect completed history. Cleanup preserves
published content, vectors, deduplication and cancellation markers, and does not
hide unrelated batches or future work.
Partial parsing warnings remain separate from vector errors. See [vector behavior
and verification](vector-retrieval.md).

## Interaction

- One compact toolbar contains counted status filters, search and a settings icon opening Zotero Settings → Knowledge MCP. Sticky Title, Location and Processing Progress headings follow. A short status line reports disabled or invalid configuration. Previous four-column widths migrate by merging the last two widths.
- Drag a column divider or use its Left/Right arrow keys to change adjacent widths. Completed changes are saved in `extensions.zotero.knowledgemcp.importTaskColumns` and survive filters and addon reload. A cancelled drag, view switch or disposal restores the previous widths and releases document/window listeners.
- Filter all, active imports, syncing, needs-attention or completed operations. Needs-attention includes failed, partial and blocked tasks; delayed retries remain active. Counts apply to top-level operations; children do not count twice. The navigation count includes active imports and running synchronization bindings.
- Locations include the knowledge library and every ancestor folder, using ` › ` separators. Item and batch rows, tooltips and details resolve current memberships, so previously abbreviated task history and renamed ancestors display correctly without resubmitting PDFs.
- Search titles, source filenames or collection names, and destinations. Select a row to inspect its details. Ctrl/Command toggles selection, Shift selects a range, and Ctrl/Command+A selects visible rows. Right-click preserves an existing multiple selection; Shift+F10 also opens the native context menu.
- Item rows use native bibliographic-type icons. Folder rows use native collection icons and expand to show child progress. Up/Down moves between titles; Right expands a folder, Left collapses it or selects a child's parent. Collapsing a selected child's folder selects the parent.
- The table and rows participate in Zotero's native icon focus-state styling. Focused selected folders use the white native collection icon; unfocused and unselected folders use the current theme's normal icon.
- Folder imports derive aggregate status from their children. Active children take precedence over terminal states, and queued or publishing children retain their respective stage when all active children share it.
- Synchronization details show the source folder, destination, last-scan added/removed counts and connected pause/resume controls. See [the synchronization contract](collection-sync.md).
- Page counts and progress bars appear during page parsing when the source supplies counts; publication has its own action without reusing a page percentage. Completed rows show Completed. Other rows show status without a fabricated percentage.
- Item details list the persisted parser and model, and search matches them. Processing-progress cells show only stage/status and available page progress. Accepted work keeps its original parser even after settings change. Queued task details display the planned parser until the worker updates its unsubmitted identity before uploading. Knowledge Base Information shows each attachment's active published parser/model, independently of task history and current settings.
- Context actions support retry, cancel, ambiguous-submission recovery and deletion of terminal import history. Running tasks must be cancelled before deleting their history. Folder actions cover children once, even if the folder and children are selected together. Published generations and parser provenance remain stored when history is hidden. Deleting a sync task's displayed record keeps its link active; stop synchronization explicitly from the source folder's context menu.

## Task Source Boundary

`src/shared/contracts/import-tasks.ts` defines the presentation shape and `ImportTaskSource`; the former UI model module re-exports it. `src/ui/knowledge/import-tasks.ts` owns the per-window view and lifecycle adapter. The application combines `ParsingService` and `CollectionSyncService` through `ImportTasksService`, shared by all windows. Tests can omit or inject a source independently.

The task service supplies authoritative snapshots through `snapshot()` and notifies the view through `subscribe()`. The returned unsubscribe function is called on disposal. Source refresh preserves search focus and cursor, row/filter focus and list scroll; refresh during a column drag waits until the drag ends.

Optional `runAction(taskID, action, value)` delegates commands without mutating task snapshots. The view suppresses duplicate pending actions, displays localized failures and ignores late completions after disposal. The parsing service implements cancel, retry/reparse, history deletion and linking an ambiguous submission to an existing remote job ID. The sync service handles pause/resume and hiding sync history. No source means no actions. Durable state, recovery and cancellation semantics belong to the services.

The supported import direction is native Zotero PDFs processed by a registered parser (currently PaddleOCR or MinerU), followed by local structured publication. Each parser owns its complete protocol and normalization; the shared queue owns scheduling, fencing and publication. Retrying a failed result download/publication reuses the accepted remote job if attachment/source/content versions still match, instead of uploading the same PDF again. A newer generation or changed attachment rejects that recovery. Direct parse-result import remains deferred. See [parsing](parsing.md) for publication and recovery contracts.

The middle list remains a temporary overlay; native list children retain their
layout but are hidden and inert while it is active. The right side instead adds a
task container to Zotero's existing item-pane deck, based on its native container
base and `collapsible-section` widgets. It shares the original sidenav, splitter,
collapse control, section shortcuts, pinning and reorder interactions. Native
section order includes retained hidden buttons, so the task container projects
the resulting sidebar order instead of treating its raw index as a task index.
Collapsed section shortcuts resume their target scroll after native expansion.
Tab from the scroll area honors the pinned section; Escape returns to the task
list. A generic per-window custom-element registration has no service ownership;
each addon instance releases its nodes, callbacks and collapse observer.

Leaving tasks restores the previous deck panel and sidenav container, preserves
native collapse/width behavior and releases the middle list's inert state.
Disposal removes owned styles, nodes and method adapters; partial construction
uses the same cleanup. Main-item details registration is unchanged. The task
navigation row returns no native items, has no knowledge-library target and
rejects membership drops through the existing target checks.

## Refresh ownership

Task notifications do not imply literature changes. Identical task/notice snapshots retain their DOM; changed snapshots render only while the task page is visible. Active-count changes refresh the left navigation label without reloading the middle literature list. Actual knowledge snapshot changes keep the separate content refresh route. Native and automated checks are documented in [idle refresh verification](idle-refresh.md).
