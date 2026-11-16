# Plugin enabled/disabled runtime comparison

Measured on 2026-10-29 on Windows, Zotero 10.0.6 / Gecko 140.17.0,
AMD Ryzen 9 5900X (24 logical processors), approximately 32 GiB RAM.
Node.js 22.23.1 controlled the experiment; measured application work ran in Zotero.

## Findings

For this nine-paper library, enabling the plugin clearly increased memory and
delayed the common addon-startup checkpoint. It did not demonstrate a sustained
idle CPU increase or a general slowdown of the tested native operations. Native
attachment toggles incurred approximately 1–1.5 ms more work. Explicit list refresh
had a higher median, with substantial variation between launches.

These findings apply to the small existing development library and the measured
production package. They do not establish large-library capacity or negligible
cost under document ingestion, PDF reading or external MCP traffic.

## Package, fixture and controls

- Production plugin version: `0.1.2`, 507,529-byte XPI, without development inline
  source maps or instrumentation in the application bundle.
- SHA-256: `fd2f97a5336f16542bdee26fad2fdddece4592e2b7941d106c3a964b45d567c8`.
  The frozen package and installed benchmark extension had identical hashes.
- The original isolated development instance was closed normally and its watcher
  stopped. Its profile and data were copied under the ignored directory
  `.scaffold/plugin-overhead-20261029/`. All condition changes and measured restarts
  used that copy. No production Zotero library was opened.
- The library contained nine native top-level papers, three native collections,
  nine knowledge resources, 2,907 content blocks including history and 1,989
  persisted 768D Float32 embeddings/index entries. Native collection `C1` contained
  five papers. Vector count is not paper count.
- Initial and final task counts were nine successful parses and nine successful
  embedding jobs, with one active vector index. Content/index counts were
  unchanged. Enabled observations waited for startup recovery and index readiness.
- Jasminum 1.1.41 stayed enabled. The other two pre-existing MCP extensions stayed
  disabled. Automatic extension updates were disabled in the benchmark copy for
  both conditions. Native search used title/creator/year and the same `Bank` query.
  No provider-backed search or ingestion was requested; network packets were not
  traced.
- A separate small measurement addon was enabled in both conditions. It logged a
  common addon-startup checkpoint once per launch and did not poll during idle.
  The production plugin was enabled/disabled through AddonManager and the entire
  application restarted between observations.
- Each condition received one discarded launch warmup. Six measured pairs used
  alternating disabled/enabled and enabled/disabled order: six independent process
  launches per condition, twelve accepted measured launches in total. OS file and
  script caches were retained; these are application restarts, not fully cold disk
  or operating-system boots. No forced GC was used.
- Other desktop applications remained open. Alternation reduces order bias but
  does not isolate all host scheduling, GPU or memory-management effects.

## Measurement boundaries

Startup starts at the external process-launch request. First paint is Zotero's
`Services.startup.getStartupInfo().firstPaint`. A debugger observer attached before
the native pane became loaded in every accepted run and checked native list
readiness every 10 ms. Readiness requires a complete main document, a loaded
ZoteroPane and a nonempty native row provider; all accepted observations had nine
rows. This is list population, not first human interaction or completed pixel
presentation.

The common addon checkpoint is later: the separate measurement addon's startup
has run and the native list is populated. The target plugin starts before that
probe in this profile. It measures arrival at that point in addon initialization,
not a delay imposed on the initial native list. Background recovery is separately
awaited before idle or operation measurements; no precise total semantic-readiness
latency is claimed here.

After readiness and five seconds of settling, each measured process had a
30-second idle observation with process counters sampled approximately every
250 ms. Main, GPU and socket process membership was checked before/after and had
to remain stable. CPU derives from accumulated process CPU-time deltas divided by
actual sample elapsed time; the percentages below also divide by 24 logical
processors, matching a whole-machine percentage scale. All accepted idle records
had zero keyboard/mouse/wheel events in the Zotero window, nine native rows and a
visible document at observation start/end. Other applications' input was not
recorded, and start/end checks do not prove continuous foreground focus.

Private bytes measure private committed address space, which can have RAM or
pagefile backing. Main-process RSS is its resident working set, including shared
pages. They must not be added together. Summed process-tree RSS can double-count
shared pages, so the main result uses tree private bytes and main-process RSS.
Memory is the median sampled value within each observation, then the median
across six launches. No startup memory peak was measured.

