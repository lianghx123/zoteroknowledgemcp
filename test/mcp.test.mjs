import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mockLocalization } from "./helpers/localization.mjs";
import { api as base, parsingFixture, page as sourcePage, result } from "./fixtures/parsing.mjs";

const bundle = await build({ stdin: { contents: `export * from "./src/security/mcp-tokens.ts"; export * from "./src/security/mcp-cursor.ts";
export * from "./src/security/mcp-crypto.ts"; export * from "./src/mcp/tools/service.ts"; export * from "./src/mcp/tools/registry.ts";
export * from "./src/connections/mcp-http.ts"; export * from "./src/ui/mcp-settings.ts"; export * from "./src/services/retrieval.ts"; export * from "./src/services/mcp.ts"; export * from "./src/services/startup-recovery.ts";`, resolveDir: process.cwd(), loader: "ts" },
bundle: true, platform: "browser", format: "esm", target: "firefox140", write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
async function fixture(t, write = true, overrides = {}) {
  const f = await parsingFixture(t, overrides); await f.enqueue(); await f.step(); await f.step();
  const tokens = new api.McpTokens(f.db), cursor = new api.McpCursor(f.db); await cursor.start();
  const embedding = new base.EmbeddingService(f.db, "file:///fixture/"); t.after(() => embedding.close()); await embedding.repository.projectFulltext();
  const retrieval = new api.RetrievalService(embedding), tools = new api.McpTools(tokens, cursor, retrieval, embedding);
  const created = await tokens.create({ name: "Test", libraryIds: [f.target.libraryID], scopes: write ? ["knowledge:search", "knowledge:read", "knowledge:annotate", "knowledge:update-summary"] : ["knowledge:read"] });
  const principal = await tokens.authenticate(created.secret);
  const call = async (name, args = {}) => {
    const result = await tools.call(name, args, principal, new AbortController().signal);
    if (!result.isError) api.validate(api.toolDefinitions.find(tool => tool.name === name).outputSchema, result.structuredContent, "output");
    return result.structuredContent;
  };
  return { ...f, tokens, cursor, tools, embedding, retrieval, principal, created, call };
}

test("parser bibliography reads preserve block order, positions, pagination and current generations", async t => {
  const source = sourcePage();
  for (let index = 0; index < 3; index++) source.prunedResult.parsing_res_list.push({ block_label: "reference_content",
    block_content: `[${index + 1}] Synthetic reference.`, block_id: index + 2, block_bbox: [10, 200 + index * 50, 500, 240 + index * 50] });
  const f = await fixture(t, false, { download: async () => new TextEncoder().encode(result([source])) });
  const args = { resourceId: f.input.resourceID, referenceType: "bibliography", responseMode: "full", includeTotal: true, limit: 2 };
  const first = await f.call("list_references", args);
  assert.equal(first.structuredReferencesAvailable, true); assert.equal(first.referenceBlocksAvailable, 3);
  assert.equal(first.total, 3); assert.equal(first.returnedCount, 2); assert.equal(first.hasMore, true);
  assert.deepEqual(first.items.map(row => row.rawText), ["Synthetic reference.", "Synthetic reference."]);
  assert.deepEqual(first.items.map(row => row.referenceNumber), [1, 2]);
  assert.deepEqual(first.items.map(row => row.canonicalOrder), [2, 3]);
  for (const [index, row] of first.items.entries()) {
    assert.equal(row.sourceId, f.input.sourceID); assert.equal(row.pageStart, 1); assert.equal(row.pageEnd, 1);
    assert.deepEqual(row.locations, [{ page: 1, bbox: source.prunedResult.parsing_res_list[index + 2].block_bbox, sourceID: String(index + 2) }]);
    assert.equal(row.matchStatus, "unmatched"); assert.equal(row.confidence, null);
  }
  const next = await f.call("list_references", { ...args, cursor: first.nextCursor });
  assert.deepEqual(next.items.map(row => row.rawText), ["Synthetic reference."]);
  assert.equal(next.items[0].referenceNumber, 3);
  const compact = await f.call("list_references", { resourceId: f.input.resourceID, responseMode: "compact" });
  assert.equal(Object.hasOwn(compact.items[0], "locations"), false);
  const positions = await f.call("list_references", { resourceId: f.input.resourceID, includeFields: ["locations", "pageStart"] });
  assert.equal(positions.items[0].pageStart, 1); assert.equal(positions.items[0].locations.length, 1);
  await f.enqueue(true); await f.step(); await f.step();
  const current = await f.call("list_references", { ...args, limit: 10 });
  assert.equal(current.total, 3); assert.ok(current.items.every(row => row.generationId !== first.items[0].generationId));
  assert.ok((await f.call("list_references", { ...args, cursor: first.nextCursor })).error);
  assert.equal((await f.db.selectFrom("resource_references").selectAll().execute()).length, 6);
});

test("all 16 tools advertise bounded schemas and validate arguments", () => {
  assert.equal(api.toolDefinitions.length, 16); assert.equal(new Set(api.toolDefinitions.map(row => row.name)).size, 16);
  for (const tool of api.toolDefinitions) { assert.equal(tool.inputSchema.type, "object"); assert.equal(tool.inputSchema.additionalProperties, false); }
  assert.throws(() => api.argumentsFor("get_resources", { resourceIds: ["bad"] }), /Invalid/);
  assert.throws(() => api.argumentsFor("search_content", { scopeType: "authorized", query: "x", scopeId: "00000000-0000-0000-0000-000000000001" }), /scopeId/);
  assert.throws(() => api.argumentsFor("list_libraries", { limit: 101 }), /Invalid/);
  assert.throws(() => api.argumentsFor("list_libraries", { surprise: true }), /Invalid/);
});

test("reference type filters distinguish no matches from document-wide structured-reference availability", async t => {
  const source = sourcePage();
  for (let index = 0; index < 32; index++) source.prunedResult.parsing_res_list.push({ block_label: "reference_content",
    block_content: `[${index + 1}] Synthetic reference ${index + 1}.`, block_id: index + 2, block_bbox: [10, 150 + index * 15, 500, 164 + index * 15] });
  const f = await fixture(t, false, { download: async () => new TextEncoder().encode(result([source])) });
  const args = { resourceId: f.input.resourceID, includeTotal: true };
  const all = await f.call("list_references", args); assert.equal(all.total, 32);
  for (const responseMode of ["compact", "standard", "full"]) {
    const empty = await f.call("list_references", { ...args, referenceType: "url", responseMode });
    assert.equal(empty.returnedCount, 0); assert.equal(empty.total, 0); assert.deepEqual(empty.items, []);
    assert.equal(empty.structuredReferencesAvailable, true); assert.deepEqual(empty.warnings, []);
    assert.equal(empty.referenceBlocksAvailable, 32); assert.equal(empty.hasMore, false); assert.equal(empty.nextCursor, null);
  }
});

test("a document with no accessible structured references still reports unavailability under a type filter", async t => {
  const f = await fixture(t, false);
  for (const referenceType of [undefined, "url"]) {
    const empty = await f.call("list_references", { resourceId: f.input.resourceID, ...(referenceType ? { referenceType } : {}) });
    assert.equal(empty.structuredReferencesAvailable, false);
    assert.deepEqual(empty.warnings.map(warning => warning.code), ["STRUCTURED_REFERENCES_UNAVAILABLE"]);
  }
});

test("rerank score thresholds require an explicit rerank request before querying or contacting an available provider", async t => {
  const f = await fixture(t); let reranks = 0;
  f.embedding.config.current.enabled = true;
  f.embedding.gateway.rerank = async (_query, texts) => { reranks++; return texts.map((_text, index) => ({ index, score: 0.9 })); };
  const args = { scopeType: "authorized", mode: "metadata", query: "Synthetic", minScoreBasis: "rerank" };
  for (const rerankPolicy of ["best_effort", "required"]) for (const rerank of [undefined, false]) for (const minScore of [undefined, 0, 0.5]) {
    const before = f.native.queries.length;
    const result = await f.call("search_content", { ...args, ...(rerank === undefined ? {} : { rerank }), ...(minScore === undefined ? {} : { minScore }), rerankPolicy });
    assert.equal(result.error.code, "INVALID_ARGUMENT"); assert.equal(result.error.retryable, false);
    assert.match(result.error.message, /reranking was not requested/); assert.equal(result.error.details.field, "rerank");
    assert.equal(f.native.queries.length, before); assert.equal(reranks, 0);
  }
  const ranked = await f.call("search_content", { ...args, rerank: true, minScore: 0.5, includeDiagnostics: true });
  assert.equal(ranked.returnedCount, 1); assert.equal(ranked.diagnostics.minScoreApplied, true); assert.equal(reranks, 1);
  assert.deepEqual(ranked.warnings, []);
  const filtered = await f.call("search_content", { ...args, rerank: true, minScore: 0.95 });
  assert.equal(filtered.returnedCount, 0); assert.equal(reranks, 2);
  assert.equal(api.argumentsFor("search_content", { ...args, rerank: false, minScoreBasis: "vector", minScore: 0 }).rerank, false);
});

test("tool argument validation rejects inherited schema keys and prototype-injected budgets", () => {
  const resourceId = "00000000-0000-0000-0000-000000000001";
  for (const key of ["__proto__", "constructor", "toString"]) {
    const payload = JSON.parse(`{"resourceId":"${resourceId}","${key}":{"maxChars":100000000}}`);
    assert.throws(() => api.argumentsFor("get_resource_content", payload), /Invalid/);
  }
  assert.throws(() => api.argumentsFor("get_resource_content", Object.create({ resourceId })), /Invalid/);
  const args = api.argumentsFor("get_resource_content", { resourceId });
  assert.equal(Object.getPrototypeOf(args), null); assert.equal(args.maxChars, 12000);
  assert.throws(() => api.argumentsFor("get_resource_content", { resourceId, maxChars: 50001 }), /Invalid/);
  assert.equal(Object.hasOwn(api.argumentsFor("search_content", { scopeType: "authorized", query: "Synthetic", minScore: null }), "minScore"), false);
});

test("rerank failure preserves best-effort results and an empty search is never a rerank failure", async t => {
  const f = await fixture(t), args = { scopeType: "authorized", mode: "metadata", query: "Synthetic", rerank: true, minScore: 0.5, minScoreBasis: "rerank", includeDiagnostics: true };
  const fallback = await f.call("search_content", { ...args, rerankPolicy: "best_effort" });
  assert.equal(fallback.returnedCount, 1); assert.equal(fallback.diagnostics.minScoreApplied, false);
  assert.ok(fallback.warnings.some(warning => warning.code === "RERANK_MIN_SCORE_NOT_APPLIED"));
  assert.equal((await f.call("search_content", { ...args, rerankPolicy: "required" })).error.code, "RERANK_UNAVAILABLE");
  for (const rerankPolicy of ["best_effort", "required"]) {
    const empty = await f.call("search_content", { ...args, query: "zzznomatchingdocument", rerankPolicy });
    assert.equal(empty.returnedCount, 0); assert.equal(empty.warnings.length, 0);
  }
});

test("vector thresholds retain cosine scores after rerank and snippets preserve the actual tail segment", async t => {
  const source = sourcePage(), tail = "TAILMARKER decisive experimental outcome.";
  source.prunedResult.parsing_res_list[1].block_content = "Unrelated introductory discussion. ".repeat(200) + tail;
  const f = await fixture(t, true, { download: async () => new TextEncoder().encode(result([source])) });
  const block = (await f.tools.repository.blockHeaders(f.input.resourceID, f.principal)).sort((a,b) => b.charCount - a.charCount)[0];
  f.embedding.config.current.enabled = true;
  f.embedding.gateway.embed = async () => [new Float32Array(768).fill(1)];
  f.embedding.gateway.rerank = async () => [{ index: 0, score: 0.95 }];
  f.retrieval.vector = async () => [{ resourceID: f.input.resourceID, title: "Synthetic paper", score: 0.9, scoreType: "cosine", parsed: true, embedded: true, metadataOnly: false,
    evidence: [{ blockID: block.id, sourceID: block.sourceId, generationID: block.generationId, text: tail, section: null, page: 1, channel: "vector", score: 0.9, scoreType: "cosine" }] }];
  const search = await f.call("search_content", { scopeType: "authorized", mode: "vector", query: "TAILMARKER", rerank: true, minScore: 0.5, minScoreBasis: "vector", snippetMaxChars: 100 });
  assert.equal(search.returnedCount, 1); assert.equal(search.items[0].resourceScore, 0.95);
  assert.ok(search.items[0].matches[0].snippet.includes(tail));
  assert.ok(Array.from(search.items[0].matches[0].snippet).length <= 100);
  const fulltext = await f.call("search_content", { scopeType: "authorized", mode: "fulltext", query: "TAILMARKER", snippetMaxChars: 100 });
  assert.equal(fulltext.returnedCount, 1); assert.ok(fulltext.items[0].matches[0].snippet.includes("TAILMARKER"));
});

test("folder resource counts and node searches include the entire deep subtree", async t => {
  const f = await fixture(t); let parent = await f.repo.create("Root", f.target); const root = parent;
  for (let depth = 0; depth < 7; depth++) parent = await f.repo.create(`Depth ${depth}`, { libraryID: f.target.libraryID, nodeID: parent });
  await f.repo.save(f.item, { libraryID: f.target.libraryID, nodeID: parent });
  const folders = await f.call("list_folders", { libraryId: f.target.libraryID });
  assert.equal(folders.items[0].resourceCount, 1); assert.equal(folders.items[0].countStatus, "exact");
  assert.equal((await f.call("list_resources", { nodeId: root, nodeDescendantDepth: 4 })).returnedCount, 0);
  const search = await f.call("search_content", { scopeType: "node", scopeId: root, query: "Synthetic", mode: "metadata" });
  assert.equal(search.returnedCount, 1);
});

test("small document, node and block budgets bound text fetched from SQLite", async t => {
  const f = await fixture(t), headers = await f.tools.repository.blockHeaders(f.input.resourceID, f.principal);
  const native = f.native.queryAsync.bind(f.native); let textRead = 0;
  f.native.queryAsync = (statement, parameters, options) => native(statement, parameters, { ...options, onRow(row, cancel) {
    return options.onRow?.({ getResultByName(key) { const value = row.getResultByName(key); if (key === "markdown") textRead += Array.from(value).length; return value; } }, cancel);
  } });
  f.native.queries.length = 0;
  assert.equal((await f.call("get_resource_content", { resourceId: f.input.resourceID, maxChars: 1 })).charCountReturned, 1);
  assert.equal(textRead, 1);
  assert.equal((await f.call("get_content_blocks_text", { resourceId: f.input.resourceID, blockIds: headers.map(block => block.id), maxTotalChars: 2 })).totalCharsReturned, 2);
  assert.equal(textRead, 3);
  const nodes = await f.call("list_resource_nodes", { resourceId: f.input.resourceID });
  const read = await f.call("get_resource_nodes", { nodeIds: [nodes.items[0].nodeId], includeChildren: true, maxChars: 2, maxTotalChars: 2 });
  assert.equal(read.totalCharsReturned, 2); assert.equal(textRead, 5);
  assert.ok(!f.native.queries.some(statement => statement.includes('"b".*')));
});

test("native cleanup can publish a refreshed knowledge view without modifying literature", async t => {
  const f = await fixture(t); let refreshes = 0;
  const service = new api.McpService(f.db, f.retrieval, f.embedding, async () => { refreshes++; });
  await service.start(); await service.refreshKnowledgeView(); assert.equal(refreshes, 1);
  assert.equal((await f.db.selectFrom("knowledge_resources").select("version").where("id", "=", f.input.resourceID).executeTakeFirstOrThrow()).version, 2);
  await service.close();
});

test("token secrets are hashed, scopes editable, libraries explicit, expiry and revocation enforced", async t => {
  const f = await fixture(t), stored = await f.db.selectFrom("mcp_tokens").selectAll().executeTakeFirstOrThrow();
  assert.ok(!JSON.stringify(stored).includes(f.created.secret)); assert.equal(stored.token_hash.length, 64);
  await assert.rejects(f.tokens.authenticate("Bearer login-token"));
  await assert.rejects(f.tokens.create({ name: "bad", libraryIds: [], scopes: ["knowledge:read"] }));
  await f.tokens.update(f.created.id, { name: "Read only", libraryIds: [f.target.libraryID], scopes: ["knowledge:read"] });
  assert.equal((await f.call("list_libraries")).error.code, "KNOWLEDGE_SCOPE_REQUIRED");
  await f.tokens.revoke(f.created.id); await assert.rejects(f.tokens.authenticate(f.created.secret), /expired or revoked/);
  assert.equal((await f.call("get_resources", { resourceIds: [f.input.resourceID] })).error.code, "KNOWLEDGE_AUTH_REQUIRED");
});

test("discovery, nodes, blocks, reference availability and fulltext search work over current generations", async t => {
  const f = await fixture(t), id = f.input.resourceID;
  assert.equal((await f.call("list_libraries")).items[0].libraryId, f.target.libraryID);
  assert.equal((await f.call("list_folders", { libraryId: f.target.libraryID })).returnedCount, 0);
  assert.equal((await f.call("list_resources")).items[0].resourceId, id);
  assert.equal((await f.call("get_resources", { resourceIds: [id] })).returnedCount, 1);
  const nodes = await f.call("list_resource_nodes", { resourceId: id }); assert.ok(nodes.items.length);
  const read = await f.call("get_resource_nodes", { nodeIds: [nodes.items[0].nodeId], includeChildren: true }); assert.ok(read.items[0].contentMarkdown);
  const blocks = await f.call("list_content_blocks", { resourceId: id, includePreview: false, responseMode: "full" }); assert.ok(blocks.items.length);
  assert.ok(blocks.items.every(row => !("preview" in row) && !("previewTruncated" in row)));
  const texts = await f.call("get_content_blocks_text", { resourceId: id, blockIds: blocks.items.map(row => row.blockId), maxTotalChars: 4 });
  assert.equal(texts.totalCharsReturned, 4); assert.ok(texts.omittedBlockIds.length);
  assert.ok((await f.call("list_block_types", { resourceId: id })).totalBlocks);
  assert.equal((await f.call("list_references", { resourceId: id })).structuredReferencesAvailable, false);
  assert.ok((await f.call("list_revisions", { resourceId: id })).items.length);
  assert.equal((await f.call("list_annotations", { resourceId: id })).returnedCount, 0);
  const search = await f.call("search_content", { scopeType: "authorized", query: "Synthetic", mode: "metadata" }); assert.ok(search.items?.length, JSON.stringify(search));
  assert.equal((await f.call("search_content", { scopeType: "run", query: "Synthetic" })).error.code, "KNOWLEDGE_RUN_SCOPE_UNAVAILABLE");
});

test("Unicode reads continue without gaps; changed parameters and content invalidate signed cursors", async t => {
  const source = sourcePage(); source.prunedResult.parsing_res_list[1].block_content = "甲😀乙🧪丙 This is Unicode evidence.";
  const f = await fixture(t, true, { download: async () => new TextEncoder().encode(result([source])) }), id = f.input.resourceID;
  const whole = await f.call("get_resource_content", { resourceId: id }); let content = "", cursor;
  do { const page = await f.call("get_resource_content", { resourceId: id, maxChars: 2, ...(cursor ? { cursor } : {}) }); assert.ok(!page.error, JSON.stringify(page)); content += page.contentMarkdown; cursor = page.nextCursor; } while (cursor);
  assert.equal(content, whole.contentMarkdown);
  const page = await f.call("get_resource_content", { resourceId: id, maxChars: 2 });
  assert.equal((await f.call("get_resource_content", { resourceId: id, maxChars: 3, includeBoilerplate: true, cursor: page.nextCursor })).error.code, "CURSOR_STALE");
  await f.db.updateTable("knowledge_resources").set(eb => ({ version: eb("version", "+", 1) })).where("id", "=", id).execute();
  assert.equal((await f.call("get_resource_content", { resourceId: id, maxChars: 2, cursor: page.nextCursor })).error.code, "CURSOR_STALE");
  await assert.rejects(f.cursor.decode(`${page.nextCursor}x`, "x"), /invalid/);
});

test("writes are transactional, version checked and retry safe; annotations survive reparse", async t => {
  const f = await fixture(t), id = f.input.resourceID, row = await f.db.selectFrom("knowledge_resources").select("version").where("id", "=", id).executeTakeFirstOrThrow();
  const summary = { resourceId: id, summary: "A local summary", operationId: "summary-1", expectedVersion: row.version };
  const receipt = await f.call("update_summary", summary); assert.ok(!receipt.error, JSON.stringify(receipt)); assert.equal(receipt.version, row.version + 1);
  assert.equal((await f.call("update_summary", summary)).replayed, true);
  assert.equal((await f.call("update_summary", { ...summary, summary: "Changed" })).error.code, "OPERATION_ID_CONFLICT");
  assert.equal((await f.call("update_summary", { ...summary, operationId: "summary-2" })).error.code, "VERSION_CONFLICT");
  const block = await f.db.selectFrom("content_blocks").select("id").executeTakeFirstOrThrow();
  const annotation = await f.call("add_annotation", { resourceId: id, contentBlockId: block.id, annotationType: "evidence", text: "Retain this evidence", operationId: "note-1", expectedVersion: receipt.version });
  assert.ok(annotation.annotationId, JSON.stringify(annotation));
  await f.enqueue(true); await f.step(); await f.step();
  const annotations = await f.call("list_annotations", { resourceId: id, responseMode: "full" }); assert.equal(annotations.items[0].anchorState, "historical");
  assert.equal((await f.db.selectFrom("knowledge_resources").select("summary").where("id", "=", id).executeTakeFirstOrThrow()).summary, "A local summary");
});

test("unauthorized batches, folders and references reveal no foreign library membership", async t => {
  const f = await fixture(t), library = await f.repo.create("Hidden library"), foreign = await f.repo.save({ ...f.item, key: "PRIVATE1", itemID: 25, title: "Hidden paper", attachments: [] }, { libraryID: library, nodeID: null });
  const read = await f.call("get_resources", { resourceIds: [foreign, f.input.resourceID], responseMode: "full" });
  assert.equal(read.items.length, 1); assert.deepEqual(read.missingResourceIds, [foreign]); assert.deepEqual(read.items[0].libraryIds, [f.target.libraryID]);
  assert.equal((await f.call("get_resource_content", { resourceId: foreign })).error.code, "KNOWLEDGE_RESOURCE_OUT_OF_SCOPE");
  assert.equal((await f.call("list_folders", { libraryId: library })).error.code, "KNOWLEDGE_RESOURCE_OUT_OF_SCOPE");
  await f.db.insertInto("resource_references").values({ id: crypto.randomUUID(), resource_id: f.input.resourceID, source_id: null, generation_id: null, source_block_id: null,
    target_resource_id: foreign, target_source_id: null, target_generation_id: null, target_block_id: null, reference_type: "citation", label: "Private target", raw_text: "Private reference text",
    confidence: null, created_at: Date.now(), updated_at: Date.now(), deleted_at: null }).execute();
  const references = await f.call("list_references", { resourceId: f.input.resourceID, includeTotal: true });
  assert.equal(references.returnedCount, 0); assert.equal(references.total, 0); assert.ok(!JSON.stringify(references).includes("Private"));
  const filtered = await f.call("list_references", { resourceId: f.input.resourceID, referenceType: "url" });
  assert.equal(filtered.structuredReferencesAvailable, false); assert.equal(filtered.warnings[0].code, "STRUCTURED_REFERENCES_UNAVAILABLE");
  await f.repo.remove(f.input.resourceID, f.target);
  assert.equal((await f.call("list_resources")).returnedCount, 0);
});

test("failed mutation rolls back annotation, resource version, revision, outbox and receipt", async t => {
  const f = await fixture(t), resource = await f.db.selectFrom("knowledge_resources").select("version").where("id", "=", f.input.resourceID).executeTakeFirstOrThrow();
  const counts = async () => Promise.all(["resource_annotations", "resource_revisions", "change_outbox", "mutation_receipts"].map(async table => (await f.db.selectFrom(table).select(eb => eb.fn.countAll().as("count")).executeTakeFirstOrThrow()).count));
  const before = await counts(), native = f.native.queryAsync.bind(f.native);
  f.native.queryAsync = async (statement, ...args) => { if (statement.startsWith('insert into "mutation_receipts"')) throw Error("Injected receipt failure"); return native(statement, ...args); };
  const args = { resourceId: f.input.resourceID, annotationType: "claim", text: "Transactional", operationId: "rollback-1", expectedVersion: resource.version };
  assert.equal((await f.call("add_annotation", args)).error.code, "INTERNAL_ERROR");
  f.native.queryAsync = native;
  assert.deepEqual(await counts(), before);
  assert.equal((await f.db.selectFrom("knowledge_resources").select("version").where("id", "=", f.input.resourceID).executeTakeFirstOrThrow()).version, resource.version);
  const receipts = await Promise.all([f.call("add_annotation", args), f.call("add_annotation", args)]);
  assert.equal(receipts.filter(row => row.replayed === false).length, 1); assert.equal(receipts.filter(row => row.replayed === true).length, 1);
});

test("cursor TTL, authorization editing and search snapshots preserve independent result budgets", async t => {
  const f = await fixture(t); let now = 1000;
  const cursor = new api.McpCursor(f.db, f.tokens.crypto, () => now); await cursor.start();
  const encoded = await cursor.encode("scope", { offset: 2 }); assert.equal((await cursor.decode(encoded, "scope")).offset, 2);
  now += 3600001; await assert.rejects(cursor.decode(encoded, "scope"), /Restart/);
  for (let i = 0; i < 3; i++) await f.repo.save({ ...f.item, key: `EXTRA00${i}`, itemID: 100 + i, title: `Synthetic extra ${i}`, attachments: [] }, f.target);
  const embedding = new base.EmbeddingService(f.db, "file:///fixture/"); t.after(() => embedding.close());
  embedding.config.current.results = 1; await embedding.repository.projectFulltext();
  const tools = new api.McpTools(f.tokens, f.cursor, new base.RetrievalService(embedding), embedding);
  const args = { scopeType: "authorized", mode: "metadata", query: "Synthetic", candidateLimit: 10, limit: 2 };
  const first = (await tools.call("search_content", args, f.principal, new AbortController().signal)).structuredContent;
  assert.equal(first.returnedCount, 2); assert.ok(first.nextCursor);
  const second = (await tools.call("search_content", { ...args, cursor: first.nextCursor }, f.principal, new AbortController().signal)).structuredContent;
  assert.equal(second.returnedCount, 2); assert.equal(new Set([...first.items, ...second.items].map(row => row.resourceId)).size, 4);
  await f.tokens.update(f.principal.id, { name: "Changed", libraryIds: [f.target.libraryID], scopes: ["knowledge:search"] });
  assert.equal((await tools.call("search_content", { ...args, cursor: first.nextCursor }, f.principal, new AbortController().signal)).structuredContent.error.code, "CURSOR_STALE");
});

test("folder expansion obeys depth and boolean projection gates", async t => {
  const f = await fixture(t), parent = await f.repo.create("Parent", f.target);
  await f.repo.create("Child", { libraryID: f.target.libraryID, nodeID: parent });
  const first = await f.call("list_folders", { libraryId: f.target.libraryID, descendantDepth: 1, includeResourceCount: false, responseMode: "full" });
  assert.equal(first.items.length, 1); assert.equal(first.items[0].parentNodeId, null); assert.ok(!("resourceCount" in first.items[0]));
  assert.equal((await f.call("list_folders", { libraryId: f.target.libraryID, descendantDepth: 2 })).items.length, 2);
  assert.equal((await f.call("list_folders", { libraryId: f.target.libraryID, descendantDepth: 0 })).items.length, 0);
  const blocks = await f.call("list_content_blocks", { resourceId: f.input.resourceID, includePreview: false, includeFields: ["preview", "previewTruncated"] });
  assert.ok(!blocks.error); assert.ok(blocks.items.every(row => !("preview" in row)));
});

test("partial publication and unavailable vector channels are explicit MCP outcomes", async t => {
  const f = await fixture(t, true, { progress: async () => ({ state: "done", completed: 1, total: 2, resultURL: "https://result.example/partial" }) });
  const read = await f.call("get_resource_content", { resourceId: f.input.resourceID });
  assert.ok(read.warnings.some(warning => warning.code === "PARTIAL_CONTENT"));
  const vector = await f.call("search_content", { scopeType: "authorized", query: "Synthetic", mode: "vector" });
  assert.equal(vector.error.code, "VECTOR_UNAVAILABLE"); assert.equal(vector.error.details.reason, "config");
});

for (const locale of ["en-US", "zh-CN", "zh-TW", "de", "fr-FR", "es-ES", "ja-JP"]) test(`MCP settings in ${locale} render scoped token controls and keep the secret out of text`, async t => {
  const f = await fixture(t), dom = new JSDOM("<section id='host'></section>");
  const localize = new (mockLocalization(locale))(["knowledgemcp.ftl"], true); globalThis.Localization = mockLocalization(locale);
  Zotero.__knowledgeMCPAccess = { snapshot: () => ({ enabled: false, port: 23126, endpoint: "http://127.0.0.1:23126/mcp/knowledge", status: "stopped", error: "" }),
    listTokens: () => f.tokens.list(), libraries: async () => [{ id: f.target.libraryID, name: "Fixture" }], createToken: input => f.tokens.create(input) };
  const host = dom.window.document.getElementById("host"), dispose = await api.mountMcpSettings(host);
  assert.ok(host.querySelector("#km-mcp-settings")); assert.equal(host.querySelector("#km-mcp-port").value, "23126");
  assert.equal(host.querySelector(".km-mcp-token-editor"), null);
  host.querySelector("#km-mcp-new-token").click();
  assert.ok(host.querySelectorAll("fieldset input[type=checkbox]").length >= 5);
  assert.ok(!host.textContent.includes(f.created.secret));
  // A native Localization instance is lazy and process-scoped; direct formatting
  // verifies the locale catalog independently of the shared module singleton.
  assert.ok(localize.formatValueSync("knowledgemcp-mcp-days", { days: 180 }).includes("180"));
  dispose(); assert.equal(host.children.length, 0); delete Zotero.__knowledgeMCPAccess; dom.window.close();
});

function response() {
  return { headers: {}, body: "", status: 0, done: false, setStatusLine(_v, status) { this.status = status; }, setHeader(key, value) { this.headers[key] = value; }, processAsync() {}, write(value) { this.body += value; }, finish() { this.done = true; } };
}

for (const [tail, query] of [["ÉCOLOGIE importante", "écologie"], ["ＥＣＯＬＯＧＹ result", "ecology"], ["e\u0301cologie importante", "ecologie"], ["ﬁnding evidence", "finding"], ["東京研究結論", "京研"], ["İSTANBUL evidence", "istanbul"], ["ΟΣ evidence", "οσ"]]) {
  test(`fulltext windows preserve normalized Unicode tail evidence: ${query}`, async t => {
    const source = sourcePage(); source.prunedResult.parsing_res_list[1].block_content = "Unrelated 😀 introduction. ".repeat(400) + tail;
    const f = await fixture(t, true, { download: async () => new TextEncoder().encode(result([source])) });
    const response = await f.call("search_content", { scopeType: "authorized", query, mode: "fulltext", snippetMaxChars: 100 });
    assert.equal(response.returnedCount, 1, JSON.stringify(response));
    assert.ok(response.items[0].matches[0].snippet.includes(tail));
    assert.ok(Array.from(response.items[0].matches[0].snippet).length <= 100);
  });
}

test("output snippet budgets cannot change rerank input, score or threshold membership", async t => {
  const source = sourcePage(); source.prunedResult.parsing_res_list[1].block_content = "Evidence supports scientific conclusions. ".repeat(50) + "DECISIVE measured outcome.";
  const f = await fixture(t, true, { download: async () => new TextEncoder().encode(result([source])) }), inputs = [];
  f.embedding.config.current.enabled = true;
  f.embedding.gateway.rerank = async (_query, texts) => { inputs.push(texts); return texts.map((text, index) => ({ index, score: text.includes("DECISIVE") ? 0.9 : 0.1 })); };
  const args = { scopeType: "authorized", query: "Evidence", mode: "fulltext", rerank: true, rerankPolicy: "required", minScore: 0.5, minScoreBasis: "rerank" };
  const small = await f.call("search_content", { ...args, snippetMaxChars: 50 }), large = await f.call("search_content", { ...args, snippetMaxChars: 2000 });
  assert.equal(small.returnedCount, 1); assert.equal(large.returnedCount, 1); assert.deepEqual(inputs[0], inputs[1]);
  assert.equal(small.items[0].resourceScore, large.items[0].resourceScore);
});

test("rerank passage limits count Unicode characters and never split a surrogate pair", async t => {
  const source = sourcePage(); source.prunedResult.parsing_res_list[1].block_content = "Evidence " + "😀".repeat(7100);
  const f = await fixture(t, true, { download: async () => new TextEncoder().encode(result([source])) });
  f.embedding.config.current.enabled = true; let called = false;
  f.embedding.gateway.rerank = async (_query, texts) => {
    called = true; assert.ok(texts.every(text => Array.from(text).length <= 7000 && text.isWellFormed()));
    return texts.map((_text, index) => ({ index, score: 0.9 }));
  };
  const response = await f.call("search_content", { scopeType: "authorized", query: "Evidence", mode: "fulltext", rerank: true, rerankPolicy: "required" });
  assert.equal(response.returnedCount, 1, JSON.stringify(response)); assert.equal(called, true);
});

test("legacy fulltext projections rebuild Unicode positions locally without changing content", async t => {
  const f = await fixture(t), resource = await f.db.selectFrom("knowledge_resources").select("version").where("id", "=", f.input.resourceID).executeTakeFirstOrThrow();
  await f.db.updateTable("search_documents").set({ tokenizer_profile: "unicode-cjk-bigram-1", body_offsets_json: "[]" }).where("document_kind", "=", "block").execute();
  f.embedding.gateway.embed = f.embedding.gateway.rerank = async () => { throw Error("Projection must remain local"); };
  await f.embedding.repository.projectFulltext();
  const rows = await f.db.selectFrom("search_documents").select(["tokenizer_profile", "body_offsets_json"]).where("document_kind", "=", "block").execute();
  assert.ok(rows.every(row => row.tokenizer_profile === "unicode-cjk-bigram-2" && JSON.parse(row.body_offsets_json).length));
  assert.equal((await f.db.selectFrom("knowledge_resources").select("version").where("id", "=", f.input.resourceID).executeTakeFirstOrThrow()).version, resource.version);
});

test("concurrent fulltext recovery publishes each projection once without duplicate metadata or revisions", async t => {
  const f = await fixture(t);
  const extra = await f.repo.save({ ...f.item, key: "PARALLEL", itemID: 104, title: "Concurrent synthetic paper", attachments: [] }, f.target);
  const revision = async () => Number((await f.db.selectFrom("plugin_state").select("value_json").where("key", "=", "fulltext-revision").executeTakeFirstOrThrow()).value_json);
  await f.db.updateTable("search_documents").set({ tokenizer_profile: "unicode-cjk-bigram-1", body_offsets_json: "[]" }).execute();
  const before = await revision(), existing = await f.db.selectFrom("search_documents").select("rowid").execute();
  await Promise.all(Array.from({ length: 3 }, () => f.embedding.repository.projectFulltext()));
  assert.equal((await f.db.selectFrom("search_documents").select("rowid").where("resource_id", "=", extra).where("document_kind", "=", "metadata").execute()).length, 1);
  assert.equal(await revision() - before, existing.length + 1);
  const stable = await revision(); await f.embedding.repository.projectFulltext(); assert.equal(await revision(), stable);
});

for (const change of ["revoke", "expire", "permissions", "libraries"]) test(`authorization ${change} after embedding prevents candidate reads and rerank dispatch`, async t => {
  const f = await fixture(t); f.embedding.config.current.enabled = true;
  let release, entered, candidates = 0, reranks = 0;
  const gate = new Promise(resolve => release = resolve), paused = new Promise(resolve => entered = resolve);
  f.embedding.gateway.embed = async () => { entered(); await gate; return [new Float32Array(768).fill(1)]; };
  f.retrieval.vector = async () => { candidates++; throw Error("Unauthorized candidate read"); };
  f.embedding.gateway.rerank = async () => { reranks++; return []; };
  const pending = f.call("search_content", { scopeType: "authorized", query: "fresh query", mode: "vector", rerank: true });
  await paused;
  if (change === "revoke") await f.tokens.revoke(f.created.id);
  else if (change === "expire") f.tokens.now = () => Date.now() + 366 * 86400000;
  else {
    const library = change === "libraries" ? await f.repo.create("Other library") : f.target.libraryID;
    await f.tokens.update(f.created.id, { name: "Edited", libraryIds: [library], scopes: change === "permissions" ? ["knowledge:read"] : ["knowledge:search", "knowledge:read"] });
  }
  release(); const response = await pending;
  assert.equal(response.error.code, ["revoke", "expire"].includes(change) ? "KNOWLEDGE_AUTH_REQUIRED" : "KNOWLEDGE_SCOPE_REQUIRED");
  assert.equal(candidates, 0); assert.equal(reranks, 0);
});

test("attachment replacement invalidates cached search evidence before publication", async t => {
  const f = await fixture(t);
  await f.repo.save({ ...f.item, key: "SECOND01", itemID: 120, title: "Synthetic second paper", attachments: [] }, f.target);
  await f.embedding.repository.projectFulltext();
  const args = { scopeType: "authorized", query: "Synthetic", mode: "hybrid", limit: 1 };
  const first = await f.call("search_content", args); assert.ok(first.nextCursor, JSON.stringify(first));
  const before = await f.db.selectFrom("knowledge_resources").select("version").where("id", "=", f.input.resourceID).executeTakeFirstOrThrow();
  f.setBytes(new TextEncoder().encode("%PDF-1.7\nReplacement PDF")); await f.enqueue();
  assert.equal((await f.db.selectFrom("knowledge_resources").select("version").where("id", "=", f.input.resourceID).executeTakeFirstOrThrow()).version, before.version);
  assert.equal((await f.tools.repository.blockHeaders(f.input.resourceID, f.principal)).length, 0);
  assert.equal((await f.call("search_content", { ...args, cursor: first.nextCursor })).error.code, "CURSOR_STALE");
});

test("fulltext projection revisions invalidate snapshots and roll back with projection transactions", async t => {
  const f = await fixture(t);
  await f.repo.save({ ...f.item, key: "EXTRA001", itemID: 100, title: "Synthetic extra one", attachments: [] }, f.target); await f.embedding.repository.projectFulltext();
  await f.repo.save({ ...f.item, key: "EXTRA002", itemID: 101, title: "Synthetic extra two", attachments: [] }, f.target);
  const args = { scopeType: "authorized", query: "Synthetic", mode: "metadata", limit: 1, diversify: false };
  const first = await f.call("search_content", args); assert.ok(first.nextCursor);
  const revision = async () => (await f.db.selectFrom("plugin_state").select("value_json").where("key", "=", "fulltext-revision").executeTakeFirstOrThrow()).value_json;
  const before = await revision();
  await assert.rejects(f.db.transaction().execute(async tx => { await tx.updateTable("search_documents").set({ title: "Rolled back" }).where("resource_id", "=", f.input.resourceID).execute(); throw Error("Rollback"); }), /Rollback/);
  assert.equal(await revision(), before);
  await f.embedding.repository.projectFulltext(); assert.notEqual(await revision(), before);
  assert.equal((await f.call("search_content", { ...args, cursor: first.nextCursor })).error.code, "CURSOR_STALE");
  assert.equal((await f.call("search_content", { ...args, limit: 50 })).returnedCount, 3);
  const stable = await revision(); await f.embedding.repository.projectFulltext(); assert.equal(await revision(), stable);
});

test("search continuation applies full, compact and expanded projections independently", async t => {
  const f = await fixture(t);
  await f.repo.save({ ...f.item, key: "EXTRA003", itemID: 103, title: "Synthetic extra", attachments: [] }, f.target); await f.embedding.repository.projectFulltext();
  const args = { scopeType: "authorized", query: "Synthetic", mode: "metadata", limit: 1, diversify: false };
  const standard = await f.call("search_content", args);
  const full = await f.call("search_content", { ...args, cursor: standard.nextCursor, responseMode: "full" });
  assert.equal(Object.hasOwn(full.items[0], "partialContent"), true);
  const firstFull = await f.call("search_content", { ...args, responseMode: "full" });
  const compact = await f.call("search_content", { ...args, cursor: firstFull.nextCursor, responseMode: "compact" });
  assert.equal(Object.hasOwn(compact.items[0], "partialContent"), false);
  assert.equal(Object.hasOwn(compact.items[0].matches[0], "metadataField"), false);
  const expanded = await f.call("search_content", { ...args, cursor: firstFull.nextCursor, responseMode: "compact", includeFields: ["partialContent", "matches.metadataField"] });
  assert.equal(Object.hasOwn(expanded.items[0], "partialContent"), true); assert.equal(Object.hasOwn(expanded.items[0].matches[0], "metadataField"), true);
  assert.equal((await f.call("search_content", { ...args, query: "No such result", includeFields: ["privatePath"] })).error.code, "INVALID_FIELD");
});

test("search snapshots materialize only requested pages and preserve replay, projections and all later results", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 4; index++) await f.repo.save({ ...f.item, key: `PAGE000${index}`, itemID: 120 + index, title: `Synthetic page ${index}`, attachments: [] }, f.target);
  const ids = await f.tools.repository.ids(f.principal), realResource = f.tools.repository.resource.bind(f.tools.repository);
  const source = await f.db.selectFrom("resource_sources").selectAll().where("id", "=", f.input.sourceID).executeTakeFirstOrThrow();
  const block = (await f.tools.repository.blockHeaders(f.input.resourceID, f.principal))[0];
  const hits = ids.map((id, index) => ({ resourceID: id, title: `Page ${index}`, score: 0.9 - index / 10, scoreType: "cosine", channels: ["vector"], parsed: true, embedded: true, metadataOnly: false,
    evidence: [{ blockID: block.id, sourceID: source.id, generationID: source.active_generation_id, text: `Exact evidence page ${index}`, section: null, page: 1, channel: "vector", score: 0.9 - index / 10, scoreType: "cosine" }] }));
  let calls = 0;
  f.retrieval.search = async () => { calls++; return { hits, channels: ["vector"], degraded: [], coverage: { resources: ids.length, parsed: ids.length, embedded: ids.length }, timings: { embeddingMs: 0, localMs: 1, rerankMs: 0 } }; };
  const headers = [];
  f.tools.repository.blockHeaders = async id => { headers.push(id); return [{ ...block, resourceId: id, charCount: 20 }]; };
  const args = { scopeType: "authorized", mode: "vector", query: "page", limit: 2, diversify: false, snippetMaxChars: 100 };
  const first = await f.call("search_content", args);
  assert.deepEqual(first.items.map(row => row.resourceId), ids.slice(0, 2));
  assert.deepEqual(headers, ids.slice(0, 2)); assert.ok(first.nextCursor);
  const second = await f.call("search_content", { ...args, cursor: first.nextCursor, responseMode: "full" });
  assert.deepEqual(second.items.map(row => row.resourceId), ids.slice(2, 4));
  assert.deepEqual(headers, ids.slice(0, 4)); assert.ok(second.nextCursor);
  const replay = await f.call("search_content", { ...args, cursor: first.nextCursor, responseMode: "full" });
  assert.deepEqual(replay.items, second.items);
  const last = await f.call("search_content", { ...args, cursor: second.nextCursor });
  assert.deepEqual(last.items.map(row => row.resourceId), ids.slice(4));
  assert.equal(last.hasMore, false); assert.equal(last.nextCursor, null); assert.equal(calls, 1);
  assert.ok([...first.items, ...second.items, ...last.items].every(row => row.matches[0].snippet.startsWith("Exact evidence page")));
  f.tools.repository.resource = realResource;
});

