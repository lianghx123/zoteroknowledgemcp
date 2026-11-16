# Markdown Companion Reader

Implemented: 2026-10-19. Target verified in development: Zotero 10.0.6 / Gecko 140 on Windows.

## Use

1. Open a PDF attachment in Zotero's reader.
2. Click **M**, immediately to the right of the native sidebar toggle. Rendered Markdown opens on the left and the existing PDF stays on the right.
3. The companion reads the attachment's saved parsed content. There are no import or refresh controls in the pane or Contents.
4. Use **Contents** to navigate sections. The first document heading stays in the body and is omitted from Contents. Parsed content also omits every heading explicitly labeled `doc_title`, including translated or repeated titles later in the paper; genuine level-one section headings remain eligible. The shallowest remaining heading level starts at the directory's outermost indentation, while relative subsection levels and navigation targets are preserved. A document with no remaining headings shows the localized empty-contents message. Contents is shown or hidden with the floating bar's directory icon; the directory heading has no separate disclosure control. In a narrow pane the directory moves above the text. This display rule applies to saved parsed content and imported Markdown without changing their stored headings.
5. Drag the separator to change the split, or focus it and use the left/right arrow keys. The supported range is 25–75% of the available reading width.
6. Use **M** to hide or reopen the companion; pending block edits remain in memory. Click **M** to restore the regular PDF layout. A compact floating reading bar stays centered above the companion, with an icon-only Contents toggle (localized tooltip and accessible label), smaller/default/larger text controls and Back to top. Text size ranges from 12 to 23 px (15 px default) and applies only to Markdown body text; tables, notes and code retain their dedicated sizes. Markdown visibility, split ratio, directory visibility/depth and text size are saved as profile-wide reading preferences and restored for newly opened PDFs and after plugin reload or application restart. The bar overlays the reading surface without a separate toolbar row. A display-only spacer follows the floating bar height to protect the initial title and scrolls away with the text; the directory and reading viewport keep their original top positions. Stored Markdown is unchanged. The native PDF toolbar remains unchanged. Loading status remains available to assistive technology, errors appear in the content area, and partial-result warnings remain visible below the content.
7. Notes use a smaller font on a pale neutral background and start collapsed.
   Activate the **Note** disclosure to expand or collapse their content.
8. Drag with the left mouse button to select text in the companion or citation
   preview. In the companion body, right-click for **Copy as text** and
   **Copy as Markdown**. Both entries stay visible and disabled without selected
   document text. The menu uses native XUL elements in the PDF reader's own
   popup host, with the same default styling and keyboard navigation. There are no
   copy buttons above the content. Only the selection is copied; Markdown retains
   selected headings, emphasis, links, lists, tables, code and equations. Image
   files and hidden, unselected notes are not added to the clipboard.
9. Use the two arrows in the middle of the divider to align reading positions.
   **Right (→)** moves the PDF to the physical source page of the Markdown at the
   top of the reading viewport. **Left (←)** moves Markdown to the first content
   associated with the current PDF page. Only the target view moves; native PDF
   zoom and scroll mode stay unchanged. The rest of the separator remains draggable.

### Block editing and document save

Use the floating pencil to enable block selection, then click a text block, or
right-click a block and choose **Edit this block**. Only blocks with unambiguous
canonical source mappings are eligible. Ambiguous multi-block display groups and
legacy imported Markdown are excluded. The type selector orders headings,
abstracts and paragraphs first, followed by lists and code, tables/images/captions,
formulas/formula numbers, then notes and references; legacy text/equation aliases retain their original
source until converted. Normal selection, dragging and interactive
links/disclosures retain their reading behavior.
The type selector uses a compact themed popup with subtle group separators and
a right-aligned checkmark. The trigger and popup share a width measured from the
localized options, with a compact 104 px minimum and a 180 px cap. It opens above the trigger near the viewport bottom,
caps its height within the viewport and scrolls internally. Arrow keys, Home/End,
Enter/Space and Escape support selection and dismissal; outside focus/click,
document scrolling, resize and editor disposal close the popup. Existing type
labels provide the localized trigger and menu accessibility names.

