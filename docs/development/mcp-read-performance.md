# MCP Read Optimization Measurements

Date: 2026-11-07. Developer-driven native Zotero 10.0.8 measurements on Windows, Node 22.23.1 controller.

These dated measurements predate application contract 2.4.0. Its richer bibliographic defaults and explicit availability checks change standard/full reads; the figures below do not measure those defaults. SQL paging, projection-aware batches and transactional revision boundaries remain implemented.

## Implementation

- Correlated authorization EXISTS retains resource/library deletion checks and active source/generation/version fences.
- Resource lists apply SQL LIMIT/OFFSET and optional COUNT; get-by-ID selects requested authorized IDs. Sources, memberships, statistics and identifiers are batched only when the response projection requires them. Stable ordering and missing-ID order are preserved.
- Migration 0015 adds 51 transactional triggers and monotonic library revisions, replacing whole-library consistency snapshots with one SELECT per check. Token authorization and revisions are checked before and after response assembly. Shared resources invalidate all live member libraries; library-local changes remain local.
- Inactive staging work and source-check timestamps do not invalidate published readers. Source publication, replacement, content/permission changes and annotations/references retain invalidation. Tombstones prevent delete/recreate ABA. Decimal strings retain full SQLite integer precision, missing state fails closed, and overflow rolls back the write. Older cursors become stale after the state-format change.
- Migration 0016 reduces revision write costs by combining resource-update membership probes and guarding inactive block trigger bodies. It preserves the already-installed development migration 0015 and all preceding checksums.

## Method and evidence

The original package uses 14 migrations; the optimized package uses 16 migrations. Both tool implementations were bundled with identical dependencies and executed against the same migrated synthetic read database inside isolated Zotero. Separate write databases use the baseline and candidate schemas respectively. The fixture contains 1,000 documents, 100,000 blocks of 1,024 characters (102,400,000 text characters), plus 20 identifiers and supplementary sources. No production library or paid parsing/embedding/rerank calls were used. Provider call counters remained zero.

Each read case and mixed-load level has one warmup and five alternating measured rounds. The 24-call mixed batch contains list20-standard, get1-standard, read12k and blocks20-preview at concurrency 1/4/16. Authentication, last-used writes, authorization, cursor hashing, actual tool execution and JSON response serialization are included. This is an in-process tool benchmark, not an HTTP/SSE network latency measurement. Query counts include authentication and adapter changes() queries. Row counts are instrumented only during warmup to avoid perturbing measured samples.

Native accessibility was already disabled (`accessibility.force_disabled=1`, `accessibilityEnabled=false`, empty activation source); debug logging was off. An external automation helper remained present. These measurements retain that environment limitation and are not a clean helper-free baseline or evidence for accessibility-enabled performance.

## Read latency

Milliseconds: mean (min–max; population coefficient of variation). No outliers removed.

| Scenario | Original | Candidate | Time reduction | SQL calls original → candidate |
| --- | ---: | ---: | ---: | ---: |
| list20-compact | 230.03 (191.02–284.57; CV 14.5%) | 19.38 (10.42–37.75; CV 52.0%) | 91.6% | 127 → 15 |
| get1-compact | 137.16 (113.24–150.66; CV 9.2%) | 11.09 (8.93–13.31; CV 13.2%) | 91.9% | 32 → 15 |
| list20-standard | 206.98 (194.10–223.34; CV 5.0%) | 19.70 (16.32–23.49; CV 14.0%) | 90.5% | 127 → 17 |
| get1-standard | 117.34 (95.60–132.35; CV 11.2%) | 11.46 (8.98–12.92; CV 13.3%) | 90.2% | 32 → 17 |
| list20-full | 219.38 (190.86–259.90; CV 10.2%) | 27.09 (19.68–43.34; CV 31.8%) | 87.6% | 127 → 19 |
| get1-full | 115.57 (106.31–127.13; CV 6.3%) | 10.58 (9.77–11.43; CV 5.6%) | 90.8% | 32 → 19 |
| list100-full-total | 648.98 (536.37–888.54; CV 19.1%) | 55.03 (48.22–57.52; CV 6.4%) | 91.5% | 527 → 20 |
| get20-full | 207.17 (186.64–231.00; CV 7.5%) | 19.98 (16.84–24.06; CV 12.2%) | 90.4% | 127 → 19 |
| get1-expanded | 111.59 (104.01–123.28; CV 5.8%) | 10.36 (8.87–11.40; CV 8.6%) | 90.7% | 32 → 19 |
| read12k | 122.15 (111.21–140.59; CV 8.2%) | 22.15 (21.48–22.97; CV 2.8%) | 81.9% | 42 → 30 |
| read50k | 193.51 (180.24–202.48; CV 4.3%) | 58.47 (50.28–82.27; CV 20.4%) | 69.8% | 79 → 67 |
| blocks20-preview | 137.75 (129.63–157.09; CV 7.4%) | 29.39 (26.23–34.34; CV 9.6%) | 78.7% | 50 → 38 |
| blocks20-full | 232.01 (157.02–293.73; CV 23.4%) | 60.77 (45.15–74.75; CV 17.5%) | 73.8% | 70 → 58 |
| metadata-search | 959.08 (901.10–1005.02; CV 3.6%) | 572.23 (550.79–615.73; CV 3.9%) | 40.3% | 221 → 161 |

