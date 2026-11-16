import assert from "node:assert/strict";
import { test } from "node:test";
import { api, parsingFixture, page, result, bytes } from "./fixtures/parsing.mjs";

const vectors = texts => texts.map(() => api.normalizedVector(Array(768).fill(1), 768));
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t, text) {
  const document = page();
  if (text) document.prunedResult.parsing_res_list[1].block_content = text;
  const f = await parsingFixture(t, { download: async () => bytes(result([document])) });
  await f.enqueue(); await f.step(); await f.step();
  const service = new api.EmbeddingService(f.db, "file:///fixture/");
  f.beforeClose(() => service.close());
  service.config.current = { ...structuredClone(api.defaultRetrievalConfig), enabled: true, requestsPerMinute: 3600 };
  service.credentials.get = () => "synthetic-no-network";
  service.store.sync = async () => { service.store.status = "ready"; };
  let requests = 0;
  service.gateway.embed = async texts => { requests++; return vectors(texts); };
  const queue = async () => {
    service.profile = await service.repository.profile(service.config.current);
    await service.repository.reconcile(service.profile, service.config.current);
    return f.db.selectFrom("processing_jobs").selectAll().where("kind", "=", "embed").executeTakeFirstOrThrow();
  };
  const restore = async () => f.repo.restoreTrash((await f.repo.snapshot()).trash.map(entry => entry.id));
  return { ...f, service, queue, restore, requests: () => requests };
}

for (const removal of ["item", "library"]) test(`queued embedding waits while its ${removal} is in Trash and resumes after restoration`, async t => {
  const f = await fixture(t), job = await f.queue();
  if (removal === "item") await f.repo.moveToTrash([f.input.resourceID], [f.target.libraryID]);
  else await f.repo.deleteLibrary(f.target.libraryID, true);
  await f.service.tick();
  assert.equal(f.requests(), 0);
  assert.equal((await f.job(job.id)).state, "pending");
  assert.equal(f.service.snapshot()[0].status, "paused");
  await f.restore(); await f.service.tick();
  assert.equal(f.requests(), 1);
  assert.equal((await f.job(job.id)).state, "succeeded");
});

test("removing one of two knowledge memberships does not stop eligible embedding", async t => {
  const f = await fixture(t);
  const libraryID = await f.repo.create("Retained library");
  await f.repo.save(f.item, { libraryID, nodeID: null });
  await f.queue(); await f.repo.moveToTrash([f.input.resourceID], [f.target.libraryID]);
  await f.service.tick();
  assert.equal(f.requests(), 1);
});

for (const boundary of ["prepare", "response"]) test(`membership removal during ${boundary} fences HTTP or vector publication without recording a failure`, async t => {
  const f = await fixture(t);
  if (boundary === "prepare") {
    const prepare = f.service.repository.prepare.bind(f.service.repository);
    f.service.repository.prepare = async (...args) => {
      await prepare(...args); await f.repo.moveToTrash([f.input.resourceID], [f.target.libraryID]);
    };
  } else {
    const embed = f.service.gateway.embed;
    f.service.gateway.embed = async texts => {
      await f.repo.moveToTrash([f.input.resourceID], [f.target.libraryID]); return embed(texts);
    };
  }
  await f.service.tick();
  assert.equal(f.requests(), boundary === "prepare" ? 0 : 1);
  assert.equal((await f.db.selectFrom("block_embeddings").select("id").execute()).length, 0);
  const job = await f.db.selectFrom("processing_jobs").selectAll().where("kind", "=", "embed").executeTakeFirstOrThrow();
  assert.equal(job.state, "pending"); assert.equal(job.failure_count, 0); assert.equal(job.error_code, null);
});

test("each embedding batch checks membership and restored jobs reuse already committed vectors", async t => {
  const f = await fixture(t, "Scientific evidence and reproducible research methods. ".repeat(400));
  f.service.config.current.batchSize = 1;
  const commit = f.service.repository.commit.bind(f.service.repository);
  let committed = 0;
  f.service.repository.commit = async (...args) => {
    await commit(...args);
    if (++committed === 1) await f.repo.moveToTrash([f.input.resourceID], [f.target.libraryID]);
  };
  await f.service.tick();
  assert.equal(f.requests(), 1);
  const first = await f.db.selectFrom("block_embeddings").select("id").execute();
  assert.equal(first.length, 1);
  await f.restore(); await f.service.tick();
  const all = await f.db.selectFrom("block_embeddings").select("id").execute();
  assert.ok(all.length > 1); assert.ok(all.some(row => row.id === first[0].id));
  assert.equal(f.requests(), all.length);
});

