import fs from "node:fs";
import assert from "node:assert/strict";

const file = process.argv[2];
if (!file) throw Error("Usage: node scripts/summarize-mcp-reads.mjs <native-results.json>");
const report = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(report.status, "passed", report.error);
assert.equal(report.cleanup.passed, true);
function stats(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { n: values.length, mean, min: Math.min(...values), max: Math.max(...values),
    cv: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) / mean * 100 };
}
function table(records, key, columns) {
  const rows = [];
  for (const name of [...new Set(records.map(row => row[key]))]) {
    const row = { name };
    for (const variant of ["baseline", "candidate"]) {
      const samples = records.filter(row => !row.warmup && row[key] === name && row.variant === variant);
      row[variant] = Object.fromEntries(columns.map(column => [column, stats(samples.map(sample => sample[column]))]));
    }
    const a = row.baseline[columns[0]].mean, b = row.candidate[columns[0]].mean;
    row.ratio = a / b; row.reductionPercent = (1 - b / a) * 100; rows.push(row);
  }
  return rows;
}
const summary = {
  source: file, environment: report.environment, fixture: report.fixture, options: report.options,
  reads: table(report.samples, "scenario", ["elapsedMs", "sqlCalls", "bytes"]),
  concurrency: table(report.batches, "concurrency", ["elapsedMs", "requestsPerSecond", "p95Ms", "eventLoopP95Ms", "eventLoopMaxMs", "sqlCalls"]),
  writes: table(report.writes, "workload", ["elapsedMs"]),
  warmupRows: report.samples.filter(sample => sample.warmup).map(({ scenario, variant, rows, sqlCalls }) => ({ scenario, variant, rows, sqlCalls })),
};
console.log(JSON.stringify(summary, null, 2));
