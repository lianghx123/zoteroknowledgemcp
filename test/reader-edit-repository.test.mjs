import assert from "node:assert/strict";
import { test } from "node:test";
import { api, parsingFixture, bytes, page, result } from "./fixtures/parsing.mjs";

async function fixture(t) {
  const f = await parsingFixture(t, { async download() {
    const p = page("Editable paper");
    p.prunedResult.parsing_res_list.push({ block_label: "paragraph_title", block_id: 2, block_content: "Methods", block_bbox: [10, 150, 550, 190] },
      { block_label: "text", block_id: 3, block_content: "Another unchanged source paragraph provides detailed scientific evidence about regional innovation, industrial capability and related research methods.", block_bbox: [10, 210, 550, 250] },
      { block_label: "reference_content", block_id: 4, block_content: "[1] Smith. A source reference.", block_bbox: [10, 300, 550, 340] });
    return bytes(result([p]));
  } });
  await f.enqueue(); await f.step(); await f.step();
  const attachment = { libraryID: 1, itemKey: "PDFKEY01" }, reader = new api.ProcessedContentReader(f.db, f.port);
  const content = await reader.read(attachment);
  return { ...f, reader, content, attachment, editor: new api.ReaderEditRepository(f.db, f.port) };
}

test("document save atomically publishes an edit generation, preserves original content and rebuilds ordered sections/FTS", async t => {
  const f = await fixture(t), original = JSON.stringify(f.content);
  const blocks = f.content.blocks.map(block => ({ ...block }));
  blocks[1].markdown = "Revised capability evidence with a unique editedneedle.";
  blocks.splice(2, 0, { id: "reader-session-1", type: "heading", label: "paragraph_title", markdown: "## New section", pageStart: 99 });
  blocks.splice(3, 0, { id: "reader-session-2", type: "paragraph", label: "text", markdown: "A new manual paragraph.", pageStart: 99 });
  const saved = await f.editor.save({ attachment: f.attachment, baseGenerationID: f.content.generationID, blocks });
  assert.notEqual(saved.generationID, f.content.generationID); assert.equal(saved.blocks.length, blocks.length);
  assert.equal(saved.blocks[2].pageStart, null); assert.equal(saved.blocks[3].pageEnd, null);
  const generation = await f.db.selectFrom("content_generations").selectAll().where("id", "=", saved.generationID).executeTakeFirstOrThrow();
  assert.equal(generation.origin, "edit"); assert.equal(generation.base_generation_id, f.content.generationID);
  assert.equal(generation.state, "ready"); assert.equal(generation.content_version, generation.base_content_version + 1);
  assert.equal((await f.db.selectFrom("content_generations").select("state").where("id", "=", f.content.generationID).executeTakeFirstOrThrow()).state, "superseded");
  assert.equal((await f.db.selectFrom("content_blocks").select("content_markdown").where("id", "=", f.content.blocks[1].id).executeTakeFirstOrThrow()).content_markdown, f.content.blocks[1].markdown);
  const rows = await f.db.selectFrom("content_blocks").selectAll().where("generation_id", "=", saved.generationID).orderBy("canonical_order").execute();
  assert.deepEqual(rows.map(row => row.canonical_order), rows.map((_, index) => index));
  assert.equal(rows[1].is_user_modified, 1); assert.equal(rows[0].is_user_modified, 0); assert.equal(rows[1].supersedes_block_id, f.content.blocks[1].id);
  const sections = await f.db.selectFrom("structure_nodes").selectAll().where("generation_id", "=", saved.generationID).where("node_type", "=", "section").execute();
  assert.ok(sections.some(section => section.label === "New section"));
  const indexed = await f.db.selectFrom("search_documents").selectAll().where("generation_id", "=", saved.generationID).execute();
  assert.equal(indexed.length, blocks.length); assert.ok(indexed.some(row => row.body.includes("editedneedle")));
  const reopened = await f.reader.read(f.attachment); assert.equal(reopened.generationID, saved.generationID); assert.equal(reopened.markdown, saved.markdown);
  assert.equal(JSON.stringify(f.content), original);
  assert.equal((await f.db.selectFrom("resource_revisions").selectAll().where("change_type", "=", "content_edit").execute()).length, 1);
  await assert.rejects(f.editor.save({ attachment: f.attachment, baseGenerationID: f.content.generationID, blocks }), /reader-save-conflict/);
});

test("save rejects foreign identities, empty blocks and source changes and rolls back a failed publication", async t => {
  const f = await fixture(t), request = { attachment: f.attachment, baseGenerationID: f.content.generationID, blocks: f.content.blocks.map(block => ({ ...block })) };
  const generations = async () => (await f.db.selectFrom("content_generations").select("id").execute()).length;
  const before = await generations();
  await assert.rejects(f.editor.save({ ...request, blocks: [{ ...request.blocks[0], id: "foreign-block-id" }] }), /reader-save-invalid/);
  await assert.rejects(f.editor.save({ ...request, blocks: [{ ...request.blocks[0], markdown: " " }] }), /reader-save-invalid/);
  await assert.rejects(f.editor.save({ ...request, attachment: { libraryID: 1, itemKey: "OTHERPDF" } }), /reader-save-conflict/);
  assert.equal(await generations(), before);
  request.blocks[1].markdown = "A transaction must not partly publish this content.";
  await f.native.queryAsync("CREATE TRIGGER fail_edit_publish BEFORE INSERT ON resource_revisions WHEN NEW.change_type='content_edit' BEGIN SELECT RAISE(ABORT, 'forced-edit-failure'); END", [], { noParseParams: true, noCache: true });
  await assert.rejects(f.editor.save(request), /forced-edit-failure/);
  assert.equal(await generations(), before); assert.equal((await f.reader.read(f.attachment)).generationID, f.content.generationID);
  await f.native.queryAsync("DROP TRIGGER fail_edit_publish", [], { noParseParams: true, noCache: true });
  await f.db.updateTable("resource_sources").set({ source_version: 2 }).where("id", "=", f.input.sourceID).execute();
  await assert.rejects(f.editor.save(request), /reader-save-conflict/); assert.equal(await generations(), before);
});