All 14 cases produced equivalent structured outputs, including projections, totals, identifiers, supplementary sources and metadata search. Only opaque continuation-token bytes were normalized to cursor presence. Warmup returned-row counts fell from 5,376 to 37 for list20-compact, 5,262 to 17 for get1-compact and 5,696 to 458 for list100-full-total.

The combined optimization is measured here; these numbers do not attribute an independent speedup to each individual change. Some small cases have high relative variability, so the ranges matter more than a single millisecond claim.

## Mixed-load throughput and tail latency

Mean across five batches. p95 is calculated within each 24-call batch and then averaged; it is not a pooled production tail percentile.

| Concurrent callers | Requests/s original → candidate | Average batch p95, ms original → candidate | Throughput ratio | Event-loop p95, ms original → candidate |
| --- | ---: | ---: | ---: | ---: |
| 1 | 7.44 → 58.20 | 197.25 → 26.24 | 7.82× | 14.30 → 6.11 |
| 4 | 9.64 → 72.82 | 997.40 → 84.91 | 7.55× | 14.98 → 11.94 |
| 16 | 9.69 → 77.01 | 2342.82 → 291.52 | 7.95× | 16.34 → 7.28 |

| Concurrent callers | Batch time original | Batch time candidate |
| --- | ---: | ---: |
| 1 | 3296.70 (2449.98–3736.37; CV 13.4%) | 417.96 (334.57–467.76; CV 10.9%) |
| 4 | 2495.80 (2348.98–2683.92; CV 5.4%) | 332.06 (306.90–387.68; CV 9.1%) |
| 16 | 2487.27 (2220.55–2638.73; CV 6.1%) | 312.27 (294.29–334.61; CV 4.6%) |

## Write costs and tradeoff

A separate write comparison uses one warmup and 20 alternating rounds per workload, with isolated original/candidate write databases. Each metadata-100 batch updates 100 resources in one transaction. Staging-1000 inserts 1,000 inactive blocks in one transaction; deletion/reset and revision assertions are outside the timed interval. The candidate revision must advance exactly 100 and 0 respectively. Summary-mcp authenticates and executes the real update_summary tool with optimistic versions, revision/outbox/receipt persistence and JSON serialization; the caller's preceding version lookup is outside timing. The harness change callback is empty, so native UI refresh/reindex scheduling is excluded. All result versions are checked.

| Workload | Original, ms | Candidate, ms | Change in time |
| --- | ---: | ---: | ---: |
| metadata-100 | 60.46 (50.28–79.85; CV 12.3%) | 70.19 (61.28–82.42; CV 7.3%) | 16.1% |
| staging-1000 | 15.22 (11.25–22.63; CV 20.6%) | 16.29 (12.46–19.49; CV 13.7%) | 7.1% |
| summary-mcp | 67.70 (48.29–92.28; CV 18.7%) | 18.55 (13.50–27.14; CV 19.0%) | -72.6% |

