import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { api, parsingFixture, bytes, result } from "./fixtures/parsing.mjs";
import { zip, mineruFiles, mineruBlocks } from "./fixtures/mineru.mjs";
const signal = () => new AbortController().signal;
const settle = () => new Promise(resolve => setImmediate(resolve));

test("MinerU profiles validate independently and legacy Paddle identities remain unchanged", async t => {
  const f = await parsingFixture(t), legacy = structuredClone(f.input.parser);
  assert.equal(api.canonicalParserJSON(api.parserIdentity(f.config.current.profiles.paddleocr, "paddleocr")), api.canonicalParserJSON(legacy));
  const profile = api.defaultParserProfile("mineru");
  const config = { ...f.config.current, activeProfile: "mineru", profiles: { mineru: { ...profile, key: "secret" } }, parserProfiles: { mineru: "mineru" } };
  assert.equal(api.validateParsingConfig(config).profiles.mineru.options.isOcr, true);
  for (const change of [{ provider: "unknown" }, { model: "MinerU-HTML" }, { model: "pipeline" }, { options: { page_ranges: "1" } }, { options: { isOcr: "true" } }]) {
    assert.throws(() => api.validateParsingConfig({ ...config, profiles: { mineru: { ...config.profiles.mineru, ...change } } }), error => error.code === "config");
  }
  f.config.current = api.validateParsingConfig(config);
  assert.throws(() => f.config.credential({ ...api.parserIdentity(profile, "mineru"), provider: "paddleocr" }), error => error.code === "credentials");
});

test("MinerU settings offer a ready profile for old configurations and retain edits across selection/save", async t => {
  const f = await parsingFixture(t); await f.config.start();
  const dom = new JSDOM('<section id="km-settings"></section>'); t.after(() => dom.window.close());
  const host = dom.window.document.getElementById("km-settings"), cleanup = await api.mountSettings(host); t.after(cleanup);
  host.querySelector("#km-setting-key").value = "paddle-secret";
  const choose = (id, value) => { const control = host.querySelector(id); control.value = value; control.dispatchEvent(new dom.window.Event("change")); };
  assert.equal(host.querySelector("#km-setting-profile"), null);
  assert.equal(host.querySelectorAll("#km-parsing-settings button").length, 2);
  choose("#km-setting-provider", "mineru");
  assert.equal(host.querySelector("#km-setting-provider").value, "mineru");
  assert.equal(host.querySelector("#km-setting-api").value, "https://mineru.net/api/v4");
  assert.equal(host.querySelector("#km-setting-model"), null);
  assert.equal(host.querySelector("#km-setting-provider option:checked").textContent, "MinerU (VLM)");
  assert.equal(host.querySelector("#km-setting-key").value, "");
  host.querySelector("#km-setting-key").value = "mineru-secret";
  host.querySelector("#km-setting-options").value = JSON.stringify({ language: "en" });
  host.querySelector("#km-setting-concurrency").value = "3";
  choose("#km-setting-provider", "paddleocr");
  assert.equal(host.querySelector("#km-setting-key").value, "paddle-secret");
  assert.equal(host.querySelector("#km-setting-concurrency").value, "3");
  choose("#km-setting-provider", "mineru");
  [...host.querySelectorAll("button")].find(button => button.textContent === "Save").click(); await settle();
  const saved = JSON.parse(new TextDecoder().decode(f.files.get(f.config.path)));
  assert.equal(saved.activeProfile, "mineru"); assert.equal(saved.profiles.mineru.model, "vlm");
  assert.equal(saved.profiles.mineru.options.language, "en"); assert.equal(saved.concurrency, 3);
  assert.equal(saved.profiles.mineru.key, "mineru-secret"); assert.equal(saved.profiles.paddleocr.key, "paddle-secret");
  choose("#km-setting-provider", "paddleocr");
  assert.equal(host.querySelector("#km-setting-key").value, "paddle-secret");
  assert.equal(host.querySelector("#km-setting-provider option:checked").textContent, "PaddleOCR (PaddleOCR VL-1.6)");
});

