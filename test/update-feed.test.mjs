import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import AdmZip from "adm-zip";
import { boundedBytes, compareStable, createFeed, feedUrl, generateFeed, pluginId, stableReleases, updateFeed, validatedUpdate } from "../scripts/update-feed.mjs";

function release(version = "1.0.0", overrides = {}) {
  return { id: 42, tag_name: `v${version}`, draft: false, prerelease: false, published_at: "2026-11-12T00:00:00Z", ...overrides };
}
function installer(version = "1.0.0", mutate = () => {}) {
  const manifest = { manifest_version: 2, version, applications: { zotero: { id: pluginId, update_url: feedUrl, strict_min_version: "10.0", strict_max_version: "10.0.*" } } };
  mutate(manifest); const zip = new AdmZip(); zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
  const bytes = zip.toBuffer(), sums = `${createHash("sha256").update(bytes).digest("hex")}  zotero-knowledge-mcp.xpi\n`;
  return { bytes, sums };
}
function fixture({ privateRepo = true, rows = [release()], badAsset = false } = {}) {
  const packageBytes = installer(), calls = [];
  const api = async (endpoint, options = {}) => {
    calls.push({ endpoint, options });
    if (options.method === "PUT") return {};
    if (endpoint.endsWith("/zoteroknowledgemcp")) return { full_name: "lianghx123/zoteroknowledgemcp", default_branch: "main", private: privateRepo };
    if (endpoint.includes("/contents/")) return { type: "file", sha: "observed-sha", content: Buffer.from(JSON.stringify(createFeed([])) + "\n").toString("base64") };
    if (endpoint.includes("/releases?")) return rows;
    if (endpoint.includes("/releases/42/assets?")) return [{ id: 1, name: "zotero-knowledge-mcp.xpi", state: "uploaded", size: packageBytes.bytes.length },
      ...(!badAsset ? [{ id: 2, name: "SHA256SUMS", state: "uploaded", size: packageBytes.sums.length }] : [])];
    if (endpoint.endsWith("/assets/1")) return packageBytes.bytes;
    if (endpoint.endsWith("/assets/2")) return Buffer.from(packageBytes.sums);
    throw Error(`Unexpected API request: ${endpoint}`);
  };
  return { api, calls, packageBytes };
}

test("stable channel omits previews, drafts, invalid tags and unpublished releases", () => {
  const rows = [release("2.0.0"), release("1.9.0"), release("2.0.0-preview.1"), release("3.0.0", { prerelease: true }),
    release("4.0.0", { draft: true }), release("5.0.0", { published_at: null }), release("01.0.0"), release("0.1.0", { tag_name: "release-0.1.0" })];
  assert.deepEqual(stableReleases(rows).map(row => row.tag_name), ["v2.0.0", "v1.9.0"]);
  assert.equal(compareStable("1.10.0", "1.9.0"), 1);
  assert.equal(compareStable("0.2.0", "0.2.0"), 0);
});

test("update entries pin exact release bytes, plugin identity and Zotero compatibility", () => {
  const { bytes, sums } = installer(), update = validatedUpdate(release(), bytes, sums);
  assert.equal(update.version, "1.0.0");
  assert.equal(update.update_link, "https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v1.0.0/zotero-knowledge-mcp.xpi");
  assert.equal(update.update_hash, `sha256:${sums.slice(0, 64)}`);
  assert.deepEqual(update.applications, { zotero: { strict_min_version: "10.0", strict_max_version: "10.0.*" } });
  assert.throws(() => validatedUpdate(release("1.0.1"), bytes, sums), /version differ/);
  assert.throws(() => validatedUpdate(release(), bytes, "0".repeat(64) + "  zotero-knowledge-mcp.xpi\n"), /checksum differs/);
  const foreign = installer("1.0.0", manifest => manifest.applications.zotero.id = "other@example.org");
  assert.throws(() => validatedUpdate(release(), foreign.bytes, foreign.sums), /plugin ID/);
  assert.throws(() => validatedUpdate(release("1.0.0-preview.1"), bytes, sums), /Only published stable/);
  const otherFeed = installer("1.0.0", manifest => manifest.applications.zotero.update_url = "https://example.org/updates.json");
  assert.throws(() => validatedUpdate(release(), otherFeed.bytes, otherFeed.sums), /Unexpected update feed/);
});

