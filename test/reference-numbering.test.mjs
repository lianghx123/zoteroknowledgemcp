import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { api as parsing, parsingFixture, page, result } from "./fixtures/parsing.mjs";

const bundle = await build({ stdin: { contents: `
export * from "./src/shared/reference-number.ts";
export * from "./src/services/reference-entries.ts";
export * from "./src/repositories/reference-content.ts";
export * from "./src/ui/rendering/structured-content.ts";
export * from "./src/mcp/tools/service.ts";
export * from "./src/security/mcp-tokens.ts";
export * from "./src/security/mcp-cursor.ts";`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, format: "esm", platform: "browser", target: "firefox140", write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("reference prefix extraction strips source punctuation without rewriting author content", () => {
  for (const prefix of ["[12]", "[ 12 ].", "［１２］．", "【12】、", "(12).", "（ １２ ）. ", "12.", "12)", "12、", "**[12]**", "__（12）.__",
    "〔12〕.", "〖１２〗。", "〘12〙", "〚12〛", "{12}.", "｛12｝", "〈12〉", "《12》", "「12」", "『12』", "<12>", "＜12＞", "⟨12⟩", "❨12❩", "﹙12﹚", "［12]", "（12)", "12】."]) {
    const value = api.referencePrefix(`${prefix} Author A. **Title**. 2025.`);
    assert.equal(value?.number, 12, prefix); assert.equal(value?.content, "Author A. **Title**. 2025.", prefix);
  }
  assert.equal(api.referencePrefix("[0] First reference").number, 0);
  for (const text of ["2025. A year-first citation", "1.25 is a decimal", "An author (12).", "[12]", "[arXiv] A paper", "[12） Title", "（12] Title", "A12B Title", "<12] Title"]) assert.equal(api.referencePrefix(text), undefined, text);
  assert.equal(api.referencePrefix("[12]", true).number, 12);
});

test("unnumbered cross-page entries merge using continuation evidence while keeping new citations and boundaries separate", () => {
  for (const [before, after, expected] of [
    ['Synthetic Author. 2021, “Synthetic Difference-in-', 'Differences", Journal, 111(12), 1–20.', 'Synthetic Author. 2021, “Synthetic Difference-in-Differences", Journal, 111(12), 1–20.'],
    ['Synthetic Author. “An unfinished', 'Title”, Journal, 2025.', 'Synthetic Author. “An unfinished Title”, Journal, 2025.'],
    ["Synthetic Author. A study of", "economic change. Journal, 2025.", "Synthetic Author. A study of economic change. Journal, 2025."],
    ["测试作者：《跨页的研究", "标题》，测试期刊，2025。", "测试作者：《跨页的研究标题》，测试期刊，2025。"],
  ]) {
    const input = [block("a", before), block("b", after, "reference", 2), block("c", "Nextauthor, A., 2025, A different paper.", "reference", 2)];
    const entries = api.referenceEntries(input);
    assert.equal(entries.length, 2); assert.equal(entries[0].number, null); assert.equal(entries[0].markdown, expected);
    assert.deepEqual(entries[0].blockIds, ["a", "b"]); assert.equal(entries[1].markdown, input[2].markdown);
    for (const alternative of [block("b", after), block("b", after, "reference", 3), block("b", "〔2〕 New numbered entry.", "reference", 2),
      block("b", "Nextauthor, A., 2025, A different paper.", "reference", 2)]) {
      assert.equal(api.referenceEntries([input[0], alternative]).length, 2);
    }
    assert.equal(api.referenceEntries([input[0], block("heading", "Appendix", "heading"), input[1]]).length, 2);
    assert.equal(api.referenceEntries([input[0], block("image", "![](x)", "image"), input[1]]).length, 1);
  }
  assert.equal(api.referenceEntries([block("a", "Author. A complete citation."), block("b", "Another independent citation.", "reference", 2)]).length, 2);
});

const block = (id, markdown, type = "reference", page = 1) => ({ id, markdown, type, page, pageEnd: page });
test("entry grouping preserves explicit numbers, splits packed entries and keeps unnumbered citations independent", () => {
  const input = [block("a", "（3）. Author. First title."), block("b", "English translation."), block("photo", "![](x)", "image"),
    block("c", "Continued journal details.", "reference", 2), block("d", "[7]. Next title.\n[9] Last title.", "reference", 2),
    block("heading", "Appendix", "heading", 2), block("e", "Unnumbered Author. Title."), block("f", "Another Author. Title.")];
  const before = structuredClone(input), entries = api.referenceEntries(input);
  assert.deepEqual(input, before);
  assert.deepEqual(entries.map(e => e.number), [3, 7, 9, null, null]);
  assert.equal(entries[0].markdown, "Author. First title.\n\nEnglish translation.\n\nContinued journal details.");
  assert.deepEqual(entries[0].blockIds, ["a", "b", "c"]);
  assert.deepEqual(entries.slice(1, 3).map(e => e.blockIds), [["d"], ["d"]]);
  assert.deepEqual(entries.map(e => e.order), [0, 1, 2, 3, 4]);
  assert.equal(api.referenceEntries([block("a", "[1] First"), { ...block("b", "[2] Manually reviewed"), protected: true }, block("c", "Uncertain continuation")]).length, 2);
  assert.equal(api.referenceEntries([block("a", "[1] First"), block("b", "Separate unknown text", "reference", 4)]).length, 2);
  assert.deepEqual(api.referenceEntries([block("packed", "[1] First\n[2]\nSecond title")]).map(e => [e.number, e.markdown]), [[1, "First"], [2, "Second title"]]);
  const separated = api.referenceEntries([block("first", "[1] First"), block("number", "（2）."), block("body", "Second title")]);
  assert.deepEqual(separated.map(e => [e.number, e.markdown]), [[1, "First"], [2, "Second title"]]);
  assert.deepEqual(separated[1].blockIds, ["number", "body"]);
});

async function published(t) {
  const f = await parsingFixture(t), id = await f.enqueue(), job = await f.repository.claim(f.worker.owner);
  const doc = parsing.parsePaddleResult(result([page()]));
  const template = doc.blocks[1];
  doc.blocks = [
    { ...template, type: "heading", label: "paragraph_title", headingLevel: 2, markdown: "## References", text: "References", sourceID: "heading" },
    ...["[3]. Author A. First reference.", "A continued translated title.", "（7）. Author B. Second reference.", "Author C. Unnumbered citation."].map((markdown, index) => ({
      ...template, type: "reference", label: "reference_content", markdown, text: markdown, sourceID: String(index), sourceIDs: [String(index)],
      locations: [{ page: 1, bbox: [10, 100 + index * 50, 500, 140 + index * 50], sourceID: String(index) }],
    })),
  ];
  // An unnumbered citation after a structural boundary has no numbered owner.
  doc.blocks.splice(4, 0, { ...template, type: "heading", label: "paragraph_title", headingLevel: 2, markdown: "## Bibliography", text: "Bibliography", sourceID: "boundary" });
  doc.markdown = doc.blocks.map(b => b.markdown).join("\n\n");
  const generation = await f.repository.publish(job, doc, []);
  return { ...f, id, generation, doc };
}

test("publication stores number-free merged entries, complete provenance and reader labels", async t => {
  const f = await published(t), entries = await api.readReferences(f.db, f.generation);
  assert.equal(entries.length, 3); assert.deepEqual(entries.map(e => e.number), [3, 7, null]);
  assert.equal(entries[0].markdown, "Author A. First reference.\n\nA continued translated title.");
  assert.equal(entries[0].blockIds.length, 2);
  const row = await f.db.selectFrom("resource_references").selectAll().where("id", "=", entries[0].id).executeTakeFirstOrThrow();
  assert.equal(row.label, "3"); assert.equal(row.reference_number, 3); assert.equal(row.entry_order, 0);
  const content = await new parsing.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" });
  assert.deepEqual(content.references, entries);
  assert.ok(content.markdown.includes("[3]. Author"), "immutable canonical source stays traceable");
  const dom = new JSDOM("<article></article>"); t.after(() => dom.window.close());
  const host = dom.window.document.querySelector("article"); host.append(api.renderStructuredContent(dom.window.document, content, () => {}).fragment);
  assert.deepEqual([...host.querySelectorAll(".km-reference-number")].map(e => e.textContent), ["[3]", "[7]", "[3]"]);
  assert.ok(!host.querySelector(".km-reference-body").textContent.includes("[3]"));
  assert.equal(host.querySelectorAll(".km-reference-entry").length, 3);
  const tokens = new api.McpTokens(f.db), cursors = new api.McpCursor(f.db); await cursors.start();
  const tools = new api.McpTools(tokens, cursors); t.after(() => tools.close());
  const created = await tokens.create({ name: "Read", libraryIds: [f.target.libraryID], scopes: ["knowledge:read"] });
  const principal = await tokens.authenticate(created.secret);
  const response = await tools.call("list_references", { resourceId: f.input.resourceID, responseMode: "full" }, principal, new AbortController().signal);
  assert.equal(response.isError, undefined); const item = response.structuredContent.items[0];
  assert.equal(item.referenceNumber, 3); assert.equal(item.rawText, entries[0].markdown);
  assert.equal(item.sourceBlockIds.length, 2); assert.equal(item.locations.length, 2);
});

test("legacy projection is transactional and idempotent and preserves manual corrections and tombstones", async t => {
  const f = await published(t);
  await f.db.deleteFrom("content_reference_projections").execute();
  await f.db.deleteFrom("resource_references").execute();
  const blocks = await f.db.selectFrom("content_blocks").selectAll().where("generation_id", "=", f.generation).where("block_type", "=", "reference").orderBy("canonical_order").execute();
  for (const [index, b] of blocks.entries()) await f.db.insertInto("resource_references").values({ id: b.id, resource_id: f.input.resourceID, source_id: f.input.sourceID,
    generation_id: f.generation, source_block_id: b.id, reference_type: "bibliography", raw_text: b.content_markdown,
    ...(index === 2 ? { match_status: "manual", raw_text: "[7]. Reviewed title." } : {}), ...(index === 3 ? { deleted_at: 1 } : {}), created_at: 0, updated_at: 0 }).execute();
  const snapshot = () => f.native.sqlite.prepare("SELECT * FROM resource_references ORDER BY id").all();
  const before = snapshot();
  f.native.options.fail = sql => sql.startsWith('insert into "reference_source_blocks"');
  await assert.rejects(f.db.transaction().execute(tx => api.projectReferenceContent(tx, f.generation, f.port.uuid)), /Injected/);
  assert.deepEqual(snapshot(), before);
  f.native.options.fail = undefined;
  const repository = new api.ReferenceContentRepository(f.db, f.port.uuid); await repository.backfill();
  const after = snapshot(); assert.equal(after.length, 3);
  assert.deepEqual(after.filter(r => r.match_status === "manual" || r.deleted_at), before.filter(r => r.match_status === "manual" || r.deleted_at));
  assert.equal(after.find(r => r.reference_number === 3).raw_text, "Author A. First reference.\n\nA continued translated title.");
  await repository.backfill(); assert.deepEqual(snapshot(), after);
  const content = await new parsing.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" });
  const dom = new JSDOM("<article></article>"); t.after(() => dom.window.close());
  const host = dom.window.document.querySelector("article"); host.append(api.renderStructuredContent(dom.window.document, content, () => {}).fragment);
  const manual = [...host.querySelectorAll(".km-reference-entry")].find(e => e.textContent.includes("Reviewed title."));
  assert.equal(manual.querySelector(".km-reference-number").textContent, "[7]");
  assert.equal(manual.querySelector(".km-reference-body").textContent, "Reviewed title.");
  assert.equal(f.native.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("projection v1 upgrades split unnumbered pages and bracket labels without overwriting edited or deleted entries", async t => {
  const f = await parsingFixture(t), jobID = await f.enqueue(), job = await f.repository.claim(f.worker.owner);
  const doc = parsing.parsePaddleResult(result([page()])), template = doc.blocks[1];
  const texts = ['Synthetic Author, 2021, “Synthetic Difference-in-', 'Differences", Journal, 111(12), 1–20.',
    "Nextauthor, A., 2025, Independent title.", "[7] Reviewed author. A title", "Translated fragment.", "[8] Deleted entry.", "〔9〕. New bracket entry."];
  doc.blocks = texts.map((markdown, index) => ({ ...template, type: "reference", label: "reference_content", markdown, text: markdown,
    page: index ? 2 : 1, pageEnd: index ? 2 : 1, sourceID: String(index), sourceIDs: [String(index)],
    locations: [{ page: index ? 2 : 1, bbox: [10, 100, 500, 140], sourceID: String(index) }] }));
  doc.blocks.splice(6, 0, { ...template, type: "heading", label: "paragraph_title", headingLevel: 2, markdown: "## Additional references", text: "Additional references" });
  doc.markdown = doc.blocks.map(b => b.markdown).join("\n\n");
  const generation = await f.repository.publish(job, doc, []);
  const blocks = await f.db.selectFrom("content_blocks").selectAll().where("generation_id", "=", generation).orderBy("canonical_order").execute();
  const canonical = blocks.map(b => ({ id: b.id, type: b.block_type, markdown: b.content_markdown, page: b.page_start, pageEnd: b.page_end }));
  await f.db.deleteFrom("resource_references").execute();
  await f.db.updateTable("content_reference_projections").set({ version: 1 }).execute();
  for (const e of api.legacyReferenceEntries(canonical)) {
    const id = e.blockIds[0];
    await f.db.insertInto("resource_references").values({ id, resource_id: f.input.resourceID, source_id: f.input.sourceID, generation_id: generation,
      source_block_id: id, reference_type: "bibliography", raw_text: e.markdown, reference_number: e.number, label: e.label, entry_order: e.order,
      created_at: 1, updated_at: 1 }).execute();
    for (const [ordinal, block_id] of e.blockIds.entries()) await f.db.insertInto("reference_source_blocks").values({ reference_id: id, generation_id: generation, block_id, ordinal }).execute();
  }
  await f.db.updateTable("resource_references").set({ raw_text: "A manually corrected unmatched entry." }).where("source_block_id", "=", blocks[2].id).execute();
  await f.db.updateTable("resource_references").set({ match_status: "manual", raw_text: "A reviewed merged entry." }).where("reference_number", "=", 7).execute();
  await f.db.updateTable("resource_references").set({ deleted_at: 2 }).where("reference_number", "=", 8).execute();
  const snapshot = () => f.native.sqlite.prepare("SELECT * FROM resource_references ORDER BY id").all();
  const protectedRows = snapshot().filter(r => [blocks[2].id, blocks[3].id, blocks[5].id].includes(r.id)), before = snapshot();
  f.native.options.fail = sql => sql.startsWith('insert into "reference_source_blocks"');
  const repository = new api.ReferenceContentRepository(f.db, f.port.uuid);
  await assert.rejects(repository.backfill(), /Injected/); assert.deepEqual(snapshot(), before);
  assert.equal((await f.db.selectFrom("content_reference_projections").select("version").executeTakeFirst()).version, 1);
  f.native.options.fail = undefined; await repository.backfill();
  const rows = snapshot();
  assert.equal(rows.length, 5); assert.deepEqual(rows.filter(r => protectedRows.some(p => p.id === r.id)), protectedRows);
  const first = rows.find(r => r.id === blocks[0].id);
  assert.equal(first.reference_number, null); assert.equal(first.raw_text, texts[0] + texts[1]);
  assert.equal(rows.find(r => r.reference_number === 9).raw_text, "New bracket entry.");
  const read = await api.readReferences(f.db, generation); assert.deepEqual(read[0].blockIds, [blocks[0].id, blocks[1].id]);
  assert.ok(!read.some(r => r.markdown === "Translated fragment."), "all source blocks of a reviewed merge stay protected");
  assert.equal((await f.db.selectFrom("content_reference_projections").select("version").executeTakeFirst()).version, 2);
  await repository.backfill(); assert.deepEqual(snapshot(), rows);
  const content = await new parsing.ProcessedContentReader(f.db, f.port).read({ libraryID: 1, itemKey: "PDFKEY01" });
  const dom = new JSDOM("<article></article>"); t.after(() => dom.window.close());
  const host = dom.window.document.querySelector("article"); host.append(api.renderStructuredContent(dom.window.document, content, () => {}).fragment);
  const merged = host.querySelector(".km-reference-entry");
  assert.equal(merged.querySelector(".km-reference-body").textContent, texts[0] + texts[1]);
  assert.equal(merged.querySelector(".km-reference-number").textContent, "[1]");
  assert.equal(f.native.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
});
