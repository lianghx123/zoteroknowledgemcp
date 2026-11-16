import assert from "node:assert/strict";
import { test } from "node:test";
import { api, parsingFixture } from "./fixtures/parsing.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t) {
  const f = await parsingFixture(t);
  await f.enqueue(); await f.step(); await f.step();
  const service = new api.EmbeddingService(f.db, "file:///fixture/");
  f.beforeClose(() => service.close());
  service.config.current = { ...structuredClone(api.defaultRetrievalConfig), enabled: true };
  service.credentials.get = () => "synthetic-test-credential";
  service.store.sync = async () => { service.store.status = "ready"; };
  return { ...f, service };
}
async function changeModel(service, revision = service.config.current.revision + 1) {
  const next = structuredClone(service.config.current);
  next.revision = revision; next.embedding.model = "synthetic-other-model";
  await IOUtils.writeUTF8(service.config.path, JSON.stringify(next));
  await service.config.reload();
}
const vectors = texts => texts.map(() => api.normalizedVector(Array(768).fill(1), 768));

for (const boundary of ["reconcile", "prepare"]) test(`model changes during ${boundary} cannot write vectors under the previous profile`, async t => {
  const { db, service } = await fixture(t);
  const original = service.repository[boundary].bind(service.repository);
  let changed = false, requests = 0;
  service.repository[boundary] = async (...args) => {
    await original(...args);
    if (!changed) { changed = true; await changeModel(service); }
  };
  service.gateway.embed = async (texts, _signal, _query, snapshot) => {
    requests++; assert.equal(snapshot.embedding.model, "synthetic-other-model");
    return vectors(texts);
  };
  await service.tick();
  assert.equal(requests, 0);
  assert.equal((await db.selectFrom("block_embeddings").select("id").execute()).length, 0);
  const previous = await db.selectFrom("processing_jobs").select(["state", "failure_count"]).where("kind", "=", "embed").executeTakeFirstOrThrow();
  assert.equal(previous.state, "pending"); assert.equal(previous.failure_count, 0);
  await service.tick();
  const committed = await db.selectFrom("block_embeddings as e").innerJoin("embedding_profiles as p", "p.id", "e.profile_id").select("p.model").execute();
  assert.ok(committed.length); assert.ok(committed.every(row => row.model === "synthetic-other-model"));
});

test("a late embedding response is discarded even when an external edit retains the revision", async t => {
  const { db, service } = await fixture(t), started = deferred(), response = deferred();
  const original = service.config.current;
  service.gateway.embed = async (texts, _signal, _query, snapshot) => {
    assert.equal(snapshot, original); started.resolve(); await response.promise; return vectors(texts);
  };
  const ticking = service.tick(); await started.promise;
  await changeModel(service, original.revision); response.resolve(); await ticking;
  assert.equal((await db.selectFrom("block_embeddings").select("id").execute()).length, 0);
  const job = await db.selectFrom("processing_jobs").select(["state", "failure_count"]).where("kind", "=", "embed").executeTakeFirstOrThrow();
  assert.equal(job.state, "pending"); assert.equal(job.failure_count, 0);
  service.gateway.embed = async (texts, _signal, _query, snapshot) => {
    assert.equal(snapshot, service.config.current); return vectors(texts);
  };
  await service.tick();
  const committed = await db.selectFrom("block_embeddings as e").innerJoin("embedding_profiles as p", "p.id", "e.profile_id").select("p.model").execute();
  assert.ok(committed.length); assert.ok(committed.every(row => row.model === "synthetic-other-model"));
});

test("the model gateway uses the supplied configuration snapshot", async t => {
  const { service } = await fixture(t), original = service.config.current;
  await changeModel(service);
  let requestedModel;
  service.gateway.transport = { async request(_url, init) {
    requestedModel = JSON.parse(init.body).model;
    return { bytes: new TextEncoder().encode(JSON.stringify({ data: [{ index: 0, embedding: Array(768).fill(1) }] })) };
  } };
  await service.gateway.embed(["Synthetic text"], new AbortController().signal, false, original);
  assert.equal(requestedModel, original.embedding.model);
});

