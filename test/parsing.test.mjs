import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { api, parsingFixture, page, result, bytes } from "./fixtures/parsing.mjs";

test("merged reference blocks publish bibliography records with exact source anchors and rollback together", async t => {
  const source = page();
  source.prunedResult.parsing_res_list.push(
    { block_label: "reference_content", block_content: "[1] First reference.\nTranslated title.", block_id: 2, block_bbox: [10, 200, 500, 250] },
    { block_label: "reference_content", block_content: "Unnumbered reference or continuation.", block_id: 3, block_bbox: [10, 260, 500, 310] },
  );
  const f = await parsingFixture(t, { download: async () => bytes(result([source])) });
  const first = await f.enqueue(); await f.step(); await f.step();
  const generation = (await f.job(first)).generation_id;
  const originalReferences = f.native.sqlite.prepare("SELECT * FROM resource_references ORDER BY id").all();
  const rows = await f.db.selectFrom("resource_references as r").innerJoin("content_blocks as b", "b.id", "r.source_block_id")
    .selectAll("r").select(["b.locations_json", "b.canonical_order"]).orderBy("b.canonical_order").execute();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_text, source.prunedResult.parsing_res_list.slice(2).map(block => block.block_content).join(" ").replace(/^\[1\] /, ""));
  assert.equal(rows[0].reference_number, 1);
  assert.deepEqual(JSON.parse(rows[0].locations_json).map(location => location.bbox), source.prunedResult.parsing_res_list.slice(2).map(block => block.block_bbox));
  for (const row of rows) {
    assert.equal(row.resource_id, f.input.resourceID); assert.equal(row.source_id, f.input.sourceID);
    assert.equal(row.generation_id, generation); assert.equal(row.reference_type, "bibliography");
    assert.equal(row.target_resource_id, null); assert.equal(row.match_status, "unmatched");
    assert.equal(row.confidence, null); assert.equal(row.parsed_json, "{}");
    assert.deepEqual(JSON.parse(row.locations_json)[0].bbox, source.prunedResult.parsing_res_list[row.canonical_order].block_bbox);
  }
  await f.enqueue(true); await f.step();
  f.native.options.fail = statement => statement.startsWith('update "resource_sources" set "active_generation_id"');
  await f.step();
  assert.deepEqual(f.native.sqlite.prepare("SELECT * FROM resource_references ORDER BY id").all(), originalReferences);
  assert.equal((await f.repository.sourceFor(1, "PDFKEY01")).active_generation_id, generation);
  f.native.options.fail = undefined;
  await f.enqueue(true); await f.step(); await f.step();
  assert.equal((await f.db.selectFrom("resource_references").selectAll().execute()).length, 2);
});

test("durable progress distinguishes service queue, page extraction, result retrieval and atomic publication", async t => {
  const f = await parsingFixture(t), id = await f.enqueue();
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers); f.beforeClose(() => service.close());
  const observations = [];
  f.worker.changed = async () => {
    await service.refresh();
    observations.push(structuredClone(service.snapshot().find(task => task.id === id)));
  };
  await f.step();
  const first = JSON.parse((await f.job(id)).checkpoint_json);
  assert.equal(first.extractionPhase, "remote-queue"); assert.ok(first.phaseStartedAt > 0);
  f.provider.progress = async () => ({ state: "pending" }); await f.step();
  assert.equal(JSON.parse((await f.job(id)).checkpoint_json).phaseStartedAt, first.phaseStartedAt);
  f.provider.progress = async () => ({ state: "running", completed: 12 }); await f.step(); await service.refresh();
  assert.equal(service.snapshot()[0].pages.completed, 12); assert.equal(service.snapshot()[0].pages.total, undefined);
  assert.equal(service.snapshot()[0].extraction.phase, "parsing");
  // The accepted remote job can now finish; the page count is not save progress.
  f.provider.progress = async () => ({ state: "done", completed: 1, total: 1, resultURL: "https://results.example/result.jsonl" });
  await f.step(); await service.refresh();
  for (const phase of ["downloading", "organizing", "saving"]) {
    const task = observations.find(task => task.extraction.phase === phase); assert.ok(task, phase);
    assert.equal(task.processing.generationID, null, `${phase}: content is not published yet`);
    assert.notEqual(task.status, "completed");
  }
  assert.equal(service.snapshot()[0].status, "completed"); assert.ok(service.snapshot()[0].processing.generationID);
  assert.equal(f.submissions, 1);
});

test("local capacity waits persist their start time and old checkpoints keep count-only progress", async t => {
  const f = await parsingFixture(t), id = await f.enqueue();
  f.repository.reserveSubmission = async () => false;
  await f.step(); const first = JSON.parse((await f.job(id)).checkpoint_json);
  assert.equal(first.extractionPhase, "local-queue"); assert.equal(f.submissions, 0);
  await f.step(); assert.equal(JSON.parse((await f.job(id)).checkpoint_json).phaseStartedAt, first.phaseStartedAt);
  await f.db.updateTable("processing_jobs").set({ checkpoint_json: JSON.stringify({ phase: "poll" }) }).where("id", "=", id).execute();
  await f.db.updateTable("parse_runs").set({ external_job_id: "restored-remote", submission_state: "confirmed", progress_current: 7, progress_total: null }).where("job_id", "=", id).execute();
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers); f.beforeClose(() => service.close()); await service.refresh();
  const task = service.snapshot()[0]; assert.equal(task.extraction.phase, "parsing"); assert.equal(task.pages.completed, 7); assert.equal(task.pages.total, undefined);
  assert.equal(task.extraction.startedAt, undefined, "old records do not invent remote waiting times");
});

for (const claimed of [false, true]) test(`returning to earlier PDF bytes replaces a stale ${claimed ? "claimed" : "queued"} attempt`, async t => {
  const f = await parsingFixture(t), original = (await f.port.attachment()).bytes;
  const first = await f.enqueue();
  const lease = claimed ? await f.repository.claim(f.worker.owner) : undefined;
  f.setBytes(bytes("%PDF-1.7\nChanged attachment")); await f.enqueue();
  f.setBytes(original);
  const latest = await f.enqueue();
  assert.notEqual(latest, first);
  assert.equal((await f.job(first)).state, "cancelled");
  if (lease) await assert.rejects(f.repository.publish(lease, api.parsePaddleResult(result()), []), error => error instanceof api.LeaseLost);
  for (let count = 0; count < 5 && (await f.job(latest)).state !== "succeeded"; count++) await f.step();
  assert.equal((await f.job(latest)).state, "succeeded");
});

