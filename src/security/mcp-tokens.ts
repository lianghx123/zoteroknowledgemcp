import type { Kysely } from "kysely";
import type { Database } from "../database/types";
import type { DatabaseContext } from "../database/unit-of-work";
import { McpError, requireValue, scopes, type Principal } from "../mcp/contracts";
import { McpCrypto } from "./mcp-crypto";

export interface TokenInput { name: string; libraryIds: string[]; scopes: string[]; expiresInDays?: number; }
export class McpTokens {
  constructor(readonly db: Kysely<Database>, readonly crypto = new McpCrypto(), private readonly now = Date.now) {}
  private async validate(input: TokenInput, db: DatabaseContext): Promise<void> {
    requireValue(input.name.trim().length >= 1 && input.name.trim().length <= 200, "A token name is required.");
    requireValue(input.libraryIds.length >= 1 && input.libraryIds.length <= 100 && new Set(input.libraryIds).size === input.libraryIds.length, "Select 1 to 100 distinct libraries.");
    requireValue(input.scopes.length > 0 && new Set(input.scopes).size === input.scopes.length && input.scopes.every(scope => (scopes as readonly string[]).includes(scope)), "Invalid token scopes.");
    requireValue([30, 90, 180, 365].includes(input.expiresInDays ?? 180), "Invalid token expiry.");
    const libraries = await db.selectFrom("knowledge_libraries").select("id").where("id", "in", input.libraryIds).where("deleted_at", "is", null).execute();
    requireValue(libraries.length === input.libraryIds.length, "A selected library is unavailable.");
  }
  async create(input: TokenInput): Promise<{ id: string; secret: string }> {
    const id = this.crypto.uuid(), selector = this.crypto.uuid(), secret = `zkm_${selector}.${this.crypto.secret()}`, hash = await this.crypto.hash(secret), now = this.now();
    await this.db.transaction().execute(async tx => {
      await this.validate(input, tx);
      await tx.insertInto("mcp_tokens").values({ id, name: input.name.trim(), selector, token_hash: hash, created_at: now,
        expires_at: now + (input.expiresInDays ?? 180) * 86400000, last_used_at: null, revoked_at: null }).execute();
      await this.replaceScope(tx, id, input);
    });
    return { id, secret };
  }
  private async replaceScope(tx: DatabaseContext, id: string, input: TokenInput): Promise<void> {
    await tx.deleteFrom("mcp_token_libraries").where("token_id", "=", id).execute();
    await tx.deleteFrom("mcp_token_scopes").where("token_id", "=", id).execute();
    await tx.insertInto("mcp_token_libraries").values(input.libraryIds.map(library_id => ({ token_id: id, library_id }))).execute();
    await tx.insertInto("mcp_token_scopes").values(input.scopes.map(scope => ({ token_id: id, scope }))).execute();
  }
  async update(id: string, input: TokenInput): Promise<void> {
    await this.db.transaction().execute(async tx => {
      await this.validate(input, tx);
      const token = await tx.selectFrom("mcp_tokens").select("id").where("id", "=", id).where("revoked_at", "is", null).executeTakeFirst();
      requireValue(token, "The token is unavailable.");
      await tx.updateTable("mcp_tokens").set(eb => ({ name: input.name.trim(), authorization_version: eb("authorization_version", "+", 1) })).where("id", "=", id).execute();
      await this.replaceScope(tx, id, input);
    });
  }
  async revoke(id: string): Promise<void> {
    await this.db.updateTable("mcp_tokens").set(eb => ({ revoked_at: this.now(), authorization_version: eb("authorization_version", "+", 1) })).where("id", "=", id).execute();
  }
  async list() {
    const rows = await this.db.selectFrom("mcp_tokens").select(["id", "name", "created_at", "expires_at", "last_used_at", "revoked_at"]).orderBy("created_at", "desc").execute();
    const result = [];
    for (const row of rows) {
      const libraries = await this.db.selectFrom("mcp_token_libraries").select("library_id").where("token_id", "=", row.id).execute();
      const permissions = await this.db.selectFrom("mcp_token_scopes").select("scope").where("token_id", "=", row.id).execute();
      result.push({ id: row.id, name: row.name, createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at, libraryIds: libraries.map(item => item.library_id), scopes: permissions.map(item => item.scope) });
    }
    return result;
  }
  async authenticate(secret: string): Promise<Principal> {
    const match = /^zkm_([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(secret);
    if (!match) throw new McpError("KNOWLEDGE_AUTH_REQUIRED", "A valid local token is required.");
    const row = await this.db.selectFrom("mcp_tokens").select(["id", "token_hash"]).where("selector", "=", match[1]).executeTakeFirst();
    if (!row || !this.crypto.equal(row.token_hash, await this.crypto.hash(secret))) throw new McpError("KNOWLEDGE_AUTH_REQUIRED", "A valid local token is required.");
    const principal = await this.current(row.id);
    await this.db.updateTable("mcp_tokens").set({ last_used_at: this.now() }).where("id", "=", row.id).execute();
    return principal;
  }
  async current(id: string, db: DatabaseContext = this.db): Promise<Principal> {
    const token = await db.selectFrom("mcp_tokens").select(["authorization_version", "revoked_at", "expires_at"]).where("id", "=", id).executeTakeFirst();
    if (!token || token.revoked_at !== null || token.expires_at <= this.now()) throw new McpError("KNOWLEDGE_AUTH_REQUIRED", "The token is expired or revoked.");
    const libraries = await db.selectFrom("mcp_token_libraries as t").innerJoin("knowledge_libraries as l", "l.id", "t.library_id").select("l.id")
      .where("t.token_id", "=", id).where("l.deleted_at", "is", null).where("l.status", "!=", "deleted").orderBy("l.id").execute();
    const permissions = await db.selectFrom("mcp_token_scopes").select("scope").where("token_id", "=", id).orderBy("scope").execute();
    return { id, authorizationVersion: token.authorization_version, libraries: libraries.map(row => row.id), scopes: permissions.map(row => row.scope) };
  }
}
