# Idle refresh and unstable item expansion

Date: 2026-10-25. Windows, Zotero 10.0.6; Node.js 22.23.1 for builds and control only.

## Refresh ownership

Task notifications and collection synchronization invalidate views only when their displayed data changes.

- Identical knowledge/vector-task snapshots do not notify again. Map contents participate in comparison; actual metadata, state, membership and warning changes still publish.
- Task panels render only while visible and after task/notice changes. Active-count changes update the navigation badge without reloading literature rows.
- Actual content changes retain a separate refresh path; task admission/progress/completion remain visible.
- Idle vector ticks still check events/jobs but skip task projection, index synchronization and no-op completion writes when the index is ready. Explicit actions, events, configuration changes and executed jobs still trigger work.
- With no enabled sync binding, only binding display data is reconciled. Deleted destinations still leave the displayed list.
- Outside submitted retrieval, Zotero handles native sorting and attachment expansion directly. Height maps apply only when changed and clear when leaving results.

## Alternating native measurements

The existing isolated library contained nine active papers, 2,907 text blocks including historical versions, and 1,989 active 768D Float32 vectors. The baseline was the preceding ordinary package; the candidate was the corrected production package. Provider calls were zero. Evidence used local full text.

Each version/scenario had three 16-second observations. After recovery and the first background check, versions alternated baseline/candidate, candidate/baseline, baseline/candidate; scenario order reversed in round two. Native search was explicitly cleared and awaited before selecting the knowledge scope and expanding a row. Full Node tests did not run concurrently. Event traces recorded no mouse, keyboard or command input during observations.

Values are median (min–max). SQL counts cover the plugin connection, excluding Zotero's own database. Write-statement counts include zero-row writes and do not measure changed rows or disk I/O. Zero means the call did not occur in a completed observation. CPU deltas include preparation and observation, approximately seventeen seconds in total, from the main process's accumulated CPU time; they are not observation-only percentages or totals for subprocesses/GPU.

| Scenario | Metric | Before | After |
| --- | --- | --- | --- |
| Native attachments | Middle-list reloads | 7 (7–11) | 0 (0–0) |
| Native attachments | Task renders | 7 (7–10) | 0 (0–0) |
| Native attachments | Custom height updates | 7 (7–11) | 0 (0–0) |
| Native attachments | Plugin SQLite query/transaction statements | 378 (371–478) | 233 (233–236) |
| Native attachments | Plugin write statements | 7 (7–17) | 0 (0–0) |
| Native attachments | Main-process CPU delta, seconds | 2.22 (2.11–3.62) | 1.19 (0.56–1.36) |
| Native attachments | Still expanded | 0/3 | 3/3 |
| Native attachments | Median per-window timer-delay P95 | 14 ms | 13 ms |
| Full-text evidence | Middle-list reloads | 11 (8–11) | 0 (0–0) |
| Full-text evidence | Task renders | 10 (8–10) | 0 (0–0) |
| Full-text evidence | Custom height updates | 11 (8–11) | 0 (0–0) |
| Full-text evidence | Plugin SQLite query/transaction statements | 478 (393–478) | 236 (233–236) |
| Full-text evidence | Plugin write statements | 17 (8–17) | 0 (0–0) |
| Full-text evidence | Main-process CPU delta, seconds | 3.58 (2.23–3.59) | 1.25 (0.89–1.28) |
| Full-text evidence | Still expanded | 0/3 | 3/3 |
| Full-text evidence | Median per-window timer-delay P95 | 14 ms | 13 ms |

Both candidate scenarios retained expansion in 3/3 observations with no extra list reload, hidden task render or height update. Median CPU deltas decreased approximately 46% and 65%, respectively, and SQL counts fell. The small timer-P95 difference does not establish general pointer latency, frame rate or equal gains across scenarios. This small real isolated library does not establish large-library, other-plugin or Bailian-network performance. Peak memory was not remeasured.

## Correctness and limits

Regression coverage includes unchanged snapshots, deferred task rendering, navigation counts without list reload, idle vector scheduling, real event/configuration work and delegation of native expansion.

Developer-driven native UI checks injected in-memory task display snapshots for admission/progress/completion. Attachments/evidence stayed expanded, evidence DOM and collapsed passage details persisted, and opening tasks displayed current progress. These snapshots were not saved to the database and do not represent real model-job execution. A separate native-input-traced ordinary expansion remained stable for 45 seconds.

Background checks remain: parse worker approximately 500 ms, vector scheduler/config polling approximately two seconds, collection reconciliation approximately thirty seconds. They no longer redraw literature merely because a timer fired. Candidate observations still made approximately 233–236 plugin SQL calls per sixteen seconds; background cost is not zero. Actual metadata, scope, content and filter changes can still require list updates.

## Reproduction and records

Use only the existing isolated profile without resetting/overwriting its library. Avoid development startup workflows that terminate Zotero processes by name when production is running. Save the original package, prepare both probes, then run:

```powershell
npm run build
node scripts/verify-idle-refresh.mjs prepare baseline .scaffold/idle-refresh-diagnostic/baseline.xpi
node scripts/verify-idle-refresh.mjs prepare candidate .scaffold/build/zotero-knowledge-mcp.xpi
$env:ZOTERO_DEBUG_PORT = "6404"
pwsh -File scripts/measure-idle-refresh.ps1 -Port 6404
node scripts/summarize-idle-refresh.mjs
node scripts/verify-task-refresh-ui.mjs
```

Restore the ordinary XPI, then run `node scripts/verify-idle-production.mjs`. Switching uses the plugin installation API; no retrieval helper process or production-library write is required.