test("an earlier ready generation cannot deduplicate admission after the PDF fingerprint changes", async t => {
  const f = await parsingFixture(t), original = (await f.port.attachment()).bytes;
  const first = await f.enqueue(); await f.step(); await f.step();
  f.setBytes(bytes("%PDF-1.7\nChanged attachment")); await f.enqueue(); f.setBytes(original);
  const latest = await f.enqueue(); assert.notEqual(latest, first);
  for (let count = 0; count < 5 && (await f.job(latest)).state !== "succeeded"; count++) await f.step();
  assert.equal((await f.job(latest)).state, "succeeded");
});

test("background admission reuses the active publication instead of invalidated competing history", async t => {
  const f = await parsingFixture(t), first = await f.enqueue();
  const other = { ...structuredClone(f.input), parser: { ...f.input.parser, model: "Alternative model" } };
  const fingerprint = await f.port.hash((await f.port.attachment()).bytes);
  const old = await f.repository.enqueue(other, fingerprint, 3);
  const claimed = await f.repository.claim(f.worker.owner);
  assert.equal(claimed.id, first);
  await f.repository.publish(claimed, api.parsePaddleResult(result()), []);
  assert.equal((await f.job(first)).state, "succeeded");
  await f.step(); assert.equal((await f.job(old)).state, "cancelled");
  const latest = await f.repository.enqueue(other, fingerprint, 3, false, true);
  assert.notEqual(latest, old);
  assert.equal(latest, first);
  assert.equal((await f.repository.list()).length, 2);
  const explicit = await f.repository.enqueue(other, fingerprint, 3, true);
  assert.equal((await f.job(explicit)).expected_content_version, 1);
});

for (const asynchronous of [false, true]) test(`${asynchronous ? "async" : "sync"} task view refresh failure cannot fabricate an ambiguous upload`, async t => {
  const f = await parsingFixture(t), id = await f.enqueue();
  const changed = () => { if (asynchronous) return Promise.reject(Error("Detached task view")); throw Error("Detached task view"); };
  const worker = new api.ParseWorker(f.repository, f.config, f.port, f.parsers, changed);
  worker.stopped = false; f.beforeClose(() => worker.close());
  await worker.tick(); await Promise.all([...worker.executions.values()].map(execution => execution.promise));
  assert.equal(f.submissions, 1); assert.equal((await f.job(id)).state, "waiting");
  const confirmed = await f.repository.run(await f.job(id)); assert.equal(confirmed.submission_state, "confirmed");
});

test("readmission retries a stale cancellation while unchanged user cancellations stay suppressed", async t => {
  const f = await parsingFixture(t), id = await f.enqueue();
  await f.repo.remove(f.input.resourceID, f.target); await f.step();
  assert.equal((await f.job(id)).error_code, "stale");
  await f.repo.save(f.item, f.target);
  const fingerprint = await f.port.hash((await f.port.attachment()).bytes);
  const retry = await f.repository.enqueue(f.input, fingerprint, 3, false, true);
  assert.notEqual(retry, id);
  await f.repository.cancel(retry);
  assert.equal(await f.repository.enqueue(f.input, fingerprint, 3, false, true), retry);
});

test("background admission retains the current partial publication without uploading again", async t => {
  const f = await parsingFixture(t, { progress: async () => ({ state: "done", completed: 1, total: 2, resultURL: "https://result.example/partial" }) });
  const id = await f.enqueue(); await f.step(); await f.step();
  assert.equal((await f.job(id)).state, "partially_succeeded");
  assert.equal(await f.repository.enqueue(f.input, await f.port.hash((await f.port.attachment()).bytes), 3, false, true), id);
  assert.equal(f.submissions, 1);
});

test("the scheduler and HTTP transport work without a bootstrap-global AbortController", async t => {
  const f = await parsingFixture(t), id = await f.enqueue();
  const NativeAbortController = globalThis.AbortController;
  const window = { AbortController: NativeAbortController, Headers,
    fetch: async (_url, init) => {
      assert.ok(init.signal instanceof AbortSignal);
      return new Response("{}", { status: 200 });
    } };
  Zotero.getMainWindows = () => [window];
  const previousComponents = globalThis.Components, previousChromeUtils = globalThis.ChromeUtils;
  globalThis.Components = { utils: { getGlobalForObject: () => ({ ...window, Promise }) } };
  globalThis.ChromeUtils = { importESModule: () => ({ setTimeout, clearTimeout }) };
  globalThis.AbortController = undefined;
  try {
    await f.worker.tick();
    await Promise.all([...f.worker.executions.values()].map(execution => execution.promise));
    assert.equal(f.submissions, 1);
    assert.equal((await f.job(id)).state, "waiting");
    assert.equal((await f.repository.run(await f.job(id))).external_job_id, "remote-1");
    const response = await new api.BrowserParseTransport().request("https://ocr.example/jobs", { method: "GET" }, 1000, 1024, new NativeAbortController().signal);
    assert.equal(new TextDecoder().decode(response.bytes), "{}");
  } finally { globalThis.AbortController = NativeAbortController;
    if (previousComponents === undefined) delete globalThis.Components; else globalThis.Components = previousComponents;
    if (previousChromeUtils === undefined) delete globalThis.ChromeUtils; else globalThis.ChromeUtils = previousChromeUtils;
    await f.worker.close(); }
});

test("controller setup failure leaves pending work unclaimed", async t => {
  const f = await parsingFixture(t), id = await f.enqueue();
  Zotero.getMainWindows = () => [{ AbortController: class { constructor() { throw Error("Window unavailable"); } } }];
  await f.worker.tick(); await f.worker.close();
  const job = await f.job(id);
  assert.equal(job.state, "pending"); assert.equal(job.attempt_count, 0); assert.equal(job.lease_owner, null);
});

