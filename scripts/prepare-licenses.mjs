import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";

// Include notices for the runtime packages and their dependency trees. Some
// dependency code is removed by bundling; retaining its notice is harmless.
const names = ["argparse", "commander", "entities", "katex", "kysely", "linkify-it",
  "markdown-it", "mdurl", "punycode.js", "uc.micro"];
let notices = "Third-party dependency notices\n\nUSearch notices are provided separately in content/vector/LICENSE and content/vector/NOTICE.\n";
for (const name of names) {
  const directory = `node_modules/${name}`;
  const pkg = JSON.parse(await readFile(`${directory}/package.json`, "utf8"));
  const licenses = (await readdir(directory)).filter(file => /^licen[cs]e(?:[.-].*)?$/i.test(file)).sort();
  assert.ok(licenses.length, `Missing upstream license: ${name}`);
  notices += `\n${"=".repeat(72)}\n${name} ${pkg.version} (${pkg.license})\n`;
  for (const license of licenses) notices += `\n${(await readFile(`${directory}/${license}`, "utf8")).replaceAll("\r\n", "\n").trim()}\n`;
}
const file = "addon/content/licenses/third-party.txt";
if (process.argv.includes("--write")) await writeFile(file, notices);
else assert.equal((await readFile(file, "utf8")).replaceAll("\r\n", "\n"), notices,
  "Dependency notices are stale; run node scripts/prepare-licenses.mjs --write and review the changes.");
assert.equal((await readFile("addon/content/licenses/project.txt", "utf8")).replaceAll("\r\n", "\n"),
  (await readFile("LICENSE", "utf8")).replaceAll("\r\n", "\n"), "Packaged project license differs from LICENSE");
console.log("Project and third-party license notices verified.");