The inline card loads the block's original Markdown, never reconstructed HTML.
A compact top row contains the Markdown/preview tabs, type selector and discard,
apply-block, insert-below, delete and expand actions. There is no visible block/page heading or bottom status area;
the save boundary remains in the apply-block tooltip and accessible
description. Switch between Markdown and a sanitized preview without another horizontal
split. **Expand** uses the Markdown pane while preserving the PDF alongside it.
Dragging the source textarea's resize handle saves a maximum height as a shared
reading preference. Source and preview fit their content, with a compact 64 px
minimum; long content scrolls at the saved limit or 60% of the window height,
whichever is smaller. Typing, deleting and changes to the reading width refit the
source without changing the preference. Short blocks do not fill the saved maximum.
The textarea observer's options are cloned into the reader window's realm.
Gecko cannot read a plugin-sandbox options dictionary through Xray wrappers;
passing it directly prevents the editor from opening. A regression simulation
checks the receiving realm, and installed-XPI native checks use trusted Gecko
clicks through the toolbar and document body to verify opening, typing, applying,
undoing, reopening and discarding. Source-helper checks alone do not exercise
this installed-plugin boundary.
Opening an editor reveals only the Markdown viewport, with clearance for the
floating toolbar. It does not use ancestor-scrolling `scrollIntoView`, which
can displace the whole native reader when the final block cannot align at the
top. Editor focus uses reader-realm `preventScroll` options so opening, switching
tabs and returning from an edit do not scroll the outer PDF reader.
Each editor also establishes its own positioning context. Its visually hidden
status messages must stay inside the card; otherwise their absolute static
positions escape the Markdown scroller and create a document-height scrollbar
on the native reader. Native layout checks must compare root scroll height with
viewport height and attempt to scroll the root, not only check whether opening
the editor immediately changes the scroll position.
The maximum persists across blocks and newly opened PDFs. Expanded-mode geometry
does not replace it. Parsed `formula` blocks and legacy
`equation` blocks open their original delimited TeX, while inline formulas open
the containing text block. Formula previews use the same sanitized math renderer.
Typing and type changes keep an in-memory draft. Switching blocks or Escape
retains the pending draft. **Apply block** or Ctrl/Cmd+Enter applies it to a local
working copy and refreshes rendered content, Contents, source anchors and text
search. **Discard** removes pending changes to the selected block. Type changes
convert the old type's outer heading, formula, code or list syntax while
preserving text; table/image content still requires valid Markdown or existing
asset keys. The preview uses the selected type's normal structured renderer.

Use **Insert block below** in the editor or context menu to insert an empty block
immediately after the selected canonical block and focus its source. New blocks
receive session-only identities and no inferred PDF page. Discarding an untouched
new block removes it. **Delete this content** opens an inline confirmation; cancellation keeps
the current draft. Deleting the final block leaves an **Add first block** action.
Unambiguous existing table/image/reference blocks can also be edited as Markdown.
Mutated blocks invalidate their local visual/reference projections. Session
copies have no published generation identity, so semantic search cannot use old
vectors; text search scans the current preview and fusion reports its local
fallback. MCP/database reads continue to return the published original content.

Edits remain in memory until **Save document** (the disk icon, or Ctrl/Cmd+S within
the companion). The floating bar also has undo/redo. Outside text controls,
Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y use block history; a focused textarea keeps
native typing undo. Document undo checkpoints pending drafts before reversing
the latest block operation. Applying a new change clears redo. History stores
block before/after deltas, limited to 200 operations and 8 MiB of UTF-8 payload
estimates, rather than full-document snapshots. This budget is not actual heap
usage. Oldest steps are discarded when necessary. Cancelling a blank insertion
removes its temporary history step. Returning to the original state restores
the original generation/projections. Hiding Markdown retains runtime work;
closing its PDF reader or reloading/restarting the plugin discards unsaved work.

Saving checkpoints pending drafts, requires a nonempty document with no blank
blocks, and freezes mutations while the accepted write runs. The repository
rechecks attachment mapping, active library/resource/source and expected content
and source versions inside a transaction. Conflict or failure preserves drafts
and history. Success resets the baseline and refreshes clean views of the same
attachment; dirty views retain their work and normal version-conflict checks.

Publication creates an immutable `origin=edit` generation with its predecessor,
new block identities and `supersedes_block_id`, rebuilt ordered section nodes,
and a revision/outbox event. Full-text rows are indexed in the same transaction.
Original parse content stays intact. Image asset links are shared; original
parser output files stay with their historical generation. Existing valid visual
associations and unchanged references are remapped, while affected bibliography
entries are regenerated. New blocks gain no invented PDF coordinates or visual
associations. Exact unchanged-block annotations follow their successors; changed
or deleted block anchors and old section anchors become historical without
rewriting note text. The existing manual-edit guard prevents automatic reparse
from replacing published edits.

Unchanged blocks reuse matching profile-bound vectors and segments. Modified
blocks receive no stale vectors; retired-generation embedding jobs are fenced.
After commit, a local refresh prepares missing segments and synchronizes the
vector store. Further embedding follows the normal background path and
automatic-embedding configuration. Until vectors are available, semantic search
reports a partial index. Save itself makes no model call.
Published edits are visible to existing knowledge/MCP readers; runtime drafts
are not. No schema migration is required.