test("PaddleOCR config validates API/model/key and retains the last valid hot reload", async t => {
  const f = await parsingFixture(t); let changed = 0;
  const config = new api.ParsingConfigFile(() => changed++); t.after(() => config.close());
  await config.start(); assert.equal(config.current.enabled, false);
  const valid = structuredClone(f.config.current);
  f.files.set(config.path, bytes(JSON.stringify(valid))); await config.reload();
  assert.equal(config.current.profiles.paddleocr.model, "PaddleOCR-VL-1.6"); assert.equal(changed, 2);
  f.files.set(config.path, bytes("{invalid")); await config.reload();
  assert.equal(config.error, true); assert.equal(config.current.enabled, true);
  f.files.set(config.path, bytes(JSON.stringify(valid))); await config.reload(); assert.equal(config.error, false);
  valid.profiles.paddleocr.key = "rotated-key"; f.files.set(config.path, bytes(JSON.stringify(valid))); await config.reload();
  assert.equal(config.credential(f.input.parser), "rotated-key");
  valid.profiles.paddleocr.api = "https://other.example/jobs"; f.files.set(config.path, bytes(JSON.stringify(valid))); await config.reload();
  assert.throws(() => config.credential(f.input.parser), error => error.code === "credentials");
  for (const value of [{ ...valid, concurrency: 0 }, { ...valid, profiles: { paddleocr: { ...valid.profiles.paddleocr, api: "http://unsafe.example/jobs" } } }]) {
    assert.throws(() => api.validateParsingConfig(value), error => error.code === "config");
  }
  assert.deepEqual(JSON.parse(readFileSync(new URL("./fixtures/parsing.example.json", import.meta.url), "utf8")), api.defaultParsingConfig);
});

test("job provider uses official multipart fields, encodes IDs and never sends keys to artifacts", async () => {
  const calls = [], profile = { profile: "paddleocr", api: "https://ocr.example/jobs", model: "PaddleOCR-VL-1.6", options: { mergeTables: true }, normalizer: "1" };
  const transport = {
    multipart: (model, options, data, name) => ({ model, optionalPayload: JSON.stringify(options), data, name }),
    async request(url, init, timeout, maxBytes, signal) {
      calls.push({ url, init, timeout, maxBytes, signal });
      const value = init.method === "POST" ? { data: { jobId: "id/1" } } : url.includes("id%2F1")
        ? { code: 0, data: { state: "done", extractProgress: { extractedPages: 1, totalPages: 1 }, resultUrl: { jsonUrl: "https://cdn.example/result" } } }
        : { result: true };
      return { bytes: bytes(JSON.stringify(value)), headers: new Headers() };
    },
  };
  const provider = new api.PaddleOCRProvider(transport), signal = new AbortController().signal;
  const id = await provider.submit(profile, "secret", bytes("%PDF-"), "fixture.pdf", 1000, signal);
  assert.equal(calls[0].init.body.model, profile.model); assert.equal(calls[0].init.body.optionalPayload, '{"mergeTables":true}');
  const progress = await provider.progress(profile, "secret", id, 1000, signal);
  await provider.download(progress.resultURL, 1000, 1024, signal);
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret"); assert.equal(calls[2].init.headers, undefined);
  assert.match(calls[1].url, /id%2F1$/); assert.throws(() => api.resultURL("file:///private.pdf"));
});

test("JSONL preserves ordered blocks, table text, page coordinates and partial page gaps", () => {
  const first = page(), last = page("Later section");
  first.prunedResult.parsing_res_list.push({ block_label: "table", block_content: "<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>" });
  const text = [result([first]), JSON.stringify({ errorCode: 500, pageCount: 2 }), result([last])].join("\n");
  const document = api.parsePaddleResult(text, 4);
  assert.equal(document.partial, true); assert.deepEqual(document.pages.map(page => page.number), [1, 4]);
  assert.equal(document.blocks.at(-1).page, 4); assert.match(document.markdown, /<table border=1/);
  assert.deepEqual(document.blocks[0].bbox, [10, 20, 500, 60]);
  assert.throws(() => api.parsePaddleResult([result(), '{"errorCode":500}', '{"errorCode":500}'].join("\n"), 4), error => error.code === "page-positions");
  assert.throws(() => api.parsePaddleResult("not json"), error => error.code === "format");
  assert.throws(() => api.parsePaddleResult('{"result":{"layoutParsingResults":[]}}'), error => error.code === "empty");
});

test("queue deduplicates live input, fences claims and recovers abandoned leases", async t => {
  const f = await parsingFixture(t), id = await f.enqueue();
  assert.equal(await f.enqueue(), id);
  const first = await f.repository.claim("first"); assert.equal(first.id, id); assert.equal(await f.repository.claim("other"), undefined);
  await f.db.updateTable("processing_jobs").set({ lease_expires_at: 1 }).where("id", "=", id).execute();
  await f.repository.recover(); const next = await f.repository.claim("second");
  assert.notEqual(next.execution_token, first.execution_token);
  await assert.rejects(f.repository.finish(first, "succeeded"), error => error instanceof api.LeaseLost);
  await f.repository.finish(next, "waiting", null, 5000);
  assert.equal(await f.repository.claim("early"), undefined);
  assert.equal((await f.job(id)).failure_count, 1);
});

test("PDF processing submits once, releases remote waits and atomically publishes structured content", async t => {
  const f = await parsingFixture(t), id = await f.enqueue();
  await f.step(); let job = await f.job(id);
  assert.equal(job.state, "waiting"); assert.equal(job.execution_token, null); assert.equal(f.submissions, 1);
  await f.step(); job = await f.job(id);
  assert.equal(job.state, "succeeded"); assert.equal(f.submissions, 1); assert.equal(f.polls, 1);
  const content = await new api.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" });
  assert.match(content.markdown, /# A synthetic paper/); assert.equal(content.origin, "parse");
  const blocks = await f.db.selectFrom("content_blocks").selectAll().execute();
  assert.equal(blocks.length, 2); assert.equal(blocks[0].page_start, 1); assert.ok(blocks[0].structure_node_id);
  const jobs = await f.repository.list(); assert.equal(jobs.length, 1); assert.equal(await f.enqueue(), id);
  assert.equal((await f.db.selectFrom("block_embeddings").selectAll().execute()).length, 0);
  const storedProfiles = (await f.db.selectFrom("provider_profiles").selectAll().execute()).map(row => [row.config_json, row.credential_ref, row.endpoint_url]);
  assert.ok(!JSON.stringify(storedProfiles).includes("private-key")); assert.ok(!job.payload_json.includes("private-key"));
  assert.equal([...f.files.keys()].filter(path => path.endsWith("manifest.json")).length, 0);
});

test("restarting the worker resumes a confirmed server task without a second upload", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(); await f.step(); await f.worker.close();
  const next = new api.ParseWorker(f.repository, f.config, f.port, f.parsers, async () => {}); next.stopped = false;
  await f.db.updateTable("processing_jobs").set({ next_run_at: 0 }).where("id", "=", id).execute();
  const claimed = await f.repository.claim(next.owner); await next.execute(claimed, new AbortController());
  assert.equal(f.submissions, 1); assert.equal((await f.job(id)).state, "succeeded");
  await next.close();
});

