import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import AdmZip from "adm-zip";

export const repository = "lianghx123/zoteroknowledgemcp";
export const pluginId = "zotero-knowledge-mcp@local.dev";
export const feedUrl = `https://raw.githubusercontent.com/${repository}/main/updates.json`;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const maxXpiBytes = 64 * 1024 * 1024;

export function compareStable(left, right) {
  assert.match(left, stableVersion); assert.match(right, stableVersion);
  const a = left.split(".").map(BigInt), b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function stableReleases(releases) {
  return releases.filter(release => !release.draft && !release.prerelease &&
    typeof release.tag_name === "string" && stableVersion.test(release.tag_name.slice(1)) &&
    release.tag_name.startsWith("v") && release.published_at)
    .sort((a, b) => compareStable(b.tag_name.slice(1), a.tag_name.slice(1)));
}

export function validatedUpdate(release, xpiBytes, checksumText) {
  assert.equal(stableReleases([release]).length, 1, "Only published stable releases may be advertised");
  const version = release.tag_name.slice(1), tag = encodeURIComponent(release.tag_name);
  assert.ok(xpiBytes.length > 0 && xpiBytes.length <= maxXpiBytes, "XPI size limit exceeded");
  const hash = createHash("sha256").update(xpiBytes).digest("hex");
  assert.match(checksumText, /^[a-f0-9]{64}  zotero-knowledge-mcp\.xpi\r?\n?$/);
  assert.equal(checksumText.trim().split(/\s+/)[0], hash, "Release checksum differs from XPI bytes");
  const zip = new AdmZip(xpiBytes), entry = zip.getEntry("manifest.json");
  assert.ok(entry && entry.header.size <= 65536, "Missing or oversized packaged manifest");
  const manifest = JSON.parse(entry.getData().toString("utf8"));
  assert.equal(manifest.version, version, "Release tag and XPI version differ");
  assert.equal(manifest.applications.zotero.id, pluginId, "Wrong plugin ID");
  assert.equal(manifest.applications.zotero.update_url, feedUrl, "Unexpected update feed URL");
  const { strict_min_version: minimum, strict_max_version: maximum } = manifest.applications.zotero;
  assert.match(minimum, /^\d+\.\d+(?:\.\d+)?$/);
  assert.match(maximum, /^\d+\.\d+(?:\.(?:\d+|\*))?$/);
  return {
    version, update_link: `https://github.com/${repository}/releases/download/${tag}/zotero-knowledge-mcp.xpi`,
    update_hash: `sha256:${hash}`, update_info_url: `https://github.com/${repository}/releases/tag/${tag}`,
    applications: { zotero: { strict_min_version: minimum, strict_max_version: maximum } },
  };
}

export function createFeed(updates) {
  const versions = new Set();
  for (const update of updates) {
    assert.match(update.version, stableVersion);
    assert.ok(!versions.has(update.version), "Duplicate release version"); versions.add(update.version);
    assert.match(update.update_hash, /^sha256:[a-f0-9]{64}$/);
  }
  return { addons: { [pluginId]: { updates: [...updates].sort((a, b) => compareStable(b.version, a.version)) } } };
}

// Auth is sent only to api.github.com. Redirected asset downloads never receive
// our Authorization header; their short-lived signed URLs are kept in memory.
export async function githubApi(endpoint, { method = "GET", body, binary = false, token = process.env.GITHUB_TOKEN } = {}) {
  assert.ok(endpoint.startsWith(`/repos/${repository}`), "Unexpected API repository");
  let response = await fetch(`https://api.github.com${endpoint}`, {
    method, redirect: "manual", signal: AbortSignal.timeout(60000),
    headers: { Accept: binary ? "application/octet-stream" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (binary && [301, 302, 303, 307, 308].includes(response.status)) {
    const location = new URL(response.headers.get("location"));
    assert.equal(location.protocol, "https:");
    response = await fetch(location, { signal: AbortSignal.timeout(60000) });
  }
  if (!response.ok) throw Error(`GitHub ${method} ${endpoint}: HTTP ${response.status}`);
  if (binary) return boundedBytes(response, maxXpiBytes);
  if (response.status === 204) return null;
  return response.json();
}

export async function boundedBytes(response, maximum) {
  const chunks = []; let size = 0;
  assert.ok(Number(response.headers.get("content-length") ?? 0) <= maximum, "Download size limit exceeded");
  for await (const chunk of response.body) {
    size += chunk.length; assert.ok(size <= maximum, "Download size limit exceeded"); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function generateFeed(api = githubApi, anonymousFetch = fetch) {
  const repo = await api(`/repos/${repository}`);
  assert.equal(repo.full_name, repository); assert.equal(repo.default_branch, "main");
  assert.equal(typeof repo.private, "boolean", "Repository visibility is unknown");
  const releases = [];
  for (let page = 1; ; page++) {
    assert.ok(page <= 100, "Release pagination limit exceeded");
    const rows = await api(`/repos/${repository}/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(rows)); releases.push(...rows);
    if (rows.length < 100) break;
  }
  const updates = [];
  for (const release of stableReleases(releases)) {
    const assets = [];
    for (let page = 1; ; page++) {
      assert.ok(page <= 10, "Asset pagination limit exceeded");
      const rows = await api(`/repos/${repository}/releases/${release.id}/assets?per_page=100&page=${page}`);
      assert.ok(Array.isArray(rows)); assets.push(...rows);
      if (rows.length < 100) break;
    }
    const download = async name => {
      const matches = assets.filter(asset => asset.name === name && asset.state === "uploaded");
      assert.equal(matches.length, 1, `Missing/duplicate release asset: ${name}`);
      assert.ok(matches[0].size > 0 && matches[0].size <= (name === "SHA256SUMS" ? 65536 : maxXpiBytes));
      return api(`/repos/${repository}/releases/assets/${matches[0].id}`, { binary: true });
    };
    const xpi = await download("zotero-knowledge-mcp.xpi"), sums = await download("SHA256SUMS");
    const update = validatedUpdate(release, xpi, sums.toString("utf8"));
    if (!repo.private) {
      const response = await anonymousFetch(update.update_link, { signal: AbortSignal.timeout(60000), cache: "no-store" });
      assert.ok(response.ok, `Published installer not anonymously reachable: HTTP ${response.status}`);
      assert.equal(createHash("sha256").update(await boundedBytes(response, maxXpiBytes)).digest("hex"), update.update_hash.slice(7), "Anonymous installer bytes differ");
    }
    updates.push(update);
  }
  return { feed: createFeed(updates), publicRepository: !repo.private, releaseCount: updates.length };
}

export function validateFeedCandidate(content) {
  assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "Feed publication requires a clean checkout");
  const file = path.resolve("updates.json");
  return readFile(file).then(async previous => {
    try {
      await writeFile(file, content);
      for (const script of ["typecheck", "test"]) execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], { stdio: "inherit", shell: process.platform === "win32" });
      execFileSync("git", ["diff", "--check"], { stdio: "inherit" });
    } finally { await writeFile(file, previous); }
  });
}

export async function updateFeed({ publish = false, api = githubApi, anonymousFetch = fetch,
  validateCandidate = validateFeedCandidate, output = ".scaffold/update-feed" } = {}) {
  const result = await generateFeed(api, anonymousFetch), content = JSON.stringify(result.feed, null, 2) + "\n";
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "updates.json"), content);
  if (!publish || !result.publicRepository) return { ...result, published: false, reason: result.publicRepository ? "rehearsal" : "private repository" };
  const existing = await api(`/repos/${repository}/contents/updates.json?ref=main`);
  assert.equal(existing.type, "file");
  const prior = Buffer.from(existing.content.replace(/\s/g, ""), "base64").toString("utf8");
  if (prior === content) return { ...result, published: true, changed: false };
  await validateCandidate(content);
  // The expected SHA makes concurrent source updates fail instead of overwriting.
  await api(`/repos/${repository}/contents/updates.json`, { method: "PUT", body: {
    message: ["chore(release): refresh verified stable update feed", "", "Why:",
      "- Keep Zotero's stable update catalog aligned with published release assets.", "", "Changes:",
      "- Advertise only published stable versions with verified XPI SHA-256, identity and compatibility.",
      "- Preserve all eligible stable releases and omit previews, drafts and deleted releases.", "", "Validation:",
      "- npm run typecheck: PASS; npm test: PASS including production build and full Node suite.",
      "- git diff --check: PASS against the generated feed candidate.",
      "- Published installer bytes and unauthenticated downloads: PASS.", "", "Risks and compatibility:",
      "- Feed metadata only; users retain Zotero's automatic-update preference.",
      "- Update compatibility ranges are read from the exact published installers."].join("\n"), branch: "main", sha: existing.sha,
    content: Buffer.from(content).toString("base64"),
  } });
  return { ...result, published: true, changed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await updateFeed({ publish: process.argv.includes("--publish") }), null, 2));
}
