import fs from "node:fs/promises";
import path from "node:path";
const folder = path.resolve(process.argv[2] ?? ".scaffold/startup-optimization");
const read = async name => JSON.parse(await fs.readFile(path.join(folder, name), "utf8"));
const trials = await read("trials.json"), samples = [];
for (const trial of trials) {
  const events = (await fs.readFile(path.join(folder, `${trial.label}.jsonl`), "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse)
    .filter(row => row.pid === trial.pid && row.at >= trial.launched);
  const at = name => events.find(row => row.event === name)?.at;
  const elapsed = name => at(name) === undefined ? null : at(name) - trial.launched;
  const list = events.find(row => row.event === "native-list-ready");
  samples.push({ ...trial, shutdownKind: trial.purgeCaches === false ? "addon-update" : "last-window-close", bootstrapMs: at("bootstrap-ready") - at("bootstrap-start"), interfaceMs: elapsed("bootstrap-ready"),
    nativeListMs: elapsed("native-list-ready"), fulltextMs: elapsed("fulltext-ready"), semanticMs: elapsed("index-ready"),
    firstPaintMs: list?.startup?.firstPaint ? Date.parse(list.startup.firstPaint) - trial.launched : null,
    shutdownMs: at("shutdown-end") === undefined ? null : at("shutdown-end") - at("shutdown-start") });
}
function stats(values) {
  values = values.filter(value => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!values.length) return { count: 0, median: null, min: null, max: null, sd: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { count: values.length, median: (values[Math.floor((values.length - 1) / 2)] + values[Math.ceil((values.length - 1) / 2)]) / 2,
    min: values[0], max: values.at(-1), mean, sd: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) };
}
const summary = Object.fromEntries(["baseline", "candidate"].map(label => [label, Object.fromEntries(
  ["bootstrapMs", "interfaceMs", "nativeListMs", "fulltextMs", "semanticMs", "firstPaintMs", "shutdownMs"].map(metric => [metric,
    stats(samples.filter(row => !row.warmup && row.label === label).map(row => row[metric]))]))]));
await fs.writeFile(path.join(folder, "summary.json"), JSON.stringify({ samples, summary }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