test("ambiguous submissions need attention and can link a known remote task without reupload", async t => {
  const f = await parsingFixture(t, { submit: async () => { throw new api.ParseError("network", true); } }), id = await f.enqueue();
  await f.step(); assert.equal((await f.job(id)).state, "needs_attention"); assert.equal((await f.job(id)).error_code, "ambiguous");
  await assert.rejects(f.repository.resume(id, 10000), error => error.code === "ambiguous");
  await f.repository.attachRemote(id, "known-remote"); await f.step();
  assert.equal((await f.job(id)).state, "succeeded");
});

test("remote concurrency counts submissions independently from local worker slots", async t => {
  const f = await parsingFixture(t), first = await f.enqueue(); await f.step();
  // A changed parser profile creates another distinct job for the same source.
  f.input.parser = { ...f.input.parser, model: "Another configured model" };
  f.config.current.profiles.paddleocr.model = "Another configured model";
  const second = await f.enqueue();
  f.config.current.remoteConcurrency = 1;
  const claimed = await f.repository.claim(f.worker.owner); assert.equal(claimed.id, second);
  await f.worker.execute(claimed, new AbortController());
  assert.equal((await f.job(first)).state, "waiting"); assert.equal((await f.job(second)).state, "waiting"); assert.equal(f.submissions, 1);
});

test("cancellation and attachment replacement prevent a late result from being published", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(); await f.step();
  f.setBytes(bytes("%PDF-1.7\nReplaced file")); await f.step();
  assert.equal((await f.job(id)).state, "cancelled"); assert.equal((await f.db.selectFrom("content_generations").selectAll().execute()).length, 0);
  const second = await f.enqueue(); const claim = await f.repository.claim(f.worker.owner); await f.repository.cancel(second);
  await assert.rejects(f.repository.publish(claim, api.parsePaddleResult(result()), []), error => error instanceof api.LeaseLost);
});

test("a failed reparse retains the old readable generation and uncommitted files are cleaned", async t => {
  const f = await parsingFixture(t), first = await f.enqueue(); await f.step(); await f.step();
  const previous = (await f.job(first)).generation_id;
  const second = await f.enqueue(true); await f.step();
  f.provider.download = async () => bytes("malformed result"); await f.step();
  assert.equal((await f.job(second)).state, "failed");
  const source = await f.db.selectFrom("resource_sources").selectAll().where("id", "=", f.input.sourceID).executeTakeFirstOrThrow();
  assert.equal(source.active_generation_id, previous);
  assert.match((await new api.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" })).markdown, /Synthetic document body/);
});

test("partial results publish usable pages and preserve missing page warnings", async t => {
  const f = await parsingFixture(t, { progress: async () => ({ state: "done", completed: 1, total: 2, resultURL: "https://result.example/a" }),
    download: async () => bytes([result(), '{"errorCode":500,"pageCount":1}'].join("\n")) });
  const id = await f.enqueue(); await f.step(); await f.step();
  assert.equal((await f.job(id)).state, "partially_succeeded");
  const content = await new api.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" }); assert.equal(content.partial, true);
});

test("result images use managed local paths and recover orphan manifests without deleting published files", async t => {
  const f = await parsingFixture(t);
  const manifest = api.parseFilePath("parse/job/token/manifest.json"), orphan = api.parseFilePath("parse/job/token/0.bin"), retained = api.parseFilePath("parse/job/token/1.bin");
  f.files.set(manifest, bytes("{}")); f.files.set(orphan, bytes("orphan")); f.files.set(retained, bytes("published"));
  await api.recoverParseFiles(f.port, new Set(["parse/job/token/1.bin"]));
  assert.equal(f.files.has(orphan), false); assert.equal(f.files.has(retained), true); assert.equal(f.files.has(manifest), false);
  for (const path of ["../private", "parse/job/token/../a", "parse/job/token/a.svg"]) assert.throws(() => api.parseFilePath(path));
  assert.equal(api.imageType(Uint8Array.from([137, 80, 78, 71])).mediaType, "image/png");
  assert.throws(() => api.imageType(bytes("<svg onload=alert(1)>")), error => error.code === "image-format");
});

test("queued work adopts hot-reloaded model settings before upload while confirmed work keeps its identity", async t => {
  const f = await parsingFixture(t), id = await f.enqueue();
  f.config.current.profiles.paddleocr.model = "Configured replacement model";
  await f.step(); const submitted = await f.job(id);
  assert.equal(JSON.parse(submitted.payload_json).parser.model, "Configured replacement model");
  assert.equal((await f.repository.run(submitted)).parser_name, "Configured replacement model");
  f.config.current.profiles.paddleocr.model = "Another model"; await f.step();
  assert.equal(JSON.parse((await f.job(id)).payload_json).parser.model, "Configured replacement model");
  assert.equal((await f.job(id)).state, "succeeded");
});

test("an expired submitting lease stays ambiguous even when its crash budget is exhausted", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(), claim = await f.repository.claim("abandoned");
  await f.repository.reserveSubmission(claim, 2);
  await f.db.updateTable("processing_jobs").set({ lease_expires_at: 1, failure_count: 3 }).where("id", "=", id).execute();
  await f.repository.recover();
  assert.equal((await f.job(id)).state, "needs_attention"); assert.equal((await f.job(id)).error_code, "ambiguous");
  assert.equal(await f.repository.claim("next"), undefined);
});

test("publication failure removes staged files and rolls back the content switch", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(); await f.step();
  const publish = f.repository.publish.bind(f.repository);
  f.repository.publish = async (...args) => {
    f.native.options.fail = sql => /^insert into "change_outbox"/i.test(sql);
    try { return await publish(...args); } finally { f.native.options.fail = undefined; }
  };
  await f.step();
  assert.equal((await f.job(id)).state, "failed");
  assert.equal((await f.db.selectFrom("content_generations").selectAll().execute()).length, 0);
  assert.equal([...f.files.keys()].filter(path => path.includes("/parse/")).length, 0);
});

