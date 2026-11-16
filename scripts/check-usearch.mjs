import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Git and Emscripten can emit different text line endings. Canonicalize only
// CRLF in text; every WASM byte remains part of its binary identity.
export function usearchHash(file, bytes) {
  const canonical = file.endsWith(".wasm") ? bytes : Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"));
  return createHash("sha256").update(canonical).digest("hex");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
const files = ["vendor/usearch/wrapper.cpp", "vendor/usearch/source/c/lib.cpp", "vendor/usearch/source/c/usearch.h",
  "vendor/usearch/source/include/usearch/index.hpp", "vendor/usearch/source/include/usearch/index_dense.hpp", "vendor/usearch/source/include/usearch/index_plugins.hpp",
  "addon/content/vector/usearch.mjs", "addon/content/vector/usearch.wasm"];
const actual = Object.fromEntries(files.map(file => [file, usearchHash(file, fs.readFileSync(file))]));
const manifestPath = "vendor/usearch/build.json";
if (process.argv.includes("--write")) {
  fs.writeFileSync(manifestPath, JSON.stringify({ hashFormat: "sha256-lf-text-v1", version: "2.26.5", vectorArenaMiB: 32, graphArena: "upstream", outputChunkMiB: 4,
    metric: "cosine", simd: true, openmp: false, numkong: false, maxWasmMemory: 2147483648, hashes: actual }, null, 2) + "\n");
} else {
  const expected = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (expected.hashFormat !== "sha256-lf-text-v1" || JSON.stringify(actual) !== JSON.stringify(expected.hashes)) throw Error("USearch sources/assets differ; rebuild with scripts/build-usearch.ps1.");
}
console.log("USearch source and packaged WASM identities verified.");
}
