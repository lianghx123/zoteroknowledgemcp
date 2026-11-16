import assert from "node:assert/strict";
import { test } from "node:test";
import { api, parsingFixture } from "./fixtures/parsing.mjs";

test("an idle vector tick keeps polling for work without reprojecting tasks or rewriting the index", async t => {
  const f = await parsingFixture(t), service = new api.EmbeddingService(f.db, "file:///fixture/");
  f.beforeClose(() => service.close()); service.config.current = { ...service.config.current, enabled: true };
  service.credentials.get = () => "fixture-key"; const calls = { text: 0, index: 0, tasks: 0, network: 0 };
  service.repository.projectFulltext = async () => { calls.text++; };
  service.store.sync = async () => { calls.index++; service.store.status = "ready"; };
  service.refreshTasks = async () => { calls.tasks++; };
  service.gateway.embed = async () => { calls.network++; assert.fail("idle tick must not call a model"); };
  await service.tick(); assert.deepEqual(calls, { text: 1, index: 1, tasks: 1, network: 0 });
  await service.tick(); await service.tick(); assert.deepEqual(calls, { text: 1, index: 1, tasks: 1, network: 0 });
  await f.repo.create("Another knowledge library"); await service.tick();
  assert.deepEqual(calls, { text: 2, index: 2, tasks: 2, network: 0 }, "new durable events still refresh the projection");
  service.config.current = { ...service.config.current, revision: service.config.current.revision + 1 };
  await service.tick(); assert.deepEqual(calls, { text: 2, index: 3, tasks: 3, network: 0 }, "new configuration is applied without waiting for a content event");
});

test("an unchanged vector task projection does not publish notifications", async t => {
  const f = await parsingFixture(t), service = new api.EmbeddingService(f.db, "file:///fixture/");
  f.beforeClose(() => service.close()); let updates = 0; service.subscribe(() => { updates++; });
  await service.refresh(); await service.refresh(); assert.equal(updates, 0);
});
