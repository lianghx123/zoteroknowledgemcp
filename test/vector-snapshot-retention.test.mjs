import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { api, parsingFixture } from "./fixtures/parsing.mjs";

const labels = async db => (await db.selectFrom("vector_index_entries").selectAll().orderBy("build_id").orderBy("engine_label").execute())
  .map(row => ({ build_id: row.build_id, engine_label: row.engine_label, embedding_id: row.embedding_id, profile_id: row.profile_id, state: row.state, indexed_at: row.indexed_at }));

async function fixture(t) {
  const f = await parsingFixture(t);
  await f.enqueue(); await f.step(); await f.step();
  const service = new api.EmbeddingService(f.db, "file:///fixture/");
  f.beforeClose(() => service.close());
  service.config.current = { ...structuredClone(api.defaultRetrievalConfig), enabled: true };
  service.credentials.get = () => "synthetic-no-network";
  service.gateway.embed = async texts => texts.map(() => api.normalizedVector(Array(768).fill(1), 768));
  service.store.sync = async () => { service.store.status = "ready"; };
  await service.tick();
  const store = new api.VectorStore(service.repository, "file:///fixture/");
  f.beforeClose(() => store.close());
  let restores = 0;
  Object.assign(store.index, {
    async open() {}, async add() {}, async remove() {}, close() {},
    async restore() { restores++; },
    async save(path) { await IOUtils.write(path, new Uint8Array([1, 2, 3])); return { hash: "a".repeat(64), bytes: 3 }; },
  });
  const sync = () => store.sync(service.profile, service.config.current, new AbortController().signal, true);
  const snapshot = () => f.db.selectFrom("vector_snapshot_state").selectAll().where("profile_id", "=", service.profile).executeTakeFirstOrThrow();
  return { ...f, service, store, sync, snapshot, restores: () => restores };
}

test("repeated snapshot publication bounds label storage and retains a restorable active snapshot", async t => {
  const f = await fixture(t);
  const vectors = await f.service.repository.activeVectors(f.service.profile).execute();
  assert.ok(vectors.length);
  let previous;
  for (let i = 0; i < 3; i++) {
    await f.sync(); await api.cleanupFiles(f.db);
    const snapshot = await f.snapshot();
    assert.equal((await f.db.selectFrom("search_index_builds").select("id").execute()).length, 1);
    const labels = await f.db.selectFrom("vector_index_entries").selectAll().execute();
    assert.equal(labels.length, vectors.length);
    assert.ok(labels.every(row => row.build_id === snapshot.build_id));
    assert.ok(await IOUtils.exists(snapshot.snapshot_path));
    if (previous) assert.equal(await IOUtils.exists(previous), false);
    previous = snapshot.snapshot_path;
  }
  const restored = new api.VectorStore(f.service.repository, "file:///fixture/");
  f.beforeClose(() => restored.close()); Object.assign(restored.index, f.store.index);
  await restored.sync(f.service.profile, f.service.config.current, new AbortController().signal);
  assert.equal(f.restores(), 1);
  assert.equal((await f.service.repository.activeVectors(f.service.profile).execute()).length, vectors.length);
});

test("failed snapshot activation rolls back reclamation and preserves the previous file and labels", async t => {
  const f = await fixture(t); await f.sync();
  const previous = await f.snapshot();
  const previousLabels = await labels(f.db);
  const query = f.native.queryAsync.bind(f.native); let fail = true;
  f.native.queryAsync = async (statement, ...args) => {
    if (fail && statement.startsWith('delete from "vector_index_entries"')) { fail = false; throw new Error("synthetic-prune-failure"); }
    return query(statement, ...args);
  };
  try { await assert.rejects(f.sync(), /synthetic-prune-failure/); }
  finally { f.native.queryAsync = query; }
  assert.equal((await f.snapshot()).build_id, previous.build_id);
  assert.deepEqual(await labels(f.db), previousLabels);
  await api.cleanupFiles(f.db);
  assert.ok(await IOUtils.exists(previous.snapshot_path));
  assert.equal((await f.db.selectFrom("search_index_builds").select("id").execute()).length, 1);
});

test("lost commit acknowledgement retains the newly activated snapshot after old labels are reclaimed", async t => {
  const f = await fixture(t); await f.sync(); const previous = await f.snapshot();
  const query = f.native.queryAsync.bind(f.native); let publishing = false, lostAck = false;
  f.native.queryAsync = async (statement, ...args) => {
    const value = await query(statement, ...args);
    if (statement.startsWith('insert into "search_index_builds"')) publishing = true;
    if (publishing && statement === "COMMIT") { publishing = false; lostAck = true; throw new Error("synthetic-lost-ack"); }
    return value;
  };
  try { await assert.rejects(f.sync()); }
  finally { f.native.queryAsync = query; }
  assert.equal(lostAck, true);
  const current = await f.snapshot(); assert.notEqual(current.build_id, previous.build_id);
  await api.cleanupFiles(f.db);
  assert.ok(await IOUtils.exists(current.snapshot_path));
  assert.equal(await IOUtils.exists(previous.snapshot_path), false);
  assert.ok((await f.db.selectFrom("vector_index_entries").select("build_id").execute()).every(row => row.build_id === current.build_id));
});

test("startup reclaims accumulated retired builds while preserving referenced snapshots in every space", async t => {
  const f = await fixture(t); await f.sync();
  const active = await f.db.selectFrom("search_index_builds").selectAll().executeTakeFirstOrThrow();
  const previousLabels = await labels(f.db);
  const oldBuild = { kind: "vector", profile_id: active.profile_id, engine_key: active.engine_key, engine_version: active.engine_version,
    configuration_hash: active.configuration_hash, state: "retired", created_at: active.created_at };
  const retired = randomUUID();
  await f.db.insertInto("search_index_builds").values({ ...oldBuild, id: retired }).execute();
  for (const row of previousLabels) await f.db.insertInto("vector_index_entries").values({ ...row, build_id: retired }).execute();
  const otherConfig = { ...f.service.config.current, embedding: { ...f.service.config.current.embedding, model: "retained-model" } };
  const otherProfile = await f.service.repository.profile(otherConfig), otherBuild = randomUUID();
  await f.db.insertInto("search_index_builds").values({ ...oldBuild, id: otherBuild, profile_id: otherProfile }).execute();
  await f.db.insertInto("vector_snapshot_state").values({ profile_id: otherProfile, build_id: otherBuild, mode: "f32", updated_at: Date.now() }).execute();
  const restarted = new api.EmbeddingService(f.db, "file:///fixture/");
  f.beforeClose(() => restarted.close()); await restarted.start(false);
  const builds = await f.db.selectFrom("search_index_builds").select("id").execute();
  assert.deepEqual(new Set(builds.map(row => row.id)), new Set([active.id, otherBuild]));
  assert.deepEqual(await labels(f.db), previousLabels);
  assert.equal((await f.db.selectFrom("vector_snapshot_state").select("build_id").where("profile_id", "=", otherProfile).executeTakeFirstOrThrow()).build_id, otherBuild);
});
