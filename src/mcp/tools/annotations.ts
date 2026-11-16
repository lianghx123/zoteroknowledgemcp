import { sql } from "kysely";
import type { McpRepository } from "../../repositories/mcp";
import type { McpCursor } from "../../security/mcp-cursor";
import { McpError, chars, number, requireValue, string, strings, type JsonObject, type Principal } from "../contracts";
import { project } from "../presentation";

/** List annotation handles and read bounded, independently resumable text/quote streams. */
export class McpAnnotationReader {
  constructor(private readonly repository: McpRepository, private readonly cursors: McpCursor) {}

  async list(args: JsonObject, p: Principal, context: string, signal: AbortSignal): Promise<JsonObject> {
    const db = this.repository.db, resourceId = string(args, "resourceId")!, resource = await this.repository.resource(resourceId, p);
    const ids = strings(args, "annotationIds"), continuations = (args.cursors ?? {}) as Record<string, { text?: string | null; quote?: string | null }>;
    if (ids.length) requireValue(Object.keys(continuations).every(id => ids.includes(id)), "A cursor refers to an unrequested annotation.");
    let query = db.selectFrom("resource_annotations").where("resource_id", "=", resourceId).where("deleted_at", "is", null);
    if (ids.length) query = query.where("id", "in", ids);
    if (args.nodeId) query = query.where("structure_node_id", "=", string(args, "nodeId")!);
    if (args.blockId) query = query.where("content_block_id", "=", string(args, "blockId")!);
    if (args.annotationType) query = query.where("annotation_type", "=", string(args, "annotationType")!);
    const rows = await query.select(["id", "annotation_type", "structure_node_id", "content_block_id", "resource_version", "source_id", "generation_id", "anchor_state", "confidence", "created_at"])
      .select([sql<number>`length(text)`.as("text_length"), sql<number>`coalesce(length(quote), 0)`.as("quote_length"), sql<number>`quote IS NOT NULL`.as("has_quote")])
      .orderBy("created_at").orderBy("id").execute();
    const position = await this.cursors.decode(string(args, "cursor"), context), offset = number(position, "offset"), limit = number(args, "limit", 20);
    requireValue(Number.isSafeInteger(offset) && offset >= 0, "Invalid cursor position.");
    const selected = rows.slice(offset, offset + limit);
    if (!ids.length) requireValue(Object.keys(continuations).every(id => selected.some(row => row.id === id)), "An annotation cursor refers to an item outside this page; select annotationIds for direct continuation.");
    const state = await this.repository.state(p), items: JsonObject[] = [];
    let remaining = number(args, "maxTotalChars", 10000);
    for (const row of selected) {
      signal.throwIfAborted();
      const id = row.id, supplied = continuations[id] ?? {};
      const read = async (stream: "text" | "quote", length: number) => {
        const streamContext = await this.cursors.context("annotation-stream", { resourceId, annotationId: id, stream }, p, state);
        const start = supplied[stream] === null ? length : number(await this.cursors.decode(supplied[stream], streamContext), "offset");
        requireValue(Number.isSafeInteger(start) && start >= 0 && start <= length, "Invalid annotation text cursor.");
        const take = Math.min(number(args, "textMaxChars", 500), remaining, length - start);
        const body = take ? await query.select(sql<string>`substr(${sql.ref(stream)}, ${start + 1}, ${take})`.as("body")).where("id", "=", id).executeTakeFirst() : undefined;
        const value = body?.body ?? "", count = chars(value);
        if (count !== take) throw new McpError("KNOWLEDGE_RESOURCE_UNAVAILABLE", "The annotation changed during reading.", true);
        remaining -= count;
        return { value, start, count, truncated: start + count < length, nextCursor: start + count < length ? await this.cursors.encode(streamContext, { offset: start + count }) : null };
      };
      const text = await read("text", Number(row.text_length)), quote = await read("quote", Number(row.quote_length));
      items.push(project("annotation", { annotationId: id, annotationType: row.annotation_type, text: text.value, textTruncated: text.truncated,
        quote: row.has_quote ? quote.value : null, quoteTruncated: quote.truncated, nextCursor: text.nextCursor, quoteNextCursor: quote.nextCursor,
        textOffset: text.start, quoteOffset: quote.start, originalCharCount: Number(row.text_length), originalQuoteCharCount: Number(row.quote_length), charCountReturned: text.count, quoteCharsReturned: quote.count,
        targetNodeId: row.structure_node_id, targetBlockId: row.content_block_id, resourceVersion: row.resource_version, sourceId: row.source_id, generationId: row.generation_id,
        confidence: row.confidence, createdAt: new Date(row.created_at).toISOString(), anchorState: row.anchor_state,
        metadata: { anchorState: row.anchor_state, sourceId: row.source_id, generationId: row.generation_id } }, args));
    }
    const hasMore = offset + limit < rows.length;
    return { resourceId, resourceVersion: resource.version, items, returnedCount: items.length, hasMore,
      nextCursor: hasMore ? await this.cursors.encode(context, { offset: offset + limit }) : null,
      ...(args.includeTotal ? { total: rows.length } : {}), missingAnnotationIds: ids.filter(id => !rows.some(row => row.id === id)),
      totalCharsReturned: number(args, "maxTotalChars", 10000) - remaining, warnings: [] };
  }
}
