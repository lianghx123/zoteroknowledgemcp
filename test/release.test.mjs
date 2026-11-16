import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import AdmZip from "adm-zip";
import { prepareRelease, releaseNotes, validateReleaseMetadata } from "../scripts/prepare-release.mjs";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const manifest = JSON.parse(await readFile("addon/manifest.json", "utf8"));
const tag = `v${pkg.version}`;

async function fixture(t, mutate = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    "manifest.json": JSON.stringify(manifest), "bootstrap.js": "// bootstrap",
    "content/main.js": "// main", "content/settings.js": "// settings",
    "content/sync-settings.js": "// sync", "content/vector/worker.js": "// worker",
    "content/vector/usearch.mjs": "// wrapper", "content/vector/usearch.wasm": "wasm",
    "content/vector/LICENSE": "license", "content/vector/NOTICE": "notice",
    "content/licenses/project.txt": "project license",
    "content/licenses/third-party.txt": "dependency notices", "content/licenses/katex.txt": "math license",
    "locale/en-US/knowledgemcp.ftl": "title = Test",
  };
  const zip = new AdmZip();
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, ".scaffold/build/addon", name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
    zip.addFile(name, Buffer.from(contents));
  }
  mutate(zip);
  for (const [name, contents] of Object.entries({ "package.json": JSON.stringify(pkg),
    "LICENSE": "project license",
    "package-lock.json": JSON.stringify(lock), "addon/manifest.json": JSON.stringify(manifest),
    [`docs/releases/${pkg.version}.md`]: "# Release\n\n[Guide](../user/index.md)\n", "addon/locale/en-US/knowledgemcp.ftl": "title = Test" })) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, contents);
  }
  await writeFile(path.join(root, ".scaffold/build/zotero-knowledge-mcp.xpi"), zip.toBuffer());
  return root;
}

test("release metadata rejects tag, version and author drift", () => {
  validateReleaseMetadata(pkg, lock, manifest, tag);
  assert.throws(() => validateReleaseMetadata(pkg, lock, manifest, "v99.0.0"), /Tag/);
  assert.throws(() => validateReleaseMetadata(pkg, { ...lock, version: "99.0.0" }, manifest, tag), /Lockfile/);
  assert.throws(() => validateReleaseMetadata(pkg, lock, { ...manifest, version: "99.0.0" }, tag), /Manifest/);
  assert.throws(() => validateReleaseMetadata(pkg, lock, { ...manifest, author: "Different" }, tag));
});

test("release notes pin relative documentation links without changing external links or anchors", () => {
  const notes = releaseNotes("[Guide](../user/index.md#start) [Web](https://example.org) [Here](#part)", tag);
  assert.ok(notes.includes(`/blob/${tag}/docs/user/index.md#start`));
  assert.ok(notes.includes("[Web](https://example.org) [Here](#part)"));
});

test("release staging preserves the validated XPI bytes and their checksum", async t => {
  const root = await fixture(t), result = await prepareRelease({ root, tag });
  const original = await readFile(path.join(root, ".scaffold/build/zotero-knowledge-mcp.xpi"));
  assert.deepEqual(await readFile(path.join(root, ".scaffold/release/zotero-knowledge-mcp.xpi")), original);
  assert.equal(result.sha256, createHash("sha256").update(original).digest("hex"));
  assert.equal(await readFile(path.join(root, ".scaffold/release/SHA256SUMS"), "utf8"), `${result.sha256}  zotero-knowledge-mcp.xpi\n`);
  assert.match(await readFile(path.join(root, ".scaffold/release/notes.md"), "utf8"), /github\.com.*\/blob\//);
});

test("release staging rejects a missing locale and stale archive bytes", async t => {
  const missing = await fixture(t, zip => zip.deleteFile("locale/en-US/knowledgemcp.ftl"));
  await assert.rejects(prepareRelease({ root: missing, tag }), /Archive differs/);
  const stale = await fixture(t, zip => zip.updateFile("content/main.js", Buffer.from("stale")));
  await assert.rejects(prepareRelease({ root: stale, tag }), /Archive differs/);
});

test("release staging excludes source maps and unexpected private files", async t => {
  for (const name of ["content/main.js.map", ".env", "content/library.sqlite"]) {
    const root = await fixture(t, zip => zip.addFile(name, Buffer.from("private")));
    await assert.rejects(prepareRelease({ root, tag }), /Unsafe|Unexpected/);
  }
});
