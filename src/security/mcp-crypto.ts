import { canonical } from "../mcp/contracts";
import { hostRuntime } from "../core/host-runtime";

/** Capture a process-lived native crypto implementation, independent of windows. */
export class McpCrypto {
  constructor(private readonly crypto: Crypto = hostRuntime().crypto) {}
  uuid(): string { return this.crypto.randomUUID(); }
  secret(): string { return this.encode(this.crypto.getRandomValues(new Uint8Array(32))); }
  async hash(value: string): Promise<string> {
    const bytes = new Uint8Array(await this.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }
  async sign(key: string, value: unknown): Promise<string> {
    const imported = await this.crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return this.encode(new Uint8Array(await this.crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(canonical(value)))));
  }
  equal(a: string, b: string): boolean {
    let difference = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return difference === 0;
  }
  encode(bytes: Uint8Array): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let output = "", bits = 0, count = 0;
    for (const byte of bytes) { bits = (bits << 8) | byte; count += 8; while (count >= 6) { count -= 6; output += alphabet[(bits >>> count) & 63]; } }
    if (count) output += alphabet[(bits << (6 - count)) & 63];
    return output;
  }
}