The floating bar's Back to top button uses a fixed-size SVG arrow centered on
both axes, avoiding font-dependent glyph alignment. Its localized tooltip and
accessible label remain on the button.

The separator is a persistent 8 px neutral-gray bar that darkens on hover or drag.
The centered arrow group uses Zotero's toolbar background, secondary icon color
and divider border variables, with compact 28 px buttons and a subtle shadow.
Keyboard focus has a neutral outline. The Markdown body reserves space beside
the separator so its scrollbar remains accessible. Colors follow the reader's
theme instead of using a fixed dark pill or blue hover strip.

## Search Within the Displayed PDF

Use the floating bar's search icon, or Ctrl/Cmd+F while focus is inside Markdown.
The PDF reader keeps its own search behavior when focus is outside the companion.
The search sidebar temporarily replaces Contents, with a current-mode dropdown
in the header, an input/search-icon button and independently scrolling result
cards. The header menu switches between all four translated modes. Idle scope
and Enter-instruction lines are omitted; Enter still submits the query.
The current mode serves as the header label. Each mode name includes Search
(Text search, Semantic search, Enhanced search and Fusion search). The compact popup supports checked
items, arrow/Home/End navigation, Escape focus restoration and outside dismissal.
The input's submit button uses the same search SVG as the floating toolbar.
In a narrow companion it stacks above the document. Closing search restores the
previous directory visibility and depth; the current section can then be revealed
by the existing outline tracker. No native PDF toolbar changes are required.

| Mode | Passage retrieval |
| --- | --- |
| Text | Case/accent-normalized literal terms in the currently rendered Markdown, all whitespace-separated terms required, in reading order; no embedding/index requirement |
| Semantic | Query embedding and current-generation vector candidates, ranked within the attachment |
| Enhanced semantic | Semantic candidates followed by paragraph-level reranking |
| Fusion | Current-generation FTS and vector passage rankings combined by block ID using reciprocal rank fusion, followed by paragraph reranking |

Model-backed modes reuse Settings' current embedding space, relevance threshold,
index and reranking provider. They can contact the configured providers; changing
modes or typing does not submit a query. Enter or the search button submits it.
The search mode is remembered separately from the knowledge-list search mode;
queries, result history and search-panel visibility are not persisted. Text mode
also supports the separate manual Markdown cache. An unindexed manual view cannot
use semantic/enhanced search; fusion explicitly reports its text-only fallback.

Results show an excerpt, available section path and physical page. Scores are not
shown. Snippets use text nodes and literal query highlighting, never provider
HTML. Selecting a result reveals collapsed notes, scrolls to its source block and
briefly accents it without rewriting the document or copied Markdown. Missing
page provenance is omitted. Search displays at most 50 result cards; the label
states when the result limit is reached. Model retrieval considers at most 200
candidate passages, bounded by the configured candidate budget. A one-candidate
budget also limits paragraph reranking to one input.

`AttachmentMarkdown.generationID` and renderer-owned source-block attributes
bind model results to the exact displayed generation, including merged abstract,
reference, caption and note groups. `RetrievalService.searchReader` resolves the
native attachment mapping and validates current source versions, active library
membership and the model configuration before provider dispatch and again after
asynchronous work. The generation filter applies inside FTS and vector candidate
selection, before limits and passage ranking, rather than discarding other PDFs
from an already truncated parent-document result. Query embedding caches remain
bound to the existing embedding space. Reranking receives candidate passages,
not one aggregate hit for the parent paper.

Unavailable or partial indexes, provider/reranker failures and changed content
have explicit translated feedback. Fusion can use a remaining channel, with a
visible incomplete-results notice. Enhanced search can return semantic ordering
when reranking fails, with the same notice. Semantic scores and successful rerank
scores respect the current relevance threshold. A replaced generation requires
closing and reopening Markdown; stale or unmappable results never navigate an
unrelated block or attachment.

New queries, mode changes, content reload, closing and disposal abort pending
requests. A sequence fence rejects late responses even if a provider ignores
cancellation. Removed result buttons cannot activate stale targets. Reader
cleanup clears highlights, timers, block maps and listeners, and application
shutdown drains accepted search work before closing the knowledge database.
All new controls, status/errors and accessibility labels are translated in the
seven supported Fluent catalogs.

## Current Section in Contents

The directory highlights the last section heading that has reached the reading
line, with `aria-current="location"`, a neutral background and an accent edge.
Its ancestor headings are emphasized. The document-title area has no section
marker; reaching the document end selects the final visible heading even when
that short section cannot reach the reading line. Hidden/collapsed-note headings
are excluded, and disclosure changes refresh the eligible headings.

