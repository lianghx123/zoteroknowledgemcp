# Native Database Concurrency Comparison

Date: 2026-11-07. This is a developer-driven native Zotero experiment against
the application baseline identified below. The experiment left the production
driver, connection routing and HTTP admission limits unchanged. These results
predate the implemented [MCP read optimizations](mcp-read-performance.md) and
the [16/64/128 admission defaults](mcp.md); they do not measure the current
optimized tool implementation.

## Read Workload Results

Increasing callers on FIFO does not increase sustained throughput in this
fixture. Multiple read connections improve concurrent throughput, but their
benefit is smaller at the complete tool-handler layer than for short SQL.
Eight readers do not provide a consistent tool-handler advantage over four.

Median throughput, requests/second; each tool batch contains 48 requests:

| Concurrent callers | FIFO | FIFO, deferred read transactions | 4 readers + 1 writer | 8 readers + 1 writer |
| --- | --- | --- | --- | --- |
| 1 | 7.36 | 7.26 | 6.72 | 6.68 |
| 4 | 7.22 | 6.91 | 9.22 | 9.35 |
| 8 | 7.20 | 7.54 | 10.30 | 9.38 |
| 16 | 7.37 | 7.52 | 9.77 | 9.78 |

For example, at 16 callers the median tool batch falls from 6,509.6 ms to
4,913.0 ms with four readers: 24.5% less time, or 32.5% more throughput.
At eight callers, four readers reach 10.30 calls/s versus FIFO's 7.20 calls/s,
a 43.1% throughput increase. Merely changing the single connection's read
transaction mode does not reproduce this improvement.

The short-SQL workload is 768 bounded queries per batch:

| Concurrent callers | FIFO requests/s | 4 readers + 1 writer requests/s | 8 readers + 1 writer requests/s |
| --- | --- | --- | --- |
| 1 | 1,843 | 1,658 | 1,653 |
| 4 | 1,825 | 2,352 | 2,482 |
| 8 | 1,798 | 2,662 | 2,514 |
| 16 | 1,747 | 2,631 | 2,824 |

At 16 callers, the short-SQL median batch falls from 439.6 ms to 291.9 ms
with four readers and 272.0 ms with eight: respectively 50.6% and 61.6% more
throughput. Single-caller performance regresses in both pooled arms; this
experiment does not establish that read routing improves sequential usage.

The event-loop probe exposes a cost. At eight concurrent tool callers, the
median of the per-batch timer-overshoot p95 values rises from 15.1 ms with FIFO
to 33.7 ms with four readers and 46.7 ms with eight. At 16 callers the values
are 15.6, 32.0 and 44.5 ms. These are timer measurements, not physical UI
acceptance. They establish that database throughput and main-thread scheduling
responsiveness need separate evaluation.

## Mixed Reads and Small Writes

The mixed batch contains 43 tool calls and five explicit small write
transactions. Median throughput still improves under concurrent reads:

| Concurrent callers | FIFO requests/s | 4 readers + 1 writer requests/s | 8 readers + 1 writer requests/s |
| --- | --- | --- | --- |
| 1 | 9.12 | 8.83 | 8.40 |
| 4 | 8.93 | 11.21 | 11.23 |
| 8 | 9.75 | 10.79 | 10.74 |
| 16 | 8.32 | 10.32 | 11.12 |

At 16 callers, four readers reduce the median batch from 5,770.6 ms to
4,651.8 ms (19.4% less time, 24.1% more throughput). Eight readers reach
4,316.0 ms (25.2% less time, 33.7% more throughput). However, the write-tail
result depends on load. Pooled p95 over the 25 explicit writes in each cell:

| Concurrent callers | FIFO write p95, ms | 4 readers + 1 writer write p95, ms | 8 readers + 1 writer write p95, ms |
| --- | --- | --- | --- |
| 4 | 39.4 | 39.0 | 39.6 |
| 8 | 18.7 | 46.0 | 104.9 |
| 16 | 182.1 | 42.0 | 81.3 |

Separating the writer from read snapshots helps the 16-caller write tail, but
the eight-caller result regresses. Extra read connections do not by themselves
guarantee faster write completion or a more responsive main thread. The
fixture's five explicit writes per batch are a limited sample of small writes;
they do not establish parse/publication transaction latency.

## Variability and Interpretation

Five measured rounds per cell are sufficient to expose the large differences
here, but do not establish precise population effect sizes. Selected complete
batch ranges and population throughput coefficients of variation (CV):

