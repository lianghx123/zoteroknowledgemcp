import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { parsingFixture } from "./fixtures/parsing.mjs";

const bundle = await build({ stdin: { contents: `export * from "./src/security/mcp-tokens.ts"; export * from "./src/security/mcp-cursor.ts";
export * from "./src/mcp/tools/service.ts"; export * from "./src/mcp/tools/registry.ts";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "browser", format: "esm", target: "firefox140", write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
async function fixture(t, parsed = true) {
  const f = await parsingFixture(t);
  if (parsed) { await f.enqueue(); await f.step(); await f.step(); }
  const tokens = new api.McpTokens(f.db), cursor = new api.McpCursor(f.db); await cursor.start();
  const created = await tokens.create({ name: "Read optimization fixture", libraryIds: [f.target.libraryID], scopes: ["knowledge:search", "knowledge:read", "knowledge:annotate", "knowledge:update-summary"] });
  const principal = await tokens.authenticate(created.secret), tools = new api.McpTools(tokens, cursor);
  const call = async (name, args = {}) => {
    const result = await tools.call(name, args, principal, new AbortController().signal);
    if (!result.isError) api.validate(api.toolDefinitions.find(tool => tool.name === name).outputSchema, result.structuredContent, "output");
    return result.structuredContent;
  };
  const state = () => tools.repository.state(principal).then(JSON.stringify);
  const revision = async (context = f.db, library = f.target.libraryID) => String((await context.selectFrom("mcp_library_revisions").select("revision").where("library_id", "=", library).executeTakeFirstOrThrow()).revision);
  return { ...f, tokens, cursor, created, principal, tools, call, state, revision };
}
let nextItemId = 200;
async function resource(f, key, title = key) {
  return f.repo.save({ ...f.item, key, itemID: nextItemId++, title, attachments: [] }, f.target);
}

test("resource paging reads one SQL page, preserves order, totals and missing ID order", async t => {
  const f = await fixture(t, false);
  const added = []; for (let i = 0; i < 5; i++) added.push(await resource(f, `PAGE${i}`));
  const all = await f.call("list_resources", { limit: 100, responseMode: "compact" });
  const ids = []; let cursor;
  do {
    const firstQuery = f.native.queries.length;
    const page = await f.call("list_resources", { limit: 2, responseMode: "compact", includeTotal: true, ...(cursor ? { cursor } : {}) });
    assert.ok(!page.error, JSON.stringify(page)); assert.equal(page.total, 6);
    const queries = f.native.queries.slice(firstQuery);
    assert.ok(queries.some(sql => /from "knowledge_resources" as "r"/.test(sql) && /limit :p\d+ offset :p\d+/.test(sql)));
    assert.ok(!queries.some(sql => /from "resource_identifiers"|from "resource_sources"|count\("b"\."id"\)/.test(sql)));
    ids.push(...page.items.map(item => item.resourceId)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, all.items.map(item => item.resourceId));
  assert.equal(new Set(ids).size, 6);
  const hidden = randomUUID(), selected = [added[3], hidden, added[0], f.input.resourceID];
  const read = await f.call("get_resources", { resourceIds: selected, responseMode: "compact" });
  assert.deepEqual(read.items.map(item => item.resourceId), selected.filter(id => id !== hidden));
  assert.deepEqual(read.missingResourceIds, [hidden]);
});

test("resource projections batch required relations and reject invalid fields even for empty results", async t => {
  const f = await fixture(t), extra = await resource(f, "BATCH");
  const ids = [f.input.resourceID, extra];
  for (const [mode, fields] of [["compact", []], ["standard", []], ["full", []], ["compact", ["identifiers", "sources", "memberships", "metadata", "stats", "contributors", "createdAt", "updatedAt", "libraryIds", "capabilities", "abstract"]]]) {
    const start = f.native.queries.length;
    const args = { resourceIds: ids, responseMode: mode, includeFields: fields };
    const batch = await f.call("get_resources", args);
    const queries = f.native.queries.slice(start);
    assert.ok(!batch.error, JSON.stringify(batch));
    for (let i = 0; i < ids.length; i++) assert.deepEqual(batch.items[i], (await f.call("get_resources", { ...args, resourceIds: [ids[i]] })).items[0]);
    if (mode === "compact" && !fields.length) {
      assert.equal(queries.length, 9, "two current-principal reads, two revision reads and one resource query");
      assert.ok(!queries.some(sql => /contributors_json|content_blocks|resource_sources|resource_identifiers/.test(sql)));
    }
    if (mode === "full") {
      assert.equal(queries.filter(sql => /from "resource_sources" as "s" left join "content_generations"/.test(sql)).length, 1, "one source batch");
      assert.equal(queries.filter(sql => /group by "s"\."resource_id"/.test(sql)).length, 1, "one grouped stats batch");
    }
  }
  for (const [name, args] of [["list_resources", { query: "no-such-title" }], ["get_resources", { resourceIds: [randomUUID()] }]]) {
    assert.equal((await f.call(name, { ...args, includeFields: ["unavailableField"] })).error.code, "INVALID_FIELD");
  }
});

test("revision reads are bounded by authorized libraries and ignore authentication and source-check bookkeeping", async t => {
  const f = await fixture(t), initial = await f.state(), offset = f.native.queries.length;
  await f.state(); const queries = f.native.queries.slice(offset);
  assert.equal(queries.length, 1); assert.match(queries[0], /CAST\(revision AS TEXT\)/);
  assert.ok(!/knowledge_resources|resource_sources|content_blocks|BEGIN/.test(queries[0]));
  await f.tokens.authenticate(f.created.secret);
  await f.db.updateTable("resource_sources").set({ last_checked_at: 999, updated_at: 999, error_code: "transient" }).where("id", "=", f.input.sourceID).execute();
  await f.db.updateTable("knowledge_resources").set({ title: f.item.title }).where("id", "=", f.input.resourceID).execute();
  assert.equal(await f.state(), initial);
  assert.deepEqual(await f.tools.repository.state({ ...f.principal, libraries: [] }), { format: 1, libraries: [] });
});

test("shared resources advance every live member scope; unrelated libraries and private folder moves stay isolated", async t => {
  const f = await fixture(t), original = await f.state(), other = await f.repo.create("Other revision scope");
  await f.db.updateTable("knowledge_libraries").set({ description: "Unrelated edit" }).where("id", "=", other).execute();
  assert.equal(await f.state(), original);
  await f.db.insertInto("library_resources").values({ id: randomUUID(), library_id: other, resource_id: f.input.resourceID, added_at: 0 }).execute();
  assert.equal(await f.state(), original);
  const a = await f.revision(), b = await f.revision(f.db, other);
  await f.db.updateTable("knowledge_resources").set({ summary: "Shared metadata" }).where("id", "=", f.input.resourceID).execute();
  assert.notEqual(await f.revision(), a); assert.notEqual(await f.revision(f.db, other), b);
  const before = await f.state();
  await f.repo.create("Private folder", { libraryID: other, nodeID: null });
  assert.equal(await f.state(), before);
});

test("revision counters cover visible metadata, relationships and content projections and roll back with their writes", async t => {
  const f = await fixture(t), source = await f.db.selectFrom("resource_sources").selectAll().where("id", "=", f.input.sourceID).executeTakeFirstOrThrow();
  const folder = await f.repo.create("Revision membership", f.target);
  const member = await f.db.selectFrom("library_resources").select("id").where("library_id", "=", f.target.libraryID).where("resource_id", "=", f.input.resourceID).executeTakeFirstOrThrow();
  const cases = [
    ["resource metadata without version bump", tx => tx.updateTable("knowledge_resources").set({ abstract: "Changed abstract" }).where("id", "=", f.input.resourceID).execute()],
    ["source availability", tx => tx.updateTable("resource_sources").set({ availability: "missing" }).where("id", "=", source.id).execute()],
    ["source version", tx => tx.updateTable("resource_sources").set({ source_version: source.source_version + 1 }).where("id", "=", source.id).execute()],
    ["folder metadata", tx => tx.updateTable("library_nodes").set({ name: "Changed folder" }).where("id", "=", folder).execute()],
    ["folder membership", tx => tx.insertInto("library_items").values({ id: randomUUID(), library_id: f.target.libraryID, node_id: folder, library_resource_id: member.id, sort_order: 0, added_at: 0 }).execute()],
    ["library membership", tx => tx.updateTable("library_resources").set({ deleted_at: 1 }).where("id", "=", member.id).execute()],
    ["identifier", tx => tx.insertInto("resource_identifiers").values({ id: randomUUID(), resource_id: f.input.resourceID, identifier_type: "doi", identifier_value: "10.test/revision", normalized_value: "10.test/revision", created_at: 0 }).execute()],
    ["annotation", tx => tx.insertInto("resource_annotations").values({ id: randomUUID(), resource_id: f.input.resourceID, resource_version: 1, annotation_type: "evidence", text: "Revision annotation", created_by_type: "user", created_at: 0, updated_at: 0 }).execute()],
    ["resource reference", tx => tx.insertInto("resource_references").values({ id: randomUUID(), resource_id: f.input.resourceID, reference_type: "bibliography", raw_text: "Revision reference", created_at: 0, updated_at: 0 }).execute()],
    ["visual projection", tx => tx.updateTable("content_visual_projections").set(eb => ({ version: eb("version", "+", 1) })).where("generation_id", "=", source.active_generation_id).execute()],
    ["reference projection", tx => tx.updateTable("content_reference_projections").set(eb => ({ version: eb("version", "+", 1) })).where("generation_id", "=", source.active_generation_id).execute()],
  ];
  const initial = await f.state();
  for (const [label, change] of cases) {
    const rollback = Error(label);
    await assert.rejects(f.db.transaction().execute(async tx => {
      const before = await f.revision(tx); await change(tx); assert.notEqual(await f.revision(tx), before, label); throw rollback;
    }), error => error === rollback);
    assert.equal(await f.state(), initial, `${label} rollback`);
  }
});

test("staging work does not invalidate a cursor; atomic publication does", async t => {
  const f = await fixture(t), initial = await f.state(), page = await f.call("get_resource_content", { resourceId: f.input.resourceID, maxChars: 1 });
  const source = await f.db.selectFrom("resource_sources").selectAll().where("id", "=", f.input.sourceID).executeTakeFirstOrThrow();
  const generation = randomUUID(), block = randomUUID();
  await f.db.insertInto("content_generations").values({ id: generation, resource_id: f.input.resourceID, source_id: source.id,
    base_content_version: source.content_version, content_version: source.content_version + 1, source_version: source.source_version,
    source_fingerprint: source.source_fingerprint, origin: "manual", content_fingerprint: "a".repeat(64), normalizer_version: "fixture", created_by_type: "system", created_at: 0 }).execute();
  await f.db.insertInto("content_blocks").values({ id: block, generation_id: generation, block_type: "text", canonical_order: 0,
    content_markdown: "New publication", content_hash: "a".repeat(64), source_type: "manual", created_at: 0 }).execute();
  assert.equal(await f.state(), initial);
  assert.ok(!(await f.call("get_resource_content", { resourceId: f.input.resourceID, maxChars: 1, cursor: page.nextCursor })).error);
  await f.db.transaction().execute(async tx => {
    await tx.updateTable("content_generations").set({ state: "ready", published_at: 1 }).where("id", "=", generation).execute();
    await tx.updateTable("resource_sources").set({ active_generation_id: generation, content_version: source.content_version + 1 }).where("id", "=", source.id).execute();
  });
  assert.notEqual(await f.state(), initial);
  assert.equal((await f.call("get_resource_content", { resourceId: f.input.resourceID, maxChars: 1, cursor: page.nextCursor })).error.code, "CURSOR_STALE");
  assert.equal((await f.call("get_resource_content", { resourceId: f.input.resourceID })).contentMarkdown, "New publication");
});

test("active visual and reference links invalidate on insert, update and delete, with transactional rollback", async t => {
  const f = await fixture(t), block = await f.db.selectFrom("content_blocks").select(["id", "generation_id"]).orderBy("canonical_order").executeTakeFirstOrThrow();
  const initial = await f.state(), rollback = Error("rollback links");
  await assert.rejects(f.db.transaction().execute(async tx => {
    const changed = async action => { const before = await f.revision(tx); await action(); assert.notEqual(await f.revision(tx), before); };
    const visual = randomUUID(), reference = randomUUID();
    await changed(() => tx.insertInto("content_visual_links").values({ id: visual, generation_id: block.generation_id, visual_block_id: block.id,
      role: "body", position: "content", evidence: "provider", ordinal: 0, content_markdown: "Visual body", created_at: 0 }).execute());
    await changed(() => tx.updateTable("content_visual_links").set({ content_markdown: "Changed visual body" }).where("id", "=", visual).execute());
    await changed(() => tx.deleteFrom("content_visual_links").where("id", "=", visual).execute());
    await changed(() => tx.insertInto("resource_references").values({ id: reference, resource_id: f.input.resourceID, source_id: f.input.sourceID,
      generation_id: block.generation_id, source_block_id: block.id, reference_type: "bibliography", raw_text: "Linked reference", created_at: 0, updated_at: 0 }).execute());
    await changed(() => tx.insertInto("reference_source_blocks").values({ reference_id: reference, generation_id: block.generation_id, block_id: block.id, ordinal: 0 }).execute());
    await changed(() => tx.updateTable("reference_source_blocks").set({ ordinal: 1 }).where("reference_id", "=", reference).execute());
    await changed(() => tx.deleteFrom("reference_source_blocks").where("reference_id", "=", reference).execute());
    await changed(() => tx.deleteFrom("resource_references").where("id", "=", reference).execute());
    throw rollback;
  }), error => error === rollback);
  assert.equal(await f.state(), initial);
});

test("rolled-back changes keep signed cursors valid while committed metadata changes invalidate them", async t => {
  const f = await fixture(t); await resource(f, "CURSOR2");
  const first = await f.call("list_resources", { limit: 1, responseMode: "compact" }), rollback = Error("rollback metadata");
  assert.ok(first.nextCursor);
  await assert.rejects(f.db.transaction().execute(async tx => {
    await tx.updateTable("knowledge_resources").set({ abstract: "Rolled back" }).where("id", "=", f.input.resourceID).execute(); throw rollback;
  }), error => error === rollback);
  assert.ok(!(await f.call("list_resources", { limit: 1, responseMode: "compact", cursor: first.nextCursor })).error);
  await f.db.updateTable("knowledge_resources").set({ abstract: "Committed without changing resource version" }).where("id", "=", f.input.resourceID).execute();
  assert.equal((await f.call("list_resources", { limit: 1, responseMode: "compact", cursor: first.nextCursor })).error.code, "CURSOR_STALE");
});

test("library revision tombstones prevent delete/recreate ABA and retain integer precision", async t => {
  const f = await fixture(t), id = await f.repo.create("Tombstone scope");
  const old = await f.revision(f.db, id);
  await f.db.deleteFrom("knowledge_libraries").where("id", "=", id).execute();
  const removed = await f.revision(f.db, id); assert.ok(BigInt(removed) > BigInt(old));
  await f.db.insertInto("knowledge_libraries").values({ id, name: "Recreated scope", created_at: 0, updated_at: 0 }).execute();
  assert.ok(BigInt(await f.revision(f.db, id)) > BigInt(removed));
  f.native.sqlite.prepare("UPDATE mcp_library_revisions SET revision=9007199254740992 WHERE library_id=?").run(f.target.libraryID);
  const before = await f.state();
  await f.db.updateTable("knowledge_resources").set({ summary: "High revision" }).where("id", "=", f.input.resourceID).execute();
  assert.notEqual(await f.state(), before); assert.match(await f.state(), /9007199254740993/);
});

test("missing or overflowing revision state fails closed instead of publishing stale results", async t => {
  const f = await fixture(t);
  f.native.sqlite.prepare("UPDATE mcp_library_revisions SET revision=9223372036854775807 WHERE library_id=?").run(f.target.libraryID);
  const before = await f.db.selectFrom("knowledge_resources").select("summary").where("id", "=", f.input.resourceID).executeTakeFirstOrThrow();
  await assert.rejects(f.db.updateTable("knowledge_resources").set({ summary: "Overflow" }).where("id", "=", f.input.resourceID).execute(), /INTEGER|constraint|REAL/i);
  assert.equal((await f.db.selectFrom("knowledge_resources").select("summary").where("id", "=", f.input.resourceID).executeTakeFirstOrThrow()).summary, before.summary);
  await f.db.deleteFrom("mcp_library_revisions").where("library_id", "=", f.target.libraryID).execute();
  assert.equal((await f.call("get_resources", { resourceIds: [f.input.resourceID] })).error.code, "INTERNAL_ERROR");
});

test("changes during batched assembly and token revocation are rejected before returning results", async t => {
  const f = await fixture(t), reader = f.tools.resources, original = reader.items.bind(reader);
  reader.items = async (...args) => { const result = await original(...args); await f.db.updateTable("knowledge_resources").set({ summary: "Concurrent change" }).where("id", "=", f.input.resourceID).execute(); return result; };
  assert.equal((await f.call("get_resources", { resourceIds: [f.input.resourceID] })).error.code, "KNOWLEDGE_RESOURCE_UNAVAILABLE");
  reader.items = async (...args) => { const result = await original(...args); await f.tokens.revoke(f.created.id); return result; };
  assert.equal((await f.call("get_resources", { resourceIds: [f.input.resourceID] })).error.code, "KNOWLEDGE_AUTH_REQUIRED");
});
