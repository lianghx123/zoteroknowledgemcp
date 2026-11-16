# Native Knowledge UI API Boundaries

The plugin combines dedicated Zotero extension APIs with narrow adapters around
native internals. Internal adapters require feature detection, reversible
installation and verification after host updates. They are not guaranteed public
extension contracts.

## Surface Ownership

| Surface | Integration boundary |
| --- | --- |
| Item-pane sections | `Zotero.ItemPaneManager.registerSection()` with native header/sidebar behavior and Fluent attributes. |
| Item/collection context menus | `Zotero.MenuManager.registerMenu()` with native command and visibility handling. |
| Settings | `Zotero.PreferencePanes` registration and native preferences navigation. |
| Title decoration | Per-window adapters around native title-cell rendering; do not create a duplicate title column or mutate bibliography. |
| Knowledge tree | Per-window collection-tree adapters with explicit custom row identities and native-compatible selection/expansion. |
| Reader | Native reader callbacks and the verified reader DOM boundary; preserve existing PDF nodes and controls. |

## Adapter Requirements

Capture the current instance's methods and restore only the methods/resources
owned by that instance. Avoid restoring a stale adapter over a replacement
window or addon. Handle initially loaded and newly opened windows, row
virtualization, detached DOM and partial registration failure. Dispose listeners,
styles, popup nodes, timers and temporary search scopes.

Preserve native filtering, sorting, keyboard ranges, focused selection, disclosure
animation and item identities outside submitted knowledge search. Refreshes must
not collapse native attachment rows or recreate unsaved view state unnecessarily.

## Verification Boundary

Node/JSDOM tests exercise registration, lifecycle, selection and failure paths.
Isolated Zotero checks must separately verify actual menu/section registration,
native row/title rendering, existing/new windows, reload cleanup and all affected
locale labels. DOM-event probes are distinct from manual pointer/keyboard,
screen-reader, scaling, operating-system theme and cross-platform acceptance.

Current feature contracts are in [membership](knowledge-membership-metadata.md),
[tasks](import-tasks.md), [reader](markdown-reader.md) and [project status](project-status.md).
