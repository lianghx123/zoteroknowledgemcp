# Knowledge UI Design and Remaining Work

This document describes the native UI boundaries and remaining design work.
Implemented behavior belongs to [membership](knowledge-membership-metadata.md),
[tasks](import-tasks.md), [parsing](parsing.md), [retrieval](vector-retrieval.md)
and [the reader](markdown-reader.md). A proposed interaction is not accepted
functionality until its storage, lifecycle and localization checks pass.

## Native Surfaces

| Surface | Responsibility |
| --- | --- |
| Collection tree | Knowledge overview, independent libraries/folders, Import Tasks and Knowledge Trash without changing native collection ownership. |
| Item list | Native literature identities, status decoration, scoped search and inline evidence; preserve selection and source metadata. |
| Item pane | Knowledge information and task details through native peer sections and sidebar navigation. |
| PDF reader | Attachment-specific companion, navigation, document search and explicitly saved corrections while keeping the original PDF available. |
| Settings | Parser/model configuration, maintenance, local MCP and scoped-token management with clear saved/applied/error states. |

## Interaction Rules

Native context menus and explicit destinations admit selected literature; the
entire library is not implicitly included. Multiple memberships share derived
content. Continuous collection binding is distinct from one-time admission.
Trash removals are recoverable until permanent deletion removes the relevant
recovery rights. Native originals remain Zotero-owned.

Titles and bibliographic fields remain actual metadata. Status decoration and
evidence are display projections. Names, errors, tooltips and accessibility labels
use Fluent in all supported locales. Large scopes require bounded queries and
virtualized/incremental display rather than loading every content body.

## Lifecycle and Security

Views own listeners, adapters, selection and request state; application services
own persistence, shared queues and recovery. Preserve unsaved edits and reject
late view requests. Treat imported content as untrusted and resolve only validated
managed assets and native source identities. Remote access permissions never
follow automatically from native UI ownership.

## Remaining Design and Acceptance

- Specify any new source/result-import workflow before exposing its UI.
- Define broader reorder/merge/split/review actions with transactional indexing and conflict handling.
- Complete manual keyboard/accessibility, themes, scaling, separate-window and cross-platform acceptance.
- Evaluate representative large-library usability with stated latency/memory budgets.
- Keep remote account/relay controls separate from local parsing, search and token settings until those adapters are implemented and accepted.

Use the [API boundary reference](knowledge-ui-feasibility.md) when changing native
adapters, and the [delivery ledger](project-status.md) for current limits.