test("saved edits preserve unchanged references and annotations while retaining changed anchors historically", async t => {
  const f = await fixture(t), originalBlocks = f.content.blocks;
  const version = (await f.db.selectFrom("knowledge_resources").select("version").where("id", "=", f.input.resourceID).executeTakeFirstOrThrow()).version;
  for (const [index, block] of originalBlocks.slice(0, 2).entries()) await f.db.insertInto("resource_annotations").values({ id: `annotation-${index}`, resource_id: f.input.resourceID,
    source_id: f.input.sourceID, generation_id: f.content.generationID, structure_node_id: null, content_block_id: block.id, resource_version: version,
    annotation_type: "evidence", text: `Keep user note ${index}`, quote: null, confidence: null, created_by_type: "user", created_by: null, created_at: 1, updated_at: 1, deleted_at: null }).execute();
  const blocks = originalBlocks.map(block => ({ ...block })); blocks[1].markdown += " A manual correction.";
  const saved = await f.editor.save({ attachment: f.attachment, baseGenerationID: f.content.generationID, blocks });
  const notes = await f.db.selectFrom("resource_annotations").selectAll().orderBy("id").execute();
  assert.equal(notes[0].generation_id, saved.generationID); assert.equal(notes[0].anchor_state, "current");
  assert.equal(notes[1].generation_id, f.content.generationID); assert.equal(notes[1].anchor_state, "historical");
  assert.equal(notes[1].text, "Keep user note 1");
  assert.ok(saved.references.length > 0); assert.equal(saved.references[0].markdown, f.content.references[0].markdown);
  const second = saved.blocks.map(block => ({ ...block })); second.at(-1).markdown = "[1] A revised bibliography entry.";
  const again = await f.editor.save({ attachment: f.attachment, baseGenerationID: saved.generationID, blocks: second });
  assert.ok(again.references.some(reference => reference.markdown.includes("revised bibliography")));
});

test("document save reuses matching vectors for unchanged blocks and leaves edited text for normal indexing", async t => {
  const f = await fixture(t), repository = new api.EmbeddingRepository(f.db), config = structuredClone(api.defaultRetrievalConfig);
  config.enabled = true; const profile = await repository.profile(config); await repository.reconcile(profile, config);
  const job = await f.db.selectFrom("processing_jobs").selectAll().where("kind", "=", "embed").executeTakeFirstOrThrow();
  await repository.prepare(job.generation_id, profile, config);
  const pending = await repository.pending(job.generation_id, profile, 100); assert.ok(pending.length);
  await f.db.updateTable("processing_jobs").set({ state: "running", lease_owner: "test", execution_token: "token", started_at: Date.now(), lease_expires_at: Date.now() + 600000 }).where("id", "=", job.id).execute();
  await repository.commit(job.id, "token", profile, pending, pending.map(() => api.normalizedVector(Array(768).fill(1), 768)));
  const vectors = await f.db.selectFrom("block_embeddings").selectAll().where("generation_id", "=", f.content.generationID).execute();
  const blocks = f.content.blocks.map(block => ({ ...block })); blocks[1].markdown = "The edited paragraph now contains comprehensive new material on innovation, industrial capabilities and publication quality, requiring its own updated semantic embedding.";
  const saved = await f.editor.save({ attachment: f.attachment, baseGenerationID: f.content.generationID, blocks });
  const copied = await f.db.selectFrom("block_embeddings").selectAll().where("generation_id", "=", saved.generationID).execute();
  assert.equal(copied.length, vectors.filter(vector => vector.content_block_id !== blocks[1].id).length);
  assert.ok(copied.length); assert.deepEqual(copied[0].vector, vectors[0].vector);
  assert.ok(copied.every(vector => vector.content_block_id !== saved.blocks[1].id));
  await repository.prepare(saved.generationID, profile, config);
  const needsEmbedding = await repository.pending(saved.generationID, profile, 100);
  assert.ok(needsEmbedding.length); assert.ok(needsEmbedding.every(row => row.block_id === saved.blocks[1].id));
});

test("post-save index refresh is local and does not wait on an in-progress configuration change", async t => {
  const f = await fixture(t), embeddings = new api.EmbeddingService(f.db, "file:///fixture/");
  f.beforeClose(() => embeddings.close());
  embeddings.config.current = { ...structuredClone(api.defaultRetrievalConfig), enabled: true };
  embeddings.gateway.embed = async () => { assert.fail("local content refresh must not call an embedding provider"); };
  let syncs = 0; embeddings.store.sync = async () => { syncs++; };
  await embeddings.refreshContent(f.content.generationID); assert.equal(syncs, 1);
  assert.ok(await f.db.selectFrom("embedding_segments").select("id").executeTakeFirst());
  embeddings.clearing = 1; await embeddings.refreshContent(f.content.generationID);
  assert.equal(syncs, 1); embeddings.clearing = 0;
});
