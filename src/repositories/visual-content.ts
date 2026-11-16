import type { Kysely } from "kysely";
import type { Database } from "../database/types";
import type { DatabaseContext } from "../database/unit-of-work";
import type { ParsedPage, ParsingPort } from "../shared/contracts/parsing";
import type { VisualLink } from "../shared/contracts/visual-content";
import { associateVisualBlocks } from "../services/visual-association";
import { object } from "../parsers/content";
import { parseFilePath } from "../storage/parse-files";

export const VISUAL_PROJECTION_VERSION = 1;

/** Derive links beside immutable canonical content, including already saved papers. */
export async function projectVisualContent(db: DatabaseContext, generationID: string, uuid: () => string, pages: ParsedPage[] = []): Promise<void> {
  const existing = await db.selectFrom("content_visual_projections").select("version").where("generation_id", "=", generationID).executeTakeFirst();
  if (existing) return;
  const rows = await db.selectFrom("content_blocks").selectAll().where("generation_id", "=", generationID).orderBy("canonical_order").execute();
  const blocks = rows.map(row => {
    const locations: unknown = JSON.parse(row.locations_json);
    return { id: row.id, type: row.block_type, label: String(object(JSON.parse(row.metadata_json)).ocr_label ?? ""), page: row.page_start, pageEnd: row.page_end,
      locations: Array.isArray(locations) ? locations.flatMap(value => {
        const location = object(value);
        return Number.isSafeInteger(location.page) && Array.isArray(location.bbox) && location.bbox.every(value => typeof value === "number")
          ? [{ page: location.page as number, bbox: location.bbox as number[] }] : [];
      }) : [] };
  });
  const ordinals = new Map<string, number>(), now = Date.now();
  for (const association of associateVisualBlocks(blocks)) {
    const key = `${association.visualBlockId}:${association.role}`, ordinal = ordinals.get(key) ?? 0; ordinals.set(key, ordinal + 1);
    await db.insertInto("content_visual_links").values({ id: uuid(), generation_id: generationID, visual_block_id: association.visualBlockId,
      related_block_id: association.relatedBlockId, role: association.role, position: association.position, evidence: association.evidence,
      ordinal, content_markdown: null, created_at: now }).execute();
  }
  // MinerU explicitly embeds captions and notes in its visual provider entry.
  // Recover these exact parts without splitting/relabeling its canonical block.
  const entries = pages.flatMap(page => {
    const content = object(page.raw.mineru).content; return Array.isArray(content) ? content.map(object) : [];
  });
  for (const row of rows) {
    if (!["image", "table"].includes(row.block_type)) continue;
    const metadata = object(JSON.parse(row.metadata_json));
    if (metadata.provider !== "mineru" || !Number.isSafeInteger(metadata.provider_index)) continue;
    const entry = entries[metadata.provider_index as number]; if (!entry) continue;
    const kind = String(metadata.provider_type), strings = (value: unknown): string[] => Array.isArray(value) && value.every(item => typeof item === "string") ? value.filter(Boolean) as string[] : [];
    const captions = strings(entry[`${kind}_caption`]), notes = strings(entry[`${kind}_footnote`]);
    if (!captions.length && !notes.length) continue;
    const prefix = captions.join("\n\n"), suffix = notes.map(note => `> ${note}`).join("\n\n");
    let body = row.content_markdown;
    if (prefix) { if (!body.startsWith(prefix)) continue; body = body.slice(prefix.length).replace(/^\n\n/, ""); }
    if (suffix) { if (!body.endsWith(suffix)) continue; body = body.slice(0, -suffix.length).replace(/\n\n$/, ""); }
    if ([...captions, body, ...notes.map(note => `> ${note}`)].filter(Boolean).join("\n\n") !== row.content_markdown) continue;
    const parts = [{ role: "body", position: "content", markdown: body, ordinal: 0 },
      ...captions.map((markdown, ordinal) => ({ role: "caption", position: "before", markdown, ordinal })),
      ...notes.map((markdown, ordinal) => ({ role: "note", position: "after", markdown: `> ${markdown}`, ordinal }))];
    for (const part of parts) await db.insertInto("content_visual_links").values({ id: uuid(), generation_id: generationID,
      visual_block_id: row.id, related_block_id: null, role: part.role, position: part.position, evidence: "provider",
      ordinal: part.ordinal + (ordinals.get(`${row.id}:${part.role}`) ?? 0),
      content_markdown: part.markdown, created_at: now }).execute();
  }
  await db.insertInto("content_visual_projections").values({ generation_id: generationID, version: VISUAL_PROJECTION_VERSION, completed_at: now }).execute();
}