The eight native operations used Zotero's real API/row-provider/selection paths in
a visible maximized window. Each launch executed two discarded warmup iterations
and eight measured iterations per operation: 48 accepted samples per operation and
condition. Timing includes the awaited operation and a forced item-list layout;
row counts, selected item or expansion state must match the expected result.
Each launch's median is computed first, then those six launch medians are
compared. Samples from one process are not treated as independent launches. These
are developer-driven native measurements, not manual pointer latency or FPS.

## Startup, idle CPU and memory

Values are median (minimum–maximum across six launches). Differences are enabled
minus disabled medians. Memory units are MiB; CPU values are percent of all 24
logical processors.

| Measurement | Disabled | Enabled | Difference |
| --- | ---: | ---: | ---: |
| Launch to native first paint, ms | 1494.50 (1424–1614) | 1443.50 (1376–1528) | -51.00 |
| Launch to native list populated, ms | 2411.00 (2271–2568) | 2340.50 (2260–2607) | -70.50 |
| Launch to common addon checkpoint, ms | 3034.50 (2473–3257) | 3706.00 (3575–3923) | +671.50 |
| Idle process-tree CPU, % | 0.103 (0.076–0.138) | 0.090 (0.080–0.130) | approximately -0.013 percentage points |
| Idle process-tree private memory, MiB | 434.19 (429.11–446.75) | 513.06 (505.49–614.56) | +78.88 |
| Idle main-process private memory, MiB | 223.33 (220.98–225.50) | 278.17 (270.46–386.06) | +54.84 |
| Idle main-process RSS, MiB | 290.95 (288.29–292.44) | 341.39 (334.12–440.49) | +50.44 |
| Per-observation 100-ms timer-delay P95, ms | 8.52 (8.19–8.82) | 9.64 (8.28–10.96) | +1.13 |

Small negative CPU/native-startup differences do not establish that the plugin
accelerates Zotero. The exploratory paired bootstrap interval includes zero for
each of those effects. Timer delay is not mouse latency or display smoothness.

The common addon checkpoint was consistently later with the plugin: paired median
increase 717 ms, exploratory interval 512–995 ms. Its extra initialization work
largely followed native list population in these observations.

The memory difference is clear, but it is not a fixed 79-MiB budget. Two enabled
launches retained substantially higher private-memory values. They remain in the
results; their cause was not isolated. The paired median tree-private difference
was 81.39 MiB, exploratory interval 65.38–175.58 MiB. No attempt was made to force
all processes to the same GC state. Costs cannot be divided by nine and projected
linearly per paper; shared startup state and index size have different scaling.

## Native operations

Milliseconds, median of per-launch medians (range of per-launch medians).

| Operation | Disabled | Enabled | Difference |
| --- | ---: | ---: | ---: |
| Open native collection | 139.84 (99.26–171.40) | 106.48 (81.73–190.45) | -33.37 |
| Return to My Library | 123.91 (115.91–130.70) | 113.78 (90.86–145.54) | -10.12 |
| Native title/creator/year search | 60.84 (48.10–73.23) | 61.88 (34.69–90.96) | +1.04 |
| Clear native search | 39.14 (33.09–41.41) | 37.02 (34.12–46.57) | -2.13 |
| Expand native attachments | 12.94 (12.54–13.62) | 14.03 (12.98–14.23) | +1.09 |
| Collapse native attachments | 11.28 (11.13–11.87) | 12.73 (12.00–13.02) | +1.45 |
| Select a native item | 66.57 (65.53–68.70) | 68.13 (65.89–69.69) | +1.56 |
| Explicit list refresh, preserving selection | 57.77 (56.31–61.07) | 70.90 (53.17–80.57) | +13.13 |

Attachment toggles had consistent small additional cost: paired median increases
0.96 ms for expansion and 1.33 ms for collapse. Exploratory intervals were
0.22–1.37 and 0.88–1.60 ms respectively. Other operation intervals included zero.
For refresh, the paired median increase was 12.97 ms with interval -3.37–23.18 ms;
the observed median warrants profiling, but does not establish a stable universal
13-ms penalty. Faster collection-switch medians do not prove acceleration;
startup work can change native cache state and this experiment did not isolate
that mechanism.

All intervals are descriptive, exploratory 95% paired-bootstrap intervals using
5,000 seeded resamples of six launch pairs. There is no correction for multiple
comparisons and six pairs cannot establish population guarantees. Standard
deviations, all paired differences and every accepted raw sample are retained in
the generated evidence.

## Exclusions, verification and remaining scope

PDF opening and
reading, sorting, import/edit/delete/sync, long-session growth/leaks, battery use,
external-client load, large libraries and combinations with other plugins beyond
this profile were not benchmarked. The earlier
[vector scale measurements](vector-retrieval-acceptance.md) are a separate
experiment and must not be added to these memory deltas.
