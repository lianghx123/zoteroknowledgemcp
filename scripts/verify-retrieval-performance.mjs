// Developer-only, fixed-vector comparisons in an already-running isolated Zotero.
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import http from "node:http";
import { evaluate, runtimeRootURI } from "./verify-vector-native.mjs";

const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const revision = flag("--baseline");
if (!revision) throw Error("Pass --baseline <git revision> explicitly.");
const commit = execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], { encoding: "utf8" }).trim();
const folder = path.resolve(".scaffold/retrieval-optimization", `native-${Date.now()}`);
await fs.mkdir(folder, { recursive: true });
const original = new Map();
function source(file) {
  const relative = path.relative(process.cwd(), file).replaceAll("\\", "/");
  if (!original.has(relative)) original.set(relative, execFileSync("git", ["show", `${commit}:${relative}`], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }));
  return original.get(relative);
}
function coverage(text) {
  const start = text.includes("      // Reuse sources") ? text.indexOf("      // Reuse sources") : text.indexOf("      const coverageRows =");
  const end = text.indexOf("      const coverage = new Map", start);
  if (start < 0 || end < 0) throw Error("Coverage comparison boundary changed.");
  return { start, end, value: text.slice(start, end) };
}
function diversity(text) {
  const start = text.indexOf("      if (args.diversify)"), end = text.indexOf("      const value: JsonObject[]", start);
  if (start < 0 || end < 0) throw Error("Baseline diversity boundary changed.");
  return text.slice(start, end);
}
const arms = process.argv.includes("--smoke") ? ["baseline", "full"] : process.argv.includes("--diversity") ? ["baseline", "diversity", "full"] : ["baseline", "recall", "coverage", "diversity", "page", "full"];
const bundles = [];
for (const arm of arms) {
  const outfile = path.join(folder, `${arm}.js`);
  await build({ stdin: { contents: `export { sql } from "kysely";
export { RetrievalService } from "./src/services/retrieval.ts";
export { VectorStore } from "./src/services/vector-store.ts";
export { VectorIndex } from "./src/services/vector-index.ts";
export { EmbeddingRepository } from "./src/repositories/embeddings.ts";
export { initializeDatabase } from "./src/database/client.ts";
export { McpTokens } from "./src/security/mcp-tokens.ts";
export { McpCursor } from "./src/security/mcp-cursor.ts";
export { McpTools } from "./src/mcp/tools/service.ts";
export { McpSearch } from "./src/mcp/tools/search.ts";
export { McpHttp } from "./src/connections/mcp-http.ts";
export { spaceKey } from "./src/shared/contracts/retrieval.ts";
export { vectorFromBlob } from "./src/providers/models.ts";`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, platform: "browser", target: "firefox140", format: "iife", globalName: `RetrievalPerf_${arm}`, outfile,
    plugins: [{ name: "comparison-source", setup(b) {
      b.onLoad({ filter: /[\\/]src[\\/].*\.ts$/ }, async args => {
        const relative = path.relative(process.cwd(), args.path).replaceAll("\\", "/");
        const current = await fs.readFile(args.path, "utf8");
        if (arm === "full" || ["src/services/retrieval-filters.ts", "src/mcp/tools/diversify.ts"].includes(relative)) return { contents: current, loader: "ts" };
        let text = source(args.path);
        if (arm === "recall" && relative === "src/services/vector-store.ts") text = current;
        if (["recall", "coverage"].includes(arm) && relative === "src/services/retrieval.ts") {
          const old = coverage(text), candidate = coverage(current);
          text = arm === "coverage" ? text.slice(0, old.start) + candidate.value + text.slice(old.end)
            : current.slice(0, candidate.start) + old.value + current.slice(candidate.end);
        }
        if (arm === "diversity" && relative === "src/mcp/tools/search.ts") text = 'import { diversify } from "./diversify";\n' + text.replace(diversity(text), '      if (args.diversify) hits = diversify(hits, number(args, "diversityLambda", 0.7));\n');
        if (arm === "page" && relative === "src/mcp/tools/search.ts") text = current.replace('      if (args.diversify) hits = diversify(hits, number(args, "diversityLambda", 0.7));\n', diversity(text));
        return { contents: text, loader: "ts" };
      });
    } }] });
  bundles.push({ arm, url: pathToFileURL(outfile).href });
}
const probe = path.join(folder, "probe.js");
await build({ entryPoints: ["scripts/fixtures/retrieval-performance.ts"], bundle: true, platform: "browser", target: "firefox140", format: "iife", globalName: "RetrievalPerformance", outfile: probe });
const options = { folder, commit, arms, bundles, rootURI: await runtimeRootURI(), rounds: process.argv.includes("--smoke") ? 1 : 5, syntheticDiversify: process.argv.includes("--diversity"), concurrency: process.argv.includes("--concurrency"), http: process.argv.includes("--http"), port: Number(flag("--http-port") ?? 23129) };
await fs.writeFile(path.join(folder, "source.json"), JSON.stringify({ commit, arms, changed: execFileSync("git", ["diff", "--stat"], { encoding: "utf8" }), options }, null, 2));
await evaluate(`(()=>{if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated Zotero required");Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(probe).href)});void RetrievalPerformance.run(${JSON.stringify(options)});return true;})()`);
console.log(`Native report: ${path.join(folder, "results.json")}`);
let checkedHttp = false;
for (;;) {
  await new Promise(resolve => setTimeout(resolve, 500));
  let report; try { report = JSON.parse(await fs.readFile(path.join(folder, "results.json"), "utf8")); } catch { continue; }
  if (report.httpReady && !checkedHttp) {
    checkedHttp = true;
    try { await verifyHttp(report.fixture.queries[0]); }
    finally { await evaluate("Zotero.__retrievalOptimizationHttp.done = true"); }
  }
  if (report.finished) { console.log(JSON.stringify({ status: report.status, samples: report.samples.length, checks: report.checks.length, cleanup: report.cleanup, error: report.error })); if (report.status !== "passed") process.exitCode = 1; break; }
}

async function verifyHttp(query) {
  const state = JSON.parse(await evaluate("JSON.stringify({port:Zotero.__retrievalOptimizationHttp.port,secret:Zotero.__retrievalOptimizationHttp.secret})"));
  const checks = []; let session, id = 0;
  const request = (method, params, extra = {}) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
    const req = http.request({ host: "127.0.0.1", port: state.port, path: "/mcp/knowledge", method: "POST", headers: {
      Authorization: `Bearer ${state.secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", Connection: "close",
      "Content-Length": Buffer.byteLength(body), "MCP-Protocol-Version": "2025-11-25", ...(session ? { "Mcp-Session-Id": session } : {}), ...extra,
    } }, res => { let text = ""; session ??= res.headers["mcp-session-id"]; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; }); res.on("end", () => {
      const data = text.split("\n").find(line => line.startsWith("data: "));
      resolve({ status: res.statusCode, message: data ? JSON.parse(data.slice(6)) : null });
    }); }); req.on("error", reject); req.setTimeout(120000, () => req.destroy(Error("HTTP check timeout"))); req.end(body);
  });
  const assert = (condition, name) => { if (!condition) throw Error(name); checks.push(name); };
  const invoke = async (name, args) => { const response = await request("tools/call", { name, arguments: args }); assert(response.status === 200 && !response.message.error && !response.message.result?.isError, `HTTP ${name}`); return response.message.result.structuredContent; };
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Isolated retrieval verification", version: "1" } });
  assert(Boolean(session), "negotiated-session");
  const definitions = await request("tools/list", {}); assert(definitions.message.result.tools.length === 16, "all-16-tools");
  const args = { scopeType: "authorized", query, mode: "hybrid", limit: 3, snippetMaxChars: 250, includeDiagnostics: true };
  const first = await invoke("search_content", args), ids = first.items.map(row => row.resourceId); let cursor = first.nextCursor;
  let replay;
  if (cursor) { replay = await invoke("search_content", { ...args, cursor }); assert(JSON.stringify(replay.items) === JSON.stringify((await invoke("search_content", { ...args, cursor })).items), "replayed-page-equal"); }
  while (cursor) { const page = await invoke("search_content", { ...args, cursor }); ids.push(...page.items.map(row => row.resourceId)); cursor = page.nextCursor; }
  assert(ids.length > 3 && new Set(ids).size === ids.length, "all-pages-without-duplicates");
  await invoke("get_resources", { resourceIds: [ids[0]] });
  const content = await invoke("get_resource_content", { resourceId: ids[0], maxChars: 1000 }); assert([...content.contentMarkdown].length <= 1000, "bounded-content-unicode-budget");
  assert((await request("tools/list", {}, { Origin: "https://invalid.example" })).status === 403, "origin-rejected");
  await evaluate("void Zotero.__retrievalOptimizationHttp.revoke().then(()=>Zotero.__retrievalOptimizationHttp.revoked=true)");
  for (let i = 0; i < 100 && !await evaluate("Zotero.__retrievalOptimizationHttp.revoked ?? false"); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert((await request("tools/list", {})).status === 401, "revocation-rejected");
  await fs.writeFile(path.join(folder, "http.json"), JSON.stringify({ status: "passed", checks, resources: ids.length }, null, 2));
}
