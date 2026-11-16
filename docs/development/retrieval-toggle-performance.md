# Retrieval result toggle timing

Date: 2026-10-25. Runtime: Windows, Zotero 10.0.6 / Gecko 140;
Node.js 22.23.1 controls the experiment only.

## Current implementation: inline native rows with targeted rendering

The dated rendering measurements below do not establish complete current UI
acceptance. A native offscreen-collapse viewport stress assertion remains open;
see [current acceptance limits](project-status.md#verification-scope).

Inline evidence uses Zotero's disclosure icon, mouse handlers and arrow animation.

The evidence body occupies 224 CSS pixels inside its native document row and
scrolls independently. A 24-pixel notice line sits above the first lower-scoring
document, outside all title cells. Every model reference is still a real Zotero
item; neither evidence nor a notice becomes a selectable synthetic child.

The performance problem was not an unavoidable cost of inline content. The old
container path inserted rows, dispatched native update listeners, restored
selection/scroll state and invalidated the whole list. The new toggle keeps the
row count and selection unchanged, updates the height map, renders only the
changed document row and moves retained visible nodes using native offsets. It
also corrects the list extent after the host recalculates offsets; the host's
height updater computes the total height before that recalculation. Paragraph
folding stays inside the fixed body and requires no new height measurement.

### Native comparison

The comparison uses the same captured result: nine documents, 27 passages, 4,657 UTF-16 characters, query `1`, first document as target. Three rounds alternate AB/BA/AB. Each condition has two warmup pairs and twelve measured pairs per round, giving 36 samples per action/implementation. No concurrent full test suite or model requests are included. A disposable native window isolates the adapters and checks original item identities.

Final comparison, milliseconds, median / minimum–maximum / population SD:

| Action | Original inline | Optimized inline |
| --- | --- | --- |
| Open, synchronous | 29.48 / 25.93–32.14 / 1.72 | 2.49 / 1.65–3.79 / 0.48 |
| Close, synchronous | 24.98 / 19.03–29.85 / 2.22 | 2.88 / 2.17–3.84 / 0.36 |
| Open, including forced layout | 29.48 / 25.93–32.15 / 1.72 | 5.24 / 3.88–7.27 / 0.80 |
| Close, including forced layout | 24.98 / 19.03–29.86 / 2.22 | 4.59 / 3.42–5.28 / 0.49 |

Each optimized toggle performs one native height update and no whole-list
invalidation or native update-listener dispatch. Both paths use the same hidden
native window, and reading the inner list's bounding rectangle forces pending
layout before the final timing. These numbers measure main-thread processing and
layout, not foreground painting, input-to-photon latency or a frame-rate guarantee.
The small library does not establish performance for every library size or machine.

Run `node scripts/measure-retrieval-inline.mjs` with `ZOTERO_DEBUG_PORT` set to the isolated instance. Supply an archived baseline bundle and captured fixture as required by the controller. Keep generated samples private. Timing conclusions require the same fixture, measurement boundaries and complete alternating pairs.

### Correctness checks

`scripts/verify-retrieval-inline.mjs` (also reached through
`verify-vector-result-ui.mjs`) checks native mouse disclosure, one-row rendering,
non-overlapping evidence, cached passage state, source-page dispatch, sorting,
unmatched queries, clearing all results, ordinary attachment restoration, separate
notice geometry, mixed/all-below selection, multi-row expansion, short-window
scroll extents and all seven locales. It never inserts a non-item model reference
and explicitly verifies the absence of a Zotero fatal error.

Node regressions verify target-only rendering, retained DOM nodes, native item references, separate notice text, viewport coverage and cancellation on teardown. Native DOM checks separately cover all seven locales. These checks do not establish independent human latency ratings or exhaustive manual translation acceptance.

Reversible per-list adapters binary-search actual row start positions for both viewport boundaries during submitted retrieval. Ordinary lists delegate to Zotero. Initial rendering and height updates attach adapters to replacement lists; disposal restores all adapted methods.

The viewport-aware implementation was measured against the same original whole-list baseline with the same fixture, warmups, alternating order and 36 samples per action. Forced-layout elapsed times in milliseconds (median / minimum–maximum / population SD):

| Action | Original inline | Repaired inline |
| --- | --- | --- |
| Open | 19.55 / 14.76–32.96 / 4.15 | 6.17 / 4.17–7.89 / 1.20 |
| Close | 23.89 / 17.04–31.43 / 3.83 | 6.72 / 4.48–8.10 / 1.09 |