test("MinerU empty table placeholders and detached notes preserve raw content without rejecting valid results", async t => {
  await parsingFixture(t);
  const empty = { type: "table", img_path: "", table_caption: [""], table_footnote: [], page_idx: 0, bbox: [0, 0, 100, 100] };
  const { document } = api.parseMinerUResult(mineruFiles([
    { type: "text", text: "Synthetic paper", page_idx: 0 }, empty,
    { ...empty, table_caption: [], table_footnote: [""] },
    { ...empty, table_caption: ["Table 2. A continued table"], table_footnote: ["Source: synthetic data"] },
  ], [0]), 1);
  assert.equal(document.blocks.length, 2); assert.equal(document.pages[0].raw.mineru.content.length, 4);
  assert.equal(document.warnings.filter(value => value.startsWith("empty-block-skipped:")).length, 2);
  assert.equal(document.blocks[1].metadata.missing_visual_body, true);
  assert.ok(document.blocks[1].qualityFlags.includes("missing_visual_body"));
  assert.match(document.markdown, /Source: synthetic data/);
  for (const broken of [{ ...empty, img_path: "images/missing.png" }, { ...empty, table_caption: [42] }, { type: "table", page_idx: 0 }]) {
    assert.throws(() => api.parseMinerUResult(mineruFiles([broken], [0]), 1), error => error.code === "format");
  }
});

test("MinerU v4 uses authenticated JSON, token-free binary upload and file-correlated polling", async t => {
  await parsingFixture(t); const calls = [], parser = api.parserIdentity(api.defaultParserProfile("mineru"), "mineru");
  const responses = [
    { data: { batch_id: "batch", file_urls: ["https://uploads.example/file?signature=private"] } }, {},
    { data: { extract_result: [{ data_id: "other", state: "failed" }, { data_id: "source", state: "running", extract_progress: { extracted_pages: 1, total_pages: 3 } }] } },
    { data: { extract_result: [{ data_id: "source", state: "done", full_zip_url: "https://results.example/result.zip" }] } },
  ];
  const provider = new api.MinerUProvider({ async request(url, init) { calls.push({ url, init }); return { bytes: bytes(JSON.stringify({ code: 0, ...responses.shift() })), headers: new Headers() }; } });
  const allocation = await provider.allocate(parser, "secret", "file.pdf", "source", 1000, signal());
  assert.equal(allocation.batchID, "batch"); await provider.upload(allocation.uploadURL, bytes("%PDF-"), 1000, signal());
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret"); assert.equal(calls[1].init.headers, undefined);
  assert.equal(calls[1].init.redirect, "error"); assert.equal(calls[1].init.body instanceof ArrayBuffer, true);
  const payload = JSON.parse(calls[0].init.body); assert.equal(payload.model_version, "vlm"); assert.equal(payload.files[0].data_id, "source"); assert.equal(payload.enable_table, true);
  const running = await provider.progress(parser, "secret", "batch", "source", 1000, signal()); assert.equal(running.total, 3);
  assert.equal((await provider.progress(parser, "secret", "batch", "source", 1000, signal())).resultURL, "https://results.example/result.zip");
});

test("MinerU business errors distinguish rejected submissions and never expose response text", async t => {
  await parsingFixture(t); const parser = api.parserIdentity(api.defaultParserProfile("mineru"), "mineru");
  for (const [code, expected, retryable] of [["A0202", "credentials", false], ["A0211", "credentials", false], [-60009, "http-429", true], [-60018, "http-429", true], [-10002, "provider", false]]) {
    const provider = new api.MinerUProvider({ async request() { return { bytes: bytes(JSON.stringify({ code, msg: "sensitive response text" })) }; } });
    await assert.rejects(provider.allocate(parser, "key", "a.pdf", "source", 1000, signal()), error => error.code === expected && error.retryable === retryable && error.submissionRejected && !error.message.includes("sensitive"));
  }
});

