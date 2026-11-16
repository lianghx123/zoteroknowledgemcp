import { createHash, randomUUID } from "node:crypto";
import { posix, resolve, join, sep } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { after } from "node:test";
import { build } from "esbuild";
import { mockLocalization } from "../helpers/localization.mjs";
import { MockNativeDatabase } from "../helpers/native-database.mjs";

const compiled = await build({ stdin: { contents: `
export * from "./src/repositories/embeddings.ts";
export * from "./src/services/embedding-input.ts";
export * from "./src/services/retrieval-config.ts";
export * from "./src/services/retrieval.ts";
export * from "./src/services/vector-store.ts";
export * from "./src/services/model-gateway.ts";
export * from "./src/services/embedding.ts";
export * from "./src/services/startup-recovery.ts";
export * from "./src/ui/knowledge/retrieval.ts";
export * from "./src/ui/knowledge/retrieval-results.ts";
export * from "./src/providers/models.ts";
export * from "./src/shared/contracts/retrieval.ts";
export * from "./src/database/client.ts";
export * from "./src/app/plugin.ts";
export * from "./src/repositories/knowledge-library.ts";
export * from "./src/repositories/processing.ts";
export * from "./src/repositories/processed-content.ts";
export * from "./src/repositories/reader-edit.ts";
export * from "./src/shared/contracts/reader-edit.ts";
export * from "./src/services/parsing-config.ts";
export * from "./src/services/parsing.ts";
export * from "./src/services/collection-sync.ts";
export * from "./src/services/import-tasks.ts";
export * from "./src/repositories/collection-sync.ts";
export * from "./src/ui/settings.ts";
export * from "./src/ui/retrieval-settings.ts";
export * from "./src/integrations/zotero/model-credentials.ts";
export * from "./src/ui/knowledge/collection-sync.ts";
export * from "./src/shared/parsing-errors.ts";
export * from "./src/worker/parse-worker/runner.ts";
export * from "./src/parsers/paddleocr/provider.ts";
export * from "./src/parsers/paddleocr/index.ts";
export * from "./src/parsers/mineru/index.ts";
export * from "./src/parsers/registry.ts";
export * from "./src/parsers/catalog.ts";
export * from "./src/parsers/transport.ts";
export * from "./src/parsers/mineru/provider.ts";
export * from "./src/parsers/mineru/archive.ts";
export * from "./src/parsers/mineru/transform.ts";
export * from "./src/shared/parser-profile.ts";
export * from "./src/parsers/paddleocr/transform.ts";
export * from "./src/parsers/running-margins.ts";
export * from "./src/parsers/image-references.ts";
export * from "./src/ui/rendering/markdown.ts";
export * from "./src/shared/contracts/parsing.ts";
export * from "./src/shared/parsing-identity.ts";
export * from "./src/ui/knowledge/title-status.ts";
export * from "./src/ui/knowledge/details.ts";
export * from "./src/services/content-read.ts";
export * from "./src/storage/parse-files.ts";
export * from "./src/storage/file-cleanup.ts";
export * from "./src/storage/reader-content-store.ts";
export * from "./src/ui/knowledge/sync-settings.ts";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, format: "esm", platform: "browser", target: "firefox140", write: false, loader: { ".css": "text" } });
const root = resolve(".scaffold"), scratch = mkdtempSync(join(root, "parsing-tests-"));
writeFileSync(join(scratch, "bundle.mjs"), compiled.outputFiles[0].text);
after(() => { if (!scratch.startsWith(`${root}${sep}`)) throw Error("Invalid test scratch path"); rmSync(scratch, { recursive: true, force: true }); });
export const api = await import(pathToFileURL(join(scratch, "bundle.mjs")).href);
export const hash = async value => createHash("sha256").update(value).digest("hex");
export const bytes = value => new TextEncoder().encode(value);
export const page = (title = "A synthetic paper") => ({ prunedResult: { width: 600, height: 800, parsing_res_list: [
  { block_label: "doc_title", block_content: title, block_id: 0, block_bbox: [10, 20, 500, 60] },
  { block_label: "text", block_content: "Synthetic document body.", block_id: 1, block_bbox: [10, 80, 500, 120] },
] }, markdown: { images: {} } });
export const result = (pages = [page()]) => JSON.stringify({ errorCode: 0, result: { layoutParsingResults: pages } });

export async function parsingFixture(t, providerOverrides = {}) {
  const files = new Map(), pdf = bytes("%PDF-1.7\nSynthetic test attachment");
  globalThis.Localization = mockLocalization();
  globalThis.PathUtils = { join: (...parts) => {
    // Match the native Windows constraint rather than hiding it with Node paths.
    if (parts.slice(1).some(part => part.includes("/"))) throw new Error("Path components must be split");
    return posix.join(...parts);
  }, parent: posix.dirname };
  globalThis.Zotero = { isWin: false, debug() {}, DataDirectory: { dir: "/isolated" },
    DBConnection: class extends MockNativeDatabase { constructor() { super(); } }, Items: { get: () => false }, getMainWindows: () => [globalThis] };
  globalThis.IOUtils = {
    exists: async path => files.has(path) || [...files.keys()].some(key => key.startsWith(`${path}/`)),
    stat: async path => { if (!files.has(path)) throw Error("Missing"); return { size: files.get(path).length }; },
    readUTF8: async path => { if (!files.has(path)) throw Error("Missing"); return new TextDecoder().decode(files.get(path)); },
    read: async path => { if (!files.has(path)) throw Error("Missing"); return new Uint8Array(files.get(path)); },
    writeUTF8: async (path, value) => { files.set(path, bytes(value)); return bytes(value).length; },
    write: async (path, value) => { files.set(path, new Uint8Array(value)); return value.length; },
    remove: async path => { files.delete(path); }, makeDirectory: async () => {},
    getChildren: async path => [...new Set([...files.keys()].filter(key => key.startsWith(`${path}/`)).map(key => `${path}/${key.slice(path.length + 1).split("/")[0]}`))],
  };
  let attachmentBytes = pdf;
  const port = { uuid: randomUUID, hash, attachment: async () => ({ bytes: attachmentBytes, name: "fixture.pdf" }),
    write: IOUtils.write, read: IOUtils.read, exists: IOUtils.exists, remove: IOUtils.remove };
  const native = new MockNativeDatabase();
  const database = await api.initializeDatabase(native, `/isolated/${randomUUID()}.sqlite`);
  const repo = new api.KnowledgeLibraryRepository(database.db, port); await repo.initialize();
  const target = { libraryID: (await repo.snapshot()).libraries[0].id, nodeID: null };
  const item = { library: { localID: 1, type: "user", externalID: "123", name: "Fixture Library", editable: true, filesEditable: true },
    itemID: 10, key: "ARTICLE1", kind: "regular", nativeVersion: 1, modified: "2026-10-22", state: "current", title: "Synthetic paper",
    itemType: "journalArticle", language: "en", abstract: null, publicationDate: null, contributors: [], fields: {}, tags: [],
    metadataFingerprint: await hash("metadata"), fingerprint: await hash("source"),
    attachments: [{ key: "PDFKEY01", itemID: 11, parentKey: "ARTICLE1", title: "Fixture PDF", mediaType: "application/pdf", linkMode: 0, state: "current" }] };
  const resourceID = await repo.save(item, target);
  const repository = new api.ProcessingRepository(database.db, port);
  const source = await repository.sourceFor(1, "PDFKEY01");
  const config = new api.ParsingConfigFile();
  config.current = api.validateParsingConfig({ ...api.defaultParsingConfig, enabled: true, profiles: {
    paddleocr: { api: "https://ocr.example/jobs", model: "PaddleOCR-VL-1.6", key: "private-key", options: {} },
  }, pollIntervalMs: 500 });
  const profile = config.current.profiles.paddleocr;
  const input = { sourceID: source.id, resourceID, libraryID: 1, attachmentKey: "PDFKEY01", title: item.title, itemType: item.itemType,
    fileName: "fixture.pdf", target: "Fixture Knowledge Base", parser: { profile: "paddleocr", api: profile.api, model: profile.model, options: structuredClone(profile.options), normalizer: api.NORMALIZER_VERSION } };
  let submissions = 0, polls = 0;
  const provider = {
    async submit() { return `remote-${++submissions}`; },
    async progress() { polls++; return { state: "done", completed: 1, total: 1, resultURL: "https://results.example/result.jsonl" }; },
    async download() { return bytes(result()); }, ...providerOverrides,
  };
  const parsers = new api.ParserRegistry([new api.PaddleOCRParser(provider), new api.MinerUParser()]);
  const worker = new api.ParseWorker(repository, config, port, parsers, async () => {});
  // Deterministic stage execution; separate tests exercise the scheduler timers.
  worker.stopped = false;
  const closers = [];
  t.after(async () => { for (const close of closers) await close(); await worker.close(); await config.close(); await database.close(); });
  return { database, db: database.db, native, repo, repository, config, port, provider, parsers, worker, input, files, target, item,
    beforeClose: close => closers.push(close),
    get submissions() { return submissions; }, get polls() { return polls; }, setBytes(value) { attachmentBytes = value; },
    enqueue: async (force = false) => repository.enqueue(input, await hash(attachmentBytes), 3, force),
    async step() {
      await database.db.updateTable("processing_jobs").set({ next_run_at: 0 }).where("state", "in", ["pending", "waiting", "retry_wait"]).execute();
      const job = await repository.claim(worker.owner); if (job) await worker.execute(job, new AbortController()); return job;
    },
    async job(id) { return database.db.selectFrom("processing_jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow(); },
  };
}
