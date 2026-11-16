import fs from "node:fs/promises";
import path from "node:path";
const folder = path.resolve(".scaffold/idle-refresh-diagnostic");
const trials = JSON.parse(await fs.readFile(path.join(folder, "trials.json"), "utf8"));
const samples = [];
for (const trial of trials) {
  const sample = JSON.parse(await fs.readFile(path.join(folder, trial.file), "utf8"));
  if (sample.status !== "passed") throw Error(`Incomplete measurement: ${trial.file}`);
  samples.push({ ...trial, ...sample });
}
const statistics = values => {
  values = values.toSorted((a, b) => a - b); const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { count: values.length, median: (values[Math.floor((values.length - 1) / 2)] + values[Math.ceil((values.length - 1) / 2)]) / 2,
    min: values[0], max: values.at(-1), mean, sd: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) };
};
const summary = {};
for (const mode of ["plain", "evidence"]) for (const engine of ["baseline", "candidate"]) {
  const rows = samples.filter(row => row.engine === engine && row.mode === mode);
  if (rows.length !== 3) throw Error(`Expected three completed samples: ${engine}/${mode}`);
  const counters = Object.fromEntries(["queries", "writeQueries", "itemRefresh", "taskRender", "embeddingProjection", "rowHeightUpdate", "metadataReconcile", "indexSync", "embeddingCalls", "rerankCalls"]
    .map(name => [name, statistics(rows.map(row => row.counts[name] ?? 0))]));
  summary[`${engine}/${mode}`] = { samples: rows.length, expanded: rows.filter(row => row.finalOpen).length,
    transitions: rows.reduce((sum, row) => sum + row.transitions.length, 0), interactions: rows.reduce((sum, row) => sum + (row.interactions?.length ?? 0), 0),
    counters, cpuMs: statistics(rows.map(row => row.cpuMs)), timerP95Ms: statistics(rows.map(row => row.timerLagMs.p95)), timerMaxMs: statistics(rows.map(row => row.timerLagMs.max)) };
}
await fs.writeFile(path.join(folder, "summary.json"), JSON.stringify({ summary, samples }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