| Workload, 16 callers | Arm | Median batch, ms | Min–max batch, ms | Throughput CV |
| --- | --- | --- | --- | --- |
| Short SQL, 768 requests | FIFO | 439.6 | 415.0–825.4 | 21.3% |
| Short SQL, 768 requests | 4 readers + 1 writer | 291.9 | 266.7–381.6 | 12.0% |
| Short SQL, 768 requests | 8 readers + 1 writer | 272.0 | 244.7–345.9 | 11.8% |
| MCP tools, 48 requests | FIFO | 6,509.6 | 6,457.3–6,664.8 | 1.1% |
| MCP tools, 48 requests | 4 readers + 1 writer | 4,913.0 | 4,560.0–5,031.2 | 3.7% |
| MCP tools, 48 requests | 8 readers + 1 writer | 4,907.7 | 4,698.1–5,379.9 | 5.0% |
| Mixed, 48 requests | FIFO | 5,770.6 | 5,691.5–6,070.5 | 2.4% |
| Mixed, 48 requests | 4 readers + 1 writer | 4,651.8 | 4,309.7–4,951.9 | 5.5% |
| Mixed, 48 requests | 8 readers + 1 writer | 4,316.0 | 4,158.9–4,916.2 | 6.7% |

No samples were discarded. Other cells have wider overlapping ranges; for
example, single-caller MCP FIFO is 5,736.9–6,965.5 ms and four readers are
4,689.4–7,803.3 ms. Their median sequential regression is a reason to avoid
claiming a general speedup, not proof of a precise sequential penalty.
`summary.md` contains all 48 cells, pooled request/write p95 and paired
same-round speedup ratios; `summary.json` also retains event-loop and queue
statistics. Percentages in this document compare the displayed medians, rather
than the distinct median of paired speedup ratios.

The results support testing a four-reader/one-writer design for concurrent MCP
reading. They do not support simply raising FIFO's request limit, or assuming
that eight readers are better for tool calls. A production change needs safe
read/write routing, deferred consistent snapshots, independent native read
connections, cancellation/draining and authorization/publication regressions.
It also needs to address or bound the measured event-loop cost and recheck
sequential usage and memory. The experiment retains no production performance
candidate: only the reproducible benchmark and evidence report are added.

This is not a measured benefit from moving the service to another JavaScript
thread. The native SQLite connections can progress independently, while the
tool handlers and result handling in this experiment still execute in the
host JavaScript context. Profiling would be needed to attribute the remaining
time precisely among database execution, callback scheduling, state checking,
projection, serialization and garbage collection.

## Question and Experimental Arms

The comparison separates increasing concurrent callers on the existing FIFO
connection from opening multiple independent read connections and retaining one
serialized writer. It also includes a single-connection transaction control.

| Arm | Read execution | Read snapshot transactions | Writes |
| --- | --- | --- | --- |
| `fifo` | Current per-query FIFO on one connection | Current `BEGIN IMMEDIATE` | Same connection, `BEGIN IMMEDIATE` |
| `fifo-deferred` | Same single connection and FIFO | `BEGIN DEFERRED` | Same connection, `BEGIN IMMEDIATE` |
| `readers-4` | Four independent read-only connections | `BEGIN DEFERRED` | One separate FIFO writer, `BEGIN IMMEDIATE` |
| `readers-8` | Eight independent read-only connections | `BEGIN DEFERRED` | One separate FIFO writer, `BEGIN IMMEDIATE` |

Each pooled read request leases one reader until its tool handler finishes.
The single-connection arms retain the current finer-grained per-query
reservation. This is a benchmark prototype, not a complete production routing
implementation. Read-only connections use both `SQLITE_OPEN_READONLY` and
`PRAGMA query_only=ON`. Private read caches avoid Gecko's default shared-cache
table locks. The writer retains its normal shared-cache setting. All arms use
WAL, the existing Zotero query/row wrapper, Kysely and native asynchronous SQLite.
The writer uses `synchronous=FULL`. Each connection has Zotero's 8,192,000-byte
page-cache budget. Eight readers remain open in all arms, so connection opening
and cleanup are outside timing and the experiment does not measure memory cost.
Active aggregate page-cache capacity is therefore larger in the pooled arms;
these numbers are not an equal-total-cache experiment and do not isolate native
thread parallelism from cache and request-scheduling effects.

The single-connection control matters because The measured baseline
uses the generic transaction API for consistent reads, and the production driver
starts every transaction with `BEGIN IMMEDIATE`. Such transactions reserve the
writer even when they contain only SELECT statements. A read connection cannot
execute this transaction mode. The pooled arms therefore require a deferred
read transaction as well as multiple connections.

## Runtime, Fixtures and Method

- Windows 11 10.0.26200; AMD Ryzen 9 5900X, 12 cores / 24 logical processors;
  approximately 31.9 GiB visible RAM. Zotero 10.0.8; controller Node.js 22.23.1.
- The measured baseline uses the 14-migration application schema before the
  [MCP read changes](mcp-read-performance.md). Benchmark-only routing bundles
  those application modules without replacing the installed plugin.
- Existing isolated `.scaffold/profile` and `.scaffold/data`; a new, separate
  scratch database under `.scaffold/database-concurrency/formal-1/`.
  Neither the profile's literature nor its knowledge database is the fixture.
- All fourteen baseline migrations, invariant triggers and foreign keys;
  1,000 resources, sources, generations and root structure nodes, 100 folders,
  100,000 content blocks, 1,024 Unicode characters per block. Total canonical
  Markdown: 102,400,000 characters, also stored as normalized text. Database:
  326,860,800 bytes, approximately 311.7 MiB. Search projections and vectors are
  intentionally not populated; this is not an FTS, ANN or provider benchmark.
