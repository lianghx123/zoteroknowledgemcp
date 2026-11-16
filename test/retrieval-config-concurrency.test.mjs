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
  const f = await parsingFixture(t), changes = [];
  const config = new api.RetrievalConfigFile(previous => changes.push(previous));
  f.beforeClose(() => config.close());
  await config.save(config.current);
  changes.length = 0;
  return { ...f, config, changes };
}

for (const oldRead of ["valid", "invalid", "failed"]) test(`an obsolete ${oldRead} reload cannot replace a newer same-revision configuration or its read status`, async t => {
  const { config, changes } = await fixture(t), started = deferred(), finish = deferred();
  const initial = config.current, read = IOUtils.readUTF8;
  if (oldRead === "invalid") await IOUtils.writeUTF8(config.path, "invalid-old-json");
  let held = false;
  IOUtils.readUTF8 = async (...args) => {
    const text = await read(...args);
    if (args[0] === config.path && !held) {
      held = true; started.resolve(); await finish.promise;
      if (oldRead === "failed") throw Error("obsolete-read-failure");
    }
    return text;
  };
  let obsolete;
  try {
    obsolete = config.reload(); await started.promise;
    await IOUtils.writeUTF8(config.path, JSON.stringify({ ...initial, dimensions: 512 }));
    await config.reload();
    assert.equal(config.current.dimensions, 512); assert.equal(config.current.revision, initial.revision);
    finish.resolve(); await obsolete;
    assert.equal(config.current.dimensions, 512); assert.equal(config.error, false); assert.equal(changes.length, 1);
  } finally { finish.resolve(); IOUtils.readUTF8 = read; await obsolete; }
});

for (const timing of ["before", "during"]) test(`publication fences a reload started ${timing} its write without requiring another reload`, async t => {
  const { config } = await fixture(t), readStarted = deferred(), finishRead = deferred(), writeStarted = deferred(), finishWrite = deferred();
  const read = IOUtils.readUTF8, write = IOUtils.writeUTF8;
  let holdRead = timing === "before", held = false, reading, saving;
  IOUtils.readUTF8 = async (...args) => {
    const text = await read(...args);
    if (args[0] === config.path && holdRead && !held) { held = true; readStarted.resolve(); await finishRead.promise; }
    return text;
  };
  IOUtils.writeUTF8 = async (...args) => {
    if (args[0] === config.path && timing === "during") { writeStarted.resolve(); await finishWrite.promise; }
    return write(...args);
  };
  try {
    if (timing === "before") { reading = config.reload(); await readStarted.promise; }
    saving = config.save({ ...config.current, dimensions: 512 }, "keep");
    if (timing === "during") { await writeStarted.promise; holdRead = true; reading = config.reload(); await readStarted.promise; finishWrite.resolve(); }
    await saving; assert.equal(config.current.dimensions, 512);
    finishRead.resolve(); await reading;
    assert.equal(config.current.dimensions, 512); assert.equal(config.error, false);
  } finally { finishRead.resolve(); finishWrite.resolve(); IOUtils.readUTF8 = read; IOUtils.writeUTF8 = write; await Promise.allSettled([reading, saving]); }
});

test("queued saves on the same instance reject the stale draft after the first publication", async t => {
  const { config } = await fixture(t), started = deferred(), finish = deferred();
  const first = config.save({ ...config.current, results: 15 }, undefined, undefined, async () => { started.resolve(); await finish.promise; return async () => {}; });
  let second;
  try {
    await started.promise;
    second = assert.rejects(config.save({ ...config.current, results: 10 }), /config-conflict/);
    finish.resolve(); await first; await second;
    assert.equal(config.current.results, 15); assert.equal(JSON.parse(await IOUtils.readUTF8(config.path)).results, 15);
  } finally { finish.resolve(); await Promise.allSettled([first, second]); }
});

test("close drains every accepted save even if a poll finishes while the write remains pending", async t => {
  const { config, changes } = await fixture(t), started = deferred(), finish = deferred();
  const saving = config.save({ ...config.current, results: 15 }, undefined, undefined, async () => { started.resolve(); await finish.promise; return async () => {}; });
  let closing;
  try {
    await started.promise; await config.reload();
    let closed = false; closing = config.close().then(() => { closed = true; });
    await settle(); assert.equal(closed, false);
    finish.resolve(); await saving; await closing;
    assert.equal(JSON.parse(await IOUtils.readUTF8(config.path)).results, 15);
    assert.equal(changes.length, 0, "closed owners do not notify their detached views");
    await assert.rejects(config.save(config.current), /config/); await assert.rejects(config.start(), /config/);
  } finally { finish.resolve(); await Promise.allSettled([saving, closing]); }
});

test("close drains direct reads and prevents their late result from updating a closed owner", async t => {
  const { config, changes } = await fixture(t), started = deferred(), finish = deferred(), read = IOUtils.readUTF8;
  await IOUtils.writeUTF8(config.path, JSON.stringify({ ...config.current, dimensions: 512 }));
  IOUtils.readUTF8 = async (...args) => { const text = await read(...args); if (args[0] === config.path) { started.resolve(); await finish.promise; } return text; };
  let reading, closing;
  try {
    reading = config.reload(); await started.promise;
    let closed = false; closing = config.close().then(() => { closed = true; }); await settle(); assert.equal(closed, false);
    finish.resolve(); await reading; await closing;
    assert.equal(config.current.dimensions, 768); assert.equal(changes.length, 0); assert.equal(config.error, false);
  } finally { finish.resolve(); IOUtils.readUTF8 = read; await Promise.allSettled([reading, closing]); }
});

test("a missing observed file reports a read error and recovers when valid content returns", async t => {
  const { config } = await fixture(t), text = await IOUtils.readUTF8(config.path);
  await IOUtils.remove(config.path); await config.reload(); assert.equal(config.error, true);
  await IOUtils.writeUTF8(config.path, text); await config.reload(); assert.equal(config.error, false);
});
