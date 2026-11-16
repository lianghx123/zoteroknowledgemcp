import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { api, parsingFixture, page, result } from "./fixtures/parsing.mjs";

const compiled = await build({ stdin: { contents: 'export { diversify } from "./src/mcp/tools/diversify.ts";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, format: "esm", platform: "browser", write: false });
const { diversify } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

function referenceDiversify(hits, lambda) {
  const pending = [...hits], selected = [];
  const words = title => new Set(title.toLowerCase().split(/\s+/));
  const similarity = (a, b) => { const x = words(a), y = words(b); return [...x].filter(word => y.has(word)).length / Math.max(1, new Set([...x, ...y]).size); };
  while (pending.length) {
    const scores = pending.map((hit, rank) => lambda / (rank + 1) - (1 - lambda) * Math.max(0, ...selected.map(row => similarity(hit.title, row.title))));
    selected.push(pending.splice(scores.indexOf(Math.max(...scores)), 1)[0]);
  }
  return selected;
}

test("incremental diversification preserves the greedy order, Unicode sets and ties", () => {
  const titles = ["", " ", "A a A", "a B", "能力支撑", "产业 创新", "é e\u0301", "😀 risk", "risk return", "RISK\treturn"];
  for (const length of [0, 1, 18, 70]) for (const lambda of [0, 0.3, 0.7, 1]) {
    const hits = Array.from({ length }, (_, id) => ({ id, title: `${titles[(id * 13) % titles.length]}${id % 3 ? "" : " common"}` }));
    const before = structuredClone(hits);
    assert.deepEqual(diversify(hits, lambda), referenceDiversify(hits, lambda));
    assert.deepEqual(hits, before);
  }
  const identical = Array.from({ length: 500 }, (_, id) => ({ id, title: "identical title" }));
  assert.deepEqual(diversify(identical, 0.7), identical);
});

async function indexedFixture(t) {
  const document = page();
  document.prunedResult.parsing_res_list[1].block_content = "Regional capability evidence supports industrial innovation. 中文证据 😀. ".repeat(220);
  document.prunedResult.parsing_res_list.push({ block_label: "text", block_content: "Independent second evidence paragraph supports diversification. ".repeat(25), block_id: 2, block_bbox: [10, 150, 500, 220] });
  const f = await parsingFixture(t, { download: async () => new TextEncoder().encode(result([document])) });
  await f.enqueue(); await f.step(); await f.step();
  const service = new api.EmbeddingService(f.db, "file:///fixture/");
  f.beforeClose(() => service.close());
  service.config.current = { ...structuredClone(api.defaultRetrievalConfig), enabled: true };
  service.credentials.get = () => "synthetic-no-network";
  service.gateway.embed = async texts => texts.map(() => api.normalizedVector(Array(768).fill(1), 768));
  service.store.sync = async () => { service.store.status = "ready"; };
  await service.tick();
  const vectors = await service.repository.activeVectors(service.profile).execute();
  assert.ok(vectors.length >= 3, "fixture must split one block into multiple segments");
  const counts = new Map();
  for (const row of vectors) counts.set(row.content_block_id, (counts.get(row.content_block_id) ?? 0) + 1);
  const primary = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  vectors.sort((a, b) => Number(b.content_block_id === primary) - Number(a.content_block_id === primary) || a.id.localeCompare(b.id));
  Object.assign(service.store, { profile: service.profile, identity: api.spaceKey(service.config.current), readable: true, status: "ready",
    labels: new Map(vectors.map((row, index) => [row.id, index + 1])), reverse: new Map(vectors.map((row, index) => [index + 1, row.id])) });
  const calls = [];
  service.store.index.query = async (_vector, labels, limit) => { calls.push({ labels: [...labels], limit }); return [...labels].sort((a, b) => a - b).slice(0, limit).map((label, rank) => ({ label, score: 0.99 - rank / 1000 })); };
  const retrieval = new api.RetrievalService(service);
  f.beforeClose(() => retrieval.close());
  return { ...f, service, retrieval, calls, vectors, vector: api.normalizedVector(Array(768).fill(1), 768) };
}

test("small-scope exhaustion retains multiple segments of the same block and hydrates only selected evidence", async t => {
  const f = await indexedFixture(t), start = f.native.queries.length;
  const found = await f.retrieval.search("capability", "semantic", [f.input.resourceID], new AbortController().signal, "active", { evidence: 2 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].limit, f.vectors.length);
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].evidence.length, 2);
  const evidence = found.hits[0].evidence;
  assert.equal(evidence[0].blockID, evidence[1].blockID);
  assert.notEqual(evidence[0].segmentID, evidence[1].segmentID);
  for (const row of evidence) {
    const original = await f.db.selectFrom("embedding_segments").selectAll().where("id", "=", row.segmentID).executeTakeFirstOrThrow();
    assert.equal(row.blockID, original.block_id); assert.equal(row.text, original.input_text);
  }
  const bodyReads = f.native.queries.slice(start).filter(sql => /select "id", "input_text" from "embedding_segments"/.test(sql));
  assert.equal(bodyReads.length, 1);
  assert.ok(!f.native.queries.slice(start).some(sql => sql.includes('"seg"."input_text"')));
});

test("vector mapping reuse is request-local, filtered, scoped and profile-fenced", async t => {
  const f = await indexedFixture(t), session = { filters: { excludeQualityFlags: ["boilerplate"] } };
  const search = (scope, context = session) => f.service.store.search(f.vector, scope, 1, api.spaceKey(f.service.config.current), undefined, context);
  const start = f.native.queries.length;
  await search([f.input.resourceID]); await search([f.input.resourceID]);
  const mappings = () => f.native.queries.slice(start).filter(sql => sql.includes("WITH sources AS MATERIALIZED"));
  assert.equal(mappings().length, 1);
  await assert.rejects(search([], session), /config-changed/);
  const fresh = { filters: { includeBlockTypes: ["missing_synthetic_type"] } };
  await search([f.input.resourceID], fresh);
  assert.ok(f.calls.at(-1).labels.length < f.calls[0].labels.length);
  assert.equal(mappings().length, 2);
  await f.db.updateTable("resource_sources").set({ source_version: 2 }).where("id", "=", f.input.sourceID).execute();
  assert.deepEqual(await search([f.input.resourceID], {}), []);
  f.service.store.identity = "changed";
  await assert.rejects(search([f.input.resourceID]), /initializing/);
});

test("coverage is recomputed from current transactional sources and matches the original aggregation", async t => {
  const f = await indexedFixture(t);
  const reference = () => f.native.sqlite.prepare(`SELECT s.resource_id, count(seg.id) AS total,
    sum(CASE WHEN e.state = 'active' THEN 1 ELSE 0 END) AS completed,
    sum(CASE WHEN seg.skip_reason IS NOT NULL THEN 1 ELSE 0 END) AS skipped
    FROM embedding_segments seg JOIN content_blocks b ON b.id=seg.block_id
    JOIN resource_sources s ON s.active_generation_id=b.generation_id JOIN content_generations g ON g.id=b.generation_id
    JOIN embedding_profiles p ON p.id=seg.profile_id LEFT JOIN block_embeddings e ON e.id=seg.embedding_id
    WHERE p.profile_key=? AND s.deleted_at IS NULL AND g.state IN ('ready','partial')
    AND s.resource_id=? AND g.source_id=s.id AND g.source_version=s.source_version AND g.content_version=s.content_version
    GROUP BY s.resource_id`).all(api.spaceKey(f.service.config.current), f.input.resourceID);
  for (const state of ["active", "stale", "active"]) {
    await f.db.updateTable("block_embeddings").set({ state }).where("profile_id", "=", f.service.profile).execute();
    const response = await f.retrieval.search("capability", "fulltext", [f.input.resourceID], new AbortController().signal);
    assert.equal(response.hits.length, 1);
    const expected = reference()[0];
    assert.deepEqual(response.hits[0].embeddingCoverage, { completed: expected.completed, total: expected.total, skipped: expected.skipped });
    assert.equal(response.coverage.embedded, Number(expected.completed > 0));
  }
  await f.db.updateTable("resource_sources").set({ source_version: 2 }).where("id", "=", f.input.sourceID).execute();
  const response = await f.retrieval.search("capability", "fulltext", [f.input.resourceID], new AbortController().signal);
  assert.deepEqual(response.coverage, { resources: 1, parsed: 0, embedded: 0 });
  assert.equal(response.hits.length, 0);
});

for (const change of ["source", "generation", "segment"]) test(`deferred vector bodies reject ${change} replacement after light ranking`, async t => {
  const f = await indexedFixture(t);
  let changed = false;
  const found = await f.retrieval.search("capability", "semantic", [f.input.resourceID], new AbortController().signal, "active", {
    evidence: 2,
    guard: async () => {
      if (changed || !f.native.queries.some(sql => sql.includes('"seg"."id" as "segmentID"'))) return;
      changed = true;
      if (change === "source") await f.db.updateTable("resource_sources").set({ source_version: 2 }).where("id", "=", f.input.sourceID).execute();
      if (change === "generation") { await f.enqueue(true); await f.step(); await f.step(); }
      if (change === "segment") await f.db.deleteFrom("embedding_segments").where("embedding_id", "=", f.vectors[0].id).execute();
    },
  });
  assert.equal(changed, true);
  assert.deepEqual(found.hits, []);
});
