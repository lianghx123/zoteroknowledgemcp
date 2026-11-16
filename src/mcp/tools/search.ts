import type { McpRepository } from "../../repositories/mcp";
import type { McpTokens } from "../../security/mcp-tokens";
import type { McpCursor } from "../../security/mcp-cursor";
import type { RetrievalService } from "../../services/retrieval";
import type { EmbeddingService } from "../../services/embedding";
import { spaceKey, type RetrievalHit } from "../../shared/contracts/retrieval";
import { McpError, canonical, string, strings, number, type JsonObject, type Principal } from "../contracts";
import { excludedBlockFlags, isReadableBlock } from "./content";
import { evidenceSnippet, evidenceWindow } from "./evidence";
import { projectSearch, validateSearchFields } from "../presentation";
import { diversify } from "./diversify";

interface SearchSnapshot {
  expires: number; context: string; hits: RetrievalHit[];
  warnings: JsonObject[]; diagnostics?: unknown; bytes: number;
}

/** Own process-local search snapshots and preserve scoped candidate/evidence behavior. */
export class McpSearch {
  private snapshots = new Map<string, SearchSnapshot>();
  private snapshotBytes = 0;
  private readonly maxSnapshotBytes = 16 * 1024 * 1024;

  constructor(
    private readonly tokens: McpTokens,
    private readonly cursors: McpCursor,
    private readonly repository: McpRepository,
    private readonly retrieval?: RetrievalService,
    private readonly embeddings?: EmbeddingService,
  ) {}

