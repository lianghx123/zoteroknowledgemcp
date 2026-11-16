import type { Kysely } from "kysely";
import type { Database } from "../database/types";
import { McpError, applicationContract, canonical, type JsonObject, type Principal } from "../mcp/contracts";
import { McpCrypto } from "./mcp-crypto";

export class McpCursor {
  private key = "";
  constructor(private readonly db: Kysely<Database>, readonly crypto = new McpCrypto(), private readonly now = Date.now) {}
  async start(): Promise<void> {
    await this.db.transaction().execute(async tx => {
      const row = await tx.selectFrom("plugin_state").select("value_json").where("key", "=", "mcp-cursor-key").executeTakeFirst();
      this.key = row ? JSON.parse(row.value_json) as string : this.crypto.secret();
      if (!row) await tx.insertInto("plugin_state").values({ key: "mcp-cursor-key", value_json: JSON.stringify(this.key), updated_at: this.now() }).execute();
    });
  }
  async context(tool: string, args: JsonObject, principal: Principal, state: unknown): Promise<string> {
    const excluded = ["cursor", "cursors", "responseMode", "includeFields", "includeDiagnostics"];
    if (["get_resource_content", "get_resource_nodes"].includes(tool)) excluded.push("maxChars", "maxBlocks", "maxTotalChars");
    const filters = Object.fromEntries(Object.entries(args).filter(([key]) => !excluded.includes(key)));
    return this.crypto.hash(canonical({ contract: applicationContract, tool, filters, principal, state }));
  }
  async encode(context: string, position: JsonObject): Promise<string> {
    const payload = { v: 2, context, position, expires: this.now() + 3600000 };
    const body = encodeURIComponent(canonical(payload));
    return `${body}.${await this.crypto.sign(this.key, payload)}`;
  }
  async decode(cursor: string | undefined, context: string): Promise<JsonObject> {
    if (!cursor) return { offset: 0 };
    try {
      if (cursor.length > 8192) throw Error();
      const split = cursor.lastIndexOf("."), payload = JSON.parse(decodeURIComponent(cursor.slice(0, split))) as { v: number; context: string; expires: number; position: JsonObject };
      if (!this.crypto.equal(cursor.slice(split + 1), await this.crypto.sign(this.key, payload)) || payload.v !== 2) throw Error();
      if (payload.expires <= this.now()) throw new McpError("CURSOR_EXPIRED", "Restart from the first page.", true);
      if (payload.context !== context) throw new McpError("CURSOR_STALE", "The scope, request or content changed; restart from the first page.", true);
      if (!payload.position || typeof payload.position !== "object") throw Error();
      return payload.position;
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError("INVALID_CURSOR", "The cursor is invalid.");
    }
  }
}
