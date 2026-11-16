import type { Kysely } from "kysely";
import type { Database } from "../database/types";
import type { DatabaseContext } from "../database/unit-of-work";
import type { ReaderReference } from "../shared/contracts/references";
import { legacyReferenceEntries, referenceEntries } from "../services/reference-entries";

export const REFERENCE_PROJECTION_VERSION = 2;

/** Caller owns the transaction; original blocks and manual reference work survive. */
export async function projectReferenceContent(db: DatabaseContext, generationID: string, uuid: () => string): Promise<void> {
  const checkpoint = await db.selectFrom("content_reference_projections").select("version").where("generation_id", "=", generationID).executeTakeFirst();
  if (checkpoint && checkpoint.version >= REFERENCE_PROJECTION_VERSION) return;
  const generation = await db.selectFrom("content_generations").select(["resource_id", "source_id", "origin"]).where("id", "=", generationID).executeTakeFirstOrThrow();
  if (!["parse", "edit"].includes(generation.origin)) return;
  const old = await db.selectFrom("resource_references").selectAll().where("generation_id", "=", generationID).execute();
  const rows = await db.selectFrom("content_blocks").select(["id", "block_type", "content_markdown", "page_start", "page_end", "created_at"])
    .where("generation_id", "=", generationID).orderBy("canonical_order").execute();
  const blocks = rows.map(row => ({ id: row.id, type: row.block_type, markdown: row.content_markdown, page: row.page_start, pageEnd: row.page_end }));
  const links = await db.selectFrom("reference_source_blocks").select(["reference_id", "block_id"]).where("generation_id", "=", generationID).orderBy("ordinal").execute();
  const sourceIDs = (id: string) => links.filter(link => link.reference_id === id).map(link => link.block_id);
  const legacy = checkpoint?.version === 1 ? legacyReferenceEntries(blocks) : [];
  const generated = old.filter(row => {
    if (row.reference_type !== "bibliography" || row.match_status !== "unmatched" || row.deleted_at !== null || row.target_resource_id !== null
      || row.target_source_id !== null || row.target_generation_id !== null || row.target_block_id !== null || row.confidence !== null || row.parsed_json !== "{}") return false;
    if (!checkpoint) return row.id === row.source_block_id && row.label === null && row.reference_number === null && row.entry_order === null
      && row.raw_text === rows.find(block => block.id === row.source_block_id)?.content_markdown;
    // Source links identify generated entries; replaying v1 also detects manual
    // text/number changes instead of treating every unmatched row as disposable.
    const ids = sourceIDs(row.id);
    return legacy.some(entry => entry.blockIds[0] === row.source_block_id && entry.markdown === row.raw_text && entry.number === row.reference_number
      && entry.label === row.label && entry.order === row.entry_order && JSON.stringify(entry.blockIds) === JSON.stringify(ids));
  });
  const generatedIDs = new Set(generated.map(row => row.id));
  const protectedBlocks = new Set(old.filter(row => !generatedIDs.has(row.id) && row.reference_type === "bibliography")
    .flatMap(row => [...sourceIDs(row.id), row.source_block_id]));
  const entries = referenceEntries(blocks.map(block => ({ ...block, protected: protectedBlocks.has(block.id) })));
  for (const row of generated) await db.deleteFrom("resource_references").where("id", "=", row.id).execute();
  const used = new Set(old.filter(row => !generatedIDs.has(row.id)).map(row => row.id)), now = Date.now();
  for (const entry of entries) {
    const firstID = entry.blockIds[0], previous = generated.find(row => row.source_block_id === firstID && row.reference_number === entry.number && !used.has(row.id));
    const id = previous?.id ?? (used.has(firstID) ? uuid() : firstID); used.add(id);
    const created = previous?.created_at ?? rows.find(row => row.id === firstID)!.created_at;
    await db.insertInto("resource_references").values({ id, resource_id: generation.resource_id, source_id: generation.source_id,
      generation_id: generationID, source_block_id: firstID, reference_type: "bibliography", reference_number: entry.number, entry_order: entry.order,
      label: entry.label, raw_text: entry.markdown, created_at: created, updated_at: now }).execute();
    for (const [ordinal, block_id] of entry.blockIds.entries()) await db.insertInto("reference_source_blocks").values({
      reference_id: id, generation_id: generationID, block_id, ordinal }).execute();
  }
  await db.insertInto("content_reference_projections").values({ generation_id: generationID, version: REFERENCE_PROJECTION_VERSION, completed_at: now })
    .onConflict(oc => oc.column("generation_id").doUpdateSet({ version: REFERENCE_PROJECTION_VERSION, completed_at: now })).execute();
}

export class ReferenceContentRepository {
  constructor(private readonly db: Kysely<Database>, private readonly uuid: () => string) {}
  async backfill(): Promise<void> {
    const generations = await this.db.selectFrom("content_generations as g").leftJoin("content_reference_projections as p", "p.generation_id", "g.id")
      .select("g.id").where("g.origin", "=", "parse").where("g.state", "in", ["ready", "partial", "superseded"])
      .where(eb => eb.or([eb("p.generation_id", "is", null), eb("p.version", "<", REFERENCE_PROJECTION_VERSION)])).execute();
    for (const generation of generations) await this.db.transaction().execute(tx => projectReferenceContent(tx, generation.id, this.uuid));
  }
}

export async function readReferences(db: DatabaseContext, generationID: string): Promise<ReaderReference[]> {
  const rows = await db.selectFrom("resource_references as r").innerJoin("content_blocks as b", "b.id", "r.source_block_id")
    .select(["r.id", "r.reference_number", "r.entry_order", "r.raw_text", "r.source_block_id", "b.canonical_order"])
    .where("r.generation_id", "=", generationID).where("r.reference_type", "=", "bibliography").where("r.deleted_at", "is", null)
    .orderBy("b.canonical_order").orderBy("r.entry_order").orderBy("r.id").execute();
  const links = await db.selectFrom("reference_source_blocks").select(["reference_id", "block_id"]).where("generation_id", "=", generationID).orderBy("ordinal").execute();
  return rows.map((row, order) => ({ id: row.id, number: row.reference_number, order, markdown: row.raw_text ?? "",
    blockIds: links.filter(link => link.reference_id === row.id).map(link => link.block_id).concat(links.some(link => link.reference_id === row.id) ? [] : [row.source_block_id!]) }));
}