`src/ui/reader-outline.ts` binds existing headings and buttons once. A passive
scroll listener coalesces work to one animation frame and uses a binary search
of live heading geometry, supporting large forward/reverse scrollbar jumps.
Intersection and resize observers, image loads and note toggles refresh layout
changes. The reading line and heading jump margin clear the floating menu.
Only section changes update active/ancestor styles. An offscreen current item
scrolls its directory container locally; it never scrolls or focuses the body.
An unchanged current item does not fight manual directory scrolling. Restoring
the directory explicitly reveals its current item. Close, reload and disposal
cancel queued work and disconnect all observers/listeners.

Native timing used 690 × 600 px article viewports, 40 headings/400 paragraphs
(140,800 characters) and 300 headings/3,000 paragraphs (1,056,000 characters).
Each fixture had four warmup runs followed by six samples per condition in
alternating order, with 40 scripted positions per sample. The baseline omits
the tracker; the feature condition includes its observers, highlighting and
directory scrolling. The fixture uses controlled 16 ms timer scheduling in an
offscreen frame, so these measurements exclude compositor/physical scrolling
and do not establish a manual-scroll frame rate or a speedup.

| Fixture | Baseline elapsed, mean ± SD | Feature elapsed, mean ± SD | Update mean ± SD across runs | Largest update |
| --- | --- | --- | --- | --- |
| 40 headings | 1,231.36 ± 40.95 ms | 1,210.90 ± 1.55 ms | 0.200 ± 0.023 ms | 0.590 ms |
| 300 headings | 1,210.74 ± 2.34 ms | 1,210.24 ± 2.73 ms | 0.593 ± 0.033 ms | 1.562 ms |

No computer-use helper was running before timing. Native accessibility was
inactive with an empty activation source; the existing
`accessibility.force_disabled=1` setting was recorded and left unchanged.
Full samples, variability and methodology are in the ignored `performance.json`;
an additional 1,590 px-wide fixture run is in `performance-wide.json`.

## Directory Depth Menu

The directory header has a compact themed menu button beside Contents. It lists the
structural depths actually present, plus All levels. The outermost heading is
level 1; skipped Markdown heading numbers do not create empty levels. A document
with fewer than two structural levels disables the button. With no headings,
the disabled button shows All levels. The default is All levels.

Filtering changes only directory button visibility, never the document text or
its heading/source anchors. The tracker still follows all document headings and
maps a filtered-out current subsection to its nearest shown ancestor. Selecting
All levels restores the actual current subsection. Selection persists across
PDFs in `contentsDepth`; a shallower document displays the available depth
without overwriting a deeper saved preference. Labels and accessibility text
are translated in all seven catalogs.

The styled menu uses a subtle trigger background, rounded popup, light shadow,
right-aligned checkmark and a separated All levels entry. Popup width follows
the localized labels instead of reserving a fixed minimum, with compact label/
checkmark spacing. It is rendered outside
the scrolling directory and clamped to the reader viewport. Arrow keys and
Home/End move between radio-menu items; Enter/Space activate native buttons;
Escape restores trigger focus. Outside pointer/focus, scrolling, resizing,
directory hiding and reader closure dismiss the popup. Disposal removes the
popup and document/window listeners. Labels reuse all seven localized catalogs.

## Saved Reading Preferences

`src/ui/reader-preferences.ts` owns the versioned JSON preference
`extensions.zotero.knowledgemcp.readerPreferences`, stored through Zotero's native
preferences API. Version 1 contains `open`, `ratio`, `contentsVisible`, `contentsDepth`,
`fontSize` and `editorMaxHeight`. The nullable `editorMaxHeight` defaults to the
viewport limit and accepts 64–2400 CSS pixels. Earlier `editorHeight` values are
read as maximum heights when the new field is absent. New preference writes use
the new field. Source and preview remain content-sized below the maximum.
Native textarea style changes are debounced, flushed on pointer release or editor
closure, and observed only while an editor is mounted. Programmatic fitting,
width/viewport changes and expansion never save a new maximum. The additive `contentsDepth` field defaults to 0 (all levels), so
previously saved version-1 preferences remain compatible. New views inherit the most recently chosen settings; existing views
keep their current layout. Changes update only their own fields against the
latest saved value, so older windows cannot overwrite unrelated preferences.
Keyboard resize saves immediately; pointer resize saves when the gesture ends,
including interrupted gestures during view cleanup. Restoring or disposing a
view does not save its closed/default state over the user's preferences.

Missing, malformed, unsupported-version or individually invalid values use safe
defaults (closed, 50% split, visible directory with all levels and 15 px text). Preference errors
do not prevent reading. Add future shared display settings to this typed module
and its validation; attachment-specific scroll positions should use a separate
per-document record. Scroll position, note expansion, PDF zoom and PDF reading
position are not included in this preference.

## Reading Position Alignment