test("upload transport explicitly accepts successful empty bodies without relaxing JSON or artifact requests", async t => {
  await parsingFixture(t);
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const transport = new api.BrowserParseTransport(), provider = new api.MinerUProvider(transport);
  const parser = api.parserIdentity(api.defaultParserProfile("mineru"), "mineru");
  for (const status of [200, 201, 204, 205]) {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.method, "PUT"); assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).has("authorization"), false);
      return new Response(status < 204 ? "" : null, { status, headers: { "x-fixture": "upload" } });
    };
    await provider.upload("https://upload.example/signed", bytes("%PDF-fixture"), 1000, signal());
    globalThis.fetch = async () => new Response(null, { status });
    const optional = await transport.request("https://upload.example/signed", { method: "PUT" }, 1000, 1024, signal(), "optional");
    assert.equal(optional.bytes.length, 0); assert.ok(optional.headers instanceof Headers);
    await assert.rejects(transport.request("https://result.example/file", { method: "GET" }, 1000, 1024, signal()), error => error.code === "format");
    await assert.rejects(provider.download("https://result.example/file", 1000, 1024, signal()), error => error.code === "format");
    await assert.rejects(provider.progress(parser, "secret", "batch", "source", 1000, signal()), error => error.code === "format");
    if (status < 204) {
      globalThis.fetch = async () => new Response("", { status });
      await assert.rejects(transport.request("https://result.example/file", { method: "GET" }, 1000, 1024, signal()), error => error.code === "format");
      await assert.rejects(provider.download("https://result.example/file", 1000, 1024, signal()), error => error.code === "format");
    }
  }
});

test("optional upload bodies retain HTTP errors and bounded response reading", async t => {
  await parsingFixture(t);
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const transport = new api.BrowserParseTransport();
  const request = () => transport.request("https://upload.example/signed", { method: "PUT" }, 1000, 4, signal(), "optional");
  globalThis.fetch = async () => new Response(null, { status: 429, headers: { "retry-after": "3" } });
  await assert.rejects(request(), error => error.code === "http-429" && error.retryable && error.retryAfterMs === 3000);
  globalThis.fetch = async () => new Response(null, { status: 400 });
  await assert.rejects(request(), error => error.code === "http-400");
  globalThis.fetch = async () => new Response(null, { status: 204, headers: { "content-length": "5" } });
  await assert.rejects(request(), error => error.code === "size");
  globalThis.fetch = async () => new Response("12345", { status: 200 });
  await assert.rejects(request(), error => error.code === "size");
  globalThis.fetch = async () => new Response("ok", { status: 201 });
  assert.equal(new TextDecoder().decode((await request()).bytes), "ok");
});

test("MinerU normalizes typed content, blank pages, heading ancestry and provider geometry", async t => {
  await parsingFixture(t); const parsed = api.parseMinerUResult(mineruFiles());
  assert.equal(parsed.version, "3.4.4"); assert.equal(parsed.document.total, 3); assert.equal(parsed.document.partial, false);
  assert.equal(parsed.document.blocks.length, 8); assert.deepEqual(parsed.document.blocks[0].bbox, [60, 40, 540, 80]);
  assert.deepEqual(parsed.document.blocks.filter(block => block.type === "heading").map(block => block.headingLevel), [1, 2, 3, 4]);
  assert.ok(parsed.document.warnings.includes("heading-level-inferred"));
  assert.ok(parsed.document.warnings.includes("source-page-count-unverified"));
  assert.match(parsed.document.markdown, /Table 1.*\n\n<table/s); assert.match(parsed.document.markdown, /A table note/);
  api.rewriteMinerUImages(parsed.document, new Map([["images/figure.png", "images/local.png"]]));
  assert.match(parsed.document.markdown, /images\/local.png/); assert.doesNotMatch(parsed.document.markdown, /images\/figure.png/);
  const partial = api.parseMinerUResult(mineruFiles(mineruBlocks, [0, 1]), 3).document;
  assert.equal(partial.partial, true); assert.ok(partial.warnings.includes("missing-page:3"));
  assert.throws(() => api.parseMinerUResult(mineruFiles([{ ...mineruBlocks[0], page_idx: 5 }])) , error => error.code === "page-positions");
  assert.throws(() => api.parseMinerUResult(mineruFiles([{ ...mineruBlocks[0], bbox: [900, 0, 100, 30] }])), error => error.code === "format");
  const missing = mineruFiles(); missing.delete("images/figure.png"); assert.throws(() => api.parseMinerUResult(missing), error => error.code === "format");
});