test("rate-queued embeddings recheck eligibility immediately before transport dispatch", async t => {
  const f = await fixture(t), started = deferred(), finish = deferred(), queued = deferred();
  f.service.config.current.concurrency = 1;
  const gateway = new api.ModelGateway(() => f.service.config.current, () => "synthetic-no-network");
  f.service.gateway = gateway;
  let calls = 0;
  gateway.transport = { async request() {
    calls++; if (calls === 1) { started.resolve(); await finish.promise; }
    return { bytes: bytes(JSON.stringify({ data: [{ index: 0, embedding: Array(768).fill(1) }] })) };
  } };
  const foreground = gateway.embed(["Foreground query"], new AbortController().signal, true);
  await started.promise;
  const acquire = gateway.acquire.bind(gateway);
  gateway.acquire = (...args) => {
    const pending = acquire(...args);
    if (gateway.queue.length) queued.resolve();
    return pending;
  };
  const ticking = f.service.tick();
  try {
    await Promise.race([queued.promise, ticking.then(() => { throw new Error("Embedding tick completed without entering the rate queue"); })]);
    assert.equal(gateway.queue.length, 1);
    await f.repo.moveToTrash([f.input.resourceID], [f.target.libraryID]);
  } finally { finish.resolve(); }
  await foreground; await ticking;
  assert.equal(calls, 1); assert.equal(gateway.active, 0); assert.equal(gateway.queue.length, 0);
  assert.equal((await f.db.selectFrom("block_embeddings").select("id").execute()).length, 0);
});

test("provider retries repeat the membership guard before sending another request", async t => {
  const f = await fixture(t);
  const gateway = new api.ModelGateway(() => f.service.config.current, () => "synthetic-no-network");
  f.service.gateway = gateway;
  let calls = 0;
  gateway.transport = { async request() {
    calls++; await f.repo.moveToTrash([f.input.resourceID], [f.target.libraryID]);
    throw new api.ParseError("http-429", true, 1);
  } };
  await f.service.tick();
  assert.equal(calls, 1); assert.equal(gateway.active, 0); assert.equal(gateway.queue.length, 0);
  const job = await f.db.selectFrom("processing_jobs").selectAll().where("kind", "=", "embed").executeTakeFirstOrThrow();
  assert.equal(job.state, "pending"); assert.equal(job.failure_count, 0);
});

for (const changed of ["source", "content", "generation-state"]) test(`changed ${changed} is fenced before embedding dispatch`, async t => {
  const f = await fixture(t), job = await f.queue();
  if (changed === "source") f.setBytes(bytes("%PDF-1.7 changed synthetic source"));
  await f.enqueue(true);
  if (changed !== "source") {
    await f.step(); await f.step();
    if (changed === "generation-state") await f.db.updateTable("content_generations").set({ state: "superseded" }).where("id", "=", job.generation_id).execute();
  }
  await f.service.execute(job.id, f.service.config.current, f.service.profile);
  assert.equal(f.requests(), 0);
});

for (const state of ["succeeded", "failed", "cancelled"]) test(`hidden ${state} history survives reconciliation/restart while explicit vectorization stays available`, async t => {
  const f = await fixture(t); await f.service.tick();
  const job = await f.db.selectFrom("processing_jobs").selectAll().where("kind", "=", "embed").executeTakeFirstOrThrow();
  if (state === "cancelled") await f.service.runAction(`embed:${job.id}`, "cancel");
  else if (state === "failed") await f.db.updateTable("processing_jobs").set({ state: "failed", error_code: "network" }).where("id", "=", job.id).execute();
  await f.service.refresh(); await f.service.runAction(`embed:${job.id}`, "delete");
  assert.equal(f.service.snapshot().length, 0);
  await f.service.repository.reconcile(f.service.profile, f.service.config.current); await f.service.tick();
  assert.equal(f.service.snapshot().length, 0); assert.equal(f.requests(), 1);
  const restarted = new api.EmbeddingService(f.db, "file:///fixture/");
  f.beforeClose(() => restarted.close());
  restarted.config.current = f.service.config.current;
  await restarted.start(false); await restarted.refresh();
  assert.equal(restarted.snapshot().length, 0);
  const rows = await f.db.selectFrom("processing_jobs").selectAll().where("kind", "=", "embed").execute();
  assert.equal(rows.length, 1); assert.equal(JSON.parse(rows[0].payload_json).hidden, true);
  await f.service.enqueue([f.input.resourceID]); await f.service.refresh();
  assert.equal(f.service.snapshot().length, 1);
  const suppression = await f.db.selectFrom("plugin_state").select("key").where("key", "=", `embedding-cancel:${job.dedup_key}`).execute();
  assert.equal(suppression.length, 0);
});