Alignment uses persisted parser page provenance, including captions, abstracts,
tables, notes, equations, code and reference entries. It does not compare the
two scrollbars' percentage positions, rewrite Markdown, migrate data or request
parsing. Source page ranges are added only to rendered DOM nodes. Typed content
with an invalid projection falls back to unmapped Markdown; imported Markdown
without reliable page provenance keeps disabled arrows with localized tooltips.

This is physical-page alignment, not character-level SyncTeX or continuous scroll
coupling. When a paragraph or reference spans pages, alignment may land at the
beginning of that block. A PDF page without corresponding extracted content
reports an unavailable match instead of selecting a different page. A target
inside a collapsed note expands that note. Missing native navigation APIs and
failed navigation produce localized feedback and allow retry. Closing, reloading
or disposing the reader clears mappings and invalidates late navigation feedback.

The PDF side uses the public `reader.navigate()` adapter, which clones arguments
into the content compartment. Page lookup reads live primary/secondary view
statistics for the last active native split, rather than the view's initial saved
state. Markdown moves through its own numeric scroll offset. Collapsed note
descendants are excluded from the visible source lookup even when Gecko reports
nonzero layout rectangles for them.

The native PDF sidebar, navigation, annotations and zoom remain Zotero controls. The companion does not change the saved PDF zoom; use the native zoom controls if the PDF is too wide for the split. Each PDF attachment has separate companion content, including multiple attachments of one bibliographic item. EPUB/snapshot readers do not receive this button.

The companion stops its bubbling `pointerdown` events before Zotero's native
focus manager cancels default selection. Citation previews apply the same boundary;
the PDF surface retains its native handlers. Clipboard completion is guarded by
the current view request so closing, reloading or disposing a view cannot publish
stale feedback. Clipboard failures leave the menu available for retry. A range
snapshot preserves selected formatting across native-menu focus changes, without
copying text outside the selection or content inside collapsed notes.

## Typed Content

Published parser content reaches the reader as ordered typed blocks and persisted
visual relationships, alongside the unchanged complete Markdown. Imported
Markdown keeps the existing Markdown path. A malformed/mismatched structured
projection falls back to complete Markdown instead of hiding content.

Related images/tables, titles and notes render in one figure container only when
their members form a contiguous group. Relationship storage never forces body
text or another unrelated visual to move. Titles use centered 13 px text with
independent spacing; math in plain or centered HTML titles uses local MathML.
Titles remain captions, including provider Markdown heading syntax, and do not
create heading-directory entries. Visual notes use 12 px text on the existing
pale background, are collapsed initially and merge adjacent disclosures while
preserving separate note paragraphs. Every line of a multiline linked note stays
inside its disclosure. Unlinked captions still receive their own styling;
uncertain note ownership never causes content to disappear.

Provider-labeled abstracts render in a separate 14 px shaded section with a
subtle border and independent spacing. Consecutive abstract blocks share one
continuous background while retaining their paragraphs, original text, language,
inline formatting, equations and individual source pages. Any intervening
non-abstract block ends the group; body text, titles, keywords and later abstracts
stay in reading order outside that container. The accessible abstract label is localized in
all supported languages. This does not infer abstracts or notes from arbitrary
text prefixes, nor modify stored canonical Markdown or MCP text. Existing body
paragraph spacing, display/inline equation scrolling, safe local images and
heading navigation remain available. Heading targets stay unique across typed
sections. MinerU's explicitly embedded title/note parts render separately only
after exact reconstruction against its canonical visual block succeeds.

## Current Boundaries

The reader displays previously saved Markdown caches and published attachment-specific PaddleOCR/MinerU content generations. [The parsing service](parsing.md) supplies provider configuration, durable jobs and section/block publication. [Embedding ingestion, persistent indexing and internal retrieval](vector-retrieval.md) are implemented separately. [Local MCP access](mcp.md) provides bounded document/section/block reads from published generations. Direct parse-result import and automatic continuous PDF/Markdown scroll synchronization remain pending. On-demand physical-page alignment is available through the divider arrows. Missing saved content produces an explicit empty state. The import service remains available internally, but the reader no longer exposes a file picker. Implementation status reviewed: 2026-11-06.

Basic Markdown headings, paragraphs, emphasis, links, lists, quotations, tables and fenced code are rendered. The prose container uses justified alignment, including raw HTML body wrappers. Blocks with CJK prose use character justification because Gecko's automatic mode can follow the English reader UI language; English prose keeps word justification. Paragraph-final lines retain natural width. Headings, code and explicit table/caption alignment keep their own formatting. A conservative HTML subset renders OCR tables (including row/column spans), centered captions and simple formatting. A direct DOM allowlist drops active elements, event attributes and arbitrary styles without assigning provider HTML to `innerHTML`; page/layout comments are hidden. Published parser images render only through hash-verified managed local assets; external Markdown images remain inert placeholders. Syntax highlighting is not included. This reader view does not upload the PDF or Markdown; parsing admission is a separate explicit workflow. External links open through Zotero's URL launcher.

