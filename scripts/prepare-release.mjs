import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import AdmZip from "adm-zip";

const repository = "https://github.com/lianghx123/zoteroknowledgemcp";

export function validateReleaseMetadata(pkg, lock, manifest, tag) {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/);
  assert.equal(tag, `v${pkg.version}`, "Tag must match the package version");
  assert.equal(manifest.version, pkg.version, "Manifest version differs");
  assert.equal(lock.version, pkg.version, "Lockfile version differs");
  assert.equal(lock.packages[""].version, pkg.version, "Lockfile root version differs");
  assert.equal(manifest.applications.zotero.id, "zotero-knowledge-mcp@local.dev");
  assert.equal(manifest.author, pkg.author.name);
  assert.equal(manifest.homepage_url, pkg.homepage);
  assert.equal(pkg.homepage, repository);
  assert.equal(pkg.license, "MIT");
  assert.equal(lock.packages[""].license, pkg.license);
}

// Release notes live under docs/releases; GitHub release bodies need absolute links.
export function releaseNotes(markdown, tag) {
  const base = `${repository}/blob/${encodeURIComponent(tag)}/docs/releases/`;
  return markdown.replace(/\]\(([^\s)]+)\)/g, (match, href) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return match;
    const target = new URL(href, base);
    assert.equal(target.origin, "https://github.com");
    assert.ok(target.pathname.startsWith("/lianghx123/zoteroknowledgemcp/blob/"));
    return `](${target.href})`;
  });
}

export async function prepareRelease({ root = process.cwd(), tag, requireClean = false, rehearsal = false } = {}) {
  const json = async file => JSON.parse(await readFile(path.join(root, file), "utf8"));
  const [pkg, lock, manifest] = await Promise.all([
    json("package.json"), json("package-lock.json"), json("addon/manifest.json"),
  ]);
  validateReleaseMetadata(pkg, lock, manifest, tag);
  let commit;
  if (requireClean) {
    const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    assert.equal(git(["status", "--porcelain"]), "", "Release requires a clean checkout");
    commit = git(["rev-parse", "HEAD"]);
    if (!rehearsal) assert.equal(commit, git(["rev-parse", `${tag}^{commit}`]), "Tag must point to HEAD");
  }
  const notes = releaseNotes(await readFile(path.join(root, `docs/releases/${pkg.version}.md`), "utf8"), tag);
  const bytes = await readFile(path.join(root, ".scaffold/build/zotero-knowledge-mcp.xpi"));
  const zip = new AdmZip(bytes), entries = zip.getEntries().filter(entry => !entry.isDirectory);
  const names = entries.map(entry => entry.entryName);
  assert.equal(new Set(names).size, names.length, "Duplicate archive entries");
  for (const name of names) {
    assert.ok(/^(?:manifest\.json|bootstrap\.js|prefs\.js|content\/.+|locale\/.+)$/.test(name), `Unexpected packaged file: ${name}`);
    assert.ok(!/(?:^|\/)\.\.?\/|\\|\.map$|(?:^|\/)\.env(?:\.|$)|\.(?:sqlite|xpi|log)$/i.test(name), `Unsafe packaged file: ${name}`);
  }
  assert.deepEqual(JSON.parse(zip.readAsText("manifest.json")), manifest, "Packaged manifest differs");
  assert.deepEqual(zip.getEntry("content/licenses/project.txt")?.getData(), await readFile(path.join(root, "LICENSE")), "Packaged project license differs");
  const bundle = zip.readAsText("content/main.js");
  assert.ok(!bundle.includes("sourceMappingURL="), "Release must not include inline source maps");
  if (requireClean) {
    const identity = bundle.match(/commit:\s*"([a-f0-9]{40})",\s*dirty:\s*(true|false|!0|!1),\s*sourceFingerprint:\s*"([a-f0-9]{64})"/);
    assert.ok(identity, "Missing embedded build identity");
    assert.equal(identity[1], commit, "Packaged build commit differs from HEAD");
    assert.ok(["false", "!1"].includes(identity[2]), "Packaged build must have dirty=false");
  }
  const buildRoot = path.join(root, ".scaffold/build/addon"), expected = [];
  async function inspect(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name, file = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspect(file, `${name}/`);
      else {
        expected.push(name);
        assert.deepEqual(zip.getEntry(name)?.getData(), await readFile(file), `Archive differs from build: ${name}`);
      }
    }
  }
  await inspect(buildRoot);
  assert.deepEqual(names.toSorted(), expected.toSorted(), "Archive file list differs from build");
  for (const name of ["bootstrap.js", "content/main.js", "content/settings.js", "content/sync-settings.js",
    "content/vector/worker.js", "content/vector/usearch.mjs", "content/vector/usearch.wasm", "content/vector/LICENSE", "content/vector/NOTICE",
    "content/licenses/third-party.txt", "content/licenses/katex.txt"]) {
    assert.ok(zip.getEntry(name)?.header.size > 0, `Missing release asset: ${name}`);
  }
  const locales = await readdir(path.join(root, "addon/locale"));
  for (const locale of locales) assert.ok(zip.getEntry(`locale/${locale}/knowledgemcp.ftl`)?.header.size > 0, `Missing locale: ${locale}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const output = path.join(root, ".scaffold/release");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "zotero-knowledge-mcp.xpi"), bytes);
  await writeFile(path.join(output, "SHA256SUMS"), `${sha256}  zotero-knowledge-mcp.xpi\n`);
  await writeFile(path.join(output, "notes.md"), notes);
  return { version: pkg.version, tag, files: names.length, locales: locales.length, bytes: bytes.length, sha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), tagIndex = args.indexOf("--tag");
  assert.ok(tagIndex >= 0 && args[tagIndex + 1], "Pass --tag v<package version>");
  console.log(JSON.stringify(await prepareRelease({ tag: args[tagIndex + 1], requireClean: args.includes("--require-clean"), rehearsal: args.includes("--rehearsal") }), null, 2));
}