test("feed preserves older compatible stable releases and rejects duplicate versions", () => {
  const first = installer("1.0.0"), second = installer("2.0.0");
  const rows = [validatedUpdate(release(), first.bytes, first.sums), validatedUpdate(release("2.0.0"), second.bytes, second.sums)];
  assert.deepEqual(createFeed(rows).addons[pluginId].updates.map(update => update.version), ["2.0.0", "1.0.0"]);
  assert.throws(() => createFeed([rows[0], rows[0]]), /Duplicate/);
});

test("private repositories can rehearse but never publish an update advertisement", async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), "knowledge-feed-")); t.after(() => rm(output, { recursive: true, force: true }));
  const f = fixture(), result = await updateFeed({ publish: true, api: f.api, output });
  assert.equal(result.published, false); assert.equal(result.releaseCount, 1);
  assert.equal(result.reason, "private repository"); assert.ok(!f.calls.some(call => call.options.method === "PUT"));
});

test("public feed generation verifies unauthenticated installer reachability and bytes", async () => {
  const f = fixture({ privateRepo: false }); let anonymousURL;
  const result = await generateFeed(f.api, async url => { anonymousURL = url; return new Response(f.packageBytes.bytes); });
  assert.equal(result.publicRepository, true); assert.equal(result.releaseCount, 1);
  assert.match(anonymousURL, /releases\/download\/v1\.0\.0/);
  await assert.rejects(generateFeed(f.api, async () => new Response("", { status: 404 })), /not anonymously reachable/);
  await assert.rejects(generateFeed(f.api, async () => new Response("bad")), /bytes differ/);
});

test("missing stable assets fail closed and preview-only repositories produce an empty feed", async () => {
  await assert.rejects(generateFeed(fixture({ badAsset: true }).api), /Missing\/duplicate release asset/);
  const f = fixture({ rows: [release("1.0.0-preview.1", { prerelease: true })] });
  const result = await generateFeed(f.api); assert.deepEqual(result.feed, createFeed([]));
  assert.ok(!f.calls.some(call => call.endpoint.includes("/assets")));
});

test("public publication validates the exact feed and uses the observed SHA without overwriting concurrent edits", async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), "knowledge-feed-write-")); t.after(() => rm(output, { recursive: true, force: true }));
  const f = fixture({ privateRepo: false }); let validated;
  const result = await updateFeed({ publish: true, api: f.api, output,
    anonymousFetch: async () => new Response(f.packageBytes.bytes), validateCandidate: async content => { validated = content; } });
  assert.equal(result.published, true); assert.equal(result.changed, true);
  const write = f.calls.find(call => call.options.method === "PUT");
  assert.equal(write.options.body.sha, "observed-sha");
  assert.equal(Buffer.from(write.options.body.content, "base64").toString(), validated);
  assert.match(write.options.body.message, /Why:\n/); assert.match(write.options.body.message, /Validation:\n/);
  const failing = fixture({ privateRepo: false });
  await assert.rejects(updateFeed({ publish: true, api: failing.api, output, anonymousFetch: async () => new Response(failing.packageBytes.bytes),
    validateCandidate: async () => { throw Error("Candidate tests failed"); } }), /Candidate tests failed/);
  assert.ok(!failing.calls.some(call => call.options.method === "PUT"));
});

test("identical public feeds do not rerun validation or create maintenance commits", async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), "knowledge-feed-noop-")); t.after(() => rm(output, { recursive: true, force: true }));
  const f = fixture({ privateRepo: false });
  const expected = createFeed([validatedUpdate(release(), f.packageBytes.bytes, f.packageBytes.sums)]);
  const result = await updateFeed({ publish: true, output,
    api: async (endpoint, options) => endpoint.includes("/contents/") ? { type: "file", sha: "unchanged", content: Buffer.from(JSON.stringify(expected, null, 2) + "\n").toString("base64") } : f.api(endpoint, options),
    anonymousFetch: async () => new Response(f.packageBytes.bytes), validateCandidate: async () => { assert.fail("Unchanged feed must not create a commit"); } });
  assert.equal(result.changed, false); assert.equal(result.published, true);
  assert.ok(!f.calls.some(call => call.options.method === "PUT"));
});

test("asset downloads reject oversized declared and streaming response bodies", async () => {
  await assert.rejects(boundedBytes(new Response("abc", { headers: { "content-length": "999" } }), 10), /size limit/);
  await assert.rejects(boundedBytes(new Response("0123456789abc"), 10), /size limit/);
  assert.equal((await boundedBytes(new Response("small"), 10)).toString(), "small");
});