TeX math uses bundled KaTeX with native Gecko MathML output, without remote scripts, stylesheets or font downloads. Inline `$...$` and `\(...\)`, plus display `$$...$$` and `\[...\]`, are recognized before Markdown interprets their contents. OCR-style spaces inside inline delimiters are accepted. Code stays literal, escaped dollar signs stay text, and common currency expressions are excluded. Display equations scroll horizontally inside the companion pane when needed. Raw HTML table cells, headers and captions also typeset TeX after the HTML allowlist has built their safe DOM. This pass touches only raw HTML text nodes, preserves merged cells and nested formatting, and does not reparse Markdown cells or code. Delimiters cannot span different cells or HTML formatting elements. Other raw HTML text remains literal. Invalid, oversized or unsupported expressions remain readable as source rather than failing the document. Trust is disabled, macro expansion and sizing are bounded, and macro definitions are not shared between expressions. Only generated MathML is parsed into an inert document and imported; provider HTML never bypasses the allowlist. The packaged KaTeX license is under `content/licenses/katex.txt`.

Literal `\n` markers in ordinary HTML and Markdown table-cell text render as
explicit line breaks, including coefficient/standard-error pairs and headers.
Markdown markers are distinguished from escaped backslashes before text-token
joining. HTML markers are converted after safe math rendering so TeX commands,
math fallbacks, code and explicitly doubled backslashes stay literal. Nested
formatting, merged cells, existing breaks and safe links remain intact; markers
outside table cells are unchanged. Copying emits real plain-text newlines or
`<br>` within Markdown table rows. This is display-only normalization; canonical
Markdown and saved generations remain unchanged.

Inline MathML also has a width-constrained horizontal scroll container, including
equations embedded in lists, body text, HTML table cells and notes. A long equation
moves as one unit onto a new line when needed and scrolls independently rather
than widening the article; short formulas stay inline. The expression is not split
or rewritten. Small vertical padding preserves space for accents, subscripts and
fractions. Native scrollbar visibility follows the platform's overlay-scrollbar
settings; the scroll range remains available within the formula when the thumb is
auto-hidden. Display equations retain their existing independent scrolling.

Body paragraphs in every language have no leading margin and a half-line trailing
margin (`0.5lh`), including plain unstyled raw HTML paragraph wrappers. Spacing
does not depend on CJK classification or the application language. Wrappers
containing nested blocks or images are not classified as prose. The existing 1.8 line
height remains unchanged: at the default 15 px body size, a line is 27 px and
the paragraph gap is 13.5 px. Table-cell, list and quoted-note paragraphs do not
receive this added spacing; explicitly aligned captions retain their layout.

All six heading levels have explicit spacing before and after their text, so
native reader styles cannot collapse the heading-to-body gap. Tables use their
native table layout at 100% of the available reading width; a separate focusable,
localized scroll region handles content that cannot fit at very narrow widths.
The grid stretches with the table instead of leaving empty space inside its
border. Column/row spans and mathematical content are retained.

Parser notes represented as top-level blockquotes are wrapped in native
`details`/`summary` disclosures, closed by default. Adjacent sibling notes share
one disclosure, ignoring only whitespace and comments between them. Each note
retains its own body with a separator; intervening body text, tables, images and
headings keep groups separate. The original quotation DOM,
links, formulas and nested content are preserved. Notes use 13 px text and a
theme-aware pale background; their prose is left aligned for compact footnotes
and URLs. Nested quotations remain within the same disclosure. Heading-directory
navigation opens a containing note before scrolling to a heading inside it.

Named References/Bibliography sections group numbered reference paragraphs for
display. Bilingual paragraphs and continuation fragments remain intact inside
their reference entry with zero additional paragraph margin; entries have a
uniform half-line gap regardless of language. Unnumbered bibliographies preserve
one entry per source paragraph. Grouping stops at the next heading or a
non-paragraph boundary, and does not rewrite canonical text, source page mapping
or stored generations. Managed images are displayed as centered blocks at their
natural aspect ratio, constrained to the available reading width.

Parsed bibliography entries use the persisted reference projection. Original
numeric labels are rendered in a separate hanging column as `[n]`; bodies omit
their number/brackets/separator prefix. Unnumbered entries use one-based reading
position. Merged tails render once at their first source block, preserving
intervening visuals; packed entries sharing a block each render independently.
Imported Markdown/HTML reference sections use the same prefix recognizer for
display, preserving links, math, ordered-list starts and explicit item values.
Canonical Markdown and original artifacts retain their complete source text.

