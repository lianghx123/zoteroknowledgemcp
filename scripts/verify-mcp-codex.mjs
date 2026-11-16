// Exercise the installed Codex MCP client directly, without model requests.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { prepare, cleanup, secret, evaluate, folder } from "./verify-mcp-native.mjs";

const report = { client: "installed Codex app-server MCP client; ephemeral thread; no model requests", checks: [] };
let child;
try {
  const fixture = await prepare(), token = await secret();
  const cli = process.env.CODEX_CLI_JS ?? path.join(path.dirname(process.execPath), "node_global/node_modules/@openai/codex/bin/codex.js");
  child = spawn(process.execPath, [cli, "app-server", "--stdio", "-c", "mcp_servers={}", "-c", "analytics.enabled=false"],
    { cwd: folder, env: { ...process.env, ZOTERO_KNOWLEDGE_MCP_TOKEN: token }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let sequence = 0, buffer = ""; const pending = new Map();
  child.stderr.on("data", () => {});
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) { const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result); }
      else if (message.id !== undefined && message.method) child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported test-client request" } })}\n`);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`Codex timed out: ${method}`)); }, 45000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  await request("initialize", { clientInfo: { name: "mcp-acceptance", version: "1.0" }, capabilities: { experimentalApi: true } });
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const thread = await request("thread/start", { cwd: folder, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", config: {
    mcp_servers: { zotero_acceptance: { url: fixture.status.endpoint, bearer_token_env_var: "ZOTERO_KNOWLEDGE_MCP_TOKEN", startup_timeout_sec: 20, tool_timeout_sec: 20 } },
  } });
  const threadId = thread.thread.id;
  const inventory = await request("mcpServerStatus/list", { threadId, serverName: "zotero_acceptance" });
  const server = inventory.data.find(server => server.name === "zotero_acceptance");
  if (!server || Object.keys(server.tools ?? {}).length !== 16) throw Error(`Expected 16 Codex tools: ${JSON.stringify(inventory)}`);
  report.checks.push("initialization and 16-tool discovery");
  const called = new Set();
  const call = async (tool, args) => {
    const response = await request("mcpServer/tool/call", { threadId, server: "zotero_acceptance", tool, arguments: args });
    if (response.isError) throw Error(JSON.stringify(response.structuredContent));
    called.add(tool);
    return response.structuredContent;
  };
  await call("list_libraries", {}); report.checks.push("library discovery");
  await call("list_folders", { libraryId: fixture.library });
  await call("list_resources", { libraryId: fixture.library });
  await call("get_resources", { resourceIds: [fixture.resource] });
  const search = await call("search_content", { scopeType: "authorized", query: "MCP synthetic", mode: "metadata" });
  if (!search.items.length) throw Error("No synthetic search result"); report.checks.push("metadata search");
  const unicode = await call("search_content", { scopeType: "authorized", query: "écologie", mode: "fulltext", snippetMaxChars: 100 });
  if (!unicode.items[0]?.matches.some(match => match.snippet.includes("ÉCOLOGIE"))) throw Error("Missing normalized tail evidence"); report.checks.push("normalized Unicode fulltext evidence");
  const structure = await call("list_resource_nodes", { resourceId: fixture.resource });
  await call("get_resource_nodes", { nodeIds: [structure.items[0].nodeId], includeChildren: true }); report.checks.push("structure and node reading");
  const content = await call("get_resource_content", { resourceId: fixture.resource });
  if (!content.contentMarkdown.includes("中文 😀")) throw Error("Incorrect UTF-8 content"); report.checks.push("document reading with UTF-8");
  await call("list_content_blocks", { resourceId: fixture.resource });
  const blockText = await call("get_content_blocks_text", { resourceId: fixture.resource, blockIds: [fixture.block], maxTotalChars: 20 });
  if (blockText.totalCharsReturned !== 20) throw Error("Block budget mismatch");
  await call("list_block_types", { resourceId: fixture.resource });
  await call("list_references", { resourceId: fixture.resource });
  const noteArgs = { resourceId: fixture.resource, annotationType: "evidence", text: "Codex native acceptance evidence", quote: "MCP native synthetic evidence.", contentBlockId: fixture.block, expectedVersion: content.resourceVersion, operationId: "codex-note-1" };
  const note = await call("add_annotation", noteArgs); report.checks.push("annotation write");
  const repeated = await call("add_annotation", noteArgs); if (!repeated.replayed) throw Error("Missing replay receipt"); report.checks.push("idempotent replay");
  const annotations = await call("list_annotations", { resourceId: fixture.resource });
  if (!annotations.items.some(item => item.annotationId === note.annotationId)) throw Error("Missing written annotation");
  if (annotations.items.find(item => item.annotationId === note.annotationId).quote !== noteArgs.quote) throw Error("Missing quoted evidence");
  await call("update_summary", { resourceId: fixture.resource, summary: "Codex acceptance summary", expectedVersion: note.version, operationId: "codex-summary-1" }); report.checks.push("summary update");
  await call("list_revisions", { resourceId: fixture.resource, responseMode: "full" });
  if (called.size !== 16) throw Error(`Expected all tools to execute: ${[...called].join(",")}`);
  report.checks.push("all 16 tools executed through the actual MCP client");
  await evaluate("delete Zotero.__mcpAcceptanceRevoked;void Zotero.__knowledgeMCPAccess.revokeToken(Zotero.__mcpAcceptance.token.id).then(()=>Zotero.__mcpAcceptanceRevoked=true)");
  for (let i = 0; i < 50 && !await evaluate("Zotero.__mcpAcceptanceRevoked??false"); i++) await new Promise(resolve => setTimeout(resolve, 50));
  let denied = false;
  try { await call("get_resource_content", { resourceId: fixture.resource }); } catch { denied = true; }
  if (!denied) throw Error("Revocation did not affect Codex"); report.checks.push("revocation enforced on existing client");
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = String(error); process.exitCode = 1; }
finally {
  if (child) { child.stdin.end(); child.kill(); }
  try { await cleanup(); report.cleanup = "passed"; } catch (error) { report.cleanup = String(error); process.exitCode = 1; }
}
await fs.writeFile(path.join(folder, "codex.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