test("MinerU real-paper shapes preserve charts, page footnotes and references while retaining empty raw blocks", async t => {
  await parsingFixture(t);
  const blocks = [
    { type: "text", text: "Synthetic scholarly title", text_level: 1, page_idx: 0, bbox: [10, 10, 900, 50] },
    { type: "text", text: "", page_idx: 0, bbox: [10, 60, 100, 70] },
    { type: "text", text: " \n ", page_idx: 0, bbox: [10, 70, 100, 80] },
    { type: "chart", img_path: "images/figure.png", content: "", chart_caption: ["Figure 1. Synthetic chart"], chart_footnote: ["Chart note"], page_idx: 0, bbox: [10, 100, 900, 500] },
    { type: "page_footnote", text: "A synthetic source note.", page_idx: 0, bbox: [10, 800, 900, 850] },
    { type: "ref_text", text: "Example A. 2026. Synthetic reference.", page_idx: 0, bbox: [10, 900, 900, 950] },
  ];
  const { document } = api.parseMinerUResult(mineruFiles(blocks, [0]), 1);
  assert.equal(document.partial, false); assert.equal(document.blocks.length, 4);
  assert.deepEqual(document.blocks.map(block => block.type), ["heading", "image", "footnote", "reference"]);
  assert.equal(document.pages[0].raw.mineru.content.length, 6);
  assert.equal(document.warnings.filter(warning => warning.startsWith("empty-block-skipped:")).length, 2);
  assert.match(document.markdown, /Figure 1\. Synthetic chart/); assert.match(document.markdown, /Chart note/);
  assert.equal(document.blocks[1].metadata.provider_type, "chart");
  assert.ok(document.blocks[3].qualityFlags.includes("reference_entry"));
  assert.match(document.blocks[2].markdown, /^> /);
  const broken = blocks.map(block => ({ ...block })); delete broken[3].img_path;
  assert.throws(() => api.parseMinerUResult(mineruFiles(broken, [0])), error => error.code === "format");
});

test("MinerU bibliography publication preserves normalized geometry and missing positions", async t => {
  const f = await parsingFixture(t), document = api.parseMinerUResult(mineruFiles([
    { type: "reference", text: "[1] First original reference.", page_idx: 0, bbox: [100, 200, 900, 250] },
    { type: "ref_text", text: "[2] Reference without available geometry.", page_idx: 0 },
    { type: "page_footnote", text: "A footnote is not a bibliography record.", page_idx: 0 },
  ], [0]), 1).document;
  await f.enqueue(); const job = await f.repository.claim(f.worker.owner);
  const generation = await f.repository.publish(job, document, []);
  const rows = await f.db.selectFrom("resource_references as r").innerJoin("content_blocks as b", "b.id", "r.source_block_id")
    .selectAll("r").select(["b.locations_json", "b.metadata_json"]).orderBy("b.canonical_order").execute();
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.generation_id === generation));
  assert.deepEqual(JSON.parse(rows[0].locations_json), [{ page: 1, bbox: [60, 160, 540, 200], sourceID: "mineru:1:0" }]);
  assert.deepEqual(JSON.parse(rows[0].metadata_json).provider_bbox, [100, 200, 900, 250]);
  assert.deepEqual(JSON.parse(rows[1].locations_json), []);
  assert.deepEqual(rows.map(row => row.raw_text), ["First original reference.", "Reference without available geometry."]);
  assert.deepEqual(rows.map(row => row.reference_number), [1, 2]);
});

