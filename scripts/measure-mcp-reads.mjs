// Compare a Git baseline with the working tree inside isolated native Zotero.
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate } from "./verify-vector-native.mjs";

const root = process.cwd(), folder = path.resolve(process.env.MCP_READ_OUTPUT ?? `.scaffold/mcp-read-optimization/run-${Date.now()}`);
if (!folder.startsWith(path.join(root, ".scaffold") + path.sep)) throw Error("Output must remain in this workspace's .scaffold");
await fs.mkdir(folder, { recursive: true });
const baselineRef = process.env.MCP_READ_BASELINE_REF ?? "HEAD";
const baselineRoot = path.join(folder, "baseline-source"), archive = path.join(folder, "baseline.tar");
await fs.mkdir(baselineRoot);
execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, baselineRef], { cwd: root });
execFileSync("tar", ["-xf", archive, "-C", baselineRoot]);
const api = `export {Kysely,sql} from "kysely";
export {initializeDatabase} from "./src/database/client.ts";
export {migrations} from "./src/database/migration-provider.ts";
export {McpTools} from "./src/mcp/tools/service.ts";
export {McpTokens} from "./src/security/mcp-tokens.ts";
export {McpCursor} from "./src/security/mcp-cursor.ts";
export {EmbeddingService} from "./src/services/embedding.ts";
export {RetrievalService} from "./src/services/retrieval.ts";
export {canonical} from "./src/mcp/contracts.ts";
export {toolDefinitions,validate} from "./src/mcp/tools/registry.ts";`;
for (const [name, source, globalName] of [["baseline", baselineRoot, "McpReadBaseline"], ["candidate", root, "McpReadCandidate"]]) {
  await build({ stdin: { contents: api, loader: "ts", resolveDir: source }, nodePaths: [path.join(root, "node_modules")], bundle: true, platform: "browser", format: "iife", target: "firefox140", keepNames: true, globalName, outfile: path.join(folder, `${name}.js`) });
}
await build({ entryPoints: ["scripts/mcp-reads-native.mjs"], bundle: true, platform: "browser", format: "iife", target: "firefox140", globalName: "McpReadComparison", outfile: path.join(folder, "probe.js") });
const options = { folder, fixture: process.env.MCP_READ_FIXTURE ? path.resolve(process.env.MCP_READ_FIXTURE) : null,
  writesOnly: process.env.MCP_READ_WRITES_ONLY === "1",
  rounds: Number(process.env.MCP_READ_ROUNDS ?? 5), requests: Number(process.env.MCP_READ_REQUESTS ?? 24) };
if (!Number.isSafeInteger(options.rounds) || options.rounds < 1 || !Number.isSafeInteger(options.requests) || options.requests < 4 || options.requests % 4) throw Error("Invalid benchmark counts");
if (options.fixture && !options.fixture.replaceAll("\\", "/").includes("/.scaffold/")) throw Error("Use an isolated synthetic fixture");
await fs.writeFile(path.join(folder, "source.json"), JSON.stringify({ baselineRef, baselineCommit: execFileSync("git", ["rev-parse", baselineRef], { encoding: "utf8" }).trim(), workingTree: execFileSync("git", ["status", "--short"], { encoding: "utf8" }), node: process.version, options }, null, 2));
const commands = ["baseline.js", "candidate.js", "probe.js"].map(file => `Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(path.join(folder, file)).href)})`).join(";");
await evaluate(`${commands};void McpReadComparison.run(${JSON.stringify(options)})`);
console.log(JSON.stringify({ dispatched: true, folder, baselineRef }));
