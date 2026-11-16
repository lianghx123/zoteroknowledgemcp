import type { Kysely } from "kysely";
import type { Database } from "../database/types";
import { McpTokens, type TokenInput } from "../security/mcp-tokens";
import { McpCursor } from "../security/mcp-cursor";
import { McpTools } from "../mcp/tools/service";
import { McpHttp, mcpPath } from "../connections/mcp-http";
import type { RetrievalService } from "./retrieval";
import type { EmbeddingService } from "./embedding";
import { requireValue } from "../mcp/contracts";

export class McpService {
  readonly tokens: McpTokens;
  readonly tools: McpTools;
  readonly http: McpHttp;
  private enabled = false;
  private port = 23126;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private error = "";
  constructor(private readonly db: Kysely<Database>, retrieval: RetrievalService, embeddings: EmbeddingService, private readonly changed: () => Promise<void>) {
    this.tokens = new McpTokens(db); const cursor = new McpCursor(db, this.tokens.crypto);
    this.tools = new McpTools(this.tokens, cursor, retrieval, embeddings, changed); this.http = new McpHttp(this.tokens, this.tools);
  }
  async start(): Promise<void> {
    await this.tools.cursors.start();
    const row = await this.db.selectFrom("plugin_state").select("value_json").where("key", "=", "mcp-settings").executeTakeFirst();
    if (row) {
      const config = JSON.parse(row.value_json) as { enabled: boolean; port: number };
      if (typeof config.enabled === "boolean" && Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535) { this.enabled = config.enabled; this.port = config.port; }
    }
    if (this.enabled) { try { this.http.start(this.port); } catch { this.error = "PORT_UNAVAILABLE"; } }
  }
  snapshot() { return { enabled: this.enabled, port: this.port, endpoint: `http://127.0.0.1:${this.port}${mcpPath}`, status: this.http.status, error: this.error }; }
  private schedule<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(Error("MCP is closing."));
    const work = this.tail.then(action); this.tail = work.catch(() => {}); return work;
  }
  configure(enabled: boolean, port: number): Promise<void> {
    return this.schedule(async () => {
      requireValue(Number.isInteger(port) && port >= 1024 && port <= 65535, "Use a port between 1024 and 65535.");
      await this.http.close(); this.error = "";
      this.enabled = enabled; this.port = port;
      if (enabled && !this.closing) { try { this.http.start(port); } catch { this.error = "PORT_UNAVAILABLE"; } }
      await this.db.insertInto("plugin_state").values({ key: "mcp-settings", value_json: JSON.stringify({ enabled, port }), updated_at: Date.now() })
        .onConflict(oc => oc.column("key").doUpdateSet({ value_json: JSON.stringify({ enabled, port }), updated_at: Date.now() })).execute();
    });
  }
  createToken(input: TokenInput) { return this.schedule(() => this.tokens.create(input)); }
  updateToken(id: string, input: TokenInput) { return this.schedule(() => this.tokens.update(id, input)); }
  revokeToken(id: string) { return this.schedule(() => this.tokens.revoke(id)); }
  listTokens() { return this.schedule(() => this.tokens.list()); }
  refreshKnowledgeView(): Promise<void> { return this.schedule(() => this.changed()); }
  libraries() { return this.schedule(async () => (await this.db.selectFrom("knowledge_libraries").select(["id", "name"]).where("deleted_at", "is", null).orderBy("name").execute()).map(row => ({ id: row.id, name: row.name }))); }
  async close(): Promise<void> { this.closing = true; this.http.stopAccepting(); await this.tail; await this.http.close(); this.tools.close(); }
}