- Fixed concurrency 1, 4, 8 and 16; five measured rounds per cell after one full
  warmup batch per arm/workload/concurrency. Arm order reverses every round.
  Equal deterministic request/resource sequences and output budgets in all arms.
- `sql`: 768 short native SQL requests per batch, each returning 12 ordered
  blocks and bounded text substrings. This isolates a relatively small query
  and materialization workload without MCP authorization or presentation.
- `mcp`: 48 actual native MCP tool-handler calls per batch, evenly divided
  between `list_resources` (20 records), `get_resources` (one record),
  `get_resource_content` (12,000-character budget), and `list_content_blocks`
  (20 blocks with previews). Each call performs real token authentication,
  including the current `last_used_at` database write, normal authorization and
  state checks, output construction and final JSON/UTF-8 encoding. Each batch
  executes 3,012 native SQL statements in every arm.
- `mixed`: the same 48-position sequence, replacing every tenth request with a
  serialized read/modify/write transaction on one scratch `plugin_state` counter
  (five explicit writes per batch). The remaining 43 tool calls still perform
  their normal authentication writes. This models small background writes,
  not large parse/index publication transactions.
- Authentication retains its entire existing writer-connection sequence,
  including selector/permission reads and the last-use update. The independent
  readers serve the tool's read paths; the experiment does not introduce an
  authentication cache or reroute authentication statements to other readers.
- Tools execute inside the actual Gecko process. The controller only dispatches
  the harness and reads its evidence files. HTTP/SSE transport, heartbeat,
  handshake and the then-current token/global 4/16 HTTP admission limits are bypassed.
  Consequently these are successful-call service measurements at controlled
  concurrency, not an assertion that the shipping endpoint accepts 16 calls on
  one token. No embedding, reranking or OCR providers are called by the harness.
- Elapsed time covers the complete fixed-size batch. Request latency starts
  when a closed-loop caller claims a request, and includes reader/driver queue
  waits; it excludes any external queue ahead of those callers. Throughput is
  completed requests / batch time. Warmups are excluded. Report medians and
  min–max batch times, population throughput CV, and pooled request p95. These
  are warm-cache measurements, without process restarts or OS cache eviction.
- A recurring 10 ms native timer records event-loop scheduling overshoot. Its
  p95/max is a responsiveness indicator, not a PDF scrolling, frame-rate or
  manual UI measurement. Windows timer granularity contributes to both arms.
  The fixture has uniform synthetic block sizes and a single authorized library;
  it does not establish behavior for every real library or request distribution.

### Accessibility measurement boundary

Native accessibility was disabled before measurement (`accessibility.force_disabled=1`, `accessibilityEnabled=false`, empty activation source) and checked after every batch. An external automation helper remained present. These measurements have that environment limitation and are not a clean helper-free baseline or evidence for accessibility-enabled performance. No UI automation was used by the harness.

## Correctness and Evidence

Before timing, all four tool results must match across arms after replacing
time-dependent continuation tokens with their presence, and must validate
against the published output schemas. The harness checks that readers reject
writes, a read snapshot remains stable while the writer commits, all expected
counter increments survive concurrent execution, and final SQLite integrity
and foreign-key checks pass. Every owned connection closes before the scratch
database's ownership lease is released. This does not substitute for production
tests of token revocation, concurrent publication, connection routing, failure
recovery or shutdown under a future read pool.

The formal run passed all of these assertions and closed every owned native
connection without cleanup errors. It completed 288 batches in 19.3 minutes:
240 measured and 48 warmup batches, with 69,120 measured requests and 82,944
requests including warmups. The postflight snapshot confirms no scratch
database owner remains, the existing plugin is available, no startup error
occurred, and accessibility remains inactive. Repository validation runs only
after native sampling finishes, so the test suite does not compete with the
recorded performance measurements.

Reproduce in a running isolated Zotero after following the repository's helper
and accessibility requirements:

```powershell
$env:ZOTERO_DEBUG_PORT = '7467' # Use the actual isolated debugger port.
$env:BENCHMARK_OUTPUT = '.scaffold/database-concurrency/new-run'
node scripts/measure-database-concurrency.mjs
# Wait until native-results.json records passed and cleanup is complete.
node scripts/summarize-database-concurrency.mjs .scaffold/database-concurrency/new-run/native-results.json
```

The controller refuses output outside `.scaffold`; the native harness refuses
a non-isolated Zotero and refuses to overwrite an existing scratch database.
`BENCHMARK_ROUNDS`, `BENCHMARK_REQUESTS`, `BENCHMARK_DOCUMENTS` and
`BENCHMARK_BLOCKS` can select smaller diagnostic runs. Formal run evidence is
`native-results.json`, `summary.json`, `summary.md` and `host-environment.json`
under `.scaffold/database-concurrency/formal-1/`. Generated databases, reports,
profiles and compiled probes remain Git-ignored. The sources are
`scripts/measure-database-concurrency.mjs`,
`scripts/database-concurrency-native.mjs` and
`scripts/summarize-database-concurrency.mjs`.
