import assert from "node:assert/strict";
import { test } from "node:test";
import { api, parsingFixture, bytes, page, result } from "./fixtures/parsing.mjs";
async function fixture(t) {
  let downloads = 0;
  const f = await parsingFixture(t, { async download() {
      const label = ++downloads === 1 ? "Target" : "Foreign", p = page(`${label} paper`);
      p.prunedResult.parsing_res_list = [p.prunedResult.parsing_res_list[0], ...["First", "Second", "Third"].map((word, index) => ({
          block_label: "text", block_id: index + 1, block_bbox: [20, 100 + index * 120, 550, 180 + index * 120],
          block_content: `${label} ${word} capability research studies industrial innovation with detailed regional evidence and useful scientific explanations.`
        }))];
      return bytes(result([p]));
    } });
  await f.repo.save({ ...f.item, nativeVersion: 2, attachments: [...f.item.attachments, { ...f.item.attachments[0], key: "PDFKEY02", itemID: 12 }] }, f.target);
  await f.enqueue();
  await f.step();
  await f.step();
  const sibling = await f.repository.sourceFor(1, "PDFKEY02");
  await f.repository.enqueue({ ...f.input, sourceID: sibling.id, attachmentKey: "PDFKEY02" }, await f.port.hash(bytes("%PDF-1.7\nSynthetic test attachment")), 3);
  await f.step();
  await f.step();
  const generation = (await f.db.selectFrom("resource_sources").select("active_generation_id").where("id", "=", f.input.sourceID).executeTakeFirstOrThrow()).active_generation_id;
  const repository = new api.EmbeddingRepository(f.db), config = structuredClone(api.defaultRetrievalConfig);
  config.enabled = true;
  const profile = await repository.profile(config);
  await repository.reconcile(profile, config);
  const jobs = await f.db.selectFrom("processing_jobs").selectAll().where("kind", "=", "embed").execute();
  for (const job of jobs) {
    await repository.prepare(job.generation_id, profile, config);
    const rows = await repository.pending(job.generation_id, profile, 300);
    await f.db.updateTable("processing_jobs").set({ state: "running", lease_owner: "test", execution_token: "token", started_at: Date.now(), lease_expires_at: Date.now() + 600000 }).where("id", "=", job.id).execute();
    await repository.commit(job.id, "token", profile, rows, rows.map(() => api.normalizedVector(Array(768).fill(1), 768)));
  }
  await repository.projectFulltext();
  const store = new api.VectorStore(repository, "file:///fixture/");
  Object.assign(store.index, { async open() { }, async add() { }, async remove() { }, async query(_v, labels, limit) { return labels.slice(0, limit).map((label, i) => ({ label, score: .95 - i * .001 })); },
    async save(path) { await IOUtils.write(path, Uint8Array.of(1, 2, 3)); return { hash: "a".repeat(64), bytes: 3 }; }, close() { } });
  await store.sync(profile, config, new AbortController().signal);
  f.beforeClose(() => store.close());
  const sent = [];
  let embeds = 0;
  const gateway = { async embed() { embeds++; return [api.normalizedVector(Array(768).fill(1), 768)]; }, async rerank(query, texts, signal, guard) { await guard?.(); signal.throwIfAborted(); sent.push([...texts]); return texts.map((_, index) => ({ index, score: index + 1 })); } };
  const embeddings = { repository, config: { current: config }, profile, store, gateway };
  return { ...f, generation, embeddings, sent, get embeds() { return embeds; }, service: new api.RetrievalService(embeddings), attachment: { libraryID: 1, itemKey: "PDFKEY01" } };
}
test("reader retrieval scopes text/vector/fusion before ranking and reranks paragraphs rather than the parent resource", async (t) => {
  const f = await fixture(t), signal = new AbortController().signal;
  for (const mode of ["fulltext", "semantic", "enhanced", "fusion"]) {
    const result = await f.service.searchReader(f.attachment, f.generation, "capability", mode, signal);
    assert.ok(result.hits.length >= 3, mode);
    assert.ok(result.hits.every(hit => hit.text.includes("Target") && !hit.text.includes("Foreign")), mode);
    assert.equal(new Set(result.hits.map(hit => hit.blockID)).size, result.hits.length);
    assert.deepEqual(result.degraded, []);
  }
  assert.ok(f.sent.length >= 2);
  assert.ok(f.sent.every(batch => batch.length >= 3 && batch.every(text => text.includes("Target") && !text.includes("Foreign"))));
  const enhanced = await f.service.searchReader(f.attachment, f.generation, "explanation", "enhanced", signal);
  assert.equal(enhanced.hits[0].text, f.sent.at(-1).at(-1), "highest rerank score chooses the passage itself");
  const before = f.embeds;
  await assert.rejects(f.service.searchReader(f.attachment, "stale-generation", "new question", "semantic", signal), /reader-content-changed/);
  assert.equal(f.embeds, before, "a stale rendered generation never dispatches a provider request");
  f.embeddings.config.current = api.validateRetrievalConfig({ ...f.embeddings.config.current, candidates: 1, results: 1 });
  const bounded = await f.service.searchReader(f.attachment, f.generation, "capability", "enhanced", signal);
  assert.equal(bounded.hits.length, 1);
  assert.equal(f.sent.at(-1).length, 1, "a small configured budget also bounds provider reranking input");
});
test("reader retrieval distinguishes missing index, explicit channel degradation, cancellation and content changes during rerank", async (t) => {
  const f = await fixture(t), signal = new AbortController().signal, profile = f.embeddings.profile;
  f.embeddings.profile = "missing-profile";
  await assert.rejects(f.service.searchReader(f.attachment, f.generation, "capability", "semantic", signal), /reader-not-indexed/);
  const fallback = await f.service.searchReader(f.attachment, f.generation, "capability", "fusion", signal);
  assert.ok(fallback.hits.length);
  assert.ok(fallback.degraded.includes("reader-not-indexed"));
  f.embeddings.profile = profile;
  f.embeddings.gateway.rerank = async () => { throw new api.ModelError("credentials"); };
  const enhanced = await f.service.searchReader(f.attachment, f.generation, "capability", "enhanced", signal);
  assert.ok(enhanced.hits.length);
  assert.deepEqual(enhanced.degraded, ["credentials"]);
  const threshold = f.embeddings.config.current.relevanceThreshold;
  f.embeddings.config.current.relevanceThreshold = 0.99;
  assert.equal((await f.service.searchReader(f.attachment, f.generation, "capability", "semantic", signal)).hits.length, 0);
  f.embeddings.config.current.relevanceThreshold = threshold;
  const segment = await f.db.selectFrom("embedding_segments as seg").innerJoin("content_blocks as b", "b.id", "seg.block_id")
    .select(["seg.id", "seg.embedding_id"]).where("b.generation_id", "=", f.generation).where("seg.embedding_id", "is not", null).executeTakeFirstOrThrow();
  await f.db.updateTable("embedding_segments").set({ embedding_id: null }).where("id", "=", segment.id).execute();
  const partial = await f.service.searchReader(f.attachment, f.generation, "capability", "semantic", signal);
  assert.ok(partial.hits.length); assert.ok(partial.degraded.includes("reader-index-partial"));
  await f.db.updateTable("embedding_segments").set({ embedding_id: segment.embedding_id }).where("id", "=", segment.id).execute();
  const missing = await f.db.selectFrom("embedding_segments").selectAll().where("id", "=", segment.id).executeTakeFirstOrThrow();
  const fields = ["id", "block_id", "profile_id", "ordinal", "start_offset", "end_offset", "overlap", "input_text", "input_hash", "skip_reason", "embedding_id", "created_at"];
  const restore = Object.fromEntries(fields.map(key => [key, missing[key]]));
  await f.db.deleteFrom("embedding_segments").where("id", "=", segment.id).execute();
  const uncovered = await f.service.searchReader(f.attachment, f.generation, "capability", "semantic", signal);
  assert.ok(uncovered.degraded.includes("reader-index-partial"), "blocks without any segments must also report an incomplete index");
  await f.db.insertInto("embedding_segments").values(restore).execute();
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(f.service.searchReader(f.attachment, f.generation, "capability", "semantic", aborted.signal));
  f.embeddings.gateway.rerank = async (_query, texts) => {
    await f.db.updateTable("resource_sources").set({ source_version: 999 }).where("id", "=", f.input.sourceID).execute();
    return texts.map((_, index) => ({ index, score: 1 }));
  };
  await assert.rejects(f.service.searchReader(f.attachment, f.generation, "different query", "enhanced", signal), /reader-content-changed/);
});
