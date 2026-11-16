# Native Performance Measurements

Measured on 2026-10-22 in isolated Zotero 10.0.6 on Windows. The following comparisons measure local database and native-row operations on synthetic fixtures.

## Method and Evidence

Sixteen isolated variants measured elapsed time through Zotero's native SQLite adapter and collection-row/icon APIs. Each variant changes only the operation under examination. Query counts and complexity are diagnostics, not timing evidence.

- Synthetic databases cover 100, 1,000 and 4,000 resources, up to 40,000 origins, plus small/bulk mutation scenarios. UI fixtures cover 100, 2,400 and 10,000 Trash entries and a 40-row viewport.
- Database configuration matches production: NORMAL locking, WAL, foreign keys and `synchronous=FULL`. Mutation times include the complete repository transaction and commit. The audit does not disable integrity or append-only triggers.
- Before each mutable sample, close the native connection, restore a byte-identical disposable database image, reopen it and prime its tables. File copying, initialization, cache priming, explicit GC and an idle delay occur outside timing. Read samples use warmed database/OS caches.
- Use four untimed paired warmups, then 16 alternating AB/BA measured pairs; combined-read controls use 12 pairs. Selected confirmation comparisons use 32 pairs. Synchronous UI calls are batched to reduce clock-granularity effects and reported per operation.
- UI providers and selection are isolated wrappers: actual native collection references, native row creation and icons are used, while the empty-selection callback supplies a known empty selection. Its timing measures plugin overhead under that condition.
- Report separate before/after medians and a paired bootstrap interval from 4,000 resamples. These exploratory 95% intervals do not establish population guarantees. The paired percentage estimate can differ from the ratio of separately calculated medians.
- Retain only candidates with demonstrated, measurable benefits in a tested scenario; investigate smaller-case regressions and replicate marginal results. Do not infer benefits for unmeasured scenarios.

These are native-runtime synthetic measurements. They do not measure a production corpus, heap usage, cold application startup, screen painting or overall application responsiveness. UI times below measure row/list processing, not a completed display frame. Timings from different comparisons must not be added together.

## Retained Changes

Times are milliseconds per operation. Each row names its measured scope; it is not a claim of universal improvement.

| Change | Scenario | Original median | Candidate median | Paired improvement, exploratory 95% interval | Decision |
| --- | --- | ---: | ---: | --- | --- |
| Joined membership placements | 1,000 active resources, 10 folders; complete snapshot; header changes excluded | 168.95 | 101.02 | 41.2%; 38.2% to 42.7% | Retain. The independent 100-resource comparison also improves. |
| Folder-deletion parent/child index | 256 folders, 32 selected; full transaction | 551.40 | 464.06 | 14.4%; 9.0% to 18.2% | Retain for batch behavior. One selected folder: 30.15 to 29.00, interval -1.9% to 12.4%; no single-folder speed claim. |
| Relational purge recovery/version checks | 100 resources, 50 selected; full transaction | 229.55 | 216.08 | 10.6%; 5.3% to 19.0% | Retain. Single-item timing is inconclusive. |
| Trash summary projection | 1,000 resources, 10,000 origins; complete snapshot against the original summary implementation | 252.10 | 48.00 | 80.9%; 80.4% to 81.7% | Retain. At 4,000 resources/40,000 origins: 685.21 to 112.29, interval 82.2% to 84.9%. |
| Direct row-kind lookup | 2,400 entries, 40 native row labels/icons; icon-module skipping excluded | 1.878 | 1.278 | 25.7%; 19.1% to 40.4% | Retain for repeated row rendering. At 10,000 entries: 2.939 to 1.262, interval 47.6% to 65.1%. |
| Search normalization once per list read | 2,400 entries, three matching case-insensitive words; complete warm list filtering | 2.713 | 1.822 | 36.6%; 19.5% to 44.6% | Retain. Both 100-entry and 10,000-entry comparisons also improve. |
| Empty-selection early return | 2,400 entries; empty `selectedEntryIDs()` | 0.148 | <0.001 | 99.3%; 99.2% to 99.4% | Retain. Absolute saving is small; do not equate the relative percentage with overall UI speed. |

First creation of 2,400 unsaved references plus the first 40 native rows was checked separately for the row-kind change. An initial comparison was 32.81 to 35.19 ms with interval -24.2% to 4.2%; a 32-pair confirmation was 28.90 to 27.22 ms with interval -10.6% to 11.5%. Neither establishes an initial-list improvement or a consistent regression. Only the repeatedly reproduced warm-row benefit is claimed.

## Correctness and Future Changes

A separate complete-snapshot comparison uses a new 1,000-resource/10-folder database and 32 alternating measured pairs:

| Final-source scenario | Original median ms | Final median ms | Paired improvement, exploratory 95% interval |
| --- | ---: | ---: | --- |
| Active resources, empty Trash | 262.81 | 147.08 | 43.0%; 40.1% to 46.9% |
| Deleted-library recovery, 10,000 origins | 258.52 | 49.65 | 81.5%; 79.4% to 82.7% |
