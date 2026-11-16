# Retrieval optimization and verification

Date: 2026-11-09. Scope: evidence-preserving recall, diversification, repeated
coverage/mapping reads and MCP page materialization. The vector engine, index
precision, search expansion parameters, configured concurrency, provider limits
and single FIFO database connection are unchanged. No new schema or persistent
retrieval cache is introduced.

## Implemented boundaries

`VectorStore.search` accepts a request-owned session. The first call resolves
current scoped sources and filtered labels using existing indexes; subsequent
expansion calls reuse that mapping. Profile, scope and filter mismatches reject
session reuse. New requests discover mappings afresh. Source-first joins avoid
repeating source/version probes per vector. Final evidence/publication checks
still reject source replacement and scope removal during search.

When the document budget exceeds the entire scope and at most 5,000 labels qualify, exact search reads all eligible labels once. Multiple segments from the same block remain distinct evidence. Larger scopes retain filtered ANN and bounded expansion.

Vector ranking reads light metadata without segment bodies. After the final
candidate/evidence selection it reads the selected bodies in bounded batches.
Missing selected segments omit their affected candidate; current generation,
membership and configuration are checked at the final transaction boundary.
No provider request is enclosed in a database transaction.

The final coverage query reuses the exact sources already validated in that
transaction. It drives existing block/segment indexes by current generation and
profile rather than repeating source/profile/version joins for each segment.
Counts are recomputed on every request. This preserves embedding state, skipped
segments, multiple sources, Trash scopes and configuration isolation without a
cross-request invalidation cache.

Diversification preserves the greedy rule, its dynamic pending rank, title word
normalization and first-entry tie breaking. Each title is tokenized once. Each
remaining candidate stores its maximum similarity to the selected set, updating
only for the newly selected title. It does not change the relevance rule or disable
diversification.

MCP snapshots retain complete ranked candidates. Block headers, neighboring
context and resource versions are generated only for the requested page. Each
continuation/replay rechecks authorization, library state, configuration and index
state, including after the final evidence read. Existing field projection and
cursor invalidation rules remain. Snapshot lifetime remains one hour and at most
64 entries; an approximate 16 MiB retained-payload budget additionally evicts old
snapshots while allowing a single newest oversized entry to remain usable.

## Automated coverage

`test/retrieval-optimization.test.mjs` compares incremental diversification with
the original rule across ties, empty/Unicode titles and multiple lambda values;
checks same-block segment preservation and deferred body reads; verifies
request-local mapping, filtering and profile/scope fences; and compares current
coverage with the original aggregation across embedding/source state changes.

`test/mcp.test.mjs` additionally verifies all pages, replay and independent
projections, absence of off-page header reads, changes during page assembly,
cancellation, retained-text eviction and shutdown. Existing retrieval integrity,
authorization, Trash, configuration, partial-content, rerank and cursor tests
continue to apply.

## Native reproduction

Use Node 22.23.1 and an isolated Zotero 10 profile with the native debugger enabled.
Do not start UI automation for these checks. Inspect accessibility state and
external automation helpers before sampling, and record any environment limitation.

```powershell
$env:ZOTERO_DEBUG_PORT = '12013'
node scripts/verify-retrieval-performance.mjs --baseline '<baseline-ref>' --smoke
node scripts/verify-retrieval-performance.mjs --baseline '<baseline-ref>' --concurrency
node scripts/verify-retrieval-performance.mjs --baseline '<baseline-ref>' --diversity
node scripts/verify-retrieval-performance.mjs --baseline '<baseline-ref>' --smoke --http
```

The controller requires an explicit baseline revision and refuses non-Scaffold
profiles. It builds separate baseline, individual optimization and complete
candidate bundles, then creates a WAL-consistent fixture copy and a task-owned
Worker restored from the same index snapshot. All arms share that same Worker
and database fixture; configured concurrency/connection topology are unchanged.
All model dispatches fail closed. Five stored vectors serve as fixed synthetic
semantic probes, not a live provider/relevance evaluation. Warmups and five
alternating measured rounds compare complete retrieval and first-page results.
Further checks read every page in metadata/fulltext/vector/hybrid modes. Optional
1/2/4-caller batches measure the existing configuration without changing it.

Reports under `.scaffold/retrieval-optimization/native-*/` contain the baseline
revision, source comparison, native environment, fixture size, timings, SQL/row
counts, Worker requests, output equivalence and cleanup. Elapsed SQL timings
include the native adapter; they are not SQLite engine-only CPU times. The
controller measures in-process tool execution, not Codex bridging or HTTP/SSE
latency. `--diversity` separately compares synthetic 18/100/250-title ranking,
including the complete selected order. `--http` creates a temporary listener and
token only on the fixture copy, verifies all-page SSE reading/replay, content
budgets, Origin rejection and revocation, then removes token children and parent
before closing storage. This transport check does not measure provider latency.
Packaged installation/reload and native DOM checks are recorded separately.
No manual physical-pointer UI review is implied.

## Native results