for (const change of ["authorization", "content", "index", "cancellation"]) test(`lazy page rejects ${change} changed during evidence assembly`, async t => {
  const f = await fixture(t);
  await f.repo.save({ ...f.item, key: "LATER001", itemID: 190, title: "Synthetic later", attachments: [] }, f.target);
  await f.embedding.repository.projectFulltext();
  const args = { scopeType: "authorized", mode: "metadata", query: "Synthetic", limit: 1, diversify: false };
  const first = await f.call("search_content", args); assert.ok(first.nextCursor);
  const original = f.tools.repository.resource.bind(f.tools.repository), controller = new AbortController(); let changed = false;
  f.tools.repository.resource = async (...args) => {
    const row = await original(...args);
    if (!changed) {
      changed = true;
      if (change === "authorization") await f.tokens.update(f.created.id, { name: "Changed", libraryIds: f.principal.libraries, scopes: ["knowledge:read"] });
      if (change === "content") await f.db.updateTable("knowledge_resources").set({ title: "Changed during page" }).where("id", "=", row.id).execute();
      if (change === "index") await f.db.updateTable("plugin_state").set({ value_json: '"changed-page-index"' }).where("key", "=", "fulltext-revision").execute();
      if (change === "cancellation") controller.abort();
    }
    return row;
  };
  const response = await f.tools.call("search_content", { ...args, cursor: first.nextCursor }, f.principal, controller.signal);
  assert.equal(response.isError, true);
  assert.equal(Object.hasOwn(response.structuredContent, "items"), false);
  assert.ok(["KNOWLEDGE_SCOPE_REQUIRED", "KNOWLEDGE_RESOURCE_UNAVAILABLE", "CURSOR_STALE", "CANCELLED"].includes(response.structuredContent.error.code));
});