test("scheduler shutdown aborts execution and leaves a recoverable task without live timers", async t => {
  const f = await parsingFixture(t), id = await f.enqueue();
  let entered; const started = new Promise(resolve => { entered = resolve; });
  f.provider.submit = async (_parser, _key, _bytes, _name, _timeout, signal) => {
    entered(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
  };
  await f.worker.start(); await started; await f.worker.close();
  assert.equal((await f.job(id)).state, "needs_attention"); assert.equal((await f.job(id)).error_code, "ambiguous"); assert.equal(f.worker.executions.size, 0);
  assert.equal((await f.repository.run(await f.job(id))).submission_state, "submitting");
});

test("content publication updates native title markers and detail status without changing titles", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(); await f.step(); await f.step();
  const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close());
  const snapshot = await f.repo.snapshot(), doc = dom.window.document;
  const view = { _renderCell() { const cell = doc.createElement("div"), text = doc.createElement("span"); text.className = "cell-text"; text.textContent = "Original title"; cell.append(text); return cell; },
    getRow: () => ({ isObjectRow: true, ref: { id: 10 } }), tree: { invalidate() {} } };
  const window = { document: doc, ZoteroPane: { itemsView: view } }, controller = { snapshot };
  const title = new api.KnowledgeTitleStatus(window, controller); t.after(() => title.dispose());
  let cell = view._renderCell(0, 0, { dataKey: "title" });
  assert.equal(cell.querySelector(".km-knowledge-status").textContent, "●");
  assert.equal(cell.querySelector(".cell-text").textContent, "Original title");
  assert.match(cell.querySelector(".cell-text").getAttribute("aria-label"), /parsed/);
  assert.match(api.renderKnowledgeDetails(doc, snapshot, { id: 10 }).content.textContent, /Added — parsed/);
  assert.deepEqual(snapshot.sources[0].parser, { provider: "paddleocr", model: "PaddleOCR-VL-1.6" });
  assert.match(api.renderKnowledgeDetails(doc, snapshot, { id: 10 }).content.querySelector(".km-knowledge-parser").textContent, /PaddleOCR · PaddleOCR-VL-1.6/);
  snapshot.sources.push({ ...snapshot.sources[0], id: "second-source", contentState: undefined });
  cell = view._renderCell(0, 0, { dataKey: "title" }); assert.equal(cell.querySelector(".km-knowledge-status").textContent, "◐");
  assert.equal((await f.job(id)).state, "succeeded");
});

test("reader chooses the latest saved text while preserving a manual import on database read failure", async () => {
  const identity = { libraryID: 1, itemKey: "PDFKEY01" }, manual = { formatVersion: 1, attachment: identity, markdown: "Manual text", origin: "import", updatedAt: 2 };
  const service = new api.ContentReadService({ read: async () => manual, save: async () => {} });
  service.setProcessedReader(async () => ({ ...manual, markdown: "Parsed text", origin: "parse", updatedAt: 3 }));
  assert.equal((await service.readAttachment(identity)).origin, "parse");
  service.setProcessedReader(async () => { throw Error("Database unavailable"); });
  assert.equal((await service.readAttachment(identity)).markdown, "Manual text");
});

test("a corrupt manual cache does not hide healthy processed content", async () => {
  const identity = { libraryID: 1, itemKey: "PDFKEY01" }, error = Error("Invalid manual cache");
  const service = new api.ContentReadService({ read: async () => { throw error; }, save: async () => {} });
  const content = { formatVersion: 1, attachment: identity, markdown: "Published text", origin: "parse", updatedAt: 3 };
  service.setProcessedReader(async () => content);
  assert.equal((await service.readAttachment(identity)).markdown, "Published text");
  service.setProcessedReader(async () => null);
  await assert.rejects(service.readAttachment(identity), error);
});

test("a lost publication acknowledgement never reclaims committed artifacts", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(), publish = f.repository.publish.bind(f.repository);
  await f.step();
  f.repository.publish = async (...args) => { await publish(...args); throw Error("Lost COMMIT acknowledgement"); };
  await assert.rejects(f.step());
  assert.equal((await f.job(id)).state, "succeeded");
  const files = await f.db.selectFrom("stored_files").select("relative_path").execute();
  assert.ok(files.length);
  for (const file of files) assert.ok(f.files.has(`/isolated/knowledgemcp/${file.relative_path}`), file.relative_path);
  assert.equal((await new api.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" })).origin, "parse");
});

test("unavailable publication ownership evidence retains files for safe startup recovery", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(); await f.step();
  f.repository.publish = async () => {
    f.native.options.fail = statement => /^select .* from "stored_files"/i.test(statement);
    throw Error("Publication unavailable");
  };
  try { await f.step(); } finally { f.native.options.fail = undefined; }
  assert.equal((await f.job(id)).state, "failed");
  assert.ok([...f.files.keys()].some(path => path.endsWith("/manifest.json")));
  assert.ok([...f.files.keys()].some(path => path.endsWith(".bin")));
  await api.recoverParseFiles(f.port, new Set()); assert.equal(f.files.size, 0);
});