test("a stale manual admission cannot reactivate its profile after the new model is applied", async t => {
  const { db, service, input } = await fixture(t), started = deferred(), finish = deferred();
  const original = service.config.current, oldIdentity = api.spaceKey(original);
  const hash = service.repository.port.hash.bind(service.repository.port);
  service.repository.port.hash = async value => {
    if (value === oldIdentity) { started.resolve(); await finish.promise; }
    return hash(value);
  };
  const admitting = service.enqueue([input.resourceID]), rejected = assert.rejects(admitting, /config-changed/);
  await started.promise; await changeModel(service);
  const currentProfile = await service.repository.profile(service.config.current);
  finish.resolve(); await rejected;
  const active = await db.selectFrom("embedding_profiles").select("id").where("is_active", "=", 1).executeTakeFirstOrThrow();
  assert.equal(active.id, currentProfile);
});

test("local recovery retries profile activation when configuration changes during hashing", async t => {
  const { db, service } = await fixture(t), originalIdentity = api.spaceKey(service.config.current);
  const hash = service.repository.port.hash.bind(service.repository.port);
  service.repository.port.hash = async value => {
    if (value === originalIdentity) await changeModel(service);
    return hash(value);
  };
  service.gateway.embed = () => { throw new Error("Recovery must not call a model"); };
  await service.restoreIndex();
  const active = await db.selectFrom("embedding_profiles").select(["id", "model"]).where("is_active", "=", 1).executeTakeFirstOrThrow();
  assert.equal(active.id, service.profile); assert.equal(active.model, "synthetic-other-model");
});

test("embedding commit rejects a profile that does not belong to its claimed job", async t => {
  const { db, service } = await fixture(t), repo = service.repository, first = service.config.current;
  const profile = await repo.profile(first); await repo.reconcile(profile, first);
  const job = await db.selectFrom("processing_jobs").selectAll().where("kind", "=", "embed").executeTakeFirstOrThrow();
  await repo.prepare(job.generation_id, profile, first);
  const rows = await repo.pending(job.generation_id, profile, 10);
  await db.updateTable("processing_jobs").set({ state: "running", execution_token: "test-token", lease_owner: "test", lease_expires_at: Date.now() + 60000, started_at: Date.now() }).where("id", "=", job.id).execute();
  await changeModel(service); const other = await repo.profile(service.config.current);
  await assert.rejects(repo.commit(job.id, "test-token", other, rows, vectors(rows)), /embedding-stale/);
  assert.equal((await db.selectFrom("block_embeddings").select("id").execute()).length, 0);
});

test("same-dimension queries cannot use the previous model's index", async t => {
  const f = await fixture(t), repo = f.service.repository, config = f.service.config.current;
  const profile = await repo.profile(config), store = new api.VectorStore(repo, "file:///fixture/");
  f.beforeClose(() => store.close());
  let queried = false;
  Object.assign(store.index, { async open() {}, async add() {}, close() {},
    async query() { queried = true; return []; },
    async save(path) { await IOUtils.write(path, new Uint8Array([1])); return { hash: "a".repeat(64), bytes: 1 }; },
  });
  await store.sync(profile, config, new AbortController().signal);
  await changeModel(f.service);
  await assert.rejects(store.search(vectors(["query"])[0], [f.input.resourceID], 20, api.spaceKey(f.service.config.current)), /initializing/);
  assert.equal(queried, false);
  await store.search(vectors(["query"])[0], [f.input.resourceID], 20, api.spaceKey(config));
  assert.equal(queried, true);
});

test("a stale query embedding cannot poison the cache for a previous model", async t => {
  const { service, input } = await fixture(t), started = deferred(), response = deferred();
  const original = service.config.current;
  service.gateway.embed = async (texts, _signal, _query, snapshot) => {
    assert.equal(snapshot, original); started.resolve(); await response.promise; return vectors(texts);
  };
  const retrieval = new api.RetrievalService(service);
  const searching = retrieval.search("Synthetic", "semantic", [input.resourceID], new AbortController().signal);
  const rejected = assert.rejects(searching, /config-changed/);
  await started.promise; await changeModel(service); response.resolve(); await rejected;
  assert.equal(retrieval.cache.size, 0);
});