test("MinerU ZIP decoding bounds expansion and rejects traversal, duplicates, symlinks and damaged content", async t => {
  await parsingFixture(t);
  for (const compress of [true, false]) {
    const archive = zip([...mineruFiles()], compress), result = await api.readMinerUArchive(archive, 1024 * 1024, signal());
    assert.equal(result.size, 4); assert.equal(api.parseMinerUResult(result).document.total, 3);
  }
  for (const entries of [[["../escape.json", "{}"]], [["a.json", "{}"], ["A.json", "{}"]], [["a\\b.json", "{}"]], [["/a.json", "{}"]]]) {
    await assert.rejects(api.readMinerUArchive(zip(entries), 100000, signal()), error => error.code === "format");
  }
  await assert.rejects(api.readMinerUArchive(zip([["large.json", "x".repeat(100000)]]), 1000, signal()), error => error.code === "size");
  const corrupt = zip([["a.json", "abc"]], false); corrupt[36] ^= 1;
  await assert.rejects(api.readMinerUArchive(corrupt, 10000, signal()), error => error.code === "format");
  const link = zip([["a.json", "abc"]]); const central = link.findIndex((_, index) => new DataView(link.buffer).getUint8(index) === 0x50 && link[index + 1] === 0x4b && link[index + 2] === 1 && link[index + 3] === 2);
  new DataView(link.buffer).setUint32(central + 38, 0xa000 << 16, true);
  await assert.rejects(api.readMinerUArchive(link, 10000, signal()), error => error.code === "format");
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(api.readMinerUArchive(zip([...mineruFiles()]), 100000, cancelled.signal), error => error.code === "interrupted");
});

async function workerFixture(t, changes = {}) {
  const archive = zip([...mineruFiles()]);
  const f = await parsingFixture(t, { download: async () => archive });
  f.config.current = api.validateParsingConfig({ ...f.config.current, activeProfile: "mineru", profiles: { ...f.config.current.profiles, mineru: { ...api.defaultParserProfile("mineru"), key: "secret" } } });
  f.input.parser = api.parserIdentity(f.config.current.profiles.mineru, "mineru");
  let allocations = 0, uploads = 0;
  const mineruClient = {
    async allocate(_parser, _key, _name, dataID) { allocations++; return { batchID: "batch", dataID, uploadURL: "https://uploads.example/fixture?signature=private" }; },
    async upload() { uploads++; const job = await f.db.selectFrom("processing_jobs").selectAll().where("state", "=", "running").executeTakeFirstOrThrow();
      const run = await f.repository.run(job); assert.match(run.external_job_id, /^batch/); assert.equal(JSON.parse(job.checkpoint_json).mineru.uploadStarted, true); },
    async progress() { return { state: "done", resultURL: "https://results.example/fixture.zip", total: 3 }; },
    async download() { return archive; }, ...changes,
  };
  f.parsers.resolve(f.input.parser).client = mineruClient;
  return { ...f, mineruClient, get allocations() { return allocations; }, get uploads() { return uploads; } };
}