test("configuration key order does not cause a duplicate parse and manual generations are protected", async t => {
  const f = await parsingFixture(t);
  f.input.parser.options = { alpha: true, beta: false };
  const id = await f.enqueue(); f.input.parser.options = { beta: false, alpha: true }; assert.equal(await f.enqueue(), id);
  const original = api.parsePaddleResult(result());
  const claim = await f.repository.claim(f.worker.owner);
  const generation = await f.repository.publish(claim, original, []);
  // Build a real manual generation through the existing staging constraints.
  await f.db.transaction().execute(async tx => {
    const row = await tx.selectFrom("content_generations").selectAll().where("id", "=", generation).executeTakeFirstOrThrow();
    const manualID = f.port.uuid();
    await tx.insertInto("content_generations").values({ id: manualID, resource_id: row.resource_id, source_id: row.source_id, parse_run_id: null,
      origin: "edit", state: "staging", published_at: null, source_version: row.source_version, source_fingerprint: row.source_fingerprint,
      normalizer_version: row.normalizer_version, content_fingerprint: row.content_fingerprint, created_by_type: "user", created_by: null,
      created_at: Date.now(), base_generation_id: generation, base_content_version: 1, content_version: 2 }).execute();
    await tx.updateTable("content_generations").set({ state: "ready", published_at: Date.now() }).where("id", "=", manualID).execute();
    await tx.updateTable("resource_sources").set({ active_generation_id: manualID, content_version: 2 }).where("id", "=", f.input.sourceID).execute();
    await tx.updateTable("content_generations").set({ state: "superseded" }).where("id", "=", generation).execute();
  });
  const next = await f.enqueue(true); await f.step();
  assert.equal((await f.job(next)).state, "needs_attention"); assert.equal((await f.job(next)).error_code, "edited");
});

test("HTTP transport enforces response bounds, rate-limit timing and request aborts", async t => {
  await parsingFixture(t);
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const transport = new api.BrowserParseTransport(), signal = new AbortController().signal;
  globalThis.fetch = async () => new Response("too large", { headers: { "content-length": "9999" } });
  await assert.rejects(transport.request("https://result.example/a", {}, 1000, 10, signal), error => error.code === "size");
  globalThis.fetch = async () => new Response("limited", { status: 429, headers: { "retry-after": "5" } });
  await assert.rejects(transport.request("https://ocr.example/a", {}, 1000, 1024, signal), error => error.code === "http-429" && error.retryAfterMs === 5000 && error.retryable);
  globalThis.fetch = async () => new Response("expired URL", { status: 403 });
  await assert.rejects(transport.request("https://result.example/a", {}, 1000, 1024, signal), error => error.code === "http-403" && error.retryable);
  await assert.rejects(transport.request("https://ocr.example/a", { headers: { Authorization: "Bearer secret" } }, 1000, 1024, signal), error => error.code === "credentials" && !error.retryable);
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(Error("Aborted")); else signal.addEventListener("abort", () => reject(Error("Aborted")), { once: true });
  });
  const abort = new AbortController(), request = transport.request("https://ocr.example/a", {}, 1000, 1024, abort.signal); abort.abort();
  await assert.rejects(request, error => error.code === "network");
});

test("failed staging cleanup retains its manifest and retries without blocking other attempt recovery", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(); await f.step();
  f.repository.publish = async () => { throw new api.ParseError("provider"); };
  const remove = f.port.remove;
  f.port.remove = async path => { if (/\/\d+\.bin$/.test(path)) throw Error("Temporary disk lock"); await remove(path); };
  await f.step(); assert.equal((await f.job(id)).state, "failed");
  const staged = [...f.files.keys()].filter(path => /\/\d+\.bin$/.test(path));
  assert.ok(staged.length); assert.equal([...f.files.keys()].filter(path => path.endsWith("manifest.json")).length, 1);
  const orphan = api.parseFilePath("parse/legacy/orphan/0.bin"); f.files.set(orphan, bytes("orphan without manifest"));
  const retained = "parse/retained/attempt/0.bin", published = api.parseFilePath(retained); f.files.set(published, bytes("shared published content"));
  // The first attempt remains locked; a different attempt is still reclaimed.
  f.port.remove = async path => { if (staged.includes(path)) throw Error("Still locked"); await remove(path); };
  await api.recoverParseFiles(f.port, new Set([retained]));
  assert.equal(f.files.has(orphan), false); assert.ok(f.files.has(published));
  assert.equal([...f.files.keys()].filter(path => path.endsWith("manifest.json")).length, 1);
  f.port.remove = remove; await api.recoverParseFiles(f.port, new Set([retained]));
  assert.deepEqual([...f.files.keys()], [published]);
});

test("batch retry keeps successful generations and only retries failed children", async t => {
  const f = await parsingFixture(t);
  f.input.batch = { id: "batch-fixture", title: "Batch", sourceCollection: "Synthetic source" };
  const succeeded = await f.enqueue(); await f.step(); await f.step();
  const generation = (await f.job(succeeded)).generation_id;
  const item = { ...f.item, itemID: 20, key: "ARTICLE2", attachments: [{ ...f.item.attachments[0], itemID: 21, key: "PDFKEY02", parentKey: "ARTICLE2" }] };
  const resourceID = await f.repo.save(item, f.target), source = await f.repository.sourceFor(1, "PDFKEY02");
  const failed = await f.repository.enqueue({ ...f.input, sourceID: source.id, resourceID, attachmentKey: "PDFKEY02" }, await f.port.hash((await f.port.attachment()).bytes), 3);
  await f.step(); f.provider.progress = async () => ({ state: "failed" }); await f.step();
  assert.equal((await f.job(failed)).state, "failed");
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers); service.config.current = f.config.current;
  f.beforeClose(() => service.close());
  await service.runAction("batch-batch-fixture", "retry");
  const jobs = await f.repository.list(); assert.equal(jobs.length, 3);
  const retry = jobs.find(job => job.id !== succeeded && job.id !== failed);
  assert.equal(retry.resource_id, resourceID); assert.equal(retry.state, "pending");
  assert.equal((await f.job(succeeded)).generation_id, generation); assert.equal(f.submissions, 2);
  await service.runAction(succeeded, "retry");
  assert.equal((await f.repository.list()).length, 4, "a single completed item still supports explicit reparsing");
});

test("batch retry skips ambiguous submissions and obsolete or hidden history", async t => {
  const f = await parsingFixture(t);
  f.input.batch = { id: "retry-filter", title: "Batch", sourceCollection: "Synthetic source" };
  const old = await f.enqueue(); await f.db.updateTable("processing_jobs").set({ state: "failed", finished_at: Date.now() }).where("id", "=", old).execute();
  const ambiguous = await f.enqueue();
  await f.db.updateTable("processing_jobs").set({ state: "needs_attention", error_code: "ambiguous" }).where("id", "=", ambiguous).execute();
  await f.db.updateTable("parse_runs").set({ submission_state: "ambiguous" }).where("job_id", "=", ambiguous).execute();
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers); service.config.current = f.config.current;
  f.beforeClose(() => service.close());
  await service.runAction("batch-retry-filter", "retry");
  assert.equal((await f.repository.list()).length, 2); assert.equal((await f.job(ambiguous)).state, "needs_attention");
  await assert.rejects(service.runAction(ambiguous, "retry"), error => error.code === "ambiguous");
  await f.repository.cancel(ambiguous); await f.repository.hide(ambiguous);
  await assert.rejects(service.runAction("batch-retry-filter", "retry"), error => error.code === "stale");
  assert.equal((await f.repository.list()).length, 2);
});

