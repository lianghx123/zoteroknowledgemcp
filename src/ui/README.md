# ui

Zotero-native views and registrations. The PDF Markdown companion and metadata-backed knowledge UI are implemented here.

`knowledge/register.ts` uses native item-pane/menu registrations and owns per-document styles/localization. `knowledge/title-status.ts` decorates the existing title cell; `knowledge/library-tree.ts` displays independent plugin libraries/folders with native linked items and scoped filters. The latter two use reversible internal adapters and require revalidation after Zotero updates. Cleanup makes retained wrappers inert without replacing another plugin's later wrappers.

Badge, title, tree, Trash and drag adapters roll back partial initialization. Window cleanup continues across detached native views and individual disposal failures; failed menu/section unregistrations remain tracked for a subsequent cleanup attempt. Tree disposal retains the originally adapted view so removal from `ZoteroPane` cannot hide its wrappers.

Native menu/section registrations use Fluent IDs; other interface text uses `shared/localization.ts` and the same `knowledgemcp.ftl` resource. Zotero discovers language directories automatically. See [localization](../../docs/development/localization.md) for supported locales, fallback and translation checks.

Knowledge roots use the bundled graph SVG through a scoped CSS mask and have no synthetic Unfiled row. `knowledge/details.ts` safely renders a label/value field list with attachment details. Library deletion uses a native confirmation dialog with an optional exclusive-data checkbox, unchecked by default.

`knowledge/drag-drop.ts` routes multi-item copies to knowledge admission or Zotero's native container copy handler, rejects full duplicates and guards original source memberships. Folder deletion removes its subtree while retaining items in the library. The graph SVG includes view-box padding for native header scaling.

Collection-tree adapters re-render the native owner after installation/disposal to update retained virtual-tree callbacks, then invalidate rows in the React commit callback. Invalidating before the props commit lets VirtualizedTree remove disclosure arrows using stale callbacks until the next interaction. Pending installation callbacks skip disposed integrations and closed windows. Creation reveals/selects the returned node ID; disclosure and native-close paths share expansion state and selection fallback. `shared/knowledge-errors.ts` exposes expected operation prompts and sanitizes unexpected exceptions before they reach alerts/results/warnings.

Tree rebuilding remaps every selected row, focus and range-selection pivot by stable row ID. It follows Zotero's own selection-index remapping pattern without emitting selection events, releasing event suppression or scrolling. Surviving selections are retained when some rows disappear; only a logical selection change updates the selected item scope. If all selected rows disappear, collapse uses its ancestor and refresh uses the knowledge overview as fallback. An empty selection stays empty.

Tree and admission-menu construction share `knowledge/folder-index.ts`, grouping folders by library and parent while retaining snapshot order. Each tree rebuild also indexes row definitions and container identities for native callbacks. These indexes are rebuilt with current metadata, preserving cycle/depth guards and avoiding a persistent cache. See the [performance review](../../docs/development/performance-review.md) for scaling regressions and native checks.

ZoteroPane normally collapses multi-selected unknown row types. `library-tree.ts` adapts its row accessor to expose a cached plugin-owned union scope for multiple knowledge folders or multiple knowledge library roots, while `collectionsView.getSelectedRows()` retains the actual left-tree selection. The scope remains a `knowledgemcp` row, is never inserted into the tree or persisted, and reads only the selected targets' current resource memberships. Its cached identity preserves filters across refreshes. Single-target menus read the physical selection and remain unavailable for a combined scope; incoming item drops also require one destination. Mixed native/knowledge selections, overview mixtures and library-root/folder mixtures retain native compatibility rules. Ctrl+A follows visible sibling scopes and delegates native selections unchanged. Cleanup restores both the pane accessor and Select All adapter.

`knowledge/import-tasks.ts` renders parsing, continuous collection bindings and embedding/index task stages. `retrieval-settings.ts` mounts generic provider, relevance threshold and index controls in native Settings. `knowledge/retrieval.ts` integrates Enter-submitted full-text/semantic/fusion search with the original search control, preserves native preferences and restores filters. `knowledge/retrieval-results.ts` groups central results and renders safe, highlighted evidence inside native document rows. Disclosure icons, mouse events and arrow animation remain Zotero's. Only the toggled row renders again; retained rows are repositioned from native virtual-list offsets. The possible-relevance notice occupies a separate line above the first lower-scoring title, outside its title cell. No synthetic reference enters native selection or item details. Its reversible native adapters require revalidation after Zotero updates. See [vector behavior and verification](../../docs/development/vector-retrieval.md).

See [knowledge usage and verification](../../docs/development/knowledge-membership-metadata.md). `mcp-settings.ts` implements local token creation, library/scope editing and revocation. Remote account/relay permission views remain deferred.

See the [implementation overview](../../docs/development/implementation-overview.md) and [delivery status](../../docs/development/project-status.md) for implemented behavior and acceptance limits.

Task snapshots are deduplicated with their current notice. Hidden task panels retain data without rerendering; opening the task view renders the latest snapshot. Only active-count changes request a navigation-only knowledge-tree refresh. `KnowledgeLibraryTree.refresh(false)` preserves the middle list, while content updates retain the default refresh path. Retrieval row adapters delegate sorting and attachment toggles directly outside submitted results.

Retrieval feedback does not create a bottom status strip. The search textbox owns temporary tooltip/accessibility feedback and restores its original attributes after success, mode changes and disposal. Startup recovery retry belongs to Settings.

Inline evidence reserves 224 CSS pixels inside the native row, with independent scrolling. No synthetic row, whole-list invalidation or resize observer is needed to toggle evidence. Height updates correct the native list's total extent after offset calculation, repaint the changed row and move retained rows. Visible-row lookup searches actual row boundaries instead of treating an expanded row as multiple base-height rows; partially visible evidence remains mounted while scrolling. The lookup adapters follow replacement native lists and are released on disposal. Cached panels preserve disclosure state until the result changes. Deferred batch updates are cancelled on disposal, and native expansion methods and heights are restored. Attachment titles are source links; scoring/channel controls stay out of the panel. See [native measurements](../../docs/development/retrieval-toggle-performance.md).

`reader-search.ts` owns the Markdown search sidebar, scoped shortcuts, request
cancellation and temporary source-block highlighting. `register.ts` injects the
attachment search provider and document-save provider, and drains accepted
searches and writes before database shutdown.
The sidebar temporarily replaces Contents without changing its saved visibility
or depth. Rendering adds display-only source-block IDs for exact navigation.

`reader-block-session.ts` owns bounded block-delta undo/redo in memory.
`reader-block-editor.ts` owns local drafts, scoped shortcuts and explicit document
save; `reader-editor-size.ts` fits source content beneath a saved maximum.
`reader-block-type-menu.ts` owns the themed type popup, keyboard navigation,
viewport placement and dismissal/cleanup outside the editor's clipping surface.
`repositories/reader-edit.ts` publishes immutable edit generations transactionally
with source-version fencing, section/projection updates, full-text indexing and
exact reuse of unchanged block vectors. Applying a block does not write storage.