export class VisualContentRepository {
  constructor(private readonly db: Kysely<Database>, private readonly port: Pick<ParsingPort, "uuid" | "read" | "hash">) {}
  async backfill(): Promise<void> {
    const generations = await this.db.selectFrom("content_generations as g").leftJoin("content_visual_projections as p", "p.generation_id", "g.id")
      .select("g.id").where("g.origin", "=", "parse").where("g.state", "in", ["ready", "partial", "superseded"]).where("p.generation_id", "is", null).execute();
    for (const generation of generations) {
      let pages: ParsedPage[] = [];
      const mineru = await this.db.selectFrom("content_blocks").select("id").where("generation_id", "=", generation.id)
        .where("metadata_json", "like", '%"provider":"mineru"%').executeTakeFirst();
      if (mineru) {
        const file = await this.db.selectFrom("generation_files as g").innerJoin("stored_files as f", "f.id", "g.stored_file_id")
          .select(["f.relative_path", "f.sha256", "f.byte_length"]).where("g.generation_id", "=", generation.id).where("g.role", "=", "pages").executeTakeFirst();
        if (file && file.byte_length <= 32 * 1024 * 1024) try {
          const bytes = await this.port.read(parseFilePath(file.relative_path));
          if (bytes.length === file.byte_length && await this.port.hash(bytes) === file.sha256) {
            const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
            if (Array.isArray(value) && value.length <= 200 && value.every(page => page && typeof page === "object" && object(page).raw)) pages = value as ParsedPage[];
          }
        } catch { /* Missing/corrupt retained artifacts leave combined provider blocks intact. */ }
      }
      await this.db.transaction().execute(tx => projectVisualContent(tx, generation.id, () => this.port.uuid(), pages));
    }
  }
}

export async function readVisualLinks(db: DatabaseContext, generationID: string): Promise<VisualLink[]> {
  const rows = await db.selectFrom("content_visual_links as v").innerJoin("content_blocks as a", "a.id", "v.visual_block_id")
    .leftJoin("content_blocks as b", "b.id", "v.related_block_id").selectAll("v").where("v.generation_id", "=", generationID)
    .where("a.review_status", "!=", "rejected").where(eb => eb.or([eb("b.id", "is", null), eb("b.review_status", "!=", "rejected")]))
    .orderBy("v.ordinal").orderBy("v.id").execute();
  return rows.map(row => ({ id: row.id, visualBlockId: row.visual_block_id, relatedBlockId: row.related_block_id, role: row.role as VisualLink["role"],
    position: row.position as VisualLink["position"], evidence: row.evidence as VisualLink["evidence"], ordinal: row.ordinal, markdown: row.content_markdown }));
}

/** MCP adds identifiers only; part text must remain under normal read budgets. */
export async function visualMetadata(db: DatabaseContext, generationID: string, blockID: string): Promise<Record<string, unknown>> {
  const rows = await db.selectFrom("content_visual_links as v").innerJoin("content_blocks as a", "a.id", "v.visual_block_id")
    .leftJoin("content_blocks as b", "b.id", "v.related_block_id").selectAll("v").where("v.generation_id", "=", generationID)
    .where(eb => eb.or([eb("v.visual_block_id", "=", blockID), eb("v.related_block_id", "=", blockID)]))
    .where("a.review_status", "!=", "rejected").where(eb => eb.or([eb("b.id", "is", null), eb("b.review_status", "!=", "rejected")]))
    .orderBy("v.role").orderBy("v.ordinal").orderBy("v.id").limit(201).execute();
  const own = rows.find(row => row.related_block_id === blockID);
  if (own) return { visualRelation: { visualBlockId: own.visual_block_id, role: own.role, position: own.position, evidence: own.evidence } };
  if (!rows.length) return {};
  const bounded = rows.slice(0, 200);
  return { visualGroup: { visualBlockId: blockID, captionBlockIds: bounded.filter(row => row.role === "caption" && row.related_block_id).map(row => row.related_block_id),
    noteBlockIds: bounded.filter(row => row.role === "note" && row.related_block_id).map(row => row.related_block_id),
    embeddedCaptionCount: bounded.filter(row => row.role === "caption" && !row.related_block_id).length,
    embeddedNoteCount: bounded.filter(row => row.role === "note" && !row.related_block_id).length, truncated: rows.length > 200 } };
}