Unnumbered cross-page reference fragments also render as one entry when the
persisted projection recognizes a continuation. Their display numbers are
recomputed from the merged reading order, so a continued title does not consume
an extra label. Original numeric labels remain unchanged.

In-text citation previews operate only inside the Markdown companion. One local
index is built from its rendered bibliography whenever an article loads. Numeric
groups such as `[1, 3–5]` resolve only original reference numbers, never generated
display labels. Author-year groups and narrative citations support surnames,
Chinese names, diacritics, coauthors, `et al.`/`等`, multiple years, year suffixes
and simple page locators. A missing year suffix can produce multiple candidates;
the preview identifies ambiguity rather than selecting one. Partial groups show
resolved entries plus an unmatched count; wholly unmatched citations stay text.
Latin author fields parse surname-first and initials-first names before title
text. Dotted/spaced/compact initials (`B. H.`, `B.H.`, `BH`, `N. K.`) and wrapped
author lists retain all coauthors. Initial periods do not truncate the author
list; continuation requires an author-list separator. The parser stops at the
title instead of indexing journal words or later book editors as coauthors.
For example, the Hall/Lerner chapter matches `(Hall and Lerner, 2010)` without
matching its later Hall/Rosenberg book editors; the Benmelech/Bergman article
matches completely inside a grouped citation. These are reader-time indexes;
existing saved reference bodies do not require reparsing or a database update.
Round numeric fallback requires more than 60% of numbered references to use round
markers, with numbered records accounting for at least 60% of all references.
At least two resolved author-year occurrences, outnumbering bracketed numeric
occurrences by more than two to one, suppress this fallback for the loaded body.
Native contextual evidence can still supply genuine citations in a mixed-style
paper. A shared semantic filter rejects numeric intervals such as `[0,1]范围`,
table-column ranges/lists such as `第(1)～(3)列`, equation/table/section locators,
and prose enumeration runs, including lists interrupted by author-year citations.
The filter applies to local patterns, numeric superscripts and native overlays,
including overlays containing only digits. Native evidence cannot reintroduce
these rejected markers. Accepted triggers expose `data-citation-source` as
`local`, `pdf` or `local+pdf` for developer inspection. Locator words distinguish
actual equation/model labels from prose nouns: bracketed superscripts after
`深度学习模型`, `学生模型` and `新范式` remain valid citations. A paragraph
need not end with its citation: `MCTN[38]` and `文献[42]` remain valid. Dedicated
recognition of bracketed numeric superscripts handles HTML `sup` and strict
number-only TeX such as `^{[33-43]}` without changing MathML or its annotation.
Genuine mathematical expressions, author-affiliation markers, code, existing
links and bibliography bodies remain excluded. Names and years are heuristic keys, not
independently verified bibliographic metadata or Zotero-library target matches.

Parsed attachments also request read-only evidence from Zotero 10's existing
`pdfDocument.getProcessedData()` interface. The adapter guards that private API,
caches one shared read per native PDF document and retries failures. It uses the
native citation words, full reference text and neighboring page characters;
projection to Markdown requires the same physical page and at least 16 matching
normalized neighboring characters. Body block page spans become display-only DOM
metadata, including when rendering joins blocks from multiple pages. Native
results can recover author names/years outside local citation patterns and add
missing candidates. When contextual native evidence covers every explicit year
in a citation group, its resolved targets take precedence over local author-year
candidates; name-only overlays cannot override a dated match. References
equivalent to stored entries reuse them; an
unmapped native reference displays its complete text with a PDF-source notice.
No reference is inferred from a display-generated number or an unscoped year.

Native enrichment runs after initial local rendering. Closed, replaced or
disposed views ignore late results, and unavailable native APIs preserve local
matching. Original PDF content, native overlay state, canonical Markdown and
database reference records are not modified. OCR omissions and native parser
limitations can still prevent a confident correspondence; this is not a blanket
precision/recall equivalence guarantee for every PDF.

Hovering or focusing a citation opens one theme-aware nonmodal card with complete
sanitized reference bodies, preserved math/emphasis and working external links.
The pointer can enter the card; long bodies scroll without truncation. Escape,
Close, outside clicks and scrolling the article dismiss it. A source button jumps
to the bibliography entry. Clicking with the keyboard moves focus into the card.
The card stays within the reader viewport. Reload, panel close, window unload and
plugin shutdown remove the card, timer, triggers, document listeners and indexes.
All seven generated preview messages are translated in all seven supported locales.
Delegated triggers use string identities rather than cross-compartment DOM object
identity, so trusted Gecko pointer events open the same cards as injected events.
Citation cursors use a normal link pointer.
Citation triggers are focusable inline text spans with button semantics and
Enter/Space activation. They preserve ordinary paragraph line breaking and
justification, including long author-year groups; only color, dotted underlining
and hover/focus feedback decorate the text. Native HTML buttons are unsuitable
here because Gecko lays them out as atomic inline boxes even with `display: inline`.
Inline triggers also remain excluded from click-to-edit block activation.

