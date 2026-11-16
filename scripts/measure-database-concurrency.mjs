// Developer controller. All measured work runs in isolated native Zotero.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate } from "./verify-vector-native.mjs";

const folder = path.resolve(process.env.BENCHMARK_OUTPUT ?? `.scaffold/database-concurrency/${Date.now()}`);
if (!folder.replaceAll("\\", "/").includes("/.scaffold/")) throw Error("Output must be under .scaffold");
await fs.mkdir(folder, { recursive: true });
const output = path.join(folder, "native-probe.js");
await build({ entryPoints: ["scripts/database-concurrency-native.mjs"], bundle: true, format: "iife", globalName: "DatabaseConcurrencyBenchmark", platform: "browser", target: "firefox140", outfile: output });
const options = {
  folder, rounds: Number(process.env.BENCHMARK_ROUNDS ?? 5), requests: Number(process.env.BENCHMARK_REQUESTS ?? 48),
  documents: Number(process.env.BENCHMARK_DOCUMENTS ?? 1000), blocksPerDocument: Number(process.env.BENCHMARK_BLOCKS ?? 100),
};
for (const [key, value] of Object.entries(options)) if (key !== "folder" && (!Number.isSafeInteger(value) || value < 1)) throw Error(`Invalid ${key}`);
if (options.blocksPerDocument < 12 || options.blocksPerDocument > options.documents) throw Error("Require 12 <= BENCHMARK_BLOCKS <= BENCHMARK_DOCUMENTS");
if (options.requests % 4 !== 0) throw Error("BENCHMARK_REQUESTS must be divisible by four for an even tool mix");
await evaluate(`Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(output).href)}); void DatabaseConcurrencyBenchmark.run(${JSON.stringify(options)})`);
console.log(JSON.stringify({ dispatched: true, folder, options }));
