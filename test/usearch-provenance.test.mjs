import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { usearchHash } from "../scripts/check-usearch.mjs";

test("USearch text identities survive Git checkout line endings while detecting source changes", () => {
  const lf = Buffer.from("source\nline\n"), crlf = Buffer.from("source\r\nline\r\n");
  assert.equal(usearchHash("wrapper.cpp", lf), usearchHash("wrapper.cpp", crlf));
  assert.notEqual(usearchHash("wrapper.cpp", lf), usearchHash("wrapper.cpp", Buffer.from("source\nchanged\n")));
  assert.notEqual(usearchHash("engine.wasm", lf), usearchHash("engine.wasm", crlf));
});

test("USearch committed blobs and local assets match the canonical provenance", () => {
  const manifest = JSON.parse(readFileSync("vendor/usearch/build.json", "utf8"));
  assert.equal(manifest.hashFormat, "sha256-lf-text-v1");
  for (const [file, expected] of Object.entries(manifest.hashes)) {
    assert.equal(usearchHash(file, readFileSync(file)), expected, file);
    assert.equal(usearchHash(file, execFileSync("git", ["show", `HEAD:${file}`], { maxBuffer: 10_000_000 })), expected, `Committed ${file}`);
  }
});