Source Markdown, processing generations, persisted bibliography data and original
PDFs are unchanged. Indexes and context checks are built when an article loads
or native evidence arrives; hover events use precomputed associations and do not
read the database, scan text or call a model.
Ranges are bounded to 200 labels and bracket groups to 500 characters. This is
an implementation bound, not a measured accuracy or performance guarantee.

Imported content is stored separately from Zotero originals and `zotero.sqlite`:

```text
<Zotero data directory>/knowledgemcp/reader-content/<libraryID>-<attachmentKey>.json
```

The version-1 cache record contains attachment identity, Markdown, import provenance and a UTC-millisecond timestamp. Identity, format and size are validated on read. Saves use an atomic temporary-file replacement and serialize writes for the same attachment within the running plugin. Shutdown drains accepted saves before closing storage. Manual imports still use this cache and do not populate database generations. `ProcessedContentReader` separately reads the active generation from SQLite and resolves its managed images; the newer timestamp selects between a saved manual import and parsed content, preserving both stores. Partial parsed results retain a visible warning. Application startup opens the knowledge database before registering reader integration.

## Markdown Parser Security

The runtime parser is pinned to `markdown-it 14.3.3`. The 2026-11-12 dependency
update replaces `14.1.0` following HTML-enabled and reference-rule
denial-of-service advisories
([inline HTML](https://github.com/advisories/GHSA-vfgh-jcmw-g37q),
[link references](https://github.com/advisories/GHSA-gfr2-rv44-r23c)). The reader
retains `html: true` for OCR tables, with linkification and typography disabled.
DOM allowlisting does not protect parser execution that occurs beforehand.
The existing 2 MiB input limit remains in effect; it does not substitute for a
patched parser.

`test/markdown-security.test.mjs` exercises the bundled reader renderer with
unclosed comments, processing instructions, declarations, CDATA and link references.
A separate worker bounds a stalled test to 60 seconds; this is a test isolation
limit, not a production deadline or performance budget. Inputs must remain literal
text without active elements or external links. Reader tests also cover tables,
equations, citations, selection, editing and cleanup. Dependency changes require
isolated native runtime checks before release; see [current acceptance](project-status.md#markdown-parser-validation).

## Source Boundaries

| Module | Responsibility |
| --- | --- |
| `src/app/` | Construct shared services and own reader lifecycle |
| `src/ui/register.ts` | Register native reader callbacks, attach existing/new readers once and dispose views |
| `src/ui/views/content-reader.ts` | M button, split layout, loading/empty/error states, contents and divider |
| `src/ui/rendering/markdown.ts` | Parse Markdown with `markdown-it`; construct allowlisted DOM without `innerHTML` |
| `src/ui/rendering/markdown-math.ts` | Recognize TeX delimiters; convert bounded, untrusted TeX to local native MathML |
| `src/services/citation-context.ts` | Identify interval, locator and enumeration exclusions shared by local and native citation matching |
| `src/services/content-read.ts` | Validate attachment reads/imports through the repository interface |
| `src/repositories/reader-content.ts` | Replaceable persistence contract |
| `src/storage/reader-content-store.ts` | Native `IOUtils` cache reads and writes |
| `src/shared/contracts/knowledge-content.ts`, `src/schemas/knowledge-content.ts` | Current reader record and runtime validation |
| `addon/content/ui/markdown-reader.css` | Packaged stylesheet bundled as trusted text into each reader document |

The integration isolates inspected native reader internals (`_readers`, `_iframeWindow`, `_initPromise`, `_type`) in registration/types and uses the verified `renderToolbar` event. It also depends on the current `sidebarToggle`, `split-view`, sidebar CSS variable and toolbar geometry. Recheck these on Zotero compatibility updates. Shutdown/window unload invalidates pending reads and removes injected controls, panel, stylesheet and listeners while preserving native PDF nodes.

## Verification

Run type checking and the full Node suite, including reader, citation, document-
search, source mapping, reader-edit persistence and Markdown security tests.
Exercise malformed content, ambiguous mappings, multiple PDFs per resource,
stale generations, rollback, conflict handling, bounded undo/redo and disposal.

Native checks use a disposable library and the packaged plugin. Verify existing/
new readers, all affected locale labels, PDF/Markdown source navigation, equations,
tables, images, narrow layouts, native keyboard/menu behavior, save/reopen and
reload cleanup. Native API/DOM probes are separate from manual accessibility,
pointer, theme and cross-platform acceptance. Provider quality and document-scale
performance require independent representative workloads.
