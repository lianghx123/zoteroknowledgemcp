# Startup optimization and native verification

Date: 2026-10-25. Windows, Zotero 10.0.6; Node.js 22.23.1 for builds, control and summaries only.

## Implemented behavior

Database opening, migrations, runtime capabilities and integrity checks remain startup prerequisites. The application then reads persisted knowledge state and registers UI/settings. After native UI readiness, metadata, files, parsing tasks, embedding tasks, collection synchronization, FTS and local vector indexes recover in stages with event-loop yields.

- Historical successful parse generations no longer repeat full metadata reconciliation; new publications still refresh it. Initial configuration loading no longer starts an extra parallel parse-task snapshot.
- Full text becomes available at its own checkpoint. Semantic/enhanced wait for index recovery; fusion can use ready fulltext/metadata channels while vector recovery is pending or failed, and reports degradation explicitly. The retrieval service enforces channel readiness too.
- Enter before the selected mode has any ready channel retains native rows and makes no model request. Fusion can execute its ready channels during vector recovery. Readiness does not automatically submit old input.
- WASM loading and worker deadlines use process-lived primitives. Index-stage failures retain safe diagnostics and retry locally after 500 and 2,000 ms before requiring manual retry. The dated timing measurements below predate these recovery guarantees; they do not measure their performance.
- Search hints, task notices and maintenance show the current stage. Failure exposes the stage and a retry that resumes there without repeating completed stages.
- Processing and maintenance wait for relevant checkpoints. Vector recovery uses canonical local vectors/snapshots; normal scheduling starts afterward and handles jobs under existing settings.
- Shutdown cancels future stages, rejects waiting actions and signals producers, then drains current recovery/accepted work before database close. No hidden window is introduced.
- All new messages were translated into seven locales. Catalog tests reject untranslated message-ID prefixes.

Recovery does not delete data/vectors/indexes, bypass database protections, reset the library or change model/dimensions/USearch parameters.

## Measurement conditions

Both packages use the same build options and inline source-map setting. Only diagnostic packages add synchronous stage logs; production has no timing probes.

The same existing isolated library/settings/hardware contained nine active papers, 2,907 text blocks including history, and 1,989 current 768D Float32 vectors. The library was not restored/overwritten. Each version/group had one warmup, then four measured samples in ABBA order. Full Node tests did not overlap timing; the watcher was paused. Each process closed normally and was confirmed exited before the next launch.

Plugin initialization spans bootstrap entry to UI registration, not all background readiness. Full-text readiness is the first completed local FTS projection; semantic readiness is the first local index recovery/sync. Neither includes query embedding/rerank HTTP. Native first paint comes from `Services.startup.getStartupInfo()` and does not mean item/plugin readiness. Other metrics start at an external process-launch request.

Each cell is median / min–max / population SD in milliseconds, n=4. Small samples and variability limit generalization.

## Normal installation with host caches retained

Versions switched through the normal addon installation flow before process restart, without `--purgecaches`. These are process launches, not hot reloads. Installation may still invalidate some host caches; fully warm caches are not established.

| Metric | Before | After |
| --- | --- | --- |
| Plugin initialization | 551.0 / 534–688 / 62.4 | 321.0 / 287–400 / 43.8 |
| Launch → plugin UI registered | 2838.0 / 2610–3178 / 222.3 | 2369.5 / 2163–3356 / 465.8 |
| Launch → FTS ready | 6091.0 / 5821–6404 / 233.7 | 3793.5 / 3472–5054 / 610.0 |
| Launch → semantic index ready | 6262.0 / 6067–6587 / 221.7 | 3974.5 / 3639–5227 / 608.5 |
| Launch → native first paint | 1406.5 / 1293–1529 / 86.2 | 1283.0 / 1207–1932 / 293.9 |

Median initialization fell approximately 42%, 551 → 321 ms; UI registration 2.84 → 2.37 s; FTS readiness 6.09 → 3.79 s; semantic recovery approximately 37%, 6.26 → 3.97 s. The slower candidate 5.23-second semantic sample remains included. Mean first paint was approximately 1.41/1.43 seconds with larger candidate variation, so the first screen was not established as consistently faster. The demonstrated gains concern startup prerequisites and usable retrieval checkpoints.

