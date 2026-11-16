import { McpRepository } from "../../repositories/mcp";
import { McpTokens } from "../../security/mcp-tokens";
import { McpCursor } from "../../security/mcp-cursor";
import type { RetrievalService } from "../../services/retrieval";
import type { EmbeddingService } from "../../services/embedding";
import { ModelError } from "../../shared/contracts/retrieval";
import { McpError, canonical, chars, string, strings, number, requireValue, failure, success, type JsonObject, type Principal, type ToolResult } from "../contracts";
import { argumentsFor } from "./registry";
import { project } from "../presentation";
import { McpContentReader, blockItem, readingSelection } from "./content";
import { McpAnnotationReader } from "./annotations";
import { McpMutations } from "./mutations";
import { McpSearch } from "./search";
import { McpResourceReader } from "./resources";

const searchTools = new Set(["list_libraries", "list_folders", "list_resources", "list_block_types", "search_content"]);
function descendants<T extends { id: string; parent: string | null }>(all: T[], parent: string | null, depth: number): T[] {
  if (depth <= 0) return [];
  const result: T[] = [], visit = (id: string | null, level: number) => {
    for (const row of all.filter(row => row.parent === id)) { result.push(row); if (level < depth) visit(row.id, level + 1); }
  }; visit(parent, 1); return result;
}
export class McpTools {
  readonly repository: McpRepository;
  private readonly content: McpContentReader;
  private readonly mutations: McpMutations;
  private readonly search: McpSearch;
  private readonly resources: McpResourceReader;
  private readonly annotations: McpAnnotationReader;
  constructor(
    readonly tokens: McpTokens,
    readonly cursors: McpCursor,
    retrieval?: RetrievalService,
    embeddings?: EmbeddingService,
    changed: () => Promise<void> = async () => {},
  ) {
    this.repository = new McpRepository(tokens.db);
    this.resources = new McpResourceReader(this.repository, cursors);
    this.content = new McpContentReader(cursors, this.repository);
    this.annotations = new McpAnnotationReader(this.repository, cursors);
    this.mutations = new McpMutations(tokens, this.repository, (name, principal) => this.permission(name, principal), changed);
    this.search = new McpSearch(tokens, cursors, this.repository, retrieval, embeddings);
  }
  async call(name: string, input: unknown, principal: Principal, signal: AbortSignal): Promise<ToolResult> {
    try {
      signal.throwIfAborted();
      const args = argumentsFor(name, input), current = await this.tokens.current(principal.id);
      this.permission(name, current);
      const state = await this.repository.state(current), context = await this.cursors.context(name, args, current,
        name === "list_references" ? { state, referenceProjection: 4 } : state);
      const result = await this.execute(name, args, current, context, signal);
      signal.throwIfAborted();
      const latest = await this.tokens.current(principal.id);
      if (canonical(latest) !== canonical(current)) throw new McpError("KNOWLEDGE_SCOPE_REQUIRED", "Authorization changed during the call.", true);
      if (!["add_annotation", "update_summary"].includes(name) && canonical(state) !== canonical(await this.repository.state(latest))) throw new McpError("KNOWLEDGE_RESOURCE_UNAVAILABLE", "Content or membership changed during the call.", true);
      return success(result);
    } catch (error) {
      const mapped = error instanceof ModelError ? new McpError(error.code === "recovery-failed" ? "INDEX_RECOVERY_FAILED" : ["initializing", "index-unavailable", "service-closed"].includes(error.code) ? "INDEX_UNAVAILABLE" : error.code === "config-changed" ? "MODEL_CONFIGURATION_CHANGED" : "VECTOR_UNAVAILABLE",
        error.code === "recovery-failed" ? "Local index recovery failed; retry recovery in plugin Settings." : "The configured retrieval channel is unavailable.", !["config", "credentials", "service-closed"].includes(error.code), { reason: error.code, ...error.details }) : error;
      return failure(signal.aborted ? new McpError("CANCELLED", "The request was cancelled.", true) : mapped);
    }
  }
  private permission(name: string, p: Principal): void {
    const scope = name === "add_annotation" ? "knowledge:annotate" : name === "update_summary" ? "knowledge:update-summary" : searchTools.has(name) ? "knowledge:search" : "knowledge:read";
    if (!p.scopes.includes(scope)) throw new McpError("KNOWLEDGE_SCOPE_REQUIRED", `The token requires ${scope}.`);
  }
  private async page(items: JsonObject[], args: JsonObject, context: string): Promise<JsonObject> {
    const position = await this.cursors.decode(string(args, "cursor"), context), offset = number(position, "offset"), limit = number(args, "limit", 20);
    requireValue(Number.isSafeInteger(offset) && offset >= 0, "Invalid cursor position.");
    const selected = items.slice(offset, offset + limit), hasMore = offset + limit < items.length;
    return { items: selected, returnedCount: selected.length, hasMore, nextCursor: hasMore ? await this.cursors.encode(context, { offset: offset + limit }) : null,
      ...(args.includeTotal ? { total: items.length } : {}) };
  }
  private async execute(name: string, args: JsonObject, p: Principal, context: string, signal: AbortSignal): Promise<JsonObject> {
    const repo = this.repository, db = this.tokens.db, resourceId = string(args, "resourceId");
    if (name === "list_libraries") {
      const rows = p.libraries.length ? await db.selectFrom("knowledge_libraries").selectAll().where("id", "in", p.libraries).where("deleted_at", "is", null)
        .where("status", "=", string(args, "status") ?? "active").orderBy("created_at").orderBy("id").execute() : [];
      const items: JsonObject[] = [];
      for (const row of rows) {
        const count = await repo.resources({ ...p, libraries: [row.id] }).select(eb => eb.fn.count<number>("r.id").as("count")).executeTakeFirstOrThrow();
        items.push(project("library", { libraryId: row.id, name: row.name, status: row.status, resourceCount: Number(count.count), description: row.description,
          createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), deletedAt: null }, args));
      }
      return this.page(items, args, context);
    }
    if (name === "list_folders") {
      const library = string(args, "libraryId")!;
      if (!p.libraries.includes(library)) throw new McpError("KNOWLEDGE_RESOURCE_OUT_OF_SCOPE", "The library is outside the authorized scope.");
      if (args.status === "archived") return this.page([], args, context);
      const parent = string(args, "parentNodeId") ?? null, rows = (await repo.folders(p)).filter(row => row.library_id === library);
      requireValue(!parent || rows.some(row => row.id === parent), "The parent folder is unavailable.");
      const expanded = descendants(rows.map(row => ({ id: row.id, parent: row.parent_id })), parent, number(args, "descendantDepth", 1));
      const items: JsonObject[] = [];
      for (const entry of expanded) {
        const row = rows.find(row => row.id === entry.id)!, childCount = rows.filter(item => item.parent_id === row.id).length;
        items.push(project("folder", { nodeId: row.id, parentNodeId: row.parent_id, name: row.name, nodeType: row.node_type, hasChildren: childCount > 0, childCount,
          ...(args.includeResourceCount ? { resourceCount: (await repo.folderResources(row.id, null, p)).length, countStatus: "exact" } : {}),
          description: row.description, sortOrder: row.sort_order, queryDefinition: null, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }, args));
      }
      return this.page(items, args, context);
    }
    if (name === "list_resources") return this.resources.list(args, p, context, signal);
    if (name === "get_resources") return this.resources.get(args, p, signal);
    if (name === "get_resource_nodes") {
      const nodes = await repo.nodes(p), requested = strings(args, "nodeIds"), cursors = (args.cursors ?? {}) as Record<string, string>;
      requireValue(Object.keys(cursors).every(id => requested.includes(id)), "A cursor refers to an unrequested node.");
      const items = [], missing: string[] = [], omitted: string[] = []; let remaining = number(args, "maxTotalChars", 50000);
      for (const id of requested) {
        const node = nodes.find(node => node.id === id);
        if (!node) { missing.push(id); continue; }
        if (!remaining) { omitted.push(id); continue; }
        const selected = new Set([id, ...(args.includeChildren ? descendants(nodes.map(row => ({ id: row.id, parent: row.parent_id })), id, 100).map(row => row.id) : [])]);
        const selection = readingSelection((await repo.blockHeaders(node.resource_id, p)).filter(block => selected.has(block.nodeId ?? "")), args);
        const resource = await repo.resource(node.resource_id, p), nodeContext = await this.cursors.context(name, { nodeId: id, includeChildren: args.includeChildren, includeBoilerplate: args.includeBoilerplate }, p, await repo.state(p));
        const rendered = await this.content.render(selection.blocks, args, nodeContext, p, signal, cursors[id], Math.min(remaining, number(args, "maxChars", 8000)), number(args, "maxBlocks", 30));
        remaining -= rendered.charCountReturned as number;
        items.push({ resourceId: node.resource_id, resourceVersion: resource.version, nodeId: id, includeChildren: args.includeChildren, ...rendered, selection: selection.selection,
          ...(args.responseMode === "full" || strings(args, "includeFields").includes("nodePath") ? { nodePath: node.path } : {}),
          ...(args.responseMode === "full" || strings(args, "includeFields").includes("nodeTitle") ? { nodeTitle: node.label } : {}),
          ...(args.responseMode === "full" || strings(args, "includeFields").includes("resourceContext") ? { resourceContext: { resourceId: resource.id, title: resource.title, resourceType: resource.resource_type, language: resource.language } } : {}) });
      }
      return { items, missingNodeIds: missing, omittedNodeIds: omitted, totalCharsReturned: number(args, "maxTotalChars", 50000) - remaining, warnings: [] };
    }
    if (name === "search_content") return this.search.execute(args, p, context, signal);
    requireValue(resourceId, "resourceId is required.");
    const resource = await repo.resource(resourceId, p);
    if (name === "add_annotation" || name === "update_summary") return this.mutations.execute(name, args, p, signal);
    if (name === "list_annotations") return this.annotations.list(args, p, context, signal);
    if (["list_revisions", "list_references"].includes(name)) return this.related(name, args, p, context);
    const blocks = await repo.blockHeaders(resourceId, p), nodes = await repo.nodes(p, resourceId);
    const base = { resourceId, resourceVersion: resource.version };
    const warnings = blocks.length ? blocks.some(block => block.partial) ? [{ code: "PARTIAL_CONTENT", message: "The published document content is partial." }] : [] : [{ code: "CONTENT_UNAVAILABLE", message: "No current processed content is available." }];
    if (name === "get_resource_content") {
      const selection = readingSelection(blocks, args), selected = selection.blocks;
      if (args.includeAnnotations) {
        selected.push(...await repo.annotationHeaders(resourceId, p));
      }
      return { ...base, ...await this.content.render(selected, args, context, p, signal, string(args, "cursor")), warnings,
        selection: { ...selection.selection, annotationsIncluded: Boolean(args.includeAnnotations) },
        ...(args.responseMode === "full" || strings(args, "includeFields").includes("resourceContext") ? { resourceContext: { resourceId, title: resource.title, resourceType: resource.resource_type, language: resource.language } } : {}) };
    }
    if (name === "list_resource_nodes") {
      const parent = string(args, "parentNodeId") ?? null;
      requireValue(!parent || nodes.some(row => row.id === parent), "The parent structure node is unavailable.");
      const expanded = descendants(nodes.map(row => ({ id: row.id, parent: row.parent_id })), parent, number(args, "descendantDepth", 1));
      const items = expanded.map(entry => {
        const row = nodes.find(row => row.id === entry.id)!, children = nodes.filter(node => node.parent_id === row.id);
        const ids = new Set([row.id, ...descendants(nodes.map(node => ({ id: node.id, parent: node.parent_id })), row.id, 100).map(node => node.id)]), selected = blocks.filter(block => ids.has(block.nodeId ?? ""));
        return project("node", { nodeId: row.id, parentNodeId: row.parent_id, title: row.label ?? "", level: row.depth, path: row.path, childCount: children.length,
          blockCount: selected.length, charCount: selected.reduce((sum, block) => sum + block.charCount, 0), hasChildren: children.length > 0,
          metadata: { sourceId: row.source_id, generationId: row.generation_id } }, args);
      });
      return { ...base, ...await this.page(items, args, context), warnings };
    }
    const nodeId = string(args, "nodeId");
    if (nodeId) requireValue(nodes.some(row => row.id === nodeId), "The structure node is unavailable.");
    const selected = blocks.filter(block => (!nodeId || block.nodeId === nodeId) && (!args.blockType || block.type === args.blockType) && (!args.contentRole || block.role === args.contentRole));
    if (name === "list_content_blocks") {
      const page = await this.page(selected.map(blockItem), args, context), items: JsonObject[] = [];
      for (const handle of page.items as JsonObject[]) {
        signal.throwIfAborted();
        const block = selected.find(block => block.id === handle.blockId)!, metadata = args.responseMode === "full" || strings(args, "includeFields").includes("metadata");
        const read = args.includePreview || metadata ? await repo.readBlock(block, 0, args.includePreview ? number(args, "previewMaxChars", 120) : 0, p, metadata) : block;
        const item = blockItem(read);
        if (args.includePreview) { item.preview = "markdown" in read ? read.markdown : ""; item.previewTruncated = block.charCount > number(args, "previewMaxChars", 120); }
        items.push(project("block", item, args));
      }
      return { ...base, ...page, items, warnings };
    }
    if (name === "list_block_types") {
      const types = new Map<string, { blockType: string; count: number; estimatedChars: number }>();
      for (const block of selected) { const item = types.get(block.type) ?? { blockType: block.type, count: 0, estimatedChars: 0 }; item.count++; item.estimatedChars += block.charCount; types.set(block.type, item); }
      const embedded = await db.selectFrom("block_embeddings as e").innerJoin("content_blocks as b", "b.id", "e.content_block_id").select("b.id").distinct()
        .where("e.state", "=", "active").where("b.generation_id", "in", repo.active(p).select("g.id").where("s.resource_id", "=", resourceId)).execute();
      const count = selected.filter(block => embedded.some(row => row.id === block.id)).length;
      return { ...base, items: [...types.values()], totalBlocks: selected.length, estimatedChars: selected.reduce((sum, block) => sum + block.charCount, 0), embeddedBlockCount: count, unembeddedBlockCount: selected.length - count, warnings };
    }
    if (name === "get_content_blocks_text") {
      let remaining = number(args, "maxTotalChars", 10000); const items = [], missing: string[] = [], omitted: string[] = [];
      const continuations = (args.cursors ?? {}) as Record<string, string>, state = await repo.state(p);
      for (const id of strings(args, "blockIds")) {
        const block = blocks.find(block => block.id === id); if (!block) { missing.push(id); continue; }
        if (!remaining) { omitted.push(id); continue; }
        signal.throwIfAborted();
        const blockContext = await this.cursors.context(name, { resourceId, blockId: id }, p, state);
        const start = number(await this.cursors.decode(continuations[id], blockContext), "offset");
        requireValue(Number.isSafeInteger(start) && start >= 0 && start <= block.charCount, "Invalid block text cursor.");
        const read = await repo.readBlock(block, start, Math.min(block.charCount - start, remaining, number(args, "maxCharsPerBlock", 2000)), p, args.responseMode === "full" || strings(args, "includeFields").includes("metadata"));
        const content = read.markdown; remaining -= chars(content);
        const truncated = start + chars(content) < block.charCount;
        items.push(project("blockText", { ...blockItem(read), contentMarkdown: content, originalCharCount: block.charCount, truncated, textOffset: start, charCountReturned: chars(content),
          nextCursor: truncated ? await this.cursors.encode(blockContext, { offset: start + chars(content) }) : null }, args));
      }
      return { ...base, items, missingBlockIds: missing, omittedBlockIds: omitted, totalCharsReturned: number(args, "maxTotalChars", 10000) - remaining, warnings };
    }
    throw new McpError("INVALID_ARGUMENT", "Unknown tool.");
  }
  private async related(name: string, args: JsonObject, p: Principal, context: string): Promise<JsonObject> {
    const db = this.tokens.db, id = string(args, "resourceId")!, resource = await this.repository.resource(id, p); let items: JsonObject[] = [];
    if (name === "list_revisions") {
      let query = db.selectFrom("resource_revisions").selectAll().where("resource_id", "=", id);
      if (args.changeType) query = query.where("change_type", "=", string(args, "changeType")!);
      if (args.targetType) query = query.where("target_type", "=", string(args, "targetType")!);
      if (args.sinceVersion !== undefined) query = query.where("result_version", ">", number(args, "sinceVersion"));
      items = (await query.orderBy("result_version").execute()).map(row => project("revision", { revisionId: row.id, changeType: row.change_type, targetType: row.target_type,
        versionAfter: row.result_version, createdAt: new Date(row.created_at).toISOString(), targetId: row.target_id, createdBy: row.created_by,
        changes: this.safeChanges(JSON.parse(row.changes_json) as JsonObject) }, args));
    } else {
      const resourceReferences = this.repository.references(p).where("resource_references.resource_id", "=", id);
      let query = resourceReferences.selectAll("resource_references").select(["b.canonical_order", "b.page_start", "b.page_end", "b.locations_json"]);
      if (args.referenceType) query = query.where("reference_type", "=", string(args, "referenceType")!);
      const rows = await query.orderBy("source_id").orderBy("b.canonical_order").orderBy("entry_order").orderBy("resource_references.created_at").orderBy("resource_references.id").execute();
      const links = await db.selectFrom("reference_source_blocks as l").innerJoin("content_blocks as c", "c.id", "l.block_id")
        .select(["l.reference_id", "l.block_id", "c.page_start", "c.page_end", "c.locations_json"])
        .where("l.reference_id", "in", query.clearSelect().select("resource_references.id")).orderBy("l.ordinal").execute();
      items = rows.map(row => {
        const sources = links.filter(link => link.reference_id === row.id);
        const starts = sources.flatMap(source => source.page_start === null ? [] : [source.page_start]);
        const ends = sources.flatMap(source => source.page_end === null ? [] : [source.page_end]);
        return project("reference", { referenceId: row.id, referenceType: row.reference_type, targetResourceId: row.target_resource_id,
        sourceBlockId: row.source_block_id, sourceId: row.source_id, generationId: row.generation_id,
        sourceBlockIds: sources.length ? sources.map(source => source.block_id) : row.source_block_id ? [row.source_block_id] : [],
        referenceNumber: row.reference_number, entryOrder: row.entry_order,
        targetBlockId: row.target_block_id, rawText: row.raw_text, label: row.label, matchStatus: row.match_status, confidence: row.confidence,
        canonicalOrder: row.canonical_order, pageStart: starts.length ? Math.min(...starts) : row.page_start, pageEnd: ends.length ? Math.max(...ends) : row.page_end,
        locations: sources.length ? sources.flatMap(source => JSON.parse(source.locations_json) as JsonObject[]) : JSON.parse(row.locations_json ?? "[]") as JsonObject[],
        createdAt: new Date(row.created_at).toISOString() }, args);
      });
      const blocks = await this.repository.blockHeaders(id, p), count = blocks.filter(block => /reference|bibliograph/i.test(block.type)).length;
      // Availability describes the authorized document, independently of a type filter.
      const available = rows.length > 0 || Boolean(args.referenceType && await resourceReferences.select("resource_references.id").limit(1).executeTakeFirst());
      return { resourceId: id, resourceVersion: resource.version, ...await this.page(items, args, context), referenceBlocksAvailable: count,
        structuredReferencesAvailable: available, warnings: available ? [] : [{ code: "STRUCTURED_REFERENCES_UNAVAILABLE", message: "Read reference-text blocks for unstructured references." }] };
    }
    return { resourceId: id, resourceVersion: resource.version, ...await this.page(items, args, context), warnings: [] };
  }
  private safeChanges(input: JsonObject): JsonObject {
    // History can contain private membership graphs, native paths and job internals.
    return Object.fromEntries(Object.entries(input).filter(([key]) => ["summary", "annotationId", "annotationType", "text", "anchorState"].includes(key)));
  }
  close(): void { this.search.close(); }
}
