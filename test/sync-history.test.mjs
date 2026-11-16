import assert from "node:assert/strict";
import { test } from "node:test";
import { api, parsingFixture } from "./fixtures/parsing.mjs";

const vectors = async db => (await db.selectFrom("block_embeddings").select(["id", "vector", "state"]).orderBy("id").execute())
  .map(row => ({ id: row.id, vector: [...row.vector], state: row.state }));
const jobs = async db => (await db.selectFrom("processing_jobs").select(["id", "state", "dedup_key"]).orderBy("id").execute())
  .map(row => ({ id: row.id, state: row.state, dedupKey: row.dedup_key }));

async function fixture(t) {
  const f = await parsingFixture(t);
  f.input.batch = { id: "sync-link", title: "Collection", sourceCollection: "Collection" };
  await f.enqueue(); await f.step(); await f.step();
  const knowledge = { snapshot: await f.repo.snapshot() };
  const parsing = new api.ParsingService(f.db, knowledge, f.port);
  const embedding = new api.EmbeddingService(f.db, "file:///fixture/");
  f.beforeClose(() => parsing.close()); f.beforeClose(() => embedding.close());
  await parsing.refresh();
  embedding.config.current = { ...structuredClone(api.defaultRetrievalConfig), enabled: true };
  embedding.credentials.get = () => "synthetic-no-network";
  let requests = 0;
  embedding.gateway.embed = async texts => { requests++; return texts.map(() => api.normalizedVector(Array(768).fill(1), 768)); };
  embedding.store.sync = async () => { embedding.store.status = "ready"; };
  await embedding.tick();
  const binding = { id: "link", target: f.target, enabled: true, mode: "flexible", collectionKey: "COLLECT1", nativeLibraryID: 1 };
  const sync = new api.CollectionSyncService({ db: f.db, list: async () => [binding] }, knowledge, parsing, embedding);
  f.beforeClose(() => sync.close());
  sync.state.set("link", { title: "Collection", added: 0, removedItems: 0, error: false });
  await sync.publish();
  const tasks = new api.ImportTasksService(parsing, sync, embedding);
  const clear = () => tasks.runAction("batch-sync-link", "delete");
  const refresh = async () => { await parsing.refresh(); await embedding.refresh(); };
  return { ...f, parsing, embedding, sync, tasks, clear, refresh, requests: () => requests };
}

test("clearing sync history hides every terminal vector profile and retains vectors, cancellation and deduplication", async t => {
  const f = await fixture(t), original = f.embedding.config.current;
  f.embedding.config.current = { ...original, embedding: { ...original.embedding, model: "other-model" } };
  await f.embedding.tick();
  const current = f.embedding.snapshot().find(row => row.embedding.current);
  await f.embedding.runAction(current.id, "cancel");
  const previousVectors = await vectors(f.db), previousJobs = await jobs(f.db);
  assert.ok(f.tasks.snapshot().some(row => row.embedding));
  await f.clear(); assert.equal(f.tasks.snapshot().length, 0);
  assert.ok((await f.db.selectFrom("processing_jobs").select("payload_json").execute()).every(row => JSON.parse(row.payload_json).hidden));
  assert.deepEqual(await jobs(f.db), previousJobs);
  assert.deepEqual(await vectors(f.db), previousVectors);
  assert.equal((await f.db.selectFrom("plugin_state").select("key").where("key", "like", "embedding-cancel:%").execute()).length, 1);
  await f.embedding.tick(); await f.refresh(); assert.equal(f.tasks.snapshot().length, 0);
  assert.equal(f.requests(), 2);
  const restarted = new api.EmbeddingService(f.db, "file:///fixture/");
  f.beforeClose(() => restarted.close()); await restarted.start(false);
  assert.equal(restarted.snapshot().length, 0);
  await f.embedding.enqueue([f.input.resourceID]);
  assert.equal(f.embedding.snapshot().length, 1, "explicit new work remains visible after a history clear");
});