The first shutdown log per trial records addon replacement, not last-window exit, and cannot be compared directly with the next group.

## Development launches with forced cache purging

Both versions used `--purgecaches` after direct same-version diagnostic-package replacement. The flag clears host script/resource caches, not literature/vectors. This group is separate.

| Metric | Before | After |
| --- | --- | --- |
| Plugin initialization | 886.0 / 670–2084 / 557.6 | 527.0 / 478–638 / 61.9 |
| Launch → plugin UI registered | 4403.0 / 2942–4629 / 680.6 | 4578.0 / 4145–4884 / 273.1 |
| Launch → FTS ready | 7471.0 / 5761–7841 / 831.5 | 8387.5 / 7277–9526 / 946.7 |
| Launch → semantic index ready | 7590.5 / 5898–7982 / 831.7 | 8916.5 / 7706–10056 / 1004.3 |
| Launch → native first paint | 1407.0 / 1332–1534 / 76.9 | 1391.0 / 1370–1600 / 93.9 |

Plugin initialization shortened, but total UI/index readiness did not consistently improve: median semantic readiness regressed 7.59 → 8.92 seconds. Some candidate file/task stages waited longer and substantial variation preceded bootstrap. Host cache, background activity and resource-loading effects were not fully isolated. Differences cannot all be charged to one function, or faster samples used to claim gains for every launch mode.

The retained design is supported by normal-install readiness gains, initialization gains in both groups and verified recovery/shutdown semantics. Total startup under forced purging remains unresolved, not a completed optimization.

## Correctness and shutdown evidence

| Layer | Result and boundary |
| --- | --- |
| Static/database | Type checking, migration integrity and generated field dictionary checks |
| Node | Regression coverage: stage order/readiness, retries, delayed cancellation, draining, completed-publication deduplication, new publication, network-free recovery and pre-ready search guards |
| Installed Zotero package | FTS returned five papers; restored semantic search returned nine. Query HTTP was replaced with an existing local vector to check recovery, not claimed as new live Bailian acceptance |
| Native UI | Paused index recovery: full text enabled, semantic disabled; Enter retained row count and provider calls stayed zero. Injected index failure retried successfully without auto-submitting old input |
| Seven locales | Native Fluent/settings DOM rendered translated failure hints, disabled maintenance and visible retry. Application language was unchanged; developer-driven DOM checks are not manual review of every screen |
| Close before recovery | Last-window close after reload, before metadata/completed stages: state became closed and later stages did not run. Shutdown logged 61 ms; independent process check confirmed exit within two seconds |
| Repeated launches/replacement | Every launch confirmed preceding process exit. Replacement, retry and final ordinary-package restoration checked; not every transient window creation was recorded |
| Network | No new live embedding/rerank calls for startup acceptance; Bailian latency excluded from startup metrics |

## Reproduction and records

Use only the existing isolated development instance, without resetting its library or operating production/concurrent Zotero. Archive the baseline, build the candidate, then prepare probes:

```powershell
npm run build
node scripts/verify-startup-recovery.mjs prepare baseline .scaffold/startup-optimization/baseline.xpi
node scripts/verify-startup-recovery.mjs prepare candidate .scaffold/build/zotero-knowledge-mcp.xpi
$env:ZOTERO_DEBUG_PORT = "6404"
# Normal installation, retained caches; the existing isolated debugger must match.
pwsh -File scripts/measure-startup-recovery.ps1 -Port 6404
node scripts/summarize-startup-recovery.mjs
# Archive preceding logs first; keep forced-purge statistics separate.
pwsh -File scripts/measure-startup-recovery.ps1 -Port 6404 -PurgeCaches
```

UI and early-close probes: `scripts/verify-startup-ui.mjs`, `scripts/verify-startup-recovery.mjs early-close candidate`. Restore the ordinary `.scaffold/build/zotero-knowledge-mcp.xpi` through normal installation, checking package identity/readiness. Do not deliver diagnostic packages.

These dated startup measurements are separate from [idle-refresh measurements](idle-refresh.md). They do not establish startup timings for later packages.
