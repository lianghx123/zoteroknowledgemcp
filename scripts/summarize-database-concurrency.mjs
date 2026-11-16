import fs from "node:fs/promises";
import path from "node:path";

const input = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw Error("Pass the native-results.json path");
const report = JSON.parse(await fs.readFile(input, "utf8"));
if (report.status !== "passed") throw Error(`Incomplete benchmark: ${report.status}: ${report.error ?? ""}`);
const measured = report.samples.filter(sample => !sample.warmup);
const quantile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};
const median = values => quantile(values, 0.5);
const summary = [];
for (const workload of ["sql", "mcp", "mixed"]) for (const concurrency of [1, 4, 8, 16]) {
  const baseline = measured.filter(row => row.workload === workload && row.concurrency === concurrency && row.config === "fifo");
  for (const config of ["fifo", "fifo-deferred", "readers-4", "readers-8"]) {
    const samples = measured.filter(row => row.workload === workload && row.concurrency === concurrency && row.config === config);
    if (samples.length !== report.options.rounds) throw Error(`Missing samples: ${workload}/${concurrency}/${config}`);
    const elapsed = samples.map(row => row.elapsedMs), throughputs = samples.map(row => row.requestsPerSecond);
    const mean = throughputs.reduce((a, b) => a + b, 0) / throughputs.length;
    const sd = Math.sqrt(throughputs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / throughputs.length);
    const ratios = samples.map(row => baseline.find(other => other.round === row.round).elapsedMs / row.elapsedMs);
    summary.push({
      workload, concurrency, config, samples: samples.length, requestsPerBatch: samples[0].count,
      medianElapsedMs: median(elapsed), minElapsedMs: Math.min(...elapsed), maxElapsedMs: Math.max(...elapsed),
      medianRequestsPerSecond: median(throughputs), throughputCvPercent: sd / mean * 100,
      pooledP50Ms: quantile(samples.flatMap(row => row.latencies), 0.5), pooledP95Ms: quantile(samples.flatMap(row => row.latencies), 0.95),
      pooledReadP95Ms: quantile(samples.flatMap(row => row.readLatencies), 0.95), pooledWriteP95Ms: quantile(samples.flatMap(row => row.writeLatencies), 0.95),
      connectionWaitP95Ms: quantile(samples.flatMap(row => row.connectionWaits), 0.95), readerWaitP95Ms: quantile(samples.flatMap(row => row.readerWaits), 0.95),
      eventLoopDelayP95Ms: quantile(samples.flatMap(row => row.eventLoopDelays), 0.95), eventLoopDelayMaxMs: Math.max(...samples.map(row => row.eventLoopDelayMaxMs)),
      pairedSpeedupMedian: median(ratios), pairedSpeedupMin: Math.min(...ratios), pairedSpeedupMax: Math.max(...ratios),
      sqlCallsPerBatch: [...new Set(samples.map(row => row.sqlCalls))],
    });
  }
}
await fs.writeFile(path.join(path.dirname(input), "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
const lines = ["# Native database concurrency measurements", "", `Runtime: Zotero ${report.environment.version}; ${report.fixture.documents} documents; ${report.fixture.blocks} blocks; ${report.fixture.databaseBytes} database bytes.`, "", "Values are five-round medians for elapsed time and throughput; request p95 pools the measured rounds. Brackets show elapsed-time min–max. Speedup compares equal-concurrency rounds to FIFO. CV is population SD / mean throughput.", ""];
for (const workload of ["sql", "mcp", "mixed"]) {
  lines.push(`## ${workload}`, "", "| Concurrent requests | Connections | Batch ms [min–max] | Requests/s | Request p95 ms | Write p95 ms | Paired speedup | CV |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of summary.filter(row => row.workload === workload)) {
    lines.push(`| ${row.concurrency} | ${row.config} | ${row.medianElapsedMs.toFixed(1)} [${row.minElapsedMs.toFixed(1)}–${row.maxElapsedMs.toFixed(1)}] | ${row.medianRequestsPerSecond.toFixed(1)} | ${row.pooledP95Ms.toFixed(1)} | ${row.pooledWriteP95Ms.toFixed(1)} | ${row.pairedSpeedupMedian.toFixed(2)}× | ${row.throughputCvPercent.toFixed(1)}% |`);
  }
  lines.push("");
}
await fs.writeFile(path.join(path.dirname(input), "summary.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