test("single-item actions reject obsolete and cleared attempts instead of creating another parse", async t => {
  const f = await parsingFixture(t), first = await f.enqueue();
  await f.db.updateTable("processing_jobs").set({ state: "failed", finished_at: Date.now() }).where("id", "=", first).execute();
  const second = await f.enqueue(true);
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers);
  f.beforeClose(() => service.close()); service.config.current = f.config.current;
  await assert.rejects(service.runAction(first, "retry"), error => error.code === "stale");
  await f.repository.cancel(second); await f.repository.hide(second);
  await assert.rejects(service.runAction(second, "retry"), error => error.code === "stale");
  assert.equal((await f.repository.list()).length, 2); assert.equal(f.submissions, 0);
});

test("an accepted remote ID survives a transient checkpoint failure without another upload", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(), checkpoint = f.repository.checkpoint.bind(f.repository);
  let failures = 1;
  f.repository.checkpoint = async (...args) => { if (args[2]?.external_job_id && failures-- > 0) throw Error("Transient local write failure"); return checkpoint(...args); };
  await f.step();
  assert.equal((await f.job(id)).state, "waiting");
  assert.equal((await f.repository.run(await f.job(id))).external_job_id, "remote-1");
  await f.step(); assert.equal((await f.job(id)).state, "succeeded"); assert.equal(f.submissions, 1);
});

test("persistent accepted-ID write failure stays recoverable and cannot be retried as a new upload", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(), checkpoint = f.repository.checkpoint.bind(f.repository);
  let attempts = 0;
  f.repository.checkpoint = async (...args) => { if (args[2]?.external_job_id) { attempts++; throw Error("Local storage failure"); } return checkpoint(...args); };
  await f.step();
  const job = await f.job(id), run = await f.repository.run(job);
  assert.equal(attempts, 3); assert.equal(job.state, "needs_attention"); assert.equal(job.error_code, "ambiguous");
  assert.equal(run.submission_state, "submitting"); assert.equal(f.submissions, 1);
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers); service.config.current = f.config.current; f.beforeClose(() => service.close());
  await assert.rejects(service.runAction(id, "retry"), error => error.code === "ambiguous");
  f.repository.checkpoint = checkpoint;
  await service.runAction(id, "recover", "remote-1"); await f.step();
  assert.equal((await f.job(id)).state, "succeeded"); assert.equal(f.submissions, 1);
});

test("legacy terminal uncertain submissions fence admission even after the parser profile changes", async t => {
  const f = await parsingFixture(t), id = await f.enqueue();
  await f.db.updateTable("parse_runs").set({ submission_state: "submitting", stage: "submitting" }).where("job_id", "=", id).execute();
  await f.db.updateTable("processing_jobs").set({ state: "failed", error_code: "internal", finished_at: Date.now() }).where("id", "=", id).execute();
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers); service.config.current = f.config.current; f.beforeClose(() => service.close());
  await service.refresh(); assert.equal(service.snapshot()[0].status, "attention"); assert.equal(service.snapshot()[0].errorCode, "ambiguous");
  await assert.rejects(service.runAction(id, "retry"), error => error.code === "ambiguous");
  const input = { ...f.input, parser: { ...f.input.parser, model: "Replacement parser model" } };
  assert.equal(await f.repository.enqueue(input, await f.port.hash((await f.port.attachment()).bytes), 3, true), id);
  assert.equal((await f.job(id)).state, "needs_attention"); assert.equal((await f.repository.list()).length, 1);
  await f.repository.attachRemote(id, "known-recovery-id"); await f.step();
  assert.equal((await f.job(id)).state, "succeeded"); assert.equal(f.submissions, 0);
});

test("uncertain submission recovery takes precedence over missing credentials and attachment", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(), claim = await f.repository.claim(f.worker.owner);
  await f.repository.reserveSubmission(claim, 2);
  const original = structuredClone(f.config.current.profiles.paddleocr);
  f.config.current = api.validateParsingConfig({ ...f.config.current, activeProfile: "replacement", profiles: { replacement: { ...original, key: "replacement-key" } }, parserProfiles: { paddleocr: "replacement" } });
  f.port.attachment = async () => { throw new api.ParseError("missing"); };
  // Simulate an older shutdown that released an uncertain submission as waiting.
  await f.db.updateTable("processing_jobs").set({ state: "waiting", lease_owner: null, execution_token: null, lease_expires_at: null }).where("id", "=", id).execute();
  await f.step(); assert.equal((await f.job(id)).error_code, "ambiguous"); assert.equal(f.submissions, 0);
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers); service.config.current = f.config.current; f.beforeClose(() => service.close());
  await service.refresh(); assert.equal(service.snapshot()[0].errorCode, "ambiguous");
  await service.runAction(id, "recover", "recovered-id");
  assert.equal((await f.repository.run(await f.job(id))).external_job_id, "recovered-id");
});

test("startup repairs a legacy credentials error masking submission uncertainty", async t => {
  const f = await parsingFixture(t), id = await f.enqueue();
  await f.db.updateTable("parse_runs").set({ submission_state: "ambiguous" }).where("job_id", "=", id).execute();
  await f.db.updateTable("processing_jobs").set({ state: "needs_attention", error_code: "credentials" }).where("id", "=", id).execute();
  await f.repository.recover(); assert.equal((await f.job(id)).error_code, "ambiguous");
  await f.repository.recover(); assert.equal((await f.job(id)).error_code, "ambiguous"); assert.equal(f.submissions, 0);
});