test("MinerU worker checkpoints before PUT, retains the provider during profile switches and publishes local structured content", async t => {
  const f = await workerFixture(t), id = await f.enqueue(); await f.step();
  assert.equal(f.allocations, 1); assert.equal(f.uploads, 0);
  f.config.current.activeProfile = "paddleocr";
  await f.step(); assert.equal(f.uploads, 1); await f.step();
  const job = await f.job(id); assert.equal(job.state, "succeeded");
  const run = await f.repository.run(job); assert.equal(run.parser_version, "3.4.4");
  const profile = await f.db.selectFrom("provider_profiles").selectAll().where("id", "=", run.provider_profile_id).executeTakeFirstOrThrow(); assert.equal(profile.adapter_key, "mineru-v4");
  const sections = await f.db.selectFrom("structure_nodes").selectAll().where("generation_id", "=", job.generation_id).execute();
  assert.deepEqual(sections.filter(section => section.node_type === "section").map(section => section.depth), [1, 2, 3]);
  assert.equal(sections.find(section => section.depth === 2).review_status, "needs_review");
  const content = await f.db.selectFrom("content_blocks").selectAll().where("generation_id", "=", job.generation_id).execute();
  assert.equal(content.length, 8); assert.ok(content.some(block => block.content_markdown.includes("images/")));
  assert.doesNotMatch(JSON.stringify(content), /https:\/\/uploads/); assert.equal(JSON.parse(job.checkpoint_json).mineru.uploadURL, undefined);
});

test("MinerU uncertain PUT and restored upload intent poll the same batch without another upload", async t => {
  let attempts = 0; const f = await workerFixture(t, { async upload() { attempts++; throw new api.ParseError("network", true); } });
  const id = await f.enqueue(); await f.step(); await f.step();
  assert.equal((await f.job(id)).state, "retry_wait");
  await f.step(); assert.equal((await f.job(id)).state, "succeeded"); assert.equal(attempts, 1); assert.equal(f.allocations, 1);
});

test("a bodyless HTTP 204 upload advances the accepted MinerU batch to polling and publication", async t => {
  const f = await workerFixture(t), upload = new api.MinerUProvider();
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  let uploads = 0, polls = 0;
  globalThis.fetch = async (_url, init) => { assert.equal(init.method, "PUT"); uploads++; return new Response(null, { status: 204 }); };
  f.mineruClient.upload = (...args) => upload.upload(...args);
  f.mineruClient.progress = async (_identity, _key, remoteID) => {
    assert.equal(remoteID, "batch"); polls++; return { state: "done", resultURL: "https://results.example/fixture.zip", total: 3 };
  };
  const id = await f.enqueue(); await f.step(); await f.step();
  const uploaded = await f.job(id);
  assert.equal(uploaded.state, "waiting"); assert.equal(uploaded.error_code, null);
  assert.equal(JSON.parse(uploaded.checkpoint_json).mineru.uploaded, true);
  await f.step();
  const completed = await f.job(id), run = await f.repository.run(completed);
  assert.equal(completed.state, "succeeded"); assert.equal(completed.error_code, null);
  assert.equal(run.external_job_id, "batch"); assert.equal(run.submission_state, "confirmed");
  assert.equal(f.allocations, 1); assert.equal(uploads, 1); assert.equal(polls, 1);
});

test("knowledge information keeps each attachment's published parser after settings switches, history deletion and failed reparse", async t => {
  const f = await workerFixture(t), first = await f.enqueue(); await f.step(); await f.step(); await f.step();
  await f.repository.hide(first);
  f.config.current.activeProfile = "paddleocr";
  f.item.attachments.push({ ...f.item.attachments[0], key: "PDFKEY02", itemID: 12, title: "Second PDF" });
  f.item.fingerprint = await f.port.hash("two attachments"); await f.repo.save(f.item, f.target);
  const secondSource = await f.repository.sourceFor(1, "PDFKEY02");
  const secondInput = { ...f.input, sourceID: secondSource.id, attachmentKey: "PDFKEY02", parser: api.parserIdentity(f.config.current.profiles.paddleocr, "paddleocr") };
  f.provider.download = async () => bytes(result());
  const second = await f.repository.enqueue(secondInput, await f.port.hash(bytes("%PDF-1.7\nSynthetic test attachment")), 3);
  await f.step(); await f.step(); assert.equal((await f.job(second)).state, "succeeded");
  f.provider.download = async () => bytes("broken result");
  const retry = await f.enqueue(true); await f.step(); await f.step(); assert.equal((await f.job(retry)).state, "failed");
  const snapshot = await f.repo.snapshot();
  assert.deepEqual(snapshot.sources.find(source => source.id === f.input.sourceID).parser, { provider: "mineru", model: "vlm" });
  assert.deepEqual(snapshot.sources.find(source => source.id === secondSource.id).parser, { provider: "paddleocr", model: "PaddleOCR-VL-1.6" });
  assert.doesNotMatch(JSON.stringify(snapshot.sources), /secret|private-key|https:/);
  const dom = new JSDOM("<html><body></body></html>"); t.after(() => dom.window.close());
  const info = api.renderKnowledgeDetails(dom.window.document, snapshot, { id: 10 }).content;
  assert.deepEqual([...info.querySelectorAll(".km-knowledge-parser")].map(node => node.textContent), ["Parser: MinerU · vlm", "Parser: PaddleOCR · PaddleOCR-VL-1.6"]);
  assert.equal(info.querySelector("img, script"), null);
});

