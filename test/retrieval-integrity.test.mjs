import assert from "node:assert/strict";
import { test } from "node:test";
import { api, parsingFixture, hash } from "./fixtures/parsing.mjs";

const vector = () => api.normalizedVector(Array(768).fill(1), 768);
async function fixture(t) {
  const f = await parsingFixture(t); await f.enqueue(); await f.step(); await f.step();
  const embedding = new api.EmbeddingService(f.db, "file:///fixture/");
  f.beforeClose(() => embedding.close());
  embedding.config.current = { ...structuredClone(api.defaultRetrievalConfig), enabled: true };
  embedding.credentials.get = () => "synthetic-no-network";
  embedding.gateway.embed = async texts => texts.map(vector);
  embedding.gateway.rerank = async (_query, texts) => texts.map((_, index) => ({ index, score: 1 - index / 10 }));
  embedding.store.sync = async () => { embedding.store.status = "ready"; };
  embedding.store.search = async (_query, ids, limit) => (await embedding.repository.activeVectors(embedding.profile).orderBy("e.id").execute())
    .filter(row => ids.includes(row.resource_id)).slice(0, limit).map(row => ({ embeddingID: row.id, score: .9 }));
  await embedding.tick();
  const retrieval = new api.RetrievalService(embedding);
  f.beforeClose(async () => retrieval.close());
  return { ...f, embedding, retrieval };
}
async function addAttachment(f, parent, key, text) {
  await f.repo.save({ ...parent, attachments: [...parent.attachments, {
    key, itemID: parent.itemID + 100, parentKey: parent.key, title: key, mediaType: "application/pdf", linkMode: 0, state: "current",
  }] }, f.target);
  const source = await f.repository.sourceFor(1, key);
  const input = { ...f.input, sourceID: source.id, resourceID: source.resource_id, attachmentKey: key };
  await f.repository.enqueue(input, await hash(key), 3);
  const job = await f.repository.claim("integrity-fixture");
  assert.equal(job.source_id, source.id);
  await f.repository.publish(job, { normalizerVersion: "synthetic-1", pages: [{ number: 1, raw: {} }],
    blocks: [{ type: "text", label: "text", markdown: text, text, page: 1 }], total: 1, partial: false, warnings: [], markdown: text }, []);
  return source;
}

for (const mode of ["fulltext", "semantic", "enhanced", "fusion"]) for (const replacement of ["source", "generation"]) {
  test(`${mode} drops evidence replaced during search (${replacement}) and reports current coverage`, async t => {
    const f = await fixture(t);
    const replace = async () => {
      if (replacement === "source") await f.db.updateTable("resource_sources").set({ source_version: 2 }).where("id", "=", f.input.sourceID).execute();
      else { await f.enqueue(true); await f.step(); await f.step(); }
    };
    if (mode === "enhanced" || mode === "fusion") {
      const rerank = f.embedding.gateway.rerank;
      f.embedding.gateway.rerank = async (...args) => { await replace(); return rerank(...args); };
    } else {
      const boundary = mode === "fulltext" ? "text" : "vector", original = f.retrieval[boundary].bind(f.retrieval);
      f.retrieval[boundary] = async (...args) => { const hits = await original(...args); assert.ok(hits.length); await replace(); return hits; };
    }
    const result = await f.retrieval.search("Body", mode, [f.input.resourceID], new AbortController().signal);
    assert.equal(result.hits.length, 0);
    assert.deepEqual(result.coverage, { resources: 1, parsed: replacement === "source" ? 0 : 1, embedded: 0 });
    if (replacement === "generation") {
      const fresh = new api.RetrievalService(f.embedding);
      const next = await fresh.search("Body", "fulltext", [f.input.resourceID], new AbortController().signal);
      // The replacement was published after the previous FTS projection.
      assert.equal(next.hits.length, 0);
      await f.embedding.tick();
      const response = await fresh.search("Body", "fulltext", [f.input.resourceID], new AbortController().signal);
      assert.equal(response.hits.length, 1);
      const source = await f.db.selectFrom("resource_sources").select("active_generation_id").where("id", "=", f.input.sourceID).executeTakeFirstOrThrow();
      assert.ok(response.hits[0].evidence.every(row => row.generationID === source.active_generation_id)); fresh.close();
    }
  });
}