for (const fails of [false, true]) test(`snapshot cleanup waits for ${fails ? "failed" : "successful"} publication`, async t => {
  const f = await fixture(t), repo = f.service.repository, config = f.service.config.current;
  const profile = await repo.profile(config), store = new api.VectorStore(repo, "file:///fixture/");
  f.beforeClose(() => store.close());
  const written = deferred(), finish = deferred(); let snapshotPath;
  Object.assign(store.index, { async open() {}, async add() {}, close() {},
    async save(path) {
      snapshotPath = path; await IOUtils.write(`${path}.tmp`, new Uint8Array([1, 2, 3]));
      written.resolve(); await finish.promise;
      if (fails) throw new Error("synthetic-write-failure");
      await IOUtils.write(path, await IOUtils.read(`${path}.tmp`)); await IOUtils.remove(`${path}.tmp`);
      return { hash: "a".repeat(64), bytes: 3 };
    },
  });
  const syncing = store.sync(profile, config, new AbortController().signal);
  const outcome = fails ? assert.rejects(syncing, /synthetic-write-failure/) : syncing;
  await written.promise;
  let cleaned = false; const cleaning = api.cleanupFiles(f.db).then(() => { cleaned = true; });
  await settle(); assert.equal(cleaned, false); assert.ok(await IOUtils.exists(`${snapshotPath}.tmp`));
  finish.resolve(); await outcome; await cleaning;
  assert.equal(await IOUtils.exists(snapshotPath), !fails);
  assert.equal(await IOUtils.exists(`${snapshotPath}.tmp`), false);
  assert.equal((await f.db.selectFrom("vector_snapshot_state").select("profile_id").execute()).length, fails ? 0 : 1);
  assert.equal((await f.db.selectFrom("file_cleanup").select("relative_path").execute()).length, 0);
});

for (const action of ["enqueue", "clear", "rebuild"]) test(`shutdown drains accepted manual ${action} and rejects new work`, async t => {
  const f = await fixture(t), service = f.service, started = deferred(), finish = deferred();
  const target = action === "enqueue" ? service.repository : service.store;
  const method = action === "enqueue" ? "reconcile" : action === "clear" ? "invalidate" : "sync";
  const original = target[method].bind(target);
  let completed = false;
  target[method] = async (...args) => { started.resolve(); await finish.promise; await original(...args); completed = true; };
  // Invalidation has already been accepted; worker interruption does not own its database work.
  if (action === "clear") service.store.invalidate = async () => { started.resolve(); await finish.promise; completed = true; };
  const operation = action === "enqueue" ? service.enqueue([f.input.resourceID]) : action === "clear" ? service.clear(service.config.current) : service.rebuild();
  await started.promise;
  let closed = false; const closing = service.close(); assert.equal(service.close(), closing);
  void closing.then(() => { closed = true; });
  await settle(); assert.equal(closed, false);
  await assert.rejects(service.enqueue([f.input.resourceID]), /initializing/);
  await assert.rejects(service.runAction("unused", "cancel"), /initializing/);
  await assert.rejects(service.clear(service.config.current), /initializing/);
  await assert.rejects(service.rebuild(), /initializing/);
  finish.resolve(); await operation; await closing;
  assert.equal(completed, true); assert.equal(service.operations.size, 0);
});

test("shutdown drains a failing accepted task action without hiding its error from the caller", async t => {
  const { service } = await fixture(t), started = deferred(), finish = deferred();
  service.beforeWork = async () => { started.resolve(); await finish.promise; throw new Error("synthetic-action-failure"); };
  const operation = service.runAction("unused", "cancel"), rejected = assert.rejects(operation, /synthetic-action-failure/);
  await started.promise;
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await settle(); assert.equal(closed, false);
  finish.resolve(); await rejected; await closing;
  assert.equal(service.operations.size, 0);
});