test("MinerU restart resumes the allocated batch and an expired upload never creates another task", async t => {
  const f = await workerFixture(t), id = await f.enqueue(); await f.step();
  await f.worker.close();
  const restarted = new api.ParseWorker(f.repository, f.config, f.port, f.parsers, async () => {});
  restarted.stopped = false; f.beforeClose(() => restarted.close());
  const advance = async () => {
    await f.db.updateTable("processing_jobs").set({ next_run_at: 0 }).where("id", "=", id).execute();
    const job = await f.repository.claim(restarted.owner); if (job) await restarted.execute(job, new AbortController());
  };
  await advance(); await advance(); assert.equal((await f.job(id)).state, "succeeded"); assert.equal(f.allocations, 1); assert.equal(f.uploads, 1);
  // A separate fixture avoids reusing the completed provider identity.
  const expired = await workerFixture(t), expiredID = await expired.enqueue(); await expired.step();
  const saved = JSON.parse((await expired.job(expiredID)).checkpoint_json); saved.mineru.expiresAt = 1;
  await expired.db.updateTable("processing_jobs").set({ checkpoint_json: JSON.stringify(saved) }).where("id", "=", expiredID).execute();
  await expired.step(); assert.equal((await expired.job(expiredID)).state, "needs_attention");
  assert.equal((await expired.job(expiredID)).error_code, "timeout"); assert.equal(expired.allocations, 1); assert.equal(expired.uploads, 0);
});

test("MinerU validates polling states and rejects ambiguous recovery batches", async t => {
  await parsingFixture(t); const parser = api.parserIdentity(api.defaultParserProfile("mineru"), "mineru");
  let entries = [];
  const provider = new api.MinerUProvider({ async request() { return { bytes: bytes(JSON.stringify({ code: 0, data: { extract_result: entries } })) }; } });
  assert.equal((await provider.progress(parser, "secret", "batch", "source", 1000, signal())).state, "pending");
  for (const state of ["waiting-file", "converting", "pending", "running", "failed"]) {
    entries = [{ data_id: "source", state }];
    assert.equal((await provider.progress(parser, "secret", "batch", "source", 1000, signal())).state, ["running", "failed"].includes(state) ? state : "pending");
    assert.equal((await provider.progress(parser, "secret", "batch", "source", 1000, signal())).phase,
      state === "waiting-file" || state === "converting" ? "remote-preparing" : state === "pending" ? "remote-queue" : state === "running" ? "parsing" : undefined);
  }
  for (const value of [[{ data_id: "other", state: "done" }], [{ data_id: "source", state: "unknown" }], [{ data_id: "source", state: "running", extract_progress: { extracted_pages: 3, total_pages: 2 } }]]) {
    entries = value; await assert.rejects(provider.progress(parser, "secret", "batch", "source", 1000, signal()), error => error.code === "format");
  }
  entries = [{ state: "pending" }, { state: "pending" }];
  await assert.rejects(provider.progress(parser, "secret", "batch", undefined, 1000, signal()), error => error.code === "format");
});