test("cancelled uncertain work stays cancelled through recovery and background sync", async t => {
  const f = await parsingFixture(t), id = await f.enqueue(), claim = await f.repository.claim(f.worker.owner);
  await f.repository.reserveSubmission(claim, 2); await f.repository.cancel(id);
  await f.repository.recover(); assert.equal((await f.job(id)).state, "cancelled");
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers); f.beforeClose(() => service.close());
  await service.refresh(); assert.equal(service.snapshot()[0].status, "cancelled"); assert.equal(service.snapshot()[0].errorCode, "ambiguous");
  await f.repository.hide(id);
  const fingerprint = await f.port.hash((await f.port.attachment()).bytes);
  assert.equal(await f.repository.enqueue(f.input, fingerprint, 3, false, true), id);
  await service.refresh(); assert.equal(service.snapshot().length, 0);
  assert.equal((await f.job(id)).state, "cancelled");
  assert.equal(await f.repository.enqueue(f.input, fingerprint, 3, true), id);
  await service.refresh(); assert.equal(service.snapshot()[0].status, "attention"); assert.equal(service.snapshot()[0].errorCode, "ambiguous");
  assert.equal((await f.repository.list()).length, 1); assert.equal(f.submissions, 0);
  await service.runAction(id, "recover", "existing-cancelled-remote-id"); await f.step();
  assert.equal((await f.job(id)).state, "succeeded"); assert.equal(f.submissions, 0);
});

async function legacyRetry(f, acceptedSuccessor = false) {
  const id = await f.enqueue(), claimed = await f.repository.claim(f.worker.owner);
  await f.repository.reserveSubmission(claimed, 2);
  await f.provider.submit();
  await f.repository.finish(claimed, "failed", "internal");
  // Reconstruct the valid persisted state produced by the old retry path.
  const previous = f.native.sqlite.prepare("SELECT * FROM processing_jobs WHERE id = ?").get(id);
  const run = f.native.sqlite.prepare("SELECT * FROM parse_runs WHERE job_id = ?").get(id), successor = randomUUID();
  await f.db.insertInto("processing_jobs").values({ ...previous, id: successor, state: acceptedSuccessor ? "waiting" : "pending",
    error_code: null, failure_count: 0, attempt_count: 0, started_at: null, finished_at: null, next_run_at: 0, checkpoint_json: "{}",
    created_at: previous.created_at + 1, payload_json: JSON.stringify({ ...JSON.parse(previous.payload_json), replacesJobID: id }) }).execute();
  await f.db.insertInto("parse_runs").values({ ...run, id: randomUUID(), job_id: successor, submission_key: randomUUID(),
    submission_state: acceptedSuccessor ? "confirmed" : "not_submitted", external_job_id: acceptedSuccessor ? "accepted-successor" : null,
    stage: acceptedSuccessor ? "polling" : "validating", created_at: previous.created_at + 1 }).execute();
  return { id, successor };
}

test("startup recovers a legacy uncertain predecessor before its pending retry without a live-key conflict", async t => {
  const f = await parsingFixture(t), { id, successor } = await legacyRetry(f);
  await f.worker.start(); await f.worker.close();
  assert.equal((await f.job(id)).state, "needs_attention"); assert.equal((await f.job(id)).error_code, "ambiguous");
  assert.equal((await f.job(successor)).state, "cancelled"); assert.equal((await f.job(successor)).error_code, "stale");
  assert.equal(f.submissions, 1); assert.deepEqual(f.native.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("explicit admission reopens an unresolved predecessor and fences its unsubmitted successor", async t => {
  const f = await parsingFixture(t), { id, successor } = await legacyRetry(f);
  assert.equal(await f.enqueue(true), id);
  assert.equal((await f.job(id)).state, "needs_attention"); assert.equal((await f.job(successor)).state, "cancelled");
  assert.equal(f.submissions, 1);
});

test("a reopened ambiguous predecessor remains visible and can recover despite replacement history", async t => {
  const f = await parsingFixture(t), { id, successor } = await legacyRetry(f);
  await f.repository.cancel(successor); await f.enqueue(true);
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers); f.beforeClose(() => service.close());
  service.config.current = f.config.current; await service.refresh();
  assert.equal(service.snapshot().find(task => task.id === id)?.errorCode, "ambiguous");
  await assert.rejects(service.runAction(id, "retry"), error => error.code === "ambiguous");
  await service.runAction(id, "recover", "remote-1"); await f.step();
  assert.equal((await f.job(id)).state, "succeeded"); assert.equal(f.submissions, 1);
});

test("legacy recovery preserves an already accepted successor and keeps the older recovery route visible", async t => {
  const f = await parsingFixture(t), { id, successor } = await legacyRetry(f, true);
  await f.repository.recover();
  assert.equal((await f.job(successor)).state, "waiting");
  assert.equal((await f.repository.run(await f.job(successor))).external_job_id, "accepted-successor");
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers); f.beforeClose(() => service.close());
  await service.refresh(); assert.equal(service.snapshot().find(task => task.id === id)?.status, "attention");
  await assert.rejects(service.runAction(id, "recover", "remote-1"), error => error.code === "stale");
  assert.equal((await f.job(successor)).state, "waiting");
  await service.runAction(id, "cancel"); assert.equal((await f.job(id)).state, "cancelled");
  assert.equal(f.submissions, 1);
});

test("submission reservation fences an already claimed replacement while its predecessor is unresolved", async t => {
  const f = await parsingFixture(t), { id, successor } = await legacyRetry(f);
  const claimed = await f.repository.claim(f.worker.owner); assert.equal(claimed.id, successor);
  await assert.rejects(f.repository.reserveSubmission(claimed, 2), error => error.code === "stale");
  await f.worker.execute(claimed, new AbortController());
  assert.equal((await f.job(successor)).state, "cancelled"); assert.equal(f.submissions, 1);
  assert.equal((await f.repository.run(await f.job(id))).submission_state, "submitting");
});

test("uncertainty fences older unsubmitted retries across parser identities", async t => {
  const f = await parsingFixture(t), { id, successor } = await legacyRetry(f);
  await f.db.updateTable("processing_jobs").set({ dedup_key: "another-profile-identity" }).where("id", "=", successor).execute();
  await f.repository.recover();
  assert.equal((await f.job(id)).state, "needs_attention"); assert.equal((await f.job(successor)).state, "cancelled");
  assert.equal(f.submissions, 1);
});
