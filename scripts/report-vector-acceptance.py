"""Development-only English tables/figures from native measurement JSON."""
import argparse
import csv
import json
from pathlib import Path
from statistics import median

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser()
parser.add_argument("performance", type=Path)
parser.add_argument("--output", type=Path, default=Path(".scaffold/vector-acceptance/report"))
args = parser.parse_args()
report = json.loads(args.performance.read_text(encoding="utf-8"))
args.output.mkdir(parents=True, exist_ok=True)
rows = report["rows"]
groups = {}
for row in rows:
    groups.setdefault((row.get("implementation", "production"), row["mode"], row["count"]), []).append(row)

def values(key, field):
    result = []
    for row in groups.get(key, []):
        if row["status"] != "passed":
            continue
        value = row
        for part in field.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        if value is not None:
            result.append(value)
    return result

fields = ["buildMs", "saveMs", "restoreMs", "queryMs.p50", "queryMs.p95", "queryMs.p99", "queryMs.mean", "queryMs.sd", "queryMs.qps", "recall20", "recall100", "extraBuiltRSS", "buildPeakRSS", "savePeakRSS", "restorePeakRSS", "savedStats.wasmHeapBytes", "restoredStats.wasmHeapBytes", "snapshot.bytes"]
summary = []
for key, runs in sorted(groups.items()):
    item = {"implementation": key[0], "mode": key[1], "count": key[2], "passed": sum(row["status"] == "passed" for row in runs), "total": len(runs)}
    for field in fields:
        sample = values(key, field)
        item[field] = median(sample) if sample else None
        item[field + ".range"] = [min(sample), max(sample)] if sample else None
    delta = [row["restoredRSS"] - row["closedRSS"] for row in runs if row["status"] == "passed"]
    item["extraRestoredRSS"] = median(delta) if delta else None
    summary.append(item)
(args.output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
with (args.output / "summary.csv").open("w", newline="", encoding="utf-8-sig") as file:
    writer = csv.DictWriter(file, fieldnames=list(summary[0]) if summary else [])
    writer.writeheader()
    writer.writerows(summary)

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False, "axes.spines.right": False, "svg.fonttype": "none"})
colors = {"f32": "#5844A4", "i8": "#16746E"}


def save_svg(figure, path):
    figure.savefig(path)
    # Matplotlib emits trailing spaces in path data; keep regenerated assets clean.
    source = path.read_text(encoding="utf-8")
    normalized = "\n".join(line.rstrip(" \t") for line in source.splitlines()).rstrip("\n") + "\n"
    path.write_text(normalized, encoding="utf-8")


fig, axes = plt.subplots(2, 2, figsize=(11, 7.4), constrained_layout=True)
for axis, field, title, ylabel, divisor in [
    (axes[0, 0], "queryMs.p95", "Local query P95 (worker RPC and filtering)", "ms", 1),
    (axes[0, 1], "buildMs", "Initial build (independent worker)", "seconds", 1000),
    (axes[1, 0], "saveMs", "Save in 4 MiB chunks", "seconds", 1000),
    (axes[1, 1], "restoreMs", "Restore (hash and worker startup)", "seconds", 1000),
]:
    for implementation in ["reference", "production"]:
        for mode in ["f32", "i8"]:
            selected = sorted([item for item in summary if item["implementation"] == implementation and item["mode"] == mode and item[field] is not None], key=lambda item: item["count"])
            if not selected:
                continue
            x = [item["count"] for item in selected]
            y = [item[field] / divisor for item in selected]
            low = [item[field] / divisor - item[field + ".range"][0] / divisor for item in selected]
            high = [item[field + ".range"][1] / divisor - item[field] / divisor for item in selected]
            label = f'{"Production" if implementation == "production" else "Reference"} {mode.upper()}'
            axis.errorbar(x, y, yerr=[low, high], color=colors[mode], linestyle="-" if implementation == "production" else "--", marker="o" if implementation == "production" else "s", capsize=3, alpha=1 if implementation == "production" else .55, label=label)
    axis.set_xscale("log")
    axis.set_xticks([1000, 10000, 100000], ["1k", "10k", "100k"])
    axis.set_title(title, loc="left")
    axis.set_ylabel(ylabel)
    axis.grid(axis="y", alpha=.18)
axes[0, 0].legend(fontsize=8)
fig.suptitle("768D USearch: median of three rounds; error bars show min to max", fontsize=12)
save_svg(fig, args.output / "performance.svg")
fig.savefig(args.output / "performance.png", dpi=150)
plt.close(fig)

fig, axes = plt.subplots(1, 3, figsize=(12, 3.8), constrained_layout=True)
for axis, field, title in [(axes[0], "extraBuiltRSS", "Extra process RSS after build"), (axes[1], "extraRestoredRSS", "Extra process RSS after restore"), (axes[2], "snapshot.bytes", "Index snapshot file")]:
    for mode in ["f32", "i8"]:
        selected = sorted([item for item in summary if item["implementation"] == "production" and item["mode"] == mode and item[field] is not None], key=lambda item: item["count"])
        axis.plot([item["count"] for item in selected], [item[field] / 1048576 for item in selected], marker="o", color=colors[mode], label=mode.upper())
    axis.set_xscale("log")
    axis.set_xticks([1000, 10000, 100000], ["1k", "10k", "100k"])
    axis.set_ylabel("MiB")
    axis.set_title(title, loc="left")
    axis.grid(axis="y", alpha=.18)
    axis.axhline(0, color="#aaa", linewidth=.5)
axes[0].legend()
fig.suptitle("RSS is the whole Zotero process delta; negative small-corpus values retain GC/baseline variation", fontsize=11)
save_svg(fig, args.output / "memory.svg")
fig.savefig(args.output / "memory.png", dpi=150)
plt.close(fig)

lines = ["| Size | Mode | Completed rounds | Build s | Query P50 / P95 / P99 ms | Mean / SD ms | QPS | R@20 / R@100 | Save / restore s |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
for item in summary:
    if item["implementation"] != "production":
        continue
    if item["passed"] != item["total"]:
        lines.append(f'| {item["count"]} | {item["mode"]} | {item["passed"]}/{item["total"]} | Failed or incomplete; see raw records | — | — | — | — | — |')
        continue
    lines.append(f'| {item["count"]:,} | {item["mode"]} | {item["passed"]}/{item["total"]} | {item["buildMs"]/1000:.2f} | {item["queryMs.p50"]:.3f} / {item["queryMs.p95"]:.3f} / {item["queryMs.p99"]:.3f} | {item["queryMs.mean"]:.3f} / {item["queryMs.sd"]:.3f} | {item["queryMs.qps"]:.1f} | {item["recall20"]*100:.2f}% / {item["recall100"]*100:.2f}% | {item["saveMs"]/1000:.3f} / {item["restoreMs"]/1000:.3f} |')
lines += ["", "| Size | Mode | Extra built RSS MiB | Build peak RSS MiB | Save peak RSS MiB | Extra restored RSS MiB | Saved WASM heap MiB | Snapshot MiB |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
for item in summary:
    if item["implementation"] == "production" and item["passed"] == item["total"]:
        lines.append(f'| {item["count"]:,} | {item["mode"]} | {item["extraBuiltRSS"]/1048576:.2f} | {item["buildPeakRSS"]/1048576:.2f} | {item["savePeakRSS"]/1048576:.2f} | {item["extraRestoredRSS"]/1048576:.2f} | {item["savedStats.wasmHeapBytes"]/1048576:.2f} | {item["snapshot.bytes"]/1048576:.2f} |')
(args.output / "tables.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"Generated {len(summary)} summaries and four figures in {args.output}")
