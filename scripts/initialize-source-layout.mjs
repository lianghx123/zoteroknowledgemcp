// Idempotent source skeleton. Implemented modules are never overwritten.
import { mkdir, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modules = {
  app: "Plugin composition, readiness and lifecycle ownership.",
  core: "Small runtime primitives, errors and resource cleanup.",
  shared: "Pure shared contracts and algorithms; no Zotero, database or IO imports.",
  "shared/contracts": "Internal typed contracts for attachment-specific content and knowledge operations.",
  schemas: "Runtime validation for application inputs and persisted import formats.",
  database: "Independent SQLite/Kysely connection, native driver, transactions and upgrade snapshots.",
  "database/models": "Boundary for private SQL row types and mappers; no runtime ORM.",
  "database/migrations": "Statically registered Kysely migrations, historical schema snapshots and integrity checks.",
  repositories: "Persistence interfaces, scoped aggregate queries and transactional publication.",
  services: "Application operations shared by plugin UI and MCP tools.",
  worker: "Durable parsing and vector execution; native admission is composed through application services.",
  "worker/runtime": "Boundary for shared scheduling, lease fencing, retries and restart recovery.",
  "worker/zotero-import-worker": "Reserved worker boundary; current native admission and reconciliation use application services.",
  "worker/parse-worker": "Durable scheduling, provider checkpoints and structured content publication.",
  "worker/vector-worker": "Profile-bound vector queries, index mutations and snapshot persistence.",
  integrations: "Native/runtime and provider adapters with explicit external contracts.",
  "integrations/zotero": "Boundary for verified native item, attachment and notification APIs.",
  storage: "Plugin-managed files and the separate manual-import cache. Never modify Zotero originals.",
  ui: "Zotero-native views, registrations, knowledge UI and the PDF Markdown companion.",
  "ui/view-models": "Boundary for per-window selection, pagination and request state.",
  "ui/views": "Native UI surfaces, including the attachment-specific Markdown reader.",
  "ui/components": "Boundary for reusable UI controls; keep business rules in services.",
  "ui/rendering": "Safe Markdown, math, citation rendering and source navigation.",
  security: "Installation-local tokens, scoped authorization and signed continuation.",
  mcp: "MCP protocol, contracts and dispatch over shared application services.",
  "mcp/tools": "Literature discovery, bounded reading, search and authorized annotation/summary tools.",
  connections: "Loopback Streamable HTTP with SSE responses; public TLS and relay adapters remain deferred.",
};

for (const [directory, purpose] of Object.entries(modules)) {
  const location = new URL(`../src/${directory}/`, import.meta.url);
  await mkdir(location, { recursive: true });
  const readme = new URL("README.md", location);
  try { await access(readme); }
  catch {
    const development = path.relative(fileURLToPath(location), fileURLToPath(new URL("../docs/development/", import.meta.url))).split(path.sep).join("/");
    await writeFile(readme, `# ${directory}\n\n${purpose}\n\nSee the [implementation overview](${development}/implementation-overview.md) and [delivery status](${development}/project-status.md) for implemented behavior and acceptance limits.\n`);
  }
}
console.log(`Initialized ${Object.keys(modules).length} source directories without overwriting existing modules.`);