  async execute(args: JsonObject, p: Principal, context: string, signal: AbortSignal): Promise<JsonObject> {
    validateSearchFields(args);
    if (args.scopeType === "run") throw new McpError("KNOWLEDGE_RUN_SCOPE_UNAVAILABLE", "External execution grants are not supported locally.");
    if (!this.retrieval || !this.embeddings) throw new McpError("INDEX_UNAVAILABLE", "Retrieval is not initialized.", true);
    const repo = this.repository, mode = string(args, "mode")!, scopeId = string(args, "scopeId");
    let ids: string[];
    if (args.scopeType === "library") {
      if (!p.libraries.includes(scopeId!)) throw new McpError("KNOWLEDGE_RESOURCE_OUT_OF_SCOPE", "The library is outside the authorized scope.");
      ids = await repo.ids({ ...p, libraries: [scopeId!] });
    } else if (args.scopeType === "resource") { await repo.resource(scopeId!, p); ids = [scopeId!]; }
    else if (args.scopeType === "node") ids = await repo.folderResources(scopeId!, null, p);
    else ids = await repo.ids(p);
    const config = this.embeddings.config.current;
    const state = canonical(await repo.state(p)), configuration = canonical(config);
    const guard = async () => {
      signal.throwIfAborted();
      const latest = await this.tokens.current(p.id);
      if (canonical(latest) !== canonical(p)) throw new McpError("KNOWLEDGE_SCOPE_REQUIRED", "Authorization changed during the call.", true);
      if (canonical(await repo.state(latest)) !== state) throw new McpError("KNOWLEDGE_RESOURCE_UNAVAILABLE", "Content or membership changed during retrieval.", true);
      if (canonical(this.embeddings!.config.current) !== configuration) throw new McpError("MODEL_CONFIGURATION_CHANGED", "Model configuration changed during retrieval.", true);
    };
    const indexState = async () => {
      const index = mode === "metadata" || mode === "fulltext" ? [] : await this.tokens.db.selectFrom("vector_snapshot_state").select(["profile_id", "build_id", "corpus_hash"]).orderBy("profile_id").execute();
      const fulltext = mode === "vector" ? undefined : await this.tokens.db.selectFrom("plugin_state").select("value_json").where("key", "=", "fulltext-revision").executeTakeFirst();
      return canonical({ space: spaceKey(config), revision: config.revision, index: index.map(row => [row.profile_id, row.build_id, row.corpus_hash]), fulltext: fulltext?.value_json });
    };
    const index = await indexState();
    const searchContext = await this.tokens.crypto.hash(canonical({ context, index }));
    for (const [id, row] of this.snapshots) if (row.expires <= Date.now()) this.forget(id);
    const position = await this.cursors.decode(string(args, "cursor"), searchContext), snapshotId = string(position, "snapshot");
    let snapshot = snapshotId ? this.snapshots.get(snapshotId) : undefined;
    if (snapshotId && (!snapshot || snapshot.context !== searchContext)) throw new McpError("CURSOR_STALE", "The search snapshot is unavailable; restart the search.", true);
    if (!snapshot) {
      const filtered = ["includeBlockTypes", "excludeBlockTypes", "includeContentRoles", "excludeContentRoles", "excludeQualityFlags"].some(key => strings(args, key).length);
      const result = await this.retrieval.search(string(args, "query")!, mode === "metadata" || mode === "fulltext" ? "fulltext" : mode === "vector" ? "semantic" : "fusion", ids, signal, "active", {
        candidates: number(args, "candidateLimit", 100), results: number(args, "candidateLimit", 100), evidence: number(args, "maxBlocksPerResource", 2),
        metadataOnly: mode === "metadata", metadata: args.includeMetadataMatches === undefined ? !filtered : Boolean(args.includeMetadataMatches), rerank: Boolean(args.rerank),
        // Retrieval/rerank input is independent of the output snippet budget.
        textMaxChars: 7000, guard,
        includeBlockTypes: strings(args, "includeBlockTypes"), excludeBlockTypes: strings(args, "excludeBlockTypes"), includeContentRoles: strings(args, "includeContentRoles"),
        excludeContentRoles: strings(args, "excludeContentRoles"), excludeQualityFlags: args.excludeQualityFlags === undefined ? excludedBlockFlags : strings(args, "excludeQualityFlags"),
      });
      const warnings: JsonObject[] = result.degraded.map(row => ({ code: row.channel === "rerank" ? "RERANK_UNAVAILABLE" : row.channel === "vector" ? "VECTOR_UNAVAILABLE" : "FULLTEXT_UNAVAILABLE", message: row.code, channel: row.channel, ...(row.details ? { details: row.details } : {}) }));
      if (result.hits.some(hit => hit.partialContent)) warnings.push({ code: "PARTIAL_CONTENT", message: "Some results have partial published content." });
      if (args.rerank && args.rerankPolicy === "required" && result.hits.length && !result.channels.includes("rerank")) throw new McpError("RERANK_UNAVAILABLE", "Required reranking failed.", true);
      const rerankThresholdUnavailable = args.minScoreBasis === "rerank" && args.minScore !== undefined && !result.channels.includes("rerank");
      if (rerankThresholdUnavailable && result.hits.length && args.rerankPolicy === "required") throw new McpError("RERANK_UNAVAILABLE", "The score threshold requires reranking.", true);
      if (rerankThresholdUnavailable && result.hits.length) warnings.push({ code: "RERANK_MIN_SCORE_NOT_APPLIED", message: "The rerank score threshold was not applied because reranking is unavailable." });
      let hits = result.hits;
      if (args.minScore !== undefined && !rerankThresholdUnavailable) hits = hits.filter(hit => {
        const score = args.minScoreBasis === "rerank" ? hit.scoreType === "rerank" ? hit.score : undefined : hit.vectorScore ?? (hit.scoreType === "cosine" ? hit.score : undefined);
        return score !== undefined && score >= number(args, "minScore");
      });
      if (args.diversify) hits = diversify(hits, number(args, "diversityLambda", 0.7));
      const bytes = hits.reduce((total, hit) => total + 512 + 2 * hit.title.length
        + hit.evidence.reduce((size, row) => size + 256 + 2 * (row.text.length + (row.section?.length ?? 0)), 0)
        + (hit.metadataMatches ?? []).reduce((size, row) => size + 64 + 2 * row.text.length, 0), 0);
      snapshot = { expires: Date.now() + 3600000, context: searchContext, hits, warnings, bytes, diagnostics: { channels: result.channels, coverage: result.coverage, timings: result.timings, minScoreApplied: args.minScore !== undefined && !rerankThresholdUnavailable } };
      const id = this.tokens.crypto.uuid(); this.snapshots.set(id, snapshot); this.snapshotBytes += bytes; position.snapshot = id;
      // Bound retained text as well as entry count. Keep one oversized newest
      // snapshot so a valid first response never returns an already-evicted cursor.
      while (this.snapshots.size > 1 && (this.snapshots.size > 64 || this.snapshotBytes > this.maxSnapshotBytes)) this.forget(this.snapshots.keys().next().value!);
    }
    await guard();
    if (index !== await indexState()) throw new McpError("CURSOR_STALE", "The search index changed; restart the search.", true);
    const allowed = new Set(await repo.ids(await this.tokens.current(p.id))), offset = number(position, "offset"), limit = number(args, "limit", 10);
    const selected = snapshot.hits.slice(offset, offset + limit).filter(hit => allowed.has(hit.resourceID));
    const items = (await this.materialize(selected, args, p, signal)).map(item => projectSearch(item, args));
    // Pages may read blocks independently of the ranking request. Revalidate after
    // the last evidence read as well, including cancelled and replayed pages.
    await guard();
    if (index !== await indexState()) throw new McpError("CURSOR_STALE", "The search index changed; restart the search.", true);
    const hasMore = offset + limit < snapshot.hits.length;
    return { items, returnedCount: items.length, hasMore, nextCursor: hasMore ? await this.cursors.encode(searchContext, { offset: offset + limit, snapshot: position.snapshot }) : null,
      warnings: snapshot.warnings, ...(args.includeDiagnostics ? { diagnostics: snapshot.diagnostics } : {}) };
  }