test("workflow history deletion hides retained profiles and attempts without losing cancellation suppression", async t => {
  const f = await fixture(t); await f.service.tick();
  const first = f.service.snapshot()[0];
  const original = f.service.config.current;
  f.service.config.current = { ...original, embedding: { ...original.embedding, model: "other-model" } };
  await f.service.tick();
  const second = f.service.snapshot().find(task => task.embedding.current);
  await f.service.runAction(second.id, "cancel");
  await f.service.runAction(second.id, "delete");
  assert.equal(f.service.snapshot().length, 0);
  f.service.config.current = original; await f.service.tick();
  assert.equal(f.service.snapshot().length, 0);
  assert.equal((await f.db.selectFrom("plugin_state").select("key").where("key", "like", "embedding-cancel:%").execute()).length, 1);
  assert.equal((await f.db.selectFrom("processing_jobs").select("id").where("kind", "=", "embed").execute()).length, 2);
  await f.service.runAction(first.id, "retry");
  assert.equal(f.service.snapshot().length, 1);
});

test("rejecting history deletion for a running task does not abort its execution", async t => {
  const f = await fixture(t), started = deferred(), finish = deferred();
  const embed = f.service.gateway.embed;
  f.service.gateway.embed = async texts => { started.resolve(); await finish.promise; return embed(texts); };
  const ticking = f.service.tick(); await started.promise;
  try {
    const job = await f.db.selectFrom("processing_jobs").select("id").where("kind", "=", "embed").executeTakeFirstOrThrow();
    await assert.rejects(f.service.runAction(`embed:${job.id}`, "delete"), /stale/);
    assert.equal(f.service.controllers.get(job.id).signal.aborted, false);
  } finally { finish.resolve(); await ticking; }
  assert.equal(f.service.snapshot()[0].status, "completed");
});

test("deleting a merged workflow keeps both phases hidden after background reconciliation", async t => {
  const f = await fixture(t); await f.service.tick();
  const parsing = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port);
  f.beforeClose(() => parsing.close()); await parsing.refresh();
  const tasks = new api.ImportTasksService(parsing, { snapshot: () => [] }, f.service);
  const task = tasks.snapshot()[0]; assert.ok(task.embedding.taskID);
  await tasks.runAction(task.id, "delete");
  assert.equal(tasks.snapshot().length, 0);
  await f.service.repository.reconcile(f.service.profile, f.service.config.current);
  await f.service.refresh(); await parsing.refresh();
  assert.equal(tasks.snapshot().length, 0);
});

test("an older detached task refresh cannot republish deleted history", async t => {
  const f = await fixture(t); await f.service.tick();
  const task = f.service.snapshot()[0], started = deferred(), finish = deferred();
  const executor = f.db.getExecutor(), execute = executor.executeQuery.bind(executor);
  let held = false;
  executor.executeQuery = async (query, ...args) => {
    const value = await execute(query, ...args);
    if (!held && query.sql.startsWith('select "j"."id", "j"."resource_id"')) {
      held = true; started.resolve(); await finish.promise;
    }
    return value;
  };
  const older = f.service.refresh();
  try {
    await started.promise; await f.service.runAction(task.id, "delete");
    assert.equal(f.service.snapshot().length, 0);
  } finally { finish.resolve(); await older; executor.executeQuery = execute; }
  assert.equal(f.service.snapshot().length, 0);
  await f.service.tick(); assert.equal(f.service.snapshot().length, 0);
});
