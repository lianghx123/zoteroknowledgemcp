import { sql, type Selectable } from "kysely";
import type { Database } from "../../database/types";
import type { McpRepository } from "../../repositories/mcp";
import type { McpCursor } from "../../security/mcp-cursor";
import { McpError, number, requireValue, string, strings, type JsonObject, type Principal } from "../contracts";
import { availableFields, project, projectionFields } from "../presentation";

const resourceFields = availableFields("resource");
type Resource = Selectable<Database["knowledge_resources"]>;
type ResourceRow = Pick<Resource, "id" | "title" | "resource_type" | "status" | "version"> & Partial<Resource>;
const fieldColumns: Record<string, readonly (keyof Resource)[]> = {
  language: ["language"], subtitle: ["subtitle"], abstract: ["abstract"], summary: ["summary"], contributors: ["contributors_json"],
  metadata: ["publication_title", "publication_date", "doi"], createdAt: ["created_at"], updatedAt: ["updated_at"],
};
function columns(selected: Set<string>) {
  const names = new Set<keyof Resource>(["id", "title", "resource_type", "status", "version"]);
  for (const field of selected) for (const name of fieldColumns[field] ?? []) names.add(name);
  return [...names].map(name => `r.${name}` as const);
}
function group<T extends { resource_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) { const items = result.get(row.resource_id) ?? []; items.push(row); result.set(row.resource_id, items); }
  return result;
}
/** Read only the selected page/IDs and the relations required by its projection. */
export class McpResourceReader {
  constructor(private readonly repository: McpRepository, private readonly cursors: McpCursor) {}
  async list(args: JsonObject, p: Principal, context: string, signal: AbortSignal): Promise<JsonObject> {
    const selected = new Set(projectionFields("resource", resourceFields, args));
    const library = string(args, "libraryId"), folder = string(args, "nodeId"), repo = this.repository;
    if (library && !p.libraries.includes(library)) throw new McpError("KNOWLEDGE_RESOURCE_OUT_OF_SCOPE", "The library is outside the authorized scope.");
    if (folder && library) requireValue((await repo.folder(folder, p)).library_id === library, "The folder belongs to a different library.");
    let query = repo.resources(library ? { ...p, libraries: [library] } : p);
    if (folder) {
      const ids = await repo.folderResources(folder, number(args, "nodeDescendantDepth", 1), p);
      query = query.where(sql<boolean>`r.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
    }
    for (const [input, column] of [["resourceType", "r.resource_type"], ["status", "r.status"], ["language", "r.language"]] as const) {
      if (string(args, input)) query = query.where(column, "=", string(args, input)!);
    }
    const term = string(args, "query")?.trim();
    if (term) query = query.where(eb => eb.or([eb("r.title", "like", `%${term}%`), eb("r.abstract", "like", `%${term}%`), eb("r.contributors_json", "like", `%${term}%`)]));
    const position = await this.cursors.decode(string(args, "cursor"), context), offset = number(position, "offset"), limit = number(args, "limit", 20);
    requireValue(Number.isSafeInteger(offset) && offset >= 0, "Invalid cursor position.");
    signal.throwIfAborted();
    const rows = await query.select(columns(selected)).orderBy("r.created_at").orderBy("r.id").offset(offset).limit(limit + 1).execute();
    const hasMore = rows.length > limit, items = await this.items(rows.slice(0, limit), args, selected, p, signal);
    const total = args.includeTotal ? Number((await query.select(eb => eb.fn.count<number>("r.id").as("total")).executeTakeFirstOrThrow()).total) : undefined;
    return { items, returnedCount: items.length, hasMore, nextCursor: hasMore ? await this.cursors.encode(context, { offset: offset + limit }) : null,
      ...(total === undefined ? {} : { total }) };
  }
  async get(args: JsonObject, p: Principal, signal: AbortSignal): Promise<JsonObject> {
    const selected = new Set(projectionFields("resourceDetail", resourceFields, args)), ids = strings(args, "resourceIds");
    signal.throwIfAborted();
    const rows = await this.repository.resources(p).select(columns(selected)).where("r.id", "in", ids).execute();
    const items = await this.items(rows, args, selected, p, signal, "resourceDetail"), byId = new Map(items.map(item => [item.resourceId, item]));
    return { items: ids.filter(id => byId.has(id)).map(id => byId.get(id)!), missingResourceIds: ids.filter(id => !byId.has(id)), returnedCount: items.length, warnings: [] };
  }
  private async items(rows: ResourceRow[], args: JsonObject, selected: Set<string>, p: Principal, signal: AbortSignal, kind = "resource"): Promise<JsonObject[]> {
    if (!rows.length) return [];
    const ids = rows.map(row => row.id), repo = this.repository, db = repo.db;
    signal.throwIfAborted();
    const sources = selected.has("sources") || selected.has("capabilities") ? group(await db.selectFrom("resource_sources as s")
      .leftJoin("content_generations as g", "g.id", "s.active_generation_id")
      .select(["s.resource_id", "s.source_version", "s.content_version", "g.state", "g.source_id as generation_source", "s.id as source_identity", "g.source_version as generation_source_version", "g.content_version as generation_content_version"])
      .$if(selected.has("sources"), query => query.select(["s.id", "s.source_type", "s.source_role", "s.media_type", "s.availability", "s.source_version", "s.content_version", "s.active_generation_id"]))
      .where("s.resource_id", "in", ids).where("s.deleted_at", "is", null).orderBy("s.id").execute()) : new Map<string, never[]>();
    signal.throwIfAborted();
    const memberships = selected.has("memberships") || selected.has("libraryIds") ? group(await db.selectFrom("library_resources")
      .select(["resource_id", "library_id"]).where("resource_id", "in", ids).where("library_id", "in", p.libraries)
      .where("deleted_at", "is", null).orderBy("library_id").execute()) : new Map<string, never[]>();
    signal.throwIfAborted();
    const stats = selected.has("stats") ? new Map((await repo.active(p).innerJoin("content_blocks as b", "b.generation_id", "g.id")
      .select("s.resource_id").select(eb => [eb.fn.count<number>("b.id").as("blocks"), eb.fn.sum<number>(sql`length(b.content_markdown)`).as("chars")])
      .where("s.resource_id", "in", ids).where("b.review_status", "!=", "rejected").groupBy("s.resource_id").execute()).map(row => [row.resource_id, row])) : new Map<string, never>();
    signal.throwIfAborted();
    const identifiers = selected.has("identifiers") ? group(await db.selectFrom("resource_identifiers").select(["resource_id", "identifier_type", "identifier_value"])
      .where("resource_id", "in", ids).execute()) : new Map<string, never[]>();
    const annotationIds = selected.has("capabilities") ? new Set((await db.selectFrom("resource_annotations").select("resource_id").distinct().where("resource_id", "in", ids).where("deleted_at", "is", null).execute()).map(row => row.resource_id)) : new Set<string>();
    const referenceIds = selected.has("capabilities") ? new Set((await repo.references(p).select("resource_references.resource_id").distinct().where("resource_references.resource_id", "in", ids).execute()).map(row => row.resource_id)) : new Set<string>();
    const structureIds = selected.has("capabilities") ? new Set((await repo.active(p).innerJoin("structure_nodes as n", "n.generation_id", "g.id").select("s.resource_id").distinct().where("s.resource_id", "in", ids).execute()).map(row => row.resource_id)) : new Set<string>();
    const contentIds = selected.has("capabilities") ? new Set((await repo.active(p).innerJoin("content_blocks as b", "b.generation_id", "g.id").select("s.resource_id").distinct()
      .where("s.resource_id", "in", ids).where("b.review_status", "!=", "rejected").execute()).map(row => row.resource_id)) : new Set<string>();
    const processingIds = selected.has("capabilities") ? new Set((await db.selectFrom("processing_jobs").select("resource_id").distinct().where("resource_id", "in", ids).where("kind", "=", "parse")
      .where("state", "in", ["pending", "running", "waiting", "retry_wait"]).where("cancel_requested_at", "is", null).execute()).map(row => row.resource_id)) : new Set<string>();
    return rows.map(row => {
      signal.throwIfAborted();
      const item: JsonObject = { resourceId: row.id, title: row.title, resourceType: row.resource_type, status: row.status, version: row.version };
      for (const field of ["language", "subtitle", "abstract", "summary"] as const) if (selected.has(field)) item[field] = row[field] ?? null;
      if (selected.has("contributors")) item.contributors = JSON.parse(row.contributors_json!);
      const sourceRows = sources.get(row.id) ?? [], links = memberships.get(row.id) ?? [], statistic = stats.get(row.id);
      if (selected.has("capabilities")) {
        const readable = sourceRows.filter(source => ["ready", "partial"].includes(source.state ?? "") && source.generation_source === source.source_identity
          && source.generation_source_version === source.source_version && source.generation_content_version === source.content_version);
        const parsed = readable.length > 0 && contentIds.has(row.id);
        item.capabilities = { metadata: true, content: parsed, structure: structureIds.has(row.id), annotations: annotationIds.has(row.id), references: referenceIds.has(row.id),
          contentState: parsed ? readable.some(source => source.state === "partial") ? "partial" : "ready" : processingIds.has(row.id) ? "processing" : "unavailable",
          supportedOperations: { read: p.scopes.includes("knowledge:read"), annotate: p.scopes.includes("knowledge:annotate"), updateSummary: p.scopes.includes("knowledge:update-summary") } };
      }
      if (selected.has("sources")) item.sources = sourceRows.map(source => ({ sourceId: source.id, sourceType: source.source_type, sourceRole: source.source_role,
        mediaType: source.media_type, availability: source.availability, sourceVersion: source.source_version, contentVersion: source.content_version,
        generationId: source.active_generation_id, contentState: source.generation_source_version === source.source_version && source.generation_content_version === source.content_version ? source.state : source.active_generation_id ? "stale" : null }));
      if (selected.has("libraryIds")) item.libraryIds = links.map(link => link.library_id);
      if (selected.has("memberships")) item.memberships = links.map(link => ({ libraryId: link.library_id }));
      if (selected.has("stats")) item.stats = { blockCount: Number(statistic?.blocks ?? 0), charCount: Number(statistic?.chars ?? 0) };
      if (selected.has("identifiers")) item.identifiers = (identifiers.get(row.id) ?? []).map(identifier => ({ type: identifier.identifier_type, value: identifier.identifier_value }));
      if (selected.has("metadata")) item.metadata = { publicationTitle: row.publication_title, publicationDate: row.publication_date, doi: row.doi };
      if (selected.has("createdAt")) item.createdAt = new Date(row.created_at!).toISOString();
      if (selected.has("updatedAt")) item.updatedAt = new Date(row.updated_at!).toISOString();
      if (selected.has("deletedAt")) item.deletedAt = null;
      return project(kind, item, args);
    });
  }
}
