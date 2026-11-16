# Implementation Review Checklist

Use this checklist with the applicable feature contract and [release procedure](releases.md).
It describes required invariants rather than a record of individual development reviews.

## Persistence and Ownership

- Keep native Zotero records and attachments authoritative and plugin persistence separate.
- Acquire database ownership before main-file preflight, backup and migration bootstrap.
- Preserve migration checksums, transactional rollback, foreign keys and integrity checks.
- Retain shared memberships, Trash recovery rights, incoming references and shared artifact owners before reclaiming data.

## Processing and Recovery

- Persist submission intent and accepted provider identity; distinguish definite failure from uncertain remote outcomes.
- Fence late work by source, content, profile and attempt identity. Reparse must not silently overwrite manual edits.
- Stage and validate artifacts before publication. Recheck file ownership after uncertain commit acknowledgement and retain recovery evidence when ownership cannot be established.
- Bound archive/JSONL/image sizes and managed paths. Keep provider keys, document bodies and signed capabilities out of public diagnostics.

## UI and Lifecycle

- Register existing and new windows/readers once, including addon reload.
- Keep task/index ownership independent of view lifetime; closing a view does not stop unrelated shared work.
- Release adapters, listeners, timers, registrations, workers and accepted asynchronous work on cleanup. Retain a safe retry path for partial cleanup failures.
- Render extracted content through validated local assets and allowlisted DOM. Use complete Fluent translations and native accessibility labels.
- Preserve user selection, unsaved edits and explicit save/conflict semantics.

## MCP

- Validate schemas, projection fields, scope and current access before protected reads or expensive work.
- Enforce independent read budgets, versioned continuations and exact missing/omitted results.
- Keep mutation authorization, expected versions, receipts, revisions and events in one transaction.
- Verify real HTTP/SSE behavior and the intended client independently from mocked handlers.

## Verification

Use Node/VM/JSDOM fixtures for repeatable failure injection and isolated Zotero for
native storage, worker and UI boundaries. Report manual interaction and live provider
quality separately. Current acceptance limits are in [project status](project-status.md).
