// Summarize per-launch paired observations without treating repeated UI calls as independent launches.
import fs from "node:fs/promises";
import path from "node:path";

const folder = path.resolve(process.argv[2] ?? ".scaffold/plugin-overhead-20261029");
const read = async name => JSON.parse(await fs.readFile(path.join(folder, name), "utf8"));
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p, low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
};
const median = values => quantile(values, 0.5);
const stats = values => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { n: values.length, median: median(values), min: Math.min(...values), max: Math.max(...values), mean,
    sd: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) };
};
const list = await read("trials.json");
const measured = (Array.isArray(list) ? list : [list]).filter(row => !row.warmup);
const trials = measured.filter(row => measured.some(other => other.pair === row.pair && other.label !== row.label));
if (!trials.length) throw Error("No complete measured pairs yet.");
const events = (await fs.readFile(path.join(folder, "startup.jsonl"), "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
const logicalProcessors = Number(process.env.NUMBER_OF_PROCESSORS ?? 24);
const observations = [];
for (const trial of trials) {
  const processSamples = await read(`${trial.id}-processes.json`);
  const idle = await read(`${trial.id}-idle-end.json`);
  const operations = await read(`${trial.id}-operations.json`);
  const early = await read(`${trial.id}-early-startup.json`);
  if(early.attached >= early.paneLoaded || early.pid !== trial.pid)throw Error(`Startup observer attached too late: ${trial.id}`);
  if (idle.status !== "passed" || operations.status !== "passed" || idle.input || idle.hidden) throw Error(`Invalid trial ${trial.id}`);
  const first = processSamples[0], last = processSamples.at(-1), elapsedMs = last.at - first.at;
  const operationMedians = {};
  for (const operation of new Set(operations.samples.map(row => row.operation))) {
    operationMedians[operation] = median(operations.samples.filter(row => row.operation === operation && !row.warmup).map(row => row.layoutMs));
  }
  const ui = events.find(row => row.pid === trial.pid && row.at >= trial.launched && row.event === "ui-ready");
  observations.push({
    id: trial.id, label: trial.label, pair: trial.pair,
    nativeListReadyMs: early.nativeListReady-trial.launched,
    addonCheckpointMs: trial.nativeListMs,
    observerAttachedMs: early.attached-trial.launched,
    uiCheckpointMs: ui.at - trial.launched,
    firstPaintMs: new Date(trial.startup.firstPaint).getTime() - trial.launched,
    idleElapsedMs: elapsedMs,
    treeCpuMs: last.cpuMs - first.cpuMs,
    mainCpuMs: last.mainCpuMs - first.mainCpuMs,
    treeCpuPercent: (last.cpuMs - first.cpuMs) / elapsedMs * 100 / logicalProcessors,
    mainCpuPercent: (last.mainCpuMs - first.mainCpuMs) / elapsedMs * 100 / logicalProcessors,
    treeCorePercent: (last.cpuMs - first.cpuMs) / elapsedMs * 100,
    treePrivateMiB: median(processSamples.map(row => row.privateBytes / 1048576)),
    mainPrivateMiB: median(processSamples.map(row => row.mainPrivateBytes / 1048576)),
    mainRssMiB: median(processSamples.map(row => row.mainWorkingSetBytes / 1048576)),
    treeRssMiB: median(processSamples.map(row => row.workingSetBytes / 1048576)),
    idleTimerP95Ms: quantile(idle.delays, 0.95),
    processCount: first.processes.length,
    operations: operationMedians,
  });
}
let seed = 20261029;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
function compare(metric, getValue) {
  const disabled = observations.filter(row => row.label === "disabled"), enabled = observations.filter(row => row.label === "enabled");
  const pairs = disabled.flatMap(row => {
    const other = enabled.find(candidate => candidate.pair === row.pair);
    return other ? [{ pair: row.pair, disabled: getValue(row), enabled: getValue(other), delta: getValue(other) - getValue(row) }] : [];
  });
  const bootstrap = Array.from({ length: 5000 }, () => median(Array.from({ length: pairs.length }, () => pairs[Math.floor(random() * pairs.length)].delta)));
  const a = stats(disabled.map(getValue)), b = stats(enabled.map(getValue));
  return { metric, disabled: a, enabled: b, deltaOfMedians: b.median - a.median, percentOfDisabled: (b.median / a.median - 1) * 100,
    paired: { n: pairs.length, medianDelta: median(pairs.map(row => row.delta)), exploratory95: [quantile(bootstrap, 0.025), quantile(bootstrap, 0.975)], pairs } };
}
const metrics = ["nativeListReadyMs", "addonCheckpointMs", "firstPaintMs", "treeCpuMs", "treeCpuPercent", "mainCpuPercent", "treeCorePercent", "treePrivateMiB", "mainPrivateMiB", "mainRssMiB", "treeRssMiB", "idleTimerP95Ms"].map(metric => compare(metric, row => row[metric]));
const operations = Object.keys(observations[0].operations).map(operation => compare(operation, row => row.operations[operation]));
const summary = { generated: new Date().toISOString(), logicalProcessors, completedLaunches: observations.length,
  artifact: await read("artifact.json"), metrics, operations, observations };
await fs.writeFile(path.join(folder, "summary.json"), JSON.stringify(summary, null, 2));
const fmt = value => value.toFixed(2);
const table = rows => ["| Metric | Disabled median (min–max) | Enabled median (min–max) | Difference | Paired median difference, exploratory 95% interval |", "| --- | ---: | ---: | ---: | ---: |", ...rows.map(row => `| ${row.metric} | ${fmt(row.disabled.median)} (${fmt(row.disabled.min)}–${fmt(row.disabled.max)}) | ${fmt(row.enabled.median)} (${fmt(row.enabled.min)}–${fmt(row.enabled.max)}) | ${fmt(row.deltaOfMedians)} | ${fmt(row.paired.medianDelta)} [${row.paired.exploratory95.map(fmt).join(", ")}] |`)].join("\n");
await fs.writeFile(path.join(folder, "summary.md"), `# Plugin enabled/disabled native comparison\n\nCompleted measured launches: ${observations.length}. CPU percentages use ${logicalProcessors} logical processors. Memory is MiB. UI values summarize each launch's median first, then compare launches.\n\n${table(metrics)}\n\n${table(operations)}\n`);
console.log(await fs.readFile(path.join(folder, "summary.md"), "utf8"));
