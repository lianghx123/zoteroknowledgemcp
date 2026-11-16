import assert from "node:assert/strict";
import { test } from "node:test";
import { api, parsingFixture, result, bytes } from "./fixtures/parsing.mjs";

test("all configured built-in parsers have peer implementations and enforce their normalizers", async t => {
  await parsingFixture(t);
  const registry = new api.ParserRegistry();
  for (const [id, definition] of api.parserCatalog) {
    const identity = api.parserIdentity(api.defaultParserProfile(id), id), parser = registry.resolve(identity);
    assert.equal(parser.id, id); assert.ok(parser.normalizers.includes(definition.normalizer));
    assert.throws(() => registry.resolve({ ...identity, normalizer: "unsupported-schema" }), error => error.code === "format");
    assert.throws(() => registry.register(parser), error => error.code === "config");
  }
  assert.throws(() => registry.resolve({ provider: "missing", normalizer: "unknown" }), error => error.code === "format");
});

test("another parser completes its own stages and reaches the same structured publication without worker changes", async t => {
  const f = await parsingFixture(t);
  const definition = { ...api.parserCatalog.get("mineru"), id: "fixture-parser", adapterKey: "fixture-protocol", normalizer: "fixture-v1", models: undefined };
  api.parserCatalog.set(definition.id, definition); t.after(() => api.parserCatalog.delete(definition.id));
  const document = { ...api.parsePaddleResult(result()), normalizerVersion: definition.normalizer }, stages = [];
  f.parsers.register({ id: definition.id, normalizers: [definition.normalizer], async process(context) {
    if (!context.remoteID) {
      stages.push("submit"); await context.submit(async () => ({ remoteID: "fixture-accepted" })); return;
    }
    stages.push("retrieve-normalize-assets");
    assert.equal(context.remoteID, "fixture-accepted");
    await context.reportProgress({ state: "done", completed: 1, total: 1 });
    await context.stage("raw.json", bytes('{"synthetic":true}'), "application/json", "raw");
    return { document, producerVersion: "fixture-producer", resultSchema: "fixture-document" };
  } });
  const profile = { ...api.defaultParserProfile(definition.id), key: "fixture-key" };
  f.config.current = api.validateParsingConfig({ ...f.config.current, activeProfile: definition.id, profiles: { [definition.id]: profile }, parserProfiles: { [definition.id]: definition.id } });
  f.input.parser = api.parserIdentity(profile, definition.id);
  const id = await f.enqueue(); await f.step(); await f.step();
  const job = await f.job(id); assert.equal(job.state, "succeeded");
  assert.deepEqual(stages, ["submit", "retrieve-normalize-assets"]);
  assert.equal((await f.repository.run(job)).parser_version, "fixture-producer");
  assert.equal((await f.db.selectFrom("content_blocks").selectAll().where("generation_id", "=", job.generation_id).execute()).length, document.blocks.length);
  assert.equal((await f.db.selectFrom("generation_files").selectAll().where("generation_id", "=", job.generation_id).execute()).length, 3);
  assert.equal(f.submissions, 0);
});

test("a parser cannot submit twice in one claim or replace a confirmed remote identity", async t => {
  const f = await parsingFixture(t); let submissions = 0;
  f.parsers.resolve(f.input.parser).process = async context => {
    await context.submit(async () => { submissions++; return { remoteID: "original-accepted" }; });
    await context.submit(async () => { submissions++; return { remoteID: "duplicate" }; });
  };
  const id = await f.enqueue(); await f.step();
  assert.equal(submissions, 1); assert.equal((await f.job(id)).state, "failed");
  assert.equal((await f.repository.run(await f.job(id))).external_job_id, "original-accepted");
});