test("MinerU allocation uncertainty fences retry and invalid ZIP preserves a previous generation", async t => {
  const f = await workerFixture(t, { async allocate() { throw new api.ParseError("network", true); } });
  const id = await f.enqueue(); await f.step(); assert.equal((await f.job(id)).state, "needs_attention");
  assert.equal((await f.repository.run(await f.job(id))).submission_state, "submitting");
  assert.equal(await f.enqueue(), id);
  f.mineruClient.allocate = async (_p, _k, _n, dataID) => ({ batchID: "batch-retry", dataID, uploadURL: "https://uploads.example/file" });
  await f.repository.attachRemote(id, "batch"); await f.step(); assert.equal((await f.job(id)).state, "succeeded");
  const generation = (await f.job(id)).generation_id;
  f.config.current.activeProfile = "mineru";
  f.mineruClient.download = async () => bytes("invalid zip");
  const retry = await f.enqueue(true); await f.step(); await f.step(); await f.step(); const failed = await f.job(retry);
  assert.equal(failed.state, "failed"); assert.equal(failed.error_code, "format");
  assert.equal((await f.repository.sourceFor(1, "PDFKEY01")).active_generation_id, generation);
});

test("retry after result validation failure reuses the confirmed task and parser despite an active-provider change", async t => {
  const f = await workerFixture(t), validDownload = f.mineruClient.download;
  f.mineruClient.download = async () => bytes("invalid archive");
  const id = await f.enqueue(); await f.step(); await f.step(); await f.step();
  assert.equal((await f.job(id)).state, "failed");
  const remoteID = (await f.repository.run(await f.job(id))).external_job_id;
  f.mineruClient.download = validDownload; f.config.current.activeProfile = "paddleocr";
  const service = new api.ParsingService(f.db, { snapshot: await f.repo.snapshot() }, f.port, f.parsers);
  service.config.current = f.config.current; f.beforeClose(() => service.close());
  await service.runAction(id, "retry"); await f.step();
  assert.equal((await f.job(id)).state, "succeeded"); assert.equal(f.allocations, 1); assert.equal(f.uploads, 1);
  assert.equal((await f.repository.run(await f.job(id))).external_job_id, remoteID);
  assert.equal((await f.repository.list()).length, 1);
  await service.refresh();
  assert.deepEqual(service.snapshot().find(task => task.id === id).parser, { provider: "mineru", model: "vlm" });
});

test("detached MinerU table notes publish as structured reviewable blocks", async t => {
  const note = { type: "table", img_path: "", table_caption: [], table_footnote: ["Synthetic continued table note."], page_idx: 0 };
  const f = await workerFixture(t, { async download() { return zip([...mineruFiles([...mineruBlocks.slice(0, 1), note], [0])]); } });
  const id = await f.enqueue(); await f.step(); await f.step(); await f.step();
  const job = await f.job(id); assert.equal(job.state, "partially_succeeded");
  const block = await f.db.selectFrom("content_blocks").selectAll().where("generation_id", "=", job.generation_id).where("block_type", "=", "table").executeTakeFirstOrThrow();
  assert.equal(block.review_status, "needs_review");
  assert.match(block.content_markdown, /continued table note/);
  assert.ok(JSON.parse(block.quality_flags_json).includes("missing_visual_body"));
});

test("result retry rejects changed attachment bytes instead of reviving a stale generation", async t => {
  const f = await workerFixture(t); f.mineruClient.download = async () => bytes("invalid archive");
  const id = await f.enqueue(); await f.step(); await f.step(); await f.step();
  assert.equal(await f.repository.resumeResult(id, await f.port.hash(bytes("different bytes")), 60000), false);
  assert.equal((await f.job(id)).state, "failed");
});