test("source replacement between vector-label selection and hydration cannot produce evidence", async t => {
  const f = await fixture(t), search = f.embedding.store.search;
  f.embedding.store.search = async (...args) => {
    const rows = await search(...args); assert.ok(rows.length);
    await f.db.updateTable("resource_sources").set({ source_version: 2 }).where("id", "=", f.input.sourceID).execute();
    return rows;
  };
  const result = await f.retrieval.search("Body", "semantic", [f.input.resourceID], new AbortController().signal);
  assert.equal(result.hits.length, 0); assert.equal(result.coverage.embedded, 0);
});

test("degraded reranking still rejects changed attachment evidence", async t => {
  const f = await fixture(t);
  f.embedding.gateway.rerank = async () => {
    await f.db.updateTable("resource_sources").set({ source_version: 2 }).where("id", "=", f.input.sourceID).execute();
    throw new api.ModelError("network");
  };
  const result = await f.retrieval.search("Body", "fusion", [f.input.resourceID], new AbortController().signal);
  assert.equal(result.hits.length, 0); assert.deepEqual(result.degraded, [{ channel: "rerank", code: "network" }]);
});

test("stale top candidates are removed before the final limit and valid lower-ranked documents remain", async t => {
  const f = await fixture(t);
  const second = { ...f.item, itemID: 20, key: "ARTICLE2", title: "Retained paper", attachments: [] };
  const resourceID = await f.repo.save(second, f.target);
  await addAttachment(f, second, "PDFKEY02", "Body evidence from a second valid scientific source.");
  await f.embedding.tick();
  f.embedding.config.current.results = 1;
  f.embedding.gateway.rerank = async (_query, texts) => {
    await f.db.updateTable("resource_sources").set({ source_version: 2 }).where("id", "=", f.input.sourceID).execute();
    return texts.map((text, index) => ({ index, score: text.startsWith("Synthetic paper") ? 1 : .8 }));
  };
  const result = await f.retrieval.search("Body", "fusion", [f.input.resourceID, resourceID], new AbortController().signal);
  assert.deepEqual(result.hits.map(hit => hit.resourceID), [resourceID]);
  assert.deepEqual(result.coverage, { resources: 2, parsed: 1, embedded: 1 });
});

test("a mixed-attachment candidate is removed when its ranking used a replaced passage", async t => {
  const f = await fixture(t);
  await addAttachment(f, f.item, "PDFKEY02", "Body evidence from another valid attachment of the same paper.");
  await f.embedding.tick();
  f.embedding.gateway.rerank = async (_query, texts) => {
    await f.db.updateTable("resource_sources").set({ source_version: 2 }).where("id", "=", f.input.sourceID).execute();
    return texts.map((_, index) => ({ index, score: .9 }));
  };
  const result = await f.retrieval.search("Body", "fusion", [f.input.resourceID], new AbortController().signal);
  assert.equal(result.hits.length, 0);
  assert.deepEqual(result.coverage, { resources: 1, parsed: 1, embedded: 1 });
});

test("knowledge Trash retrieval also excludes changed source evidence", async t => {
  const f = await fixture(t);
  await f.repo.moveToTrash([f.input.resourceID], [f.target.libraryID]);
  f.embedding.gateway.rerank = async (_query, texts) => {
    await f.db.updateTable("resource_sources").set({ source_version: 2 }).where("id", "=", f.input.sourceID).execute();
    return texts.map((_, index) => ({ index, score: .9 }));
  };
  const result = await f.retrieval.search("Body", "enhanced", [f.input.resourceID], new AbortController().signal, "trash");
  assert.equal(result.hits.length, 0); assert.equal(result.coverage.resources, 1); assert.equal(result.coverage.parsed, 0);
});

test("the final snapshot releases its database reservation after cancellation", async t => {
  const f = await fixture(t), controller = new AbortController();
  const allowedScope = f.retrieval.allowedScope.bind(f.retrieval);
  f.retrieval.allowedScope = async (...args) => {
    const value = await allowedScope(...args);
    if (args[2]) controller.abort();
    return value;
  };
  await assert.rejects(f.retrieval.search("Body", "fulltext", [f.input.resourceID], controller.signal), { name: "AbortError" });
  const next = new api.RetrievalService(f.embedding);
  assert.equal((await next.search("Body", "fulltext", [f.input.resourceID], new AbortController().signal)).hits.length, 1);
  next.close();
});
