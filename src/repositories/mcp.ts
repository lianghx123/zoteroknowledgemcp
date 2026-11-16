import { sql, type Kysely, type Selectable } from "kysely";
import type { Database } from "../database/types";
import type { DatabaseContext } from "../database/unit-of-work";
import { McpError, chars, requireValue, type Principal, type JsonObject } from "../mcp/contracts";
import { visualMetadata } from "./visual-content";

export interface McpBlock {
  id: string; resourceId: string; sourceId: string; generationId: string; sourceVersion: number; contentVersion: number;
  nodeId: string | null; type: string; role: string; order: number; markdown: string; text: string; pageStart: number | null; pageEnd: number | null;
  quality: string[]; metadata: JsonObject;
  partial?: boolean;
}
export interface McpBlockHeader extends Omit<McpBlock, "markdown" | "text"> {
  charCount: number;
  annotation?: boolean;
}
export class McpRepository {
  constructor(readonly db: Kysely<Database>) {}
  resources(p: Principal, db: DatabaseContext = this.db) {
    return db.selectFrom("knowledge_resources as r").where("r.deleted_at", "is", null).where("r.status", "!=", "deleted")
      .where(eb => eb.exists(eb.selectFrom("library_resources as lr").innerJoin("knowledge_libraries as l", "l.id", "lr.library_id")
        .select("lr.id").whereRef("lr.resource_id", "=", "r.id").where("lr.deleted_at", "is", null).where("l.deleted_at", "is", null)
        .where("l.status", "!=", "deleted").where("l.id", "in", p.libraries.length ? p.libraries : [""])));
  }
  async ids(p: Principal, db: DatabaseContext = this.db): Promise<string[]> { return (await this.resources(p, db).select("r.id").orderBy("r.id").execute()).map(row => row.id); }
  async resource(id: string, p: Principal, db: DatabaseContext = this.db): Promise<Selectable<Database["knowledge_resources"]>> {
    const row = await this.resources(p, db).selectAll("r").where("r.id", "=", id).executeTakeFirst();
    if (!row) throw new McpError("KNOWLEDGE_RESOURCE_OUT_OF_SCOPE", "The resource is unavailable in the authorized libraries.");
    return row;
  }
  async state(p: Principal): Promise<unknown> {
    if (!p.libraries.length) return { format: 1, libraries: [] };
    // One statement observes an atomic committed snapshot. Decimal text retains
    // SQLite's full integer precision; tombstones prevent delete/recreate ABA.
    const rows = await this.db.selectFrom("mcp_library_revisions").select("library_id")
      .select(sql<string>`CAST(revision AS TEXT)`.as("revision"))
      .where("library_id", "in", p.libraries).orderBy("library_id").execute();
    if (rows.length !== new Set(p.libraries).size) throw new McpError("INTERNAL_ERROR", "The knowledge revision state is unavailable.");
    return { format: 1, libraries: rows.map(row => [row.library_id, row.revision]) };
  }
  async folders(p: Principal) {
    if (!p.libraries.length) return [];
    return this.db.selectFrom("library_nodes").selectAll().where("library_id", "in", p.libraries).where("deleted_at", "is", null).orderBy("sort_order").orderBy("id").execute();
  }
  async folder(id: string, p: Principal) {
    const folder = (await this.folders(p)).find(row => row.id === id);
    if (!folder) throw new McpError("KNOWLEDGE_RESOURCE_OUT_OF_SCOPE", "The folder is outside the authorized libraries.");
    return folder;
  }
  async folderResources(id: string, depth: number | null, p: Principal): Promise<string[]> {
    const root = await this.folder(id, p), all = await this.folders(p), selected = new Set([root.id]);
    let current = [root.id];
    for (let level = 0; current.length && (depth === null || level < depth); level++) {
      const parents = new Set(current);
      current = all.filter(row => row.library_id === root.library_id && row.parent_id && parents.has(row.parent_id) && !selected.has(row.id)).map(row => row.id);
      current.forEach(id => selected.add(id));
    }
    const rows = await this.db.selectFrom("library_items as li").innerJoin("library_resources as lr", "lr.id", "li.library_resource_id")
      .innerJoin("knowledge_resources as r", "r.id", "lr.resource_id").select("lr.resource_id").distinct()
      .where(sql<boolean>`li.node_id IN (SELECT value FROM json_each(${JSON.stringify([...selected])}))`)
      .where("li.library_id", "=", root.library_id).where("lr.library_id", "=", root.library_id)
      .where("li.deleted_at", "is", null).where("lr.deleted_at", "is", null).where("r.deleted_at", "is", null).execute();
    return rows.map(row => row.resource_id);
  }
  active(p: Principal, db: DatabaseContext = this.db) {
    return db.selectFrom("resource_sources as s").innerJoin("content_generations as g", "g.id", "s.active_generation_id")
      .innerJoin("knowledge_resources as r", "r.id", "s.resource_id")
      .where("s.deleted_at", "is", null).where("r.deleted_at", "is", null).where("r.status", "!=", "deleted").where("g.state", "in", ["ready", "partial"])
      .whereRef("g.source_id", "=", "s.id").whereRef("g.source_version", "=", "s.source_version").whereRef("g.content_version", "=", "s.content_version")
      .where(eb => eb.exists(eb.selectFrom("library_resources as lr").innerJoin("knowledge_libraries as l", "l.id", "lr.library_id")
        .select("lr.id").whereRef("lr.resource_id", "=", "r.id").where("lr.deleted_at", "is", null).where("l.deleted_at", "is", null)
        .where("l.status", "!=", "deleted").where("l.id", "in", p.libraries.length ? p.libraries : [""])));
  }
  async nodes(p: Principal, resourceId?: string) {
    let query = this.active(p).innerJoin("structure_nodes as n", "n.generation_id", "g.id").selectAll("n").select(["s.resource_id", "s.id as source_id"]);
    if (resourceId) query = query.where("s.resource_id", "=", resourceId);
    return query.orderBy("s.id").orderBy("n.sort_order").orderBy("n.id").execute();
  }
  references(p: Principal) {
    return this.db.selectFrom("resource_references").leftJoin("content_blocks as b", "b.id", "resource_references.source_block_id")
      .where("resource_references.deleted_at", "is", null)
      .where("resource_references.resource_id", "in", this.resources(p).select("r.id"))
      .where(eb => eb.or([eb("b.id", "is", null), eb("b.review_status", "!=", "rejected")]))
      .where(eb => eb.or([eb("target_resource_id", "is", null), eb("target_resource_id", "in", this.resources(p).select("r.id"))]))
      .where(eb => eb.or([eb("resource_references.generation_id", "is", null), eb("resource_references.generation_id", "in", this.active(p).select("g.id").where(sql<boolean>`s.resource_id = resource_references.resource_id`))]))
      .where(eb => eb.or([eb("source_id", "is", null), eb("source_id", "in", this.db.selectFrom("resource_sources").select("id").where(sql<boolean>`resource_id = resource_references.resource_id`).where("deleted_at", "is", null))]))
      .where(eb => eb.or([eb("target_generation_id", "is", null), eb("target_generation_id", "in", this.active(p).select("g.id"))]))
      .where(eb => eb.or([eb("target_source_id", "is", null), eb("target_source_id", "in", this.db.selectFrom("resource_sources").select("id").where("deleted_at", "is", null).where("resource_id", "in", this.resources(p).select("r.id")))]))
      .where(eb => eb.or([eb("target_block_id", "is", null), eb("target_block_id", "in", this.active(p).innerJoin("content_blocks as target_block", "target_block.generation_id", "g.id").select("target_block.id").where("target_block.review_status", "!=", "rejected"))]));
  }
  async blockHeaders(resourceId: string, p: Principal, db: DatabaseContext = this.db): Promise<McpBlockHeader[]> {
    await this.resource(resourceId, p, db);
    const rows = await this.active(p, db).innerJoin("content_blocks as b", "b.generation_id", "g.id")
      .select(["b.id", "b.generation_id", "b.structure_node_id", "b.block_type", "b.content_role", "b.canonical_order", "b.page_start", "b.page_end", "b.quality_flags_json"])
      .select(sql<number>`length(b.content_markdown)`.as("char_count"))
      .select(["s.id as source_id", "s.resource_id", "s.source_version", "s.content_version", "g.state as generation_state"])
      .where("s.resource_id", "=", resourceId).where("b.review_status", "!=", "rejected")
      .orderBy(sql`CASE WHEN s.id = r.canonical_source_id THEN 0 ELSE 1 END`).orderBy("s.created_at").orderBy("s.id").orderBy("b.canonical_order").orderBy("b.id").execute();
    return rows.map(row => ({ id: row.id, resourceId: row.resource_id, sourceId: row.source_id, generationId: row.generation_id, sourceVersion: row.source_version,
      contentVersion: row.content_version, nodeId: row.structure_node_id, type: row.block_type, role: row.content_role, order: row.canonical_order,
      charCount: Number(row.char_count), pageStart: row.page_start, pageEnd: row.page_end,
      quality: JSON.parse(row.quality_flags_json) as string[], metadata: {}, partial: row.generation_state === "partial" }));
  }
  async annotationHeaders(resourceId: string, p: Principal): Promise<McpBlockHeader[]> {
    await this.resource(resourceId, p);
    const rows = await this.db.selectFrom("resource_annotations").select(["id", "source_id", "generation_id"])
      .select(sql<number>`length(text) + 2`.as("char_count")).where("resource_id", "=", resourceId).where("deleted_at", "is", null).orderBy("created_at").orderBy("id").execute();
    return rows.map((row, order) => ({ id: row.id, resourceId, sourceId: row.source_id ?? "", generationId: row.generation_id ?? "", sourceVersion: 0,
      contentVersion: 0, nodeId: null, type: "annotation", role: "note", order, pageStart: null, pageEnd: null, quality: [], metadata: {}, charCount: Number(row.char_count), annotation: true }));
  }
  async readBlock(header: McpBlockHeader, start: number, length: number, p: Principal, metadata = false, db: DatabaseContext = this.db): Promise<McpBlock> {
    requireValue(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(length) && length >= 0 && length <= 200000, "Invalid block read budget.");
    let markdown: string | undefined, details: JsonObject = {};
    if (header.annotation) {
      await this.resource(header.resourceId, p, db);
      const row = await db.selectFrom("resource_annotations").select(sql<string>`substr('> ' || text, ${start + 1}, ${length})`.as("markdown"))
        .where("id", "=", header.id).where("resource_id", "=", header.resourceId).where("deleted_at", "is", null).executeTakeFirst();
      markdown = row?.markdown;
    } else {
      let query = this.active(p, db).innerJoin("content_blocks as b", "b.generation_id", "g.id")
        .select(sql<string>`substr(b.content_markdown, ${start + 1}, ${length})`.as("markdown"))
        .where("s.resource_id", "=", header.resourceId).where("b.id", "=", header.id).where("g.id", "=", header.generationId).where("b.review_status", "!=", "rejected");
      if (metadata) query = query.select("b.metadata_json") as typeof query;
      const row = await query.executeTakeFirst(); markdown = row?.markdown;
      if (row && metadata) details = { ...JSON.parse((row as typeof row & { metadata_json: string }).metadata_json) as JsonObject,
        ...await visualMetadata(db, header.generationId, header.id) };
    }
    if (markdown === undefined || chars(markdown) !== Math.min(length, Math.max(0, header.charCount - start))) throw new McpError("KNOWLEDGE_RESOURCE_UNAVAILABLE", "The selected content changed during reading.", true);
    return { ...header, markdown, text: markdown, metadata: details };
  }
  /** Bounded convenience read for internal callers; public reads use headers and substrings. */
  async blocks(resourceId: string, p: Principal, db: DatabaseContext = this.db): Promise<McpBlock[]> {
    const headers = await this.blockHeaders(resourceId, p, db), blocks: McpBlock[] = []; let remaining = 200000;
    for (const header of headers) {
      if (!remaining) break;
      const length = Math.min(header.charCount, remaining); blocks.push(await this.readBlock(header, 0, length, p, true, db)); remaining -= length;
    }
    return blocks;
  }
}
