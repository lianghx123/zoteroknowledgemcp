import { McpCrypto } from "../security/mcp-crypto";
import { applicationContract, canonical } from "./contracts";
import { toolDefinitions } from "./tools/registry";

declare const __MCP_BUILD__: { commit: string | null; dirty: boolean | null; sourceFingerprint: string | null };

/** Schema and source identities distinguish this implementation from the reference backend. */
export async function implementationIdentity() {
  return { applicationContract, schemaFingerprint: await new McpCrypto().hash(canonical(toolDefinitions)),
    build: typeof __MCP_BUILD__ === "undefined" ? { commit: null, dirty: null, sourceFingerprint: null } : __MCP_BUILD__ };
}
