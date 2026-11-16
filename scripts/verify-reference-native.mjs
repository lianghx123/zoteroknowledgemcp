// Developer-driven native SQLite and MCP checks; never opens a daily library.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate } from "./verify-vector-native.mjs";

const port = Number(process.env.ZOTERO_DEBUG_PORT ?? 5399);
const folder = path.resolve(".scaffold/reference-acceptance");
await fs.mkdir(folder, { recursive: true });
const state = JSON.parse(await evaluate("JSON.stringify({dir:Zotero.DataDirectory.dir,version:Zotero.version})", port));
if (!state.dir.replaceAll("\\", "/").includes("/.scaffold/")) throw Error("Isolated development Zotero required");
const probe = path.join(folder, `probe-${Date.now()}.js`);
await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
import { Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { migrations } from "./src/database/migration-provider.ts";
import { ZoteroDialect } from "./src/database/zotero-dialect.ts";
import { createDatabaseOwner } from "./src/database/owner-lease.ts";
import { initializeDatabase } from "./src/database/client.ts";
import { KnowledgeLibraryRepository } from "./src/repositories/knowledge-library.ts";
import { ProcessingRepository } from "./src/repositories/processing.ts";
import { ZoteroParsingPort } from "./src/integrations/zotero/parsing-port.ts";
import { parsePaddleResult, NORMALIZER_VERSION } from "./src/parsers/paddleocr/transform.ts";
import { McpTokens } from "./src/security/mcp-tokens.ts";
import { McpCursor } from "./src/security/mcp-cursor.ts";
import { McpTools } from "./src/mcp/tools/service.ts";
import { hostRuntime } from "./src/core/host-runtime.ts";
import { ReferenceContentRepository } from "./src/repositories/reference-content.ts";
import { ProcessedContentReader } from "./src/repositories/processed-content.ts";
import { renderStructuredContent } from "./src/ui/rendering/structured-content.ts";
import { renderMarkdown } from "./src/ui/rendering/markdown.ts";
import readerStyles from "./addon/content/ui/markdown-reader.css";
export async function run(folder) {
  const report = { runtime: "Zotero " + Zotero.version, checks: [], status: "running" };
  const check = (name, value) => { if (!value) throw Error(name); report.checks.push(name); };
  const parsing = new ZoteroParsingPort(), id = parsing.uuid(), dbPath = PathUtils.join(folder, id + ".sqlite");
  const owner = createDatabaseOwner(dbPath); let database, legacy, tools;
  try {
    await owner.acquire();
    const native = new Zotero.DBConnection(dbPath);
    legacy = new Kysely({ dialect: new ZoteroDialect(native, () => owner.assertHeld()) });
    await sql.raw("PRAGMA foreign_keys = ON").execute(legacy); await native.loadExtension("fts5");
    const baseline = Object.fromEntries(Object.entries(migrations).slice(0, 10));
    const migration = await new Migrator({ db: legacy, provider: { async getMigrations() { return baseline; } } }).migrateToLatest();
    if (migration.error) throw migration.error;
    // Current publication also writes the derived projections. Supply their
    // empty tables only while seeding the legacy fixture, then remove them so
    // initializeDatabase still exercises the real schema-10 upgrade below.
    for (const name of ["0012-visual-links", "0013-reference-numbering"]) for (const statement of migrations[name].statements) await sql.raw(statement).execute(legacy);
    const libraries = new KnowledgeLibraryRepository(legacy, parsing); await libraries.initialize();
    const target = { libraryID: (await libraries.snapshot()).libraries[0].id, nodeID: null };
    const resourceID = await libraries.save({
      library: { localID: 1, type: "user", externalID: "synthetic", name: "Reference probe", editable: true, filesEditable: true },
      itemID: 987654, key: "REFPAPER", kind: "regular", nativeVersion: 1, modified: "2026-11-03", state: "current", title: "Synthetic reference probe",
      itemType: "journalArticle", language: "en", abstract: null, publicationDate: null, contributors: [], fields: {}, tags: [],
      metadataFingerprint: await parsing.hash("metadata"), fingerprint: await parsing.hash("source"),
      attachments: [{ key: "REFPDF01", itemID: 987655, parentKey: "REFPAPER", title: "Synthetic PDF", mediaType: "application/pdf", linkMode: 0, state: "current" }]
    }, target);
    let repository = new ProcessingRepository(legacy, parsing);
    const source = await repository.sourceFor(1, "REFPDF01"), fingerprint = await parsing.hash("synthetic PDF");
    const input = { resourceID, sourceID: source.id, libraryID: 1, attachmentKey: "REFPDF01", title: "Synthetic reference probe", itemType: "journalArticle",
      parser: { profile: "paddleocr", api: "https://example.invalid/unused", model: "PaddleOCR-VL-1.6", options: {}, normalizer: NORMALIZER_VERSION } };
    const document = parsePaddleResult(JSON.stringify({ errorCode: 0, result: { layoutParsingResults: [{ prunedResult: { width: 600, height: 800, parsing_res_list: [
      { block_label: "reference_content", block_content: "［３］． First native reference.", block_id: 1, block_bbox: [10, 100, 500, 140] },
      { block_label: "reference_content", block_content: "Translated continuation.", block_id: 2, block_bbox: [10, 145, 500, 170] },
      { block_label: "reference_content", block_content: "（7）. Second native reference.", block_id: 3, block_bbox: [10, 180, 500, 210] }
    ] }, markdown: { images: {} } }] } }), 1);
    await repository.enqueue(input, fingerprint, 3);
    await repository.publish(await repository.claim("reference-probe"), document, []);
    await legacy.deleteFrom("resource_references").execute();
    await sql.raw("DROP TABLE reference_source_blocks").execute(legacy);
    await sql.raw("DROP TABLE content_reference_projections").execute(legacy);
    await sql.raw("DROP INDEX uq_reference_generation").execute(legacy);
    await sql.raw("ALTER TABLE resource_references DROP COLUMN entry_order").execute(legacy);
    await sql.raw("ALTER TABLE resource_references DROP COLUMN reference_number").execute(legacy);
    await sql.raw("DROP TABLE content_visual_links").execute(legacy);
    await sql.raw("DROP TABLE content_visual_projections").execute(legacy);
    await legacy.destroy(); legacy = undefined; await owner.close();
    database = await initializeDatabase(new Zotero.DBConnection(dbPath), dbPath);
    const db = database.db;
    const count = async () => Number((await db.selectFrom("resource_references").select(eb => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);
    check("native migration 0011 backfills both legacy blocks", await count() === 2);
    check("all thirteen migration checksums accepted", (await db.selectFrom("kysely_migration").select("name").execute()).length === 13);
    const references = new ReferenceContentRepository(db, () => parsing.uuid()); await references.backfill();
    check("native local backfill strips labels and stores original numbers", JSON.stringify((await db.selectFrom("resource_references").select("reference_number").orderBy("entry_order").execute()).map(r => r.reference_number)) === "[3,7]");
    await references.backfill(); check("native backfill is idempotent", await count() === 2);
    const tokens = new McpTokens(db), cursor = new McpCursor(db); await cursor.start(); tools = new McpTools(tokens, cursor);
    const token = await tokens.create({ name: "Synthetic probe", libraryIds: [target.libraryID], scopes: ["knowledge:read"] });
    const principal = await tokens.authenticate(token.secret);
    const args = { resourceId: resourceID, responseMode: "full", limit: 1, includeTotal: true };
    const read = async (values = args) => {
      const response = await tools.call("list_references", values, principal, new (hostRuntime().AbortController)().signal);
      if (response.isError) throw Error(JSON.stringify(response.structuredContent)); return response.structuredContent;
    };
    const before = await read();
    check("native MCP returns number-free merged text in reading order", before.total === 2 && before.items[0].referenceNumber === 3 && before.items[0].rawText.startsWith("First native reference.") && before.items[0].rawText.includes("Translated continuation."));
    check("native MCP retains original bbox", JSON.stringify(before.items[0].locations[0].bbox) === "[10,100,500,140]");
    check("native MCP pagination reaches the original nonconsecutive number", (await read({ ...args, cursor: before.nextCursor })).items[0].referenceNumber === 7);
    const content = await new ProcessedContentReader(db, parsing).read({ libraryID: 1, itemKey: "REFPDF01" });
    const doc = Zotero.Reader._readers.find(reader => reader._iframeWindow?.document?.contentType === "text/html")?._iframeWindow.document;
    if (!doc) throw Error("Open an isolated PDF reader for native HTML layout checks");
    const host = doc.createElement("article"), style = doc.createElement("style");
    host.className = "km-markdown-content"; style.textContent = readerStyles;
    try {
      host.append(renderStructuredContent(doc, content, () => {}).fragment); doc.head.append(style); doc.body.append(host);
      check("native Gecko renders separate original labels", JSON.stringify([...host.querySelectorAll(".km-reference-number")].map(e => e.textContent)) === '["[3]","[7]"]');
      check("native bodies have no duplicate prefixes", [...host.querySelectorAll(".km-reference-body")].every(e => !/^[［（\\[(]/u.test(e.textContent)));
      check("native reference layout uses a hanging number column", doc.defaultView.getComputedStyle(host.querySelector(".km-reference-entry")).display === "grid");
      host.replaceChildren(renderMarkdown(doc, "## References\\n\\nAuthor A. First paper.\\n\\nAuthor B. Second paper.", () => {}).fragment);
      check("native unnumbered bibliography renders sequential labels", JSON.stringify([...host.querySelectorAll(".km-reference-number")].map(e => e.textContent)) === '["[1]","[2]"]');
    } finally { host.remove(); style.remove(); }
    repository = new ProcessingRepository(db, parsing);
    await repository.enqueue(input, fingerprint, 3, true);
    await repository.publish(await repository.claim("reference-probe"), document, []);
    const after = await read();
    check("native reparse retains history and exposes only current generation", await count() === 4 && after.total === 2 && after.items[0].generationId !== before.items[0].generationId);
    check("native foreign key integrity", !(await sql.raw("PRAGMA foreign_key_check").execute(db)).rows.length);
    report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = String(error); report.stack = error?.stack; }
  finally {
    tools?.close();
    try { await database?.close(); await legacy?.destroy(); await owner.close(); }
    catch (error) { report.status = "failed"; report.cleanupError = String(error); }
    // Only this probe's isolated directory contains its database/backup files.
    await IOUtils.writeUTF8(PathUtils.join(folder, "report.json"), JSON.stringify(report, null, 2));
  }
}` }, bundle: true, platform: "browser", target: "firefox140", format: "iife", globalName: "ReferenceAcceptance", loader: { ".css": "text" }, outfile: probe });
const runFolder = path.join(folder, `run-${Date.now()}`);
await fs.mkdir(runFolder);
await evaluate(`Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(probe).href)}); void ReferenceAcceptance.run(${JSON.stringify(runFolder)})`, port);
console.log(`Native checks dispatched: ${path.join(runFolder, "report.json")}`);