Raw metadata updates cost about 9.74 ms more per 100 updates (0.097 ms each, +16.1%). An independent 20-round repeat measured 61.44 → 73.05 ms (+18.9%). This is a repeatable cost of transactional revision maintenance. Migration 0016 supplies lookup indexes for revision checks; these cross-run figures do not isolate its independent effect.

Staging insertion adds 1.07 ms per 1,000 blocks (+7.1%) in the second write run, and 0.72 ms (+3.6%) in the first. Both have considerable variability; no staging speedup or statistically established zero overhead is claimed. In contrast, the complete MCP summary operation improves 72.6%, because its consistency checks no longer load the whole library. The retained design exchanges a small absolute raw-write cost for bounded state reads and demonstrated interface-level gains. Write-heavy metadata imports may still pay that additional cost; this implementation must not be advertised as improving every database workload.

## Correctness and runtime acceptance

The native benchmark passes response-schema validation and original/candidate output equivalence. Native SQL checks also verify source bookkeeping non-invalidation, rollback preserving revisions, committed changes invalidating signed cursors, removal of a membership hiding the resource, delete/recreate ABA protection and integrity/foreign keys on all three fixtures. Every service and database owner closes successfully.

The separate real Gecko HTTP/SSE acceptance passes initialization, tool discovery/calls, UTF-8 and normalized Unicode evidence, current 16-migration history, seven localized settings, occupied-port recovery, transactional annotation, two disable/enable cycles, reading/searching with all main windows actually closed, process HTTP without a window, Origin rejection and token revocation. The installed Codex app-server MCP client executes all 16 tools, summary/annotation mutations, idempotent replay and revocation checks without model requests. Both acceptance fixtures are cleaned up. These are developer-driven native API/DOM/client checks, not physical-pointer manual acceptance.

The regression suite covers projection-dependent query bounds, SQL paging,
missing IDs, scope isolation, shared resources, no-op changes, publication,
annotation/reference/visual links, rollback, cursor invalidation, authorization
changes during assembly, revision precision/overflow, missing state and atomic
14→16 / 15→16 migration rollback/retry.

## Reproduction

Use an isolated development Zotero debugger without concurrent build/test jobs. Stop task-owned UI automation helpers and record native accessibility state before fresh sampling. Use a new output directory under ignored `.scaffold`.

```powershell
$env:ZOTERO_DEBUG_PORT = '<isolated debugger port>'
$env:MCP_READ_BASELINE_REF = '<baseline-ref>'
$env:MCP_READ_OUTPUT = '.scaffold/mcp-read-optimization/new-read-run'
$env:MCP_READ_ROUNDS = '5'
$env:MCP_READ_WRITES_ONLY = '0'
node scripts/measure-mcp-reads.mjs
# The controller dispatches asynchronous native work; inspect native-results.json
# until status is passed and cleanup.passed is true before starting another task.
node scripts/summarize-mcp-reads.mjs .scaffold/mcp-read-optimization/new-read-run/native-results.json
```

For a longer write-cost run, set MCP_READ_WRITES_ONLY=1 and MCP_READ_ROUNDS=20.
MCP_READ_FIXTURE may reuse a fully checkpointed, closed synthetic baseline fixture;
the harness refuses a nonempty WAL and existing destination files. The read and
write databases are disposable copies; each closes its owner on success or failure.

## Practical limits

- The implementation retains the single FIFO connection. The throughput gains
  follow reduced SQL work and materialization, without a connection pool.
- Metadata search still has substantial retrieval/candidate costs; the candidate
  averages about 572 ms here. Longer content reads still perform bounded
  per-block substring/metadata queries. SQL paging applies to resource lists;
  structure/block listings retain their existing bounded-content architecture.
- Library-wide invalidation can conservatively reject a read when a different
  resource in the same authorized library changes. No fixed revision, stale
  permission cache or time-based permission bypass is used.
- OFFSET traversal, folder expansion, cold disk I/O, multiple-library scaling,
  production-library distributions, OCR/embedding pipelines, long-duration load,
  OS power-loss faults and human search quality are outside this benchmark.
- The synthetic metadata fixture has one matching term across all documents.
  The test proves response equivalence and measured local execution cost; it
  does not establish search relevance quality or approximately 1,000-paper
  end-to-end ingestion acceptance.