for (const state of ["pending", "running", "waiting"]) test(`clearing sync history preserves ${state} vector work and its parse grouping`, async t => {
  const f = await fixture(t);
  const job = await f.db.selectFrom("processing_jobs").selectAll().where("kind", "=", "embed").executeTakeFirstOrThrow();
  await f.db.updateTable("processing_jobs").set({ state, finished_at: null, checkpoint_json: "{}",
    ...(state === "running" ? { lease_owner: "test", execution_token: "test-token", lease_expires_at: Date.now() + 60000 } : {}) }).where("id", "=", job.id).execute();
  await f.embedding.refresh(); await f.clear();
  const rows = f.tasks.snapshot(), child = rows.find(row => row.kind === "item");
  assert.ok(rows.some(row => row.id === "batch-sync-link"));
  assert.equal(child.parentID, "batch-sync-link"); assert.ok(child.processing.parseTaskID);
  assert.equal((await f.job(job.id)).state, state);
  assert.ok((await f.db.selectFrom("processing_jobs").select("payload_json").execute()).every(row => !JSON.parse(row.payload_json).hidden));
  await f.db.updateTable("processing_jobs").set({ state: "succeeded", finished_at: Date.now(), lease_owner: null, execution_token: null, lease_expires_at: null }).where("id", "=", job.id).execute();
  await f.refresh();
  assert.ok(f.tasks.snapshot().some(row => row.kind === "item" && row.status === "completed"), "work retained during the clear stays visible when it finishes");
  await f.clear(); assert.equal(f.tasks.snapshot().length, 0);
});

test("batch cleanup failure rolls back both phases and does not mark the sync history cleared", async t => {
  const f = await fixture(t), query = f.native.queryAsync.bind(f.native);
  let updates = 0;
  f.native.queryAsync = async (statement, ...args) => {
    if (statement.startsWith('update "processing_jobs" set "payload_json"') && ++updates === 2) throw new Error("synthetic-history-failure");
    return query(statement, ...args);
  };
  try { await assert.rejects(f.clear(), /synthetic-history-failure/); }
  finally { f.native.queryAsync = query; }
  assert.equal(f.sync.isHidden("link"), false);
  assert.ok((await f.db.selectFrom("processing_jobs").select("payload_json").execute()).every(row => !JSON.parse(row.payload_json).hidden));
  await f.refresh(); assert.ok(f.tasks.snapshot().some(row => row.embedding));
  await f.clear(); assert.equal(f.tasks.snapshot().length, 0);
});

test("hidden live work from a retained profile cannot keep a completed workflow visible", async t => {
  const f = await fixture(t), current = f.embedding.snapshot()[0], original = f.embedding.config.current;
  const job = await f.job(current.id.slice(6));
  await f.db.updateTable("processing_jobs").set({ state: "pending", finished_at: null,
    payload_json: JSON.stringify({ ...JSON.parse(job.payload_json), hidden: true }) }).where("id", "=", job.id).execute();
  f.embedding.config.current = { ...original, embedding: { ...original.embedding, model: "new-model" } };
  await f.embedding.tick(); await f.clear();
  assert.equal(f.tasks.snapshot().length, 0);
  assert.equal((await f.job(job.id)).state, "pending", "archived work keeps its durable state");
});

test("obsolete pending vectors cannot retain the history of a superseded parse generation", async t => {
  const f = await fixture(t), oldJob = await f.job(f.embedding.snapshot()[0].id.slice(6));
  await f.db.updateTable("processing_jobs").set({ state: "pending", finished_at: null }).where("id", "=", oldJob.id).execute();
  await f.enqueue(true); await f.step(); await f.step(); await f.embedding.tick(); await f.parsing.refresh();
  await f.clear(); assert.equal(f.tasks.snapshot().length, 0);
  assert.equal((await f.job(oldJob.id)).state, "pending");
});

test("batch history cleanup does not hide another batch", async t => {
  const f = await fixture(t);
  await f.parsing.clearFinishedBatch("batch-sync-other"); await f.refresh();
  assert.ok(f.tasks.snapshot().some(row => row.kind === "item" && row.embedding));
  assert.ok((await f.db.selectFrom("processing_jobs").select("payload_json").execute()).every(row => !JSON.parse(row.payload_json).hidden));
});