  private async materialize(hits: readonly RetrievalHit[], args: JsonObject, p: Principal, signal: AbortSignal): Promise<JsonObject[]> {
    const repo = this.repository, value: JsonObject[] = [];
    for (const hit of hits) {
      signal.throwIfAborted();
      const blocks = hit.evidence.length ? await repo.blockHeaders(hit.resourceID, p) : [], matches: JsonObject[] = [];
      for (const evidence of hit.evidence) {
        const block = blocks.find(block => block.id === evidence.blockID); if (!block) continue;
        const neighbors = blocks.filter(candidate => candidate.sourceId === block.sourceId && candidate.nodeId === block.nodeId && Math.abs(candidate.order - block.order) <= 1 && isReadableBlock(candidate)
          && (!strings(args, "includeBlockTypes").length || strings(args, "includeBlockTypes").includes(candidate.type)) && !strings(args, "excludeBlockTypes").includes(candidate.type)
          && (!strings(args, "includeContentRoles").length || strings(args, "includeContentRoles").includes(candidate.role)) && !strings(args, "excludeContentRoles").includes(candidate.role)
          && !candidate.quality.some(flag => strings(args, "excludeQualityFlags").includes(flag)));
        const snippet = await evidenceSnippet(repo, evidence, block, neighbors, string(args, "query")!, number(args, "snippetMaxChars", 300), p, signal);
        matches.push({ contentBlockId: block.id, evidenceBlockId: block.id, ...snippet,
          matchSource: "content_block", channel: evidence.channel === "vector" ? "vector" : "fulltext", structureNodeId: block.nodeId, nodeLabel: evidence.section,
          blockType: block.type, contentRole: block.role, qualityFlags: block.quality,
          rawScore: evidence.score, scoreType: "final", finalScore: hit.score, pageStart: block.pageStart, pageEnd: block.pageEnd,
          metadata: { sourceId: block.sourceId, generationId: block.generationId } });
      }
      for (const match of hit.metadataMatches ?? []) if (args.includeMetadataMatches !== false) {
        const window = evidenceWindow(match.text, string(args, "query")!, number(args, "snippetMaxChars", 300));
        matches.push({ matchSource: "resource_metadata", channel: "metadata", metadataField: match.field, snippet: window.text,
          snippetTruncated: window.truncated, scoreType: "final", finalScore: hit.score });
      }
      const resource = await repo.resource(hit.resourceID, p);
      value.push({ resourceId: hit.resourceID, resourceVersion: resource.version, resourceTitle: hit.title, scoreType: "final", resourceScore: hit.score, matches: matches.slice(0, number(args, "maxBlocksPerResource", 2)),
        partialContent: hit.partialContent, embeddingCoverage: hit.embeddingCoverage });
    }
    return value;
  }

  private forget(id: string): void {
    const row = this.snapshots.get(id);
    if (row) { this.snapshotBytes -= row.bytes; this.snapshots.delete(id); }
  }

  close(): void { this.snapshots.clear(); this.snapshotBytes = 0; }
}
