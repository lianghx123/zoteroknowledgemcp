import { McpCrypto } from "../security/mcp-crypto";

/** Self-contained client identities; no sessions or secrets are persisted. */
export class McpClientIdentity {
  private key = "";
  constructor(private readonly crypto = new McpCrypto()) {}
  restart(): void { this.key = this.crypto.secret(); }
  async issue(tokenId: string): Promise<string> {
    const nonce = this.crypto.uuid();
    return `${nonce}.${await this.crypto.sign(this.key, { tokenId, nonce })}`;
  }
  async valid(id: string, tokenId: string): Promise<boolean> {
    const match = /^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(id);
    return Boolean(match && this.key && this.crypto.equal(match[2], await this.crypto.sign(this.key, { tokenId, nonce: match[1] })));
  }
}