test("lazy search snapshots bound retained text, keep a newest oversized cursor and clear on shutdown", async t => {
  const f = await fixture(t);
  await f.repo.save({ ...f.item, key: "BUDGET01", itemID: 192, title: "Synthetic later", attachments: [] }, f.target);
  await f.embedding.repository.projectFulltext();
  const args = { scopeType: "authorized", query: "Synthetic", mode: "metadata", limit: 1, diversify: false };
  const first = await f.call("search_content", args); assert.ok(first.nextCursor);
  const search = f.tools.search;
  search.maxSnapshotBytes = 1;
  const second = await f.call("search_content", args); assert.ok(second.nextCursor);
  assert.equal(search.snapshots.size, 1);
  assert.ok(search.snapshotBytes > search.maxSnapshotBytes);
  assert.equal((await f.call("search_content", { ...args, cursor: first.nextCursor })).error.code, "CURSOR_STALE");
  assert.equal((await f.call("search_content", { ...args, cursor: second.nextCursor })).returnedCount, 1);
  f.tools.close(); assert.equal(search.snapshots.size, 0); assert.equal(search.snapshotBytes, 0);
});

test("reference lists retain resource references and exclude superseded source and target anchors", async t => {
  const f = await fixture(t), block = (await f.tools.repository.blockHeaders(f.input.resourceID, f.principal))[0], now = Date.now();
  const reference = { resource_id: f.input.resourceID, source_id: null, generation_id: null, source_block_id: null, target_resource_id: null,
    target_source_id: null, target_generation_id: null, target_block_id: null, reference_type: "citation", label: "Citation", raw_text: "Citation text", confidence: null, created_at: now, updated_at: now, deleted_at: null };
  const unanchored = crypto.randomUUID();
  await f.db.insertInto("resource_references").values([
    { ...reference, id: unanchored },
    { ...reference, id: crypto.randomUUID(), source_id: block.sourceId, generation_id: block.generationId, source_block_id: block.id },
    { ...reference, id: crypto.randomUUID(), target_resource_id: f.input.resourceID, target_source_id: block.sourceId, target_generation_id: block.generationId, target_block_id: block.id },
  ]).execute();
  const current = await f.call("list_references", { resourceId: f.input.resourceID, responseMode: "full" }); assert.equal(current.returnedCount, 3);
  assert.ok(current.items.some(item => item.sourceBlockId === block.id && item.generationId === block.generationId));
  await f.enqueue(true); await f.step(); await f.step();
  const after = await f.call("list_references", { resourceId: f.input.resourceID, responseMode: "full" });
  assert.deepEqual(after.items.map(row => row.referenceId), [unanchored]);
});
function request(secret, message, headers = {}, method = "POST") {
  const values = { Host: "127.0.0.1:23126", Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", ...headers };
  return { method, path: "/mcp/knowledge", httpVersion: "1.1", body: JSON.stringify(message), hasHeader: key => key in values, getHeader: key => values[key], bodyInputStream: { available: () => 0 } };
}
async function sendHttp(handler, secret, message, headers = {}, method = "POST") {
  const reply = response(); handler(request(secret, message, headers, method), reply);
  for (let i = 0; i < 1000 && !reply.done; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(reply.done, true); return reply;
}
async function initializeClient(handler, secret) {
  const reply = await sendHttp(handler, secret, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test-client", version: "1" } } });
  assert.equal(reply.status, 200); assert.ok(reply.headers["Mcp-Session-Id"]); return reply.headers["Mcp-Session-Id"];
}
test("HTTP uses only SSE for initialization, discovery and tool calls; validates auth, Origin and Accept", async t => {
  const f = await fixture(t); let handler;
  const server = { registerPathHandler(path, callback) { assert.equal(path, "/mcp/knowledge"); handler = callback; }, start() {}, stop(callback) { callback(); } };
  const http = new api.McpHttp(f.tokens, f.tools, () => server, request => request.body); http.start(23126); t.after(() => http.close());
  let clientId;
  const send = async (message, headers, method) => {
    const r = await sendHttp(handler, f.created.secret, message, { ...(clientId ? { "Mcp-Session-Id": clientId } : {}), ...headers }, method);
    if (r.headers["Mcp-Session-Id"]) clientId = r.headers["Mcp-Session-Id"]; return r;
  };
  for (const message of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_resource_content", arguments: { resourceId: f.input.resourceID } } },
  ]) {
    const r = await send(message); assert.equal(r.status, 200); assert.match(r.headers["Content-Type"], /^text\/event-stream/); assert.match(r.body, /event: message\ndata: /);
    if (message.method === "initialize") {
      const result = JSON.parse(/^data: (.+)$/m.exec(r.body)[1]).result;
      const identity = result._meta["zotero-knowledge-mcp/identity"];
      assert.equal(identity.applicationContract, "2.4.0"); assert.match(identity.schemaFingerprint, /^[a-f0-9]{64}$/);
      assert.deepEqual(identity.build, { commit: null, dirty: null, sourceFingerprint: null }, "Unbundled tests must not fabricate build provenance");
      assert.match(result.instructions, /footnotes/);
    }
  }
  assert.equal((await send({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  assert.equal((await send({}, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await send({}, { Host: "evil.example:23126" })).status, 403);
  assert.equal((await send({}, { Authorization: "Bearer invalid" })).status, 401);
  assert.equal((await send({}, { Accept: "application/json" })).status, 406);
  assert.equal((await send({}, {}, "GET")).status, 405);
});

test("HTTP shares 16 token permits across clients and cancellation releases them", async t => {
  const f = await fixture(t); let handler;
  const server = { registerPathHandler(_path, callback) { handler = callback; }, start() {}, stop(callback) { callback(); } };
  const tools = { async call(_name, _args, _p, signal) { await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); return { content: [], structuredContent: { cancelled: true } }; } };
  const http = new api.McpHttp(f.tokens, tools, () => server, request => request.body); http.start(23126); t.after(() => http.close());
  const clientId = await initializeClient(handler, f.created.secret), otherClient = await initializeClient(handler, f.created.secret);
  const clientHeaders = { "Mcp-Session-Id": clientId }, headersFor = id => ({ "Mcp-Session-Id": id % 2 ? clientId : otherClient });
  const replies = [];
  for (let id = 1; id <= 16; id++) { const r = response(); replies.push(r); handler(request(f.created.secret, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_libraries" } }, headersFor(id)), r); }
  for (let i = 0; i < 1000 && http.active.size < 16; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(http.active.size, 16);
  const rejected = response(); handler(request(f.created.secret, { jsonrpc: "2.0", id: 17, method: "tools/list" }, clientHeaders), rejected);
  for (let i = 0; i < 100 && !rejected.done; i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(rejected.status, 429);
  for (let id = 1; id <= 16; id++) handler(request(f.created.secret, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }, headersFor(id)), response());
  for (let i = 0; i < 100 && http.active.size; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(http.active.size, 0); assert.ok(replies.every(row => row.done));
  assert.equal((await sendHttp(handler, f.created.secret, { jsonrpc: "2.0", id: 18, method: "tools/list" }, clientHeaders)).status, 200);
});

test("HTTP admits 64 active calls globally and reuses a released permit across tokens", async t => {
  const f = await fixture(t); let handler;
  const server = { registerPathHandler(_path, callback) { handler = callback; }, start() {}, stop(callback) { callback(); } };
  const tools = { async call(_name, _args, _p, signal) { await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); return { content: [], structuredContent: {} }; } };
  const http = new api.McpHttp(f.tokens, tools, () => server, request => request.body); http.start(23126); t.after(() => http.close());
  const clients = [];
  for (let i = 0; i < 5; i++) {
    const token = await f.tokens.create({ name: `Global limit ${i}`, libraryIds: [f.target.libraryID], scopes: ["knowledge:read"] });
    clients.push({ secret: token.secret, headers: { "Mcp-Session-Id": await initializeClient(handler, token.secret) } });
  }
  const replies = [];
  for (const client of clients.slice(0, 4)) for (let id = 1; id <= 16; id++) {
    const reply = response(); replies.push(reply);
    handler(request(client.secret, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_resources" } }, client.headers), reply);
  }
  for (let i = 0; i < 1000 && http.active.size < 64; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(http.active.size, 64);
  const last = clients[4], call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_resources" } };
  assert.equal((await sendHttp(handler, last.secret, call, last.headers)).status, 429);
  await sendHttp(handler, clients[0].secret, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }, clients[0].headers);
  assert.equal(http.active.size, 63);
  const replacement = response(); handler(request(last.secret, call, last.headers), replacement);
  for (let i = 0; i < 1000 && http.active.size < 64; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(http.active.size, 64);
  await http.close();
  assert.ok([...replies, replacement].every(reply => reply.done));
  assert.equal(http.active.size, 0); assert.equal(http.pending.size, 0);
});

test("HTTP pending guard admits 128 authentication waits and rejects the 129th before authentication", async t => {
  let handler, release, entered = 0;
  const gate = new Promise(resolve => release = resolve);
  const tokens = { async authenticate() { entered++; await gate; return { id: "pending-token" }; } };
  const server = { registerPathHandler(_path, callback) { handler = callback; }, start() {}, stop(callback) { callback(); } };
  const http = new api.McpHttp(tokens, { async call() { assert.fail("No tool dispatch during shutdown"); } }, () => server, request => request.body);
  http.start(23126); t.after(async () => { release(); await http.close(); });
  const replies = [];
  for (let id = 1; id <= 128; id++) { const reply = response(); replies.push(reply); handler(request("synthetic", { jsonrpc: "2.0", id, method: "ping" }), reply); }
  assert.equal(entered, 128); assert.equal(http.pending.size, 128);
  const rejected = await sendHttp(handler, "synthetic", { jsonrpc: "2.0", id: 129, method: "ping" });
  assert.equal(rejected.status, 503); assert.equal(entered, 128);
  const closing = http.close(); release(); await closing;
  assert.ok(replies.every(reply => reply.done && reply.status === 503));
  assert.equal(http.pending.size, 0); assert.equal(http.active.size, 0);
});

test("clients sharing a token can reuse request IDs and cancel only their own invocation", async t => {
  const f = await fixture(t); let handler; const calls = [];
  const server = { registerPathHandler(_path, callback) { handler = callback; }, start() {}, stop(callback) { callback(); } };
  const tools = { async call(_name, _args, _p, signal) {
    const call = { signal, finish: undefined }; calls.push(call);
    await new Promise(resolve => { call.finish = resolve; signal.addEventListener("abort", resolve, { once: true }); });
    return { content: [], structuredContent: { cancelled: signal.aborted } };
  } };
  const http = new api.McpHttp(f.tokens, tools, () => server, request => request.body); http.start(23126); t.after(() => http.close());
  const a = await initializeClient(handler, f.created.secret), b = await initializeClient(handler, f.created.secret); assert.notEqual(a, b);
  const message = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_libraries" } }, first = response(), second = response();
  handler(request(f.created.secret, message, { "Mcp-Session-Id": a }), first);
  for (let i=0;i<100&&!calls.length;i++) await new Promise(resolve=>setTimeout(resolve,2));
  handler(request(f.created.secret, message, { "Mcp-Session-Id": b }), second);
  for (let i=0;i<100&&calls.length<2;i++) await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(calls.length, 2); assert.equal(second.done, false);
  const duplicate = await sendHttp(handler, f.created.secret, message, { "Mcp-Session-Id": a });
  assert.match(duplicate.body, /already active/);
  await sendHttp(handler, f.created.secret, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } }, { "Mcp-Session-Id": b });
  assert.equal(calls[1].signal.aborted, true); assert.equal(calls[0].signal.aborted, false);
  calls[0].finish(); await http.close(); assert.equal(first.done, true); assert.equal(second.done, true);
});

for (const stage of ["authentication", "client-identity"]) test(`shutdown fences a request paused in ${stage}`, async t => {
  const f = await fixture(t); let handler, toolCalls=0, release, entered;
  const gate = new Promise(resolve=>release=resolve), paused = new Promise(resolve=>entered=resolve);
  const server = { registerPathHandler(_path, callback) { handler=callback; }, start(){}, stop(callback){callback();} };
  const http = new api.McpHttp(f.tokens, { async call(){toolCalls++;return {content:[],structuredContent:{}};} }, ()=>server, request=>request.body);
  http.start(23126); const client = await initializeClient(handler, f.created.secret);
  if(stage==="authentication") { const authenticate=f.tokens.authenticate.bind(f.tokens);f.tokens.authenticate=async secret=>{entered();await gate;return authenticate(secret);}; }
  else { const valid=http.clients.valid.bind(http.clients);http.clients.valid=async (...args)=>{entered();await gate;return valid(...args);}; }
  const reply=response();handler(request(f.created.secret,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"list_libraries"}},{"Mcp-Session-Id":client}),reply);
  await paused;const closing=http.close();release();await closing;
  assert.equal(toolCalls,0);assert.equal(reply.status,503);assert.equal(http.active.size,0);
});

test("client identities are token-bound and invalidated on listener restart", async t => {
  const f=await fixture(t);let handler;
  const server={registerPathHandler(_path,callback){handler=callback;},start(){},stop(callback){callback();}};
  const http=new api.McpHttp(f.tokens,f.tools,()=>server,request=>request.body);http.start(23126);t.after(()=>http.close());
  const client=await initializeClient(handler,f.created.secret), message={jsonrpc:"2.0",id:1,method:"tools/list"};
  assert.equal((await sendHttp(handler,f.created.secret,message)).status,400);
  assert.equal((await sendHttp(handler,f.created.secret,message,{"Mcp-Session-Id":client+"x"})).status,404);
  const other=await f.tokens.create({name:"Other",libraryIds:[f.target.libraryID],scopes:["knowledge:read"]});
  assert.equal((await sendHttp(handler,other.secret,message,{"Mcp-Session-Id":client})).status,404);
  await http.close();http.start(23126);
  assert.equal((await sendHttp(handler,f.created.secret,message,{"Mcp-Session-Id":client})).status,404);
  const renewed=await initializeClient(handler,f.created.secret);assert.equal((await sendHttp(handler,f.created.secret,message,{"Mcp-Session-Id":renewed})).status,200);
});

test("quoted annotations validate native lazy rows, reject invalid anchors and replay across reparse", async t => {
  const f = await fixture(t), id = f.input.resourceID, header = (await f.tools.repository.blockHeaders(id, f.principal))[0];
  const block = (await f.call("get_content_blocks_text", { resourceId: id, blockIds: [header.id] })).items[0];
  const resource = (await f.call("get_resources", { resourceIds: [id] })).items[0];
  const args = { resourceId: id, contentBlockId: header.id, annotationType: "evidence", text: "A grounded annotation", quote: block.contentMarkdown.slice(0, 10), operationId: "quoted-note", expectedVersion: resource.version };
  assert.equal((await f.call("add_annotation", { ...args, quote: "absent quote", operationId: "bad-quote" })).error.code, "INVALID_ARGUMENT");
  assert.equal((await f.call("get_resources", { resourceIds: [id] })).items[0].version, resource.version);
  const receipt = await f.call("add_annotation", args); assert.ok(receipt.annotationId, JSON.stringify(receipt));
  const detail = await f.call("list_annotations", { resourceId: id, annotationIds: [receipt.annotationId], responseMode: "compact" });
  assert.equal(detail.items[0].quote, args.quote); assert.equal(detail.items[0].sourceId, header.sourceId); assert.equal(detail.items[0].generationId, header.generationId);
  assert.equal((await f.call("add_annotation", { ...args, contentBlockId: crypto.randomUUID(), operationId: "missing-anchor-note", expectedVersion: receipt.version })).error.code, "INVALID_ARGUMENT");
  await f.enqueue(true); await f.step(); await f.step();
  assert.equal((await f.call("add_annotation", args)).replayed, true);
  const historical = await f.call("list_annotations", { resourceId: id, annotationIds: [receipt.annotationId] });
  assert.equal(historical.items[0].anchorState, "historical"); assert.equal(historical.items[0].quote, args.quote);
});

test("paper footnotes survive document/section reads and selection explicitly reports boilerplate", async t => {
  const source = sourcePage();
  for (const [index, label, content] of [[2, "text", "Authors: Alice Smith, Bob Jones"], [3, "text", "Keywords: innovation; risk"], [4, "display_formula", "$$ x=y+z $$"],
    [5, "footnote", "SCIENTIFIC_NOTE sample excludes withdrawn observations."], [6, "vision_footnote", "TABLE_NOTE estimates use robust standard errors."],
    [7, "text", "Copyright all rights reserved. BOILERPLATE_MARKER"]]) {
    source.prunedResult.parsing_res_list.push({ block_label: label, block_content: content, block_id: index, block_bbox: [10, 150 + index * 55, 500, 190 + index * 55] });
  }
  const f = await fixture(t, true, { download: async () => new TextEncoder().encode(result([source])) }), id = f.input.resourceID;
  const read = await f.call("get_resource_content", { resourceId: id });
  for (const marker of ["Authors:", "Keywords:", "x=y+z", "SCIENTIFIC_NOTE", "TABLE_NOTE"]) assert.ok(read.contentMarkdown.includes(marker), marker);
  assert.equal(read.selection.originalNotesIncluded, true); assert.equal(read.selection.excludedBlockCount, 1);
  assert.ok(read.selection.excludedByReason.some(row => row.reason === "boilerplate" && row.count === 1));
  assert.ok(!read.contentMarkdown.includes("BOILERPLATE_MARKER"));
  const nodes = await f.call("list_resource_nodes", { resourceId: id });
  const section = await f.call("get_resource_nodes", { nodeIds: [nodes.items[0].nodeId], includeChildren: true });
  assert.equal(section.items[0].contentMarkdown, read.contentMarkdown);
  const expanded = await f.call("get_resource_content", { resourceId: id, includeBoilerplate: true });
  assert.equal(expanded.selection.excludedBlockCount, 0); assert.ok(expanded.contentMarkdown.includes("BOILERPLATE_MARKER"));
  assert.ok(expanded.contentMarkdown.includes("SCIENTIFIC_NOTE"));
});

test("resource discovery identifies literature while detail defaults include bibliographic content", async t => {
  const f = await fixture(t), id = f.input.resourceID;
  await f.db.updateTable("knowledge_resources").set({ contributors_json: JSON.stringify([{ firstName: "Alice", lastName: "Smith", role: "author" }]), abstract: "Published abstract",
    summary: "Maintained research summary", publication_title: "Synthetic Journal", publication_date: "2026", doi: "10.0000/synthetic" }).where("id", "=", id).execute();
  const list = (await f.call("list_resources")).items[0], detail = (await f.call("get_resources", { resourceIds: [id] })).items[0];
  assert.equal(list.contributors[0].lastName, "Smith"); assert.equal(list.metadata.doi, "10.0000/synthetic"); assert.ok(!Object.hasOwn(list, "abstract"));
  assert.equal(detail.abstract, "Published abstract"); assert.equal(detail.summary, "Maintained research summary"); assert.equal(detail.metadata.publicationTitle, "Synthetic Journal");
  assert.equal(detail.metadata.publicationDate, "2026"); assert.ok(Array.isArray(detail.identifiers)); assert.equal(detail.subtitle, null);
  assert.ok(!Object.hasOwn(detail, "stats")); assert.ok(!Object.hasOwn(detail, "sources"));
  assert.equal(detail.capabilities.annotations, false); assert.equal(detail.capabilities.references, false);
  assert.deepEqual(detail.capabilities.supportedOperations, { read: true, annotate: true, updateSummary: true });
});

test("content capabilities follow current readable generations during replacement and reprocessing", async t => {
  const f = await fixture(t), id = f.input.resourceID;
  assert.equal((await f.call("get_resources", { resourceIds: [id] })).items[0].capabilities.content, true);
  f.setBytes(new TextEncoder().encode("%PDF-1.7\nReplacement attachment")); await f.enqueue();
  const changed = (await f.call("get_resources", { resourceIds: [id], responseMode: "full" })).items[0];
  assert.equal(changed.capabilities.content, false); assert.equal(changed.capabilities.structure, false); assert.equal(changed.capabilities.contentState, "processing");
  assert.equal(changed.sources[0].contentState, "stale"); assert.equal(changed.stats.blockCount, 0);
  assert.equal((await f.call("get_resource_content", { resourceId: id })).charCountReturned, 0);
  await f.step(); await f.step();
  assert.equal((await f.call("get_resources", { resourceIds: [id] })).items[0].capabilities.contentState, "ready");
  const unprocessed = await f.repo.save({ ...f.item, key: "UNPARSED", itemID: 900, attachments: [] }, f.target);
  assert.equal((await f.call("get_resources", { resourceIds: [unprocessed] })).items[0].capabilities.contentState, "unavailable");
});

test("long Unicode blocks resume independently of batch composition and budgets with source offsets", async t => {
  const source = sourcePage(), text = "Long evidence 😀🧪 ".repeat(800) + "TAIL_EVIDENCE";
  source.prunedResult.parsing_res_list[1].block_content = text;
  const f = await fixture(t, true, { download: async () => new TextEncoder().encode(result([source])) }), id = f.input.resourceID;
  const headers = await f.tools.repository.blockHeaders(id, f.principal), block = headers.toSorted((a,b) => b.charCount - a.charCount)[0];
  const whole = (await f.tools.repository.readBlock(block, 0, block.charCount, f.principal)).markdown;
  let assembled = "", cursor, iterations = 0;
  do {
    const page = await f.call("get_content_blocks_text", { resourceId: id, blockIds: iterations ? [block.id] : headers.map(row => row.id),
      maxCharsPerBlock: iterations ? 9000 : 5000, maxTotalChars: iterations ? 9000 : 20000, responseMode: iterations % 2 ? "compact" : "full", ...(cursor ? { cursors: { [block.id]: cursor } } : {}) });
    assert.ok(!page.error, JSON.stringify(page));
    const item = page.items.find(row => row.blockId === block.id); assert.equal(item.textOffset, Array.from(assembled).length); assert.equal(item.sourceId, block.sourceId);
    assert.equal(item.generationId, block.generationId); assert.equal(item.charCountReturned, Array.from(item.contentMarkdown).length);
    assembled += item.contentMarkdown; cursor = item.nextCursor; assert.ok(++iterations < 10);
  } while (cursor);
  assert.equal(assembled, whole); assert.ok(assembled.includes("TAIL_EVIDENCE"));
  const first = await f.call("get_content_blocks_text", { resourceId: id, blockIds: [block.id], maxCharsPerBlock: 1 });
  const other = headers.find(row => row.id !== block.id);
  assert.equal((await f.call("get_content_blocks_text", { resourceId: id, blockIds: [other.id], cursors: { [other.id]: first.items[0].nextCursor } })).error.code, "CURSOR_STALE");
  assert.equal((await f.call("get_content_blocks_text", { resourceId: id, blockIds: [block.id], cursors: { [other.id]: first.items[0].nextCursor } })).error.code, "INVALID_ARGUMENT");
  await f.db.updateTable("knowledge_resources").set(eb => ({ version: eb("version", "+", 1) })).where("id", "=", id).execute();
  assert.equal((await f.call("get_content_blocks_text", { resourceId: id, blockIds: [block.id], cursors: { [block.id]: first.items[0].nextCursor } })).error.code, "CURSOR_STALE");
});

test("annotation text and quotes are budgeted and independently readable to completion by annotation ID", async t => {
  const source = sourcePage(), quote = "Quoted evidence 😀 ".repeat(800);
  source.prunedResult.parsing_res_list[1].block_content = quote;
  const f = await fixture(t, true, { download: async () => new TextEncoder().encode(result([source])) }), id = f.input.resourceID;
  const block = (await f.tools.repository.blockHeaders(id, f.principal)).toSorted((a,b) => b.charCount - a.charCount)[0];
  const stored = (await f.tools.repository.readBlock(block, 0, block.charCount, f.principal)).markdown;
  const text = "A long annotation 🧪 ".repeat(600).trim(), version = (await f.call("get_resources", { resourceIds: [id] })).items[0].version;
  const note = await f.call("add_annotation", { resourceId: id, contentBlockId: block.id, annotationType: "evidence", text, quote: stored, operationId: "long-quoted-note", expectedVersion: version });
  assert.ok(note.annotationId, JSON.stringify(note));
  let cursors, assembledText = "", assembledQuote = "", iterations = 0;
  do {
    const response = await f.call("list_annotations", { resourceId: id, annotationIds: [note.annotationId], textMaxChars: 1000, maxTotalChars: iterations ? 1600 : 7,
      responseMode: iterations % 2 ? "compact" : "full", ...(cursors ? { cursors } : {}) });
    assert.ok(!response.error, JSON.stringify(response)); const item = response.items[0];
    assert.equal(item.textOffset, Array.from(assembledText).length); assert.equal(item.quoteOffset, Array.from(assembledQuote).length);
    assert.equal(response.totalCharsReturned, Array.from(item.text).length + Array.from(item.quote).length);
    assert.ok(response.totalCharsReturned <= (iterations ? 1600 : 7));
    assembledText += item.text; assembledQuote += item.quote;
    cursors = item.nextCursor || item.quoteNextCursor ? { [note.annotationId]: { text: item.nextCursor, quote: item.quoteNextCursor } } : undefined;
    assert.ok(++iterations < 100);
  } while (cursors);
  assert.equal(assembledText, text); assert.equal(assembledQuote, stored);
  const missing = crypto.randomUUID(), mixed = await f.call("list_annotations", { resourceId: id, annotationIds: [missing, note.annotationId] });
  assert.deepEqual(mixed.missingAnnotationIds, [missing]); assert.equal(mixed.returnedCount, 1);
  const first = mixed.items[0];
  assert.equal((await f.call("list_annotations", { resourceId: id, annotationIds: [note.annotationId], cursors: { [note.annotationId]: { text: first.quoteNextCursor } } })).error.code, "CURSOR_STALE");
  await f.tokens.revoke(f.principal.id);
  assert.equal((await f.call("list_annotations", { resourceId: id, annotationIds: [note.annotationId] })).error.code, "KNOWLEDGE_AUTH_REQUIRED");
});

test("all tools reject unknown field expansions before querying, including empty results", async t => {
  const f = await fixture(t);
  for (const tool of api.toolDefinitions) {
    const before = f.native.queries.length;
    const output = await f.call(tool.name, { includeFields: ["nonexistentField"] });
    assert.equal(output.error.code, "INVALID_FIELD", tool.name); assert.equal(f.native.queries.length, before, tool.name);
    for (const [name, schema] of Object.entries(tool.inputSchema.properties)) assert.ok(schema.description, `${tool.name}.${name}`);
  }
  const empty = await f.repo.create("Empty library");
  await f.tokens.update(f.principal.id, { name: "Test", libraryIds: [empty], scopes: f.principal.scopes });
  assert.equal((await f.call("list_folders", { libraryId: empty, includeFields: ["nonexistentField"] })).error.code, "INVALID_FIELD");
  const search = api.toolDefinitions.find(tool => tool.name === "search_content");
  assert.ok(!search.inputSchema.properties.scopeType.enum.includes("run")); assert.equal(search.annotations.openWorldHint, true);
});

test("explicit folder counts and block previews survive every mode while false gates remain authoritative", async t => {
  const f = await fixture(t), folder = await f.repo.create("Counted folder", f.target);
  await f.repo.save(f.item, { ...f.target, nodeID: folder });
  for (const responseMode of ["compact", "standard", "full"]) {
    const folders = await f.call("list_folders", { libraryId: f.target.libraryID, includeResourceCount: true, responseMode });
    assert.equal(folders.items[0].resourceCount, 1); assert.equal(folders.items[0].countStatus, "exact");
    const hidden = await f.call("list_folders", { libraryId: f.target.libraryID, includeResourceCount: false, includeFields: ["resourceCount"], responseMode });
    assert.ok(!Object.hasOwn(hidden.items[0], "resourceCount"));
    const blocks = await f.call("list_content_blocks", { resourceId: f.input.resourceID, includePreview: true, responseMode });
    assert.ok(blocks.items[0].preview);
    const noPreview = await f.call("list_content_blocks", { resourceId: f.input.resourceID, includePreview: false, includeFields: ["preview"], responseMode });
    assert.ok(!Object.hasOwn(noPreview.items[0], "preview"));
  }
});

test("node continuations survive a smaller retry batch and retain segment offsets", async t => {
  const source = sourcePage();
  source.prunedResult.parsing_res_list.push({ block_label: "paragraph_title", block_content: "1. Methods", block_id: 2, block_bbox: [10, 150, 500, 190] });
  const f = await fixture(t, true, { download: async () => new TextEncoder().encode(result([source])) }), id = f.input.resourceID;
  const nodes = (await f.call("list_resource_nodes", { resourceId: id, descendantDepth: 4 })).items;
  assert.ok(nodes.length > 1);
  const first = await f.call("get_resource_nodes", { nodeIds: nodes.map(node => node.nodeId), maxChars: 1, maxTotalChars: 1, includeChildren: true });
  const item = first.items[0]; assert.ok(item.nextCursor); assert.equal(item.segments[0].blockOffset, 0);
  const next = await f.call("get_resource_nodes", { nodeIds: [item.nodeId], cursors: { [item.nodeId]: item.nextCursor }, maxChars: 3, includeChildren: true });
  assert.ok(!next.error, JSON.stringify(next)); assert.equal(next.items[0].textOffset, 1); assert.equal(next.items[0].segments[0].blockOffset, 1);
});

test("all 16 tools keep schema-valid protocol fields in compact, standard and full modes", async t => {
  const source = sourcePage(); source.prunedResult.parsing_res_list.push({ block_label: "reference_content", block_content: "[1] Synthetic bibliography entry.", block_id: 2, block_bbox: [10, 300, 500, 330] });
  const f = await fixture(t, true, { download: async () => new TextEncoder().encode(result([source])) }), id = f.input.resourceID;
  const nodes = await f.call("list_resource_nodes", { resourceId: id }), blocks = await f.call("list_content_blocks", { resourceId: id });
  const row = (await f.call("get_resources", { resourceIds: [id] })).items[0];
  const summary = { resourceId: id, summary: "Matrix summary", expectedVersion: row.version, operationId: "matrix-summary" };
  const receipt = await f.call("update_summary", summary);
  const annotation = { resourceId: id, annotationType: "evidence", text: "Matrix evidence", expectedVersion: receipt.version, operationId: "matrix-annotation" };
  assert.ok((await f.call("add_annotation", annotation)).annotationId);
  const args = { list_libraries: {}, list_folders: { libraryId: f.target.libraryID }, list_resources: {}, get_resources: { resourceIds: [id, crypto.randomUUID()] },
    get_resource_content: { resourceId: id, maxChars: 2 }, list_resource_nodes: { resourceId: id }, get_resource_nodes: { nodeIds: [nodes.items[0].nodeId], maxChars: 2 },
    list_content_blocks: { resourceId: id }, get_content_blocks_text: { resourceId: id, blockIds: [blocks.items[0].blockId], maxCharsPerBlock: 2 },
    list_block_types: { resourceId: id }, search_content: { scopeType: "authorized", query: "Synthetic", mode: "metadata" }, list_references: { resourceId: id },
    list_annotations: { resourceId: id, textMaxChars: 2 }, list_revisions: { resourceId: id }, update_summary: summary, add_annotation: annotation };
  for (const tool of api.toolDefinitions) for (const responseMode of ["compact", "standard", "full"]) {
    const output = await f.call(tool.name, { ...args[tool.name], responseMode });
    assert.ok(!output.error, `${tool.name}/${responseMode}: ${JSON.stringify(output)}`);
    if (output.nextCursor) assert.equal(typeof output.nextCursor, "string");
  }
});

test("failed vector recovery reports its cause while hybrid uses ready text channels without model dispatch", async t => {
  const f = await fixture(t); let providerCalls = 0;
  f.embedding.config.current.enabled = true;
  f.embedding.gateway.embed = async () => { providerCalls++; assert.fail("Embedding requested before index readiness"); };
  const recovery = new api.StartupRecovery(Object.fromEntries(api.recoveryStages.map(stage => [stage, async () => { if (stage === "index") throw Error("index-worker"); }])), () => {}, []);
  f.beforeClose(() => recovery.close()); recovery.retry(); await recovery.waitFor("fulltext");
  for (let i = 0; i < 100 && recovery.snapshot().state !== "failed"; i++) await new Promise(resolve => setTimeout(resolve, 2));
  const retrieval = new api.RetrievalService(f.embedding, mode => recovery.isRetrievalReady(mode), mode => recovery.unavailable(mode === "fulltext" ? "fulltext" : "index"));
  const tools = new api.McpTools(f.tokens, f.cursor, retrieval, f.embedding); t.after(() => tools.close());
  const args = { scopeType: "resource", scopeId: f.input.resourceID, query: "Synthetic", rerank: false, includeDiagnostics: true };
  const vector = await tools.call("search_content", { ...args, mode: "vector" }, f.principal, new AbortController().signal);
  assert.equal(vector.isError, true); assert.equal(vector.structuredContent.error.code, "INDEX_RECOVERY_FAILED");
  assert.equal(vector.structuredContent.error.details.stage, "index"); assert.equal(vector.structuredContent.error.details.failureCode, "index-worker");
  const hybrid = await tools.call("search_content", { ...args, mode: "hybrid" }, f.principal, new AbortController().signal);
  assert.ok(!hybrid.isError, JSON.stringify(hybrid)); assert.equal(hybrid.structuredContent.returnedCount, 1);
  assert.deepEqual(hybrid.structuredContent.diagnostics.channels, ["fulltext", "metadata"]);
  assert.equal(hybrid.structuredContent.warnings[0].code, "VECTOR_UNAVAILABLE");
  assert.equal(hybrid.structuredContent.warnings[0].details.failureCode, "index-worker"); assert.equal(providerCalls, 0);
  const original = retrieval.text.bind(retrieval);
  retrieval.text = async (...args) => { const result = await original(...args); await f.tokens.revoke(f.principal.id); return result; };
  const rejected = await tools.call("search_content", { ...args, mode: "hybrid" }, f.principal, new AbortController().signal);
  assert.equal(rejected.isError, true); assert.equal(rejected.structuredContent.error.code, "KNOWLEDGE_AUTH_REQUIRED");
  assert.ok(!Object.hasOwn(rejected.structuredContent, "items"));
});

test("hybrid can use a ready vector channel while fulltext is unavailable without mislabeling its warning", async t => {
  const f = await fixture(t); f.embedding.config.current.enabled = true;
  f.embedding.gateway.embed = async () => [new Float32Array(768).fill(1)];
  const retrieval = new api.RetrievalService(f.embedding, mode => mode !== "fulltext");
  retrieval.text = async () => { assert.fail("Unready text channel executed"); };
  retrieval.vector = async () => [{ resourceID: f.input.resourceID, title: "Synthetic paper", score: 0.9, scoreType: "cosine", channels: ["vector"], evidence: [], parsed: true, embedded: true, metadataOnly: false }];
  const tools = new api.McpTools(f.tokens, f.cursor, retrieval, f.embedding); t.after(() => tools.close());
  const result = await tools.call("search_content", { scopeType: "authorized", query: "Synthetic", mode: "hybrid", rerank: false, includeDiagnostics: true }, f.principal, new AbortController().signal);
  assert.ok(!result.isError, JSON.stringify(result)); assert.equal(result.structuredContent.returnedCount, 1);
  assert.deepEqual(result.structuredContent.diagnostics.channels, ["vector"]); assert.equal(result.structuredContent.warnings[0].code, "FULLTEXT_UNAVAILABLE");
});
