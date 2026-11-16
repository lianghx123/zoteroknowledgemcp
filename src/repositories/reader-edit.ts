import { sql, type Kysely } from "kysely";
import type { Database } from "../database/types";
import type { DatabaseContext } from "../database/unit-of-work";
import type { ParsingPort } from "../shared/contracts/parsing";
import { ReaderSaveError, readerBlockType, type ReaderSaveRequest } from "../shared/contracts/reader-edit";
import type { AttachmentMarkdown } from "../shared/contracts/knowledge-content";
import type { ReaderContentBlock } from "../shared/contracts/visual-content";
import { validateAttachment, validateMarkdown } from "../schemas/knowledge-content";
import { normalizeOCRText } from "../parsers/content";
import { fulltextProfile, searchOffsets, searchTokens } from "../services/search-text";
import { ProcessedContentReader } from "./processed-content";
import { projectReferenceContent, readReferences } from "./reference-content";
import { readVisualLinks, VISUAL_PROJECTION_VERSION } from "./visual-content";

/** Publishes one immutable user revision. No writes occur before explicit document save. */
export class ReaderEditRepository {
  constructor(private readonly db: Kysely<Database>, private readonly port: ParsingPort) {}

  async save(request: ReaderSaveRequest): Promise<AttachmentMarkdown> {
    validateAttachment(request.attachment);
    if (!request.baseGenerationID || !Array.isArray(request.blocks) || !request.blocks.length
      || new Set(request.blocks.map(block => block.id)).size !== request.blocks.length
      || request.blocks.some(block => typeof block.id !== "string" || typeof block.type !== "string" || typeof block.label !== "string"
        || typeof block.markdown !== "string" || !block.markdown.trim())) throw new ReaderSaveError("invalid");
    const drafts = request.blocks.map(block => ({ id: block.id, type: block.type, label: block.label, markdown: block.markdown }));
    const markdown = drafts.map(block => block.markdown).join("\n\n"); validateMarkdown(markdown);
    const base = await new ProcessedContentReader(this.db, this.port).read(request.attachment);
    if (!base || base.generationID !== request.baseGenerationID) throw new ReaderSaveError("conflict");
    const generationID = this.port.uuid(), fingerprint = await this.port.hash(JSON.stringify(drafts)), hashes = await Promise.all(drafts.map(block => this.port.hash(block.markdown)));
    return this.db.transaction().execute(async tx => {
      const source = await tx.selectFrom("zotero_item_links as z").innerJoin("zotero_libraries as l", "l.id", "z.zotero_library_id")
        .innerJoin("resource_sources as s", "s.id", "z.source_id").innerJoin("content_generations as g", "g.id", "s.active_generation_id")
        .innerJoin("knowledge_resources as r", "r.id", "s.resource_id")
        .select(["s.id", "s.resource_id", "s.content_version", "s.source_version", "s.source_fingerprint", "g.page_manifest_json", "g.warnings_json", "g.state", "r.version"])
        .where("z.item_key", "=", request.attachment.itemKey).where("l.local_library_id", "=", request.attachment.libraryID)
        .where("z.state", "=", "current").where("l.availability", "=", "available").where("s.deleted_at", "is", null)
        .where("r.status", "=", "active").where("r.deleted_at", "is", null).where("g.id", "=", request.baseGenerationID)
        .where("g.state", "in", ["ready", "partial"]).whereRef("g.source_version", "=", "s.source_version")
        .whereRef("g.source_fingerprint", "=", "s.source_fingerprint")
        .whereRef("g.content_version", "=", "s.content_version")
        .where(eb => eb.exists(eb.selectFrom("library_resources as m").innerJoin("knowledge_libraries as k", "k.id", "m.library_id")
          .select("m.id").whereRef("m.resource_id", "=", "s.resource_id").where("m.deleted_at", "is", null).where("k.status", "=", "active"))).executeTakeFirst();
      if (!source?.source_fingerprint) throw new ReaderSaveError("conflict");
      const old = await tx.selectFrom("content_blocks").selectAll().where("generation_id", "=", request.baseGenerationID).orderBy("canonical_order").execute();
      const byID = new Map(old.map(block => [block.id, block]));
      const unchanged = new Set(drafts.filter(block => {
        const prior = byID.get(block.id);
        return prior && prior.content_markdown === block.markdown && prior.block_type === block.type
          && String(JSON.parse(prior.metadata_json).ocr_label ?? "") === block.label;
      }).map(block => block.id));
      for (const block of drafts) {
        if ((!byID.has(block.id) && !/^reader-session-\d+$/.test(block.id)) || (!unchanged.has(block.id) && !readerBlockType(block.type))) throw new ReaderSaveError("invalid");
      }
      if (drafts.length === old.length && drafts.every((block, index) => old[index].id === block.id && unchanged.has(block.id))) return base;
      const now = Date.now(), ids = new Map(drafts.map(block => [block.id, this.port.uuid()]));
      await tx.insertInto("content_generations").values({ id: generationID, source_id: source.id, resource_id: source.resource_id,
        parse_run_id: null, base_generation_id: request.baseGenerationID, base_content_version: source.content_version, content_version: source.content_version + 1,
        source_version: source.source_version, source_fingerprint: source.source_fingerprint, origin: "edit", state: "staging", content_fingerprint: fingerprint,
        normalizer_version: "reader-edit-1", page_manifest_json: source.page_manifest_json, warnings_json: source.warnings_json,
        created_by_type: "user", created_by: null, created_at: now, published_at: null }).execute();
      const root = this.port.uuid();
      await tx.insertInto("structure_nodes").values({ id: root, generation_id: generationID, parent_id: null, node_type: "root", label: null, path: "/", depth: 0,
        sort_order: 0, canonical_order_start: 0, canonical_order_end: drafts.length - 1, page_start: null, page_end: null,
        source_type: "manual", source_ref_id: null, confidence: null, review_status: "reviewed", is_user_modified: 1, created_at: now }).execute();
      const sections = new Map<string, { end: number; start: number | null; finish: number | null }>();
      const stack: Array<{ id: string; level: number; path: string; depth: number }> = [{ id: root, level: 0, path: "", depth: 0 }];
      const childOrder = new Map<string, number>(), localOrder = new Map<string, number>(), published: ReaderContentBlock[] = [];
      for (const [order, block] of drafts.entries()) {
        const prior = byID.get(block.id), same = unchanged.has(block.id), metadata = prior ? JSON.parse(prior.metadata_json) : {};
        const page = prior?.page_start ?? null, end = prior?.page_end ?? null;
        if (block.type === "heading" && block.label !== "doc_title") {
          const level = /^\s*(#{1,6})(?:\s|$)/.exec(block.markdown)?.[1].length ?? 2;
          while (stack.length > 1 && stack.at(-1)!.level >= level) stack.pop();
          const parent = stack.at(-1)!, ordinal = childOrder.get(parent.id) ?? 0; childOrder.set(parent.id, ordinal + 1);
          const section = { id: this.port.uuid(), level, path: `${parent.path}/${ordinal + 1}`, depth: parent.depth + 1 };
          await tx.insertInto("structure_nodes").values({ id: section.id, generation_id: generationID, parent_id: parent.id, node_type: "section",
            label: normalizeOCRText(block.markdown), path: section.path, depth: section.depth, sort_order: ordinal,
            canonical_order_start: order, canonical_order_end: order, page_start: page, page_end: end,
            source_type: "manual", source_ref_id: null, confidence: null, review_status: "reviewed", is_user_modified: 1, created_at: now }).execute();
          stack.push(section);
        }
        for (const section of stack) {
          const range = sections.get(section.id) ?? { end: order, start: null, finish: null }; range.end = order;
          if (page !== null) range.start = Math.min(range.start ?? page, page);
          if (end !== null) range.finish = Math.max(range.finish ?? end, end);
          sections.set(section.id, range);
        }
        const parent = stack.at(-1)!.id, local = localOrder.get(parent) ?? 0; localOrder.set(parent, local + 1);
        const id = ids.get(block.id)!;
        await tx.insertInto("content_blocks").values({ id, generation_id: generationID, structure_node_id: parent, parent_block_id: null,
          supersedes_block_id: prior?.id ?? null, block_type: block.type, content_role: block.type === "footnote" ? "note" : "body",
          canonical_order: order, local_order: local, content_markdown: block.markdown,
          content_normalized: same ? prior!.content_normalized : normalizeOCRText(block.markdown), content_hash: hashes[order],
          source_type: same ? prior!.source_type : "manual", source_block_ids_json: prior?.source_block_ids_json ?? "[]",
          page_start: page, page_end: end, locations_json: prior?.locations_json ?? "[]", confidence: prior?.confidence ?? null,
          review_status: same ? prior!.review_status : "corrected", is_user_modified: same ? prior!.is_user_modified : 1,
          quality_flags_json: same ? prior!.quality_flags_json : "[]", metadata_json: JSON.stringify({ ...metadata, label: block.label, ocr_label: block.label }), created_at: now }).execute();
        await tx.insertInto("search_documents").values({ document_kind: "block", resource_id: source.resource_id, source_id: source.id, generation_id: generationID, block_id: id,
          body: block.markdown, search_text: searchTokens(block.markdown), body_offsets_json: JSON.stringify(searchOffsets(block.markdown)), tokenizer_profile: fulltextProfile,
          indexed_version: source.content_version + 1, updated_at: now }).execute();
        published.push({ ...block, id, pageStart: page, pageEnd: end });
      }
      for (const [id, range] of sections) await tx.updateTable("structure_nodes").set({ canonical_order_end: range.end, page_start: range.start, page_end: range.finish }).where("id", "=", id).execute();
      for (const prior of old) {
        if (ids.has(prior.id) && prior.parent_block_id && ids.has(prior.parent_block_id)) await tx.updateTable("content_blocks").set({ parent_block_id: ids.get(prior.parent_block_id)! }).where("id", "=", ids.get(prior.id)!).execute();
      }
      const files = await tx.selectFrom("generation_files").select(["asset_key", "stored_file_id", "role"]).where("generation_id", "=", request.baseGenerationID).where("role", "=", "image").execute();
      for (const file of files) await tx.insertInto("generation_files").values({ generation_id: generationID, asset_key: file.asset_key, stored_file_id: file.stored_file_id, role: file.role }).execute();
      const types = new Map(drafts.map(block => [block.id, block.type]));
      const links = await tx.selectFrom("content_visual_links").selectAll().where("generation_id", "=", request.baseGenerationID).execute();
      for (const link of links) {
        if (!["image", "table"].includes(types.get(link.visual_block_id) ?? "") || (link.related_block_id && !["caption", "footnote"].includes(types.get(link.related_block_id) ?? ""))
          || (!link.related_block_id && !unchanged.has(link.visual_block_id))) continue;
        await tx.insertInto("content_visual_links").values({ id: this.port.uuid(), generation_id: generationID, visual_block_id: ids.get(link.visual_block_id)!,
          related_block_id: link.related_block_id ? ids.get(link.related_block_id)! : null, role: link.role, position: link.position, evidence: link.evidence,
          ordinal: link.ordinal, content_markdown: link.content_markdown, created_at: now }).execute();
      }
      await tx.insertInto("content_visual_projections").values({ generation_id: generationID, version: VISUAL_PROJECTION_VERSION, completed_at: now }).execute();
      await this.copyReferences(tx, request.baseGenerationID, generationID, ids, unchanged, now);
      await projectReferenceContent(tx, generationID, () => this.port.uuid());
      await this.copyVectors(tx, request.baseGenerationID, generationID, ids, unchanged, now);
      await tx.updateTable("content_generations").set({ state: source.state, published_at: now }).where("id", "=", generationID).execute();
      await tx.updateTable("resource_sources").set({ active_generation_id: generationID, content_version: source.content_version + 1, updated_at: now }).where("id", "=", source.id).execute();
      await tx.updateTable("content_generations").set({ state: "superseded" }).where("id", "=", request.baseGenerationID).execute();
      for (const id of unchanged) await tx.updateTable("resource_annotations").set({ generation_id: generationID, content_block_id: ids.get(id)!, resource_version: source.version + 1, updated_at: now })
        .where("generation_id", "=", request.baseGenerationID).where("content_block_id", "=", id).where("anchor_state", "=", "current").execute();
      await tx.updateTable("resource_annotations").set({ anchor_state: "historical", updated_at: now }).where("generation_id", "=", request.baseGenerationID).where("anchor_state", "=", "current").execute();
      await tx.updateTable("processing_jobs").set({ state: "cancelled", cancel_requested_at: now, lease_owner: null, execution_token: null, lease_expires_at: null, finished_at: now, updated_at: now })
        .where("kind", "=", "embed").where("generation_id", "=", request.baseGenerationID).where("state", "in", ["pending", "running", "waiting", "retry_wait"]).execute();
      await tx.updateTable("knowledge_resources").set({ version: sql`version + 1`, updated_at: now }).where("id", "=", source.resource_id).execute();
      await tx.insertInto("resource_revisions").values({ id: this.port.uuid(), resource_id: source.resource_id, operation_id: this.port.uuid(), base_version: source.version, result_version: source.version + 1,
        change_type: "content_edit", target_type: "resource_source", target_id: source.id, before_json: JSON.stringify({ generationID: request.baseGenerationID }),
        after_json: JSON.stringify({ generationID }), changes_json: JSON.stringify({ blocks: drafts.length, modified: drafts.filter(block => !unchanged.has(block.id)).length, removed: old.filter(block => !ids.has(block.id)).length }),
        created_by_type: "user", created_by: null, agent_run_id: null, created_at: now }).execute();
      await tx.insertInto("change_outbox").values({ event_id: this.port.uuid(), aggregate_type: "resource_source", aggregate_id: source.id,
        aggregate_version: source.content_version + 1, event_type: "content_published", payload_json: JSON.stringify({ generationID, origin: "edit" }), created_at: now }).execute();
      return { ...base, generationID, updatedAt: now, markdown, blocks: published, visualLinks: await readVisualLinks(tx, generationID), references: await readReferences(tx, generationID) };
    });
  }

  private async copyReferences(tx: DatabaseContext, before: string, generation: string, ids: Map<string, string>, unchanged: Set<string>, now: number): Promise<void> {
    const rows = await tx.selectFrom("resource_references").selectAll().where("generation_id", "=", before).execute();
    const links = await tx.selectFrom("reference_source_blocks").selectAll().where("generation_id", "=", before).execute();
    for (const row of rows) {
      const members = links.filter(link => link.reference_id === row.id);
      if (!row.source_block_id || !unchanged.has(row.source_block_id) || members.some(link => !unchanged.has(link.block_id))) continue;
      const id = this.port.uuid();
      await tx.insertInto("resource_references").values({ id, resource_id: row.resource_id, source_id: row.source_id, generation_id: generation, source_block_id: ids.get(row.source_block_id)!,
        target_resource_id: row.target_resource_id, target_source_id: row.target_source_id, target_generation_id: row.target_generation_id, target_block_id: row.target_block_id,
        reference_type: row.reference_type, label: row.label, raw_text: row.raw_text, parsed_json: row.parsed_json, match_status: row.match_status, confidence: row.confidence,
        created_at: row.created_at, updated_at: now, deleted_at: row.deleted_at, reference_number: row.reference_number, entry_order: row.entry_order }).execute();
      for (const member of members) await tx.insertInto("reference_source_blocks").values({ reference_id: id, generation_id: generation, block_id: ids.get(member.block_id)!, ordinal: member.ordinal }).execute();
    }
  }

  private async copyVectors(tx: DatabaseContext, before: string, generation: string, ids: Map<string, string>, unchanged: Set<string>, now: number): Promise<void> {
    const vectors = await tx.selectFrom("block_embeddings").selectAll().where("generation_id", "=", before).where("state", "=", "active").execute();
    const mapped = new Map<string, string>();
    for (const vector of vectors) {
      if (!unchanged.has(vector.content_block_id)) continue;
      const id = this.port.uuid(); mapped.set(vector.id, id);
      await tx.insertInto("block_embeddings").values({ id, generation_id: generation, content_block_id: ids.get(vector.content_block_id)!, profile_id: vector.profile_id,
        dimensions: vector.dimensions, input_text_hash: vector.input_text_hash, vector: vector.vector, state: "active", created_at: now, updated_at: now }).execute();
    }
    const segments = await tx.selectFrom("embedding_segments as s").innerJoin("content_blocks as b", "b.id", "s.block_id").selectAll("s").where("b.generation_id", "=", before).execute();
    for (const segment of segments) {
      if (!unchanged.has(segment.block_id)) continue;
      await tx.insertInto("embedding_segments").values({ id: this.port.uuid(), block_id: ids.get(segment.block_id)!, profile_id: segment.profile_id,
        ordinal: segment.ordinal, start_offset: segment.start_offset, end_offset: segment.end_offset, overlap: segment.overlap, input_text: segment.input_text,
        input_hash: segment.input_hash, skip_reason: segment.skip_reason, embedding_id: segment.embedding_id ? mapped.get(segment.embedding_id) ?? null : null, created_at: now }).execute();
    }
  }
}