for (const outcome of ["saved", "write-failed", "reload-failed", "lost-ack"]) test(`clear-and-switch fences old scheduling until configuration publication: ${outcome}`, async t => {
  const f = await fixture(t), service = f.service, requests = [];
  await service.config.save(service.config.current);
  const settings = new api.RetrievalConfigFile(); await settings.reload();
  f.beforeClose(() => settings.close());
  service.gateway.embed = async (texts, _signal, _query, snapshot) => {
    requests.push(snapshot.dimensions);
    return texts.map(() => api.normalizedVector(Array(snapshot.dimensions).fill(1), snapshot.dimensions));
  };
  await service.tick(); assert.deepEqual(requests, [768]);
  const write = IOUtils.writeUTF8, read = IOUtils.readUTF8;
  t.after(() => { IOUtils.writeUTF8 = write; IOUtils.readUTF8 = read; });
  let fenced = false, failReload = false;
  IOUtils.readUTF8 = async (...args) => {
    if (failReload && args[0] === service.config.path) { failReload = false; throw new Error("synthetic-reload-failure"); }
    return read(...args);
  };
  IOUtils.writeUTF8 = async (path, text, ...args) => {
    if (path === settings.path && JSON.parse(text).dimensions === 512) {
      assert.equal(service.config.current.dimensions, 768);
      await service.tick();
      assert.deepEqual(requests, [768], "polling gap cannot request old vectors again");
      assert.equal((await f.db.selectFrom("block_embeddings").select("id").execute()).length, 0);
      fenced = true;
      if (outcome === "write-failed") throw new Error("synthetic-save-failure");
      const value = await write(path, text, ...args);
      if (outcome === "lost-ack") throw new Error("synthetic-lost-acknowledgement");
      failReload = outcome === "reload-failed";
      return value;
    }
    return write(path, text, ...args);
  };
  const saving = settings.save({ ...settings.current, dimensions: 512 }, "clear", (old, publish) => service.clear(old, publish));
  if (outcome === "saved" || outcome === "lost-ack") await saving;
  else await assert.rejects(saving, outcome === "write-failed" ? /synthetic-save-failure/ : /config/);
  assert.equal(fenced, true);
  if (outcome === "reload-failed") {
    await service.tick(); assert.deepEqual(requests, [768], "failed runtime reload keeps the old snapshot fenced");
    const recovering = service.restoreIndex();
    await service.config.reload(); await recovering;
  }
  await service.tick();
  const expected = outcome === "write-failed" ? 768 : 512;
  assert.deepEqual(requests, [768, expected]);
  const stored = await f.db.selectFrom("block_embeddings").select("dimensions").execute();
  assert.ok(stored.length); assert.ok(stored.every(row => row.dimensions === expected));
  assert.equal(service.clearing, 0);
});

for (const failOldRead of [false, true]) test(`clear-and-switch cannot be undone by an earlier ${failOldRead ? "failed" : "successful"} configuration poll`, async t => {
  const f = await fixture(t), service = f.service, requests = [];
  await service.config.save(service.config.current);
  const settings = new api.RetrievalConfigFile(); await settings.reload(); f.beforeClose(() => settings.close());
  service.gateway.embed = async (texts, _signal, _query, config) => {
    requests.push(config.dimensions); return texts.map(() => api.normalizedVector(Array(config.dimensions).fill(1), config.dimensions));
  };
  await service.tick(); assert.deepEqual(requests, [768]);
  const started = deferred(), finish = deferred(), read = IOUtils.readUTF8;
  let held = false, polling;
  IOUtils.readUTF8 = async (...args) => {
    const text = await read(...args);
    if (args[0] === service.config.path && !held) {
      held = true; started.resolve(); await finish.promise;
      if (failOldRead) throw Error("obsolete-poll-failure");
    }
    return text;
  };
  try {
    polling = service.config.reload(); await started.promise;
    await settings.save({ ...settings.current, dimensions: 512 }, "clear", (old, publish) => service.clear(old, publish));
    assert.equal(service.config.current.dimensions, 512);
    finish.resolve(); await polling; await service.tick();
    assert.equal(service.config.current.dimensions, 512); assert.equal(service.config.error, false);
    assert.deepEqual(requests, [768, 512]);
    const stored = await f.db.selectFrom("block_embeddings").select("dimensions").execute();
    assert.ok(stored.length); assert.ok(stored.every(row => row.dimensions === 512));
  } finally { finish.resolve(); IOUtils.readUTF8 = read; await polling; }
});