The comparison isolates the retrieval changes described above against the
original eager materialization and repeated mapping implementation. Both run in
isolated Zotero 10.0.8 on Windows with the same SQLite snapshot, Worker, 18-resource
scope and 3,174 active 768D Float32 vectors. Five stored vectors are fixed synthetic
query probes, not freshly generated embeddings or a model-quality evaluation.
No provider calls occur. Each serial cell has one warmup per question and five
alternating measured rounds for each of five questions (25 measured observations).
No outliers are removed. Source, individual optimization and complete arms are
compared in the same process; elapsed times include native adaptation and tool
result construction, but exclude the Codex bridge and HTTP transport.

Milliseconds; CV is the population coefficient of variation across observations:

| Arm / measurement | Median | Min–max | CV |
| --- | ---: | ---: | ---: |
| Original retrieval | 1509.06 | 1239.36–4548.64 | 38.14% |
| Recall/mapping only | 754.23 | 620.71–2305.27 | 42.59% |
| Coverage only | 1334.89 | 1109.24–3447.26 | 36.39% |
| Complete retrieval | 582.10 | 497.29–2194.72 | 52.21% |
| Original MCP first page | 1513.48 | 1157.49–1832.74 | 11.56% |
| Paging only | 1388.60 | 1033.64–1786.48 | 13.27% |
| Complete MCP first page | 565.65 | 433.62–1188.31 | 27.07% |

The complete first-page median decreases by
62.63%.
Its mean decreases from 1479.85 to
610.75 ms. Per-request SQL median falls from
278 to 145; the
retained speedup is supported by elapsed measurements, not query count alone.
The full arm uses one Worker search instead of four in this small scope. A separate
diagnostic smoke run observed source mapping near 33 ms and coverage near 25 ms,
versus approximately 147 ms eligibility filtering plus repeated 50–60 ms mappings
and approximately 177 ms coverage in its original arm. These phase observations
are not independent effect estimates. Do not add the component savings together.

Title diversification costs are small at 18 resources; the isolated diversification
arm did not demonstrate an overall speedup on that corpus. Its scalability is
measured separately using synthetic multiword titles, actual MCP ranking code and
lightweight synthetic metadata. Baseline and diversification-only arms keep the
same eager page assembly, so the comparison isolates the ranking implementation.
Every arm preserves the complete selected order. These figures are not whole
literature retrieval latency:

| Candidate titles | Repetitions per arm, excluding warmup | Original median ms | Diversification-only median ms |
| --- | ---: | ---: | ---: |
| 18 | 5 | 10.63 | 7.25 |
| 100 | 5 | 576.21 | 7.15 |
| 250 | 3 | 8958.00 | 13.53 |

For example, 100-title baseline observations range from
541.17 to 608.63 ms;
the optimized arm ranges from 4.59 to
18.50 ms. At 250 titles the respective ranges
are 8929.65–9289.02
and 12.38–14.96 ms.

The existing 1/2/4-caller workload was repeated without changing any concurrency
configuration. Each cell has one warmup and three alternating measured batches
of eight requests. Throughput is the median of batch successful-requests/elapsed;
latency is the pooled median of 24 measured requests per cell:

| Callers | Original request median ms | Complete request median ms | Original requests/s | Complete requests/s |
| --- | ---: | ---: | ---: | ---: |
| 1 | 1510.92 | 601.92 | 0.64 | 1.65 |
| 2 | 3254.00 | 1214.26 | 0.64 | 1.62 |
| 4 | 6262.58 | 2260.89 | 0.64 | 1.76 |

Higher caller counts still raise latency, and batch throughput varies. These
results establish reduced work in the current topology, not linear scaling,
production QPS, cold-cache behavior or capacity for 1,000 papers. They provide
no rationale for increasing configured concurrency or adding connection pools.

## Verification and limits

- Native comparison: 360 serial calls including warmups, 192 load requests,
  64 output-equivalence assertions and successful database/Worker cleanup.
  Metadata/full-text/vector/hybrid pages match the original results. Synthetic
  diversification adds 48 complete-order assertions. Timing fields and opaque
  cursor bytes are excluded from equality.
- A separate Gecko HTTP/SSE fixture verifies protocol negotiation, all 16 tools,
  paged hybrid results, replay, Unicode budgets, Origin rejection and revocation.
  Temporary tokens, listeners, Workers and database owners are cleaned up.
- Native DOM checks cover evidence, highlights, source navigation, grouping,
  sorting, clearing and seven locales. The inline stress assertion
  `viewport-covered-after-offscreen-collapse` remains a known failure in both
  compared packages; this retrieval optimization does not claim to fix it.
- Native accessibility was already force-disabled, with no activation source;
  debug logging was off. An external automation helper remained present.
  Measurements retain that limitation and are not a clean helper-free baseline
  or evidence for accessibility-enabled performance.
- These measurements exclude live model/rerank services, large-corpus relevance,
  mixed writes and long-running production capacity. Small samples do not
  establish reliable P95/P99. Native DOM checks are distinct from manual review.
