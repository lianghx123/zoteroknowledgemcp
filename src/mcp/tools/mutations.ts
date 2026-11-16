import type { DatabaseContext } from "../../database/unit-of-work";
import { sql } from "kysely";
import type { McpRepository } from "../../repositories/mcp";
import type { McpTokens } from "../../security/mcp-tokens";
import { McpError, canonical, string, requireValue, type JsonObject, type Principal } from "../contracts";

/** Keep authorization, version checks, revisions and replay receipts in one transaction. */
export class McpMutations {
  constructor(
    private readonly tokens: McpTokens,
    private readonly repository: McpRepository,
    private readonly authorize: (name: string, principal: Principal) => void,
    private readonly changed: () => Promise<void>,
  ) {}

  async execute(name: string, args: JsonObject, p: Principal, signal: AbortSignal): Promise<JsonObject> {
    const resourceId = string(args, "resourceId")!, operation = string(args, "operationId")!, text = string(args, name === "add_annotation" ? "text" : "summary")!.trim();
    requireValue(text, "Text must not be blank.");
    const authority = `mcp:${p.id}`, hash = await this.tokens.crypto.hash(canonical({ name, ...Object.fromEntries(Object.entries(args).filter(([key]) => !["responseMode", "includeFields"].includes(key))) }));
    const result = await this.tokens.db.transaction().execute(async tx => {
      signal.throwIfAborted(); const current = await this.tokens.current(p.id, tx); this.authorize(name, current);
      const resource = await this.repository.resource(resourceId, current, tx);
      const receipt = await tx.selectFrom("mutation_receipts").selectAll().where("authority_key", "=", authority).where("operation_id", "=", operation).executeTakeFirst();
      if (receipt) {
        if (receipt.request_hash !== hash) throw new McpError("OPERATION_ID_CONFLICT", "The operation ID was used with different arguments.");
        return { ...JSON.parse(receipt.result_json) as JsonObject, replayed: true };
      }
      if (resource.version !== args.expectedVersion) throw new McpError("VERSION_CONFLICT", "Refresh the resource before writing.", true, { expectedVersion: args.expectedVersion, version: resource.version });
      const now = Date.now(), version = resource.version + 1, annotationId = name === "add_annotation" ? this.tokens.crypto.uuid() : undefined;
      if (annotationId) await this.insertAnnotation(tx, args, current, resourceId, annotationId, version, now, text);
      const updated = await tx.updateTable("knowledge_resources").set({ version, updated_at: now, ...(name === "update_summary" ? { summary: text } : {}) })
        .where("id", "=", resourceId).where("version", "=", resource.version).executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) throw new McpError("VERSION_CONFLICT", "The resource changed during the write.", true);
      const revisionId = this.tokens.crypto.uuid(), eventId = this.tokens.crypto.uuid(), changes = annotationId ? { annotationId, annotationType: args.annotationType } : { summary: text };
      await tx.insertInto("resource_revisions").values({ id: revisionId, resource_id: resourceId, operation_id: await this.tokens.crypto.hash(`${authority}:${operation}`),
        base_version: resource.version, result_version: version, change_type: annotationId ? "annotation_added" : "summary_updated", target_type: annotationId ? "annotation" : "resource",
        target_id: annotationId ?? resourceId, before_json: name === "update_summary" ? JSON.stringify({ summary: resource.summary }) : null,
        after_json: JSON.stringify(changes), changes_json: JSON.stringify(changes), created_by_type: "agent", created_by: authority, agent_run_id: operation, created_at: now }).execute();
      await tx.insertInto("change_outbox").values({ event_id: eventId, aggregate_type: "resource", aggregate_id: resourceId, aggregate_version: version,
        event_type: annotationId ? "annotation_added" : "summary_updated", payload_json: JSON.stringify(changes), created_at: now }).execute();
      const value: JsonObject = { operationId: operation, resourceId, version, replayed: false, ...(annotationId ? { annotationId } : {}), warnings: [] };
      await tx.insertInto("mutation_receipts").values({ authority_key: authority, operation_id: operation, operation_kind: name, target_key: resourceId,
        request_hash: hash, result_json: JSON.stringify(value), created_at: now }).execute();
      signal.throwIfAborted(); return value;
    });
    await this.changed(); return result;
  }
  private async insertAnnotation(tx: DatabaseContext, args: JsonObject, p: Principal, resourceId: string, id: string, version: number, now: number, text: string): Promise<void> {
    let sourceId: string | null = null, generationId: string | null = null;
    const nodeId = string(args, "structureNodeId"), blockId = string(args, "contentBlockId");
    if (nodeId || blockId) {
      const query = this.repository.active(p, tx).where("s.resource_id", "=", resourceId);
      const row = blockId ? await query.innerJoin("content_blocks as b", "b.generation_id", "g.id").select(["s.id", "g.id as generationId", "b.content_markdown"]).where("b.id", "=", blockId).where("b.review_status", "!=", "rejected").executeTakeFirst()
        : await query.innerJoin("structure_nodes as n", "n.generation_id", "g.id").select(["s.id", "g.id as generationId"]).select(sql<null>`NULL`.as("content_markdown")).where("n.id", "=", nodeId!).executeTakeFirst();
      requireValue(row, "The annotation anchor is not in current content."); sourceId = row.id; generationId = row.generationId;
      // Native rows populate columns lazily: an `in` check cannot inspect a selected column.
      if (args.quote) requireValue(blockId && typeof row.content_markdown === "string" && row.content_markdown.includes(string(args, "quote")!), "The quote is absent from the selected block.");
    }
    await tx.insertInto("resource_annotations").values({ id, resource_id: resourceId, source_id: sourceId, generation_id: generationId, structure_node_id: nodeId ?? null,
      content_block_id: blockId ?? null, resource_version: version, annotation_type: string(args, "annotationType")!, text, quote: string(args, "quote") ?? null,
      confidence: typeof args.confidence === "number" ? args.confidence : null, created_by_type: "agent", created_by: `mcp:${p.id}`, created_at: now, updated_at: now, deleted_at: null }).execute();
  }
}
