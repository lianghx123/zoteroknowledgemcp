import { hostRuntime } from "../core/host-runtime";
import { McpError, failure, type JsonObject } from "../mcp/contracts";
import { toolDefinitions } from "../mcp/tools/registry";
import { applicationContract } from "../mcp/contracts";
import { implementationIdentity } from "../mcp/identity";
import type { McpTools } from "../mcp/tools/service";
import type { McpTokens } from "../security/mcp-tokens";
import { McpClientIdentity } from "./mcp-client-identity";

export interface HttpRequest { method: string; httpVersion: string; path: string; hasHeader(name: string): boolean; getHeader(name: string): string; bodyInputStream: { available(): number }; }
export interface HttpResponse { setStatusLine(version: string, code: number, description: string): void; setHeader(name: string, value: string, merge?: boolean): void; processAsync(): void; write(value: string): void; finish(): void; }
export interface NativeHttpServer { registerPathHandler(path: string, handler: (request: HttpRequest, response: HttpResponse) => void): void; start(port: number): void; stop(callback: () => void): void; }
export const mcpPath = "/mcp/knowledge";
export const protocolVersions = ["2025-11-25", "2025-06-18"];
const maxRequest = 1024 * 1024, maxResponse = 4 * 1024 * 1024;
const maxPendingRequests = 128, maxActiveRequests = 64, maxTokenRequests = 16;
function bytes(value: string): string {
  const encoded = new TextEncoder().encode(value); let output = "";
  for (let offset = 0; offset < encoded.length; offset += 8192) output += String.fromCharCode(...encoded.subarray(offset, offset + 8192));
  return output;
}
export class McpHttp {
  private server: NativeHttpServer | undefined;
  private pending = new Set<Promise<void>>();
  private active = new Map<string, { controller: AbortController; tokenId: string }>();
  private readonly clients = new McpClientIdentity();
  private closing = false;
  private generation = 0;
  private port = 23126;
  status: "stopped" | "running" | "failed" = "stopped";
  constructor(private readonly tokens: McpTokens, private readonly tools: McpTools,
    private readonly createServer: () => NativeHttpServer = () => new (ChromeUtils.importESModule("chrome://remote/content/server/httpd.sys.mjs").HttpServer)(),
    private readonly readBody: (request: HttpRequest) => string = request => {
      const count = request.bodyInputStream.available();
      if (count > maxRequest) throw new McpError("REQUEST_TOO_LARGE", "The request exceeds 1 MiB.");
      const raw = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs").NetUtil.readInputStreamToString(request.bodyInputStream, count);
      return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(raw, character => character.charCodeAt(0)));
    }) {}
  start(port: number): void {
    if (this.server) throw new Error("listener-already-running");
    this.port = port; this.closing = false; this.generation++; this.clients.restart();
    const server = this.createServer();
    server.registerPathHandler(mcpPath, (request, response) => {
      response.processAsync();
      const work = this.respond(request, response).catch(() => { try { response.finish(); } catch { /* Peer disconnected. */ } });
      this.pending.add(work); void work.finally(() => this.pending.delete(work));
    });
    try { server.start(port); this.server = server; this.status = "running"; }
    catch { this.status = "failed"; throw new McpError("PORT_UNAVAILABLE", "The configured MCP port is unavailable."); }
  }
  private header(request: HttpRequest, name: string): string { return request.hasHeader(name) ? request.getHeader(name) : ""; }
  private reject(response: HttpResponse, status: number, message: string): void {
    response.setStatusLine("1.1", status, "Request rejected"); response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store"); response.write(bytes(message)); response.finish();
  }
  private async respond(request: HttpRequest, response: HttpResponse): Promise<void> {
    const generation = this.generation;
    if (this.closing || this.pending.size >= maxPendingRequests) { this.reject(response, 503, "The MCP service is unavailable."); return; }
    const host = this.header(request, "Host"), hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!hosts.includes(host.toLowerCase())) { this.reject(response, 403, "Invalid Host."); return; }
    const origin = this.header(request, "Origin");
    if (origin && !hosts.some(host => origin === `http://${host}`)) { this.reject(response, 403, "Invalid Origin."); return; }
    let principal;
    try { principal = await this.tokens.authenticate(this.header(request, "Authorization").replace(/^Bearer /, "")); }
    catch { response.setHeader("WWW-Authenticate", 'Bearer realm="Zotero Knowledge MCP"'); this.reject(response, 401, "A valid local MCP token is required."); return; }
    if (this.closing || generation !== this.generation) { this.reject(response, 503, "The MCP service is stopping."); return; }
    if (request.method !== "POST") { response.setHeader("Allow", "POST"); this.reject(response, 405, "Only POST is supported."); return; }
    if (!this.header(request, "Content-Type").toLowerCase().startsWith("application/json") || this.header(request, "Content-Encoding")) { this.reject(response, 415, "Use uncompressed application/json requests."); return; }
    if (!this.header(request, "Accept").split(",").some(value => /^\s*text\/event-stream(?:\s*;|\s*$)/i.test(value) && !/;\s*q=0(?:\.0*)?\s*$/i.test(value))) { this.reject(response, 406, "SSE responses must be accepted."); return; }
    if (Number(this.header(request, "Content-Length")) > maxRequest) { this.reject(response, 413, "The request exceeds 1 MiB."); return; }
    let message: JsonObject;
    try {
      const body = this.readBody(request); if (new TextEncoder().encode(body).length > maxRequest) { this.reject(response, 413, "The request exceeds 1 MiB."); return; }
      const value: unknown = JSON.parse(body);
      if (!value || Array.isArray(value) || typeof value !== "object") { this.sse(response, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } }); return; }
      message = value as JsonObject;
    } catch (error) {
      if (error instanceof McpError && error.code === "REQUEST_TOO_LARGE") { this.reject(response, 413, error.message); return; }
      this.sse(response, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }); return;
    }
    const id = message.id, method = message.method;
    if (message.jsonrpc !== "2.0" || typeof method !== "string" || id !== undefined && typeof id !== "string" && (typeof id !== "number" || !Number.isFinite(id))) {
      this.sse(response, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } }); return;
    }
    const params = message.params === undefined ? {} : message.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) { this.sse(response, { jsonrpc: "2.0", id: id ?? null, error: { code: -32602, message: "Invalid params." } }); return; }
    const values = params as JsonObject;
    if (method !== "initialize" && !protocolVersions.includes(this.header(request, "MCP-Protocol-Version"))) { this.reject(response, 400, "Unsupported or missing MCP-Protocol-Version."); return; }
    if (method === "initialize" && (typeof values.protocolVersion !== "string" || !values.clientInfo || typeof values.clientInfo !== "object" || Array.isArray(values.clientInfo)
      || !values.capabilities || typeof values.capabilities !== "object" || Array.isArray(values.capabilities))) {
      this.sse(response, { jsonrpc: "2.0", id: id ?? null, error: { code: -32602, message: "Invalid initialization parameters." } }); return;
    }
    let client = this.header(request, "Mcp-Session-Id");
    if (method === "initialize") client = await this.clients.issue(principal.id);
    else {
      if (!client) { this.reject(response, 400, "Initialize the MCP client before making requests."); return; }
      if (!await this.clients.valid(client, principal.id)) { this.reject(response, 404, "The MCP client identity is no longer valid; initialize again."); return; }
    }
    if (this.closing || generation !== this.generation) { this.reject(response, 503, "The MCP service is stopping."); return; }
    if (id === undefined) {
      if (method === "notifications/cancelled") {
        const key = `${client}:${canonicalId(values.requestId)}`; this.active.get(key)?.controller.abort();
      }
      response.setStatusLine("1.1", 202, "Accepted"); response.finish(); return;
    }
    const key = `${client}:${canonicalId(id)}`;
    if (this.active.size >= maxActiveRequests || [...this.active.values()].filter(row => row.tokenId === principal.id).length >= maxTokenRequests) { this.reject(response, 429, "The MCP concurrency limit was reached."); return; }
    if (this.active.has(key)) { this.sse(response, { jsonrpc: "2.0", id, error: { code: -32600, message: "The request ID is already active." } }); return; }
    const runtime = hostRuntime(), controller = new runtime.AbortController(); this.active.set(key, { controller, tokenId: principal.id });
    const timers = typeof Components === "undefined" ? globalThis : ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    const timeout = timers.setTimeout(() => controller.abort(), 120000);
    let timer: ReturnType<typeof setTimeout> | undefined, alive = true;
    try {
      response.setStatusLine("1.1", 200, "OK"); response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      if (method === "initialize") response.setHeader("Mcp-Session-Id", client);
      response.setHeader("Cache-Control", "no-cache, no-store"); response.setHeader("X-Accel-Buffering", "no");
      response.write(": connected\n\n");
      const heartbeat = () => {
        try { response.write(": heartbeat\n\n"); } catch { alive = false; }
        if (alive) timer = timers.setTimeout(heartbeat, 15000);
      }; timer = timers.setTimeout(heartbeat, 15000);
      let result: unknown, error: JsonObject | undefined;
      if (method === "initialize") {
        if (typeof values.protocolVersion !== "string" || !values.clientInfo || !values.capabilities) error = { code: -32602, message: "Invalid initialization parameters." };
        else result = { protocolVersion: protocolVersions.includes(values.protocolVersion) ? values.protocolVersion : protocolVersions[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "zotero-knowledge-mcp", version: "0.1.2" }, _meta: { "zotero-knowledge-mcp/identity": await implementationIdentity() },
          instructions: `Local knowledge tools, application contract ${applicationContract}. Discover with list_resources, inspect bibliographic detail with get_resources, then search or read evidence. Reading includes original paper footnotes. Text and quote continuations use Unicode code points and bind current content/authorization. Personal tokens use authorized/library/resource/node scopes. Vector/rerank search may contact configured providers. Writes require explicit token permissions; retry uncertain writes with the original operation ID and arguments.` };
      } else if (method === "ping") result = {};
      else if (method === "tools/list") result = { tools: toolDefinitions };
      else if (method === "tools/call") {
        if (typeof values.name !== "string" || !toolDefinitions.some(tool => tool.name === values.name)) error = { code: -32602, message: "Unknown tool." };
        else result = await this.tools.call(values.name, values.arguments ?? {}, principal, controller.signal);
      } else error = { code: -32601, message: "Method not found." };
      let encoded = JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) });
      if (new TextEncoder().encode(encoded).length > maxResponse) encoded = JSON.stringify({ jsonrpc: "2.0", id, result: failure(new McpError("OUTPUT_TOO_LARGE", "Reduce the requested output budget.")) });
      if (alive) response.write(bytes(`event: message\ndata: ${encoded}\n\n`));
    } finally {
      timers.clearTimeout(timeout); if (timer) timers.clearTimeout(timer);
      this.active.delete(key); try { response.finish(); } catch { /* Finish after peer disconnect is harmless. */ }
    }
  }
  private sse(response: HttpResponse, message: JsonObject): void {
    response.setStatusLine("1.1", 200, "OK"); response.setHeader("Content-Type", "text/event-stream; charset=utf-8"); response.setHeader("Cache-Control", "no-store");
    response.write(bytes(`event: message\ndata: ${JSON.stringify(message)}\n\n`)); response.finish();
  }
  async close(): Promise<void> {
    this.stopAccepting();
    await Promise.allSettled([...this.pending]);
    const server = this.server;
    if (server) { await new Promise<void>(resolve => server.stop(resolve)); if (this.server === server) this.server = undefined; }
    this.status = "stopped";
  }
  stopAccepting(): void { this.closing = true; this.generation++; for (const row of this.active.values()) row.controller.abort(); }
}
function canonicalId(id: unknown): string { return `${typeof id}:${String(id)}`; }
