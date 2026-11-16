import { sql } from "kysely";
import type { DatabaseContext } from "../database/unit-of-work";
import { embeddingAdmission, ftsExpression, searchTokens } from "./embedding-input";
import type { EmbeddingService } from "./embedding";
import { modelProviders } from "../providers/models";
import { searchKey } from "./search-text";
import { blockPredicate, type RetrievalFilters } from "./retrieval-filters";
import type { VectorSearchSession } from "./vector-store";
import { ModelError, spaceKey, type RetrievalConfig, type RetrievalEvidence, type RetrievalHit, type RetrievalMode, type RetrievalResult } from "../shared/contracts/retrieval";
import type { AttachmentIdentity } from "../shared/contracts/knowledge-content";
import type { ReaderSearchResult } from "../shared/contracts/reader-search";

export function reciprocalRankFusion(channels: readonly (readonly RetrievalHit[])[]): RetrievalHit[] {
  const hits = new Map<string, RetrievalHit>();
  for (const channel of channels) for (const [rank, hit] of channel.entries()) {
    const current = hits.get(hit.resourceID) ?? { ...hit, evidence: [], channels: [], score: 0, scoreType: "rrf" as const };
    current.channels = [...new Set([...(current.channels ?? []), ...(hit.channels ?? [])])];
    if (hit.scoreType === "cosine") current.vectorScore = Math.max(current.vectorScore ?? -Infinity, hit.score);
    current.score += 1 / (60 + rank + 1);
    for (const evidence of hit.evidence) if (!current.evidence.some(row => row.blockID === evidence.blockID && row.segmentID === evidence.segmentID && row.channel === evidence.channel)) current.evidence.push(evidence);
    current.metadataOnly = current.evidence.length === 0; hits.set(hit.resourceID, current);
  }
  return [...hits.values()].sort((a, b) => b.score - a.score || a.resourceID.localeCompare(b.resourceID));
}
/** Keyword ranks are unbounded and must never be compared to a cosine threshold. */
export function classifyRelevance(hit: RetrievalHit, threshold: number): NonNullable<RetrievalHit["relevance"]> {
  const basis = hit.scoreType === "rerank" ? "rerank" : hit.scoreType === "cosine" || hit.vectorScore !== undefined ? "cosine" : "keyword";
  const score = basis === "keyword" ? undefined : hit.scoreType === "rrf" ? hit.vectorScore : hit.score;
  return { basis, ...(score === undefined ? {} : { score }), group: score === undefined || score >= threshold ? "matched" : "possible" };
}
export interface RetrievalSearchOptions extends RetrievalFilters {
  candidates?: number; results?: number; evidence?: number; metadataOnly?: boolean; metadata?: boolean; rerank?: boolean;
  textMaxChars?: number;
  guard?: () => Promise<void>;
}
export class RetrievalService {
  private cache = new Map<string, { vector: Float32Array; expires: number }>();
  constructor(private readonly embeddings: EmbeddingService, private readonly ready: (mode: RetrievalMode) => boolean = () => true,
    private readonly unavailable: (mode: RetrievalMode) => ModelError = () => new ModelError("initializing", true)) {}

  /** Rank passages within one current attachment, rather than ranking its parent document. */
  async searchReader(attachment: AttachmentIdentity, generationID: string, query: string, mode: RetrievalMode, signal: AbortSignal): Promise<ReaderSearchResult> {
    query = query.trim(); if (!query || query.length > 8000) throw new ModelError("query");
    const config = this.embeddings.config.current, identity = spaceKey(config), db = this.embeddings.repository.db;
    const resolve = () => db.selectFrom("zotero_item_links as z").innerJoin("zotero_libraries as l", "l.id", "z.zotero_library_id")
      .innerJoin("resource_sources as s", "s.id", "z.source_id").innerJoin("content_generations as g", "g.id", "s.active_generation_id")
      .innerJoin("knowledge_resources as r", "r.id", "s.resource_id")
      .select(["s.id as sourceID", "s.resource_id as resourceID", "g.id as generationID"])
      .where("z.item_key", "=", attachment.itemKey).where("l.local_library_id", "=", attachment.libraryID)
      .where("z.state", "=", "current").where("l.availability", "=", "available").where("s.deleted_at", "is", null)
      .where("r.status", "=", "active").where("r.deleted_at", "is", null).where("g.state", "in", ["ready", "partial"])
      .whereRef("g.source_version", "=", "s.source_version").whereRef("g.content_version", "=", "s.content_version").executeTakeFirst();
    const source = await resolve();
    const guard = async () => {
      signal.throwIfAborted();
      const current = await resolve();
      if (!source || !current || current.generationID !== generationID || current.sourceID !== source.sourceID || current.resourceID !== source.resourceID
        || !(await this.allowedScope([current.resourceID], "active")).length) throw new ModelError("reader-content-changed");
      if (this.embeddings.config.current !== config || spaceKey(this.embeddings.config.current) !== identity) throw new ModelError("config-changed");
    };
    await guard();
    const limit = Math.min(200, Math.max(1, config.candidates)), options = { generationID, guard };
    const channels: RetrievalEvidence[][] = [], degraded: string[] = [];
    if (mode === "fulltext" || mode === "fusion") {
      if (this.ready("fulltext")) channels.push((await this.text(query, [source!.resourceID], "block", 1, "active", options, limit)).flatMap(hit => hit.evidence));
      else if (mode === "fulltext") throw this.unavailable("fulltext");
      else degraded.push("initializing");
    }
    if (mode !== "fulltext") {
      try {
        if (!this.ready(mode === "fusion" ? "semantic" : mode)) throw this.unavailable("semantic");
        if (!config.enabled) throw new ModelError("config");
        const indexed = await db.selectFrom("block_embeddings").select("id").where("generation_id", "=", generationID)
          .where("profile_id", "=", this.embeddings.profile).where("state", "=", "active").executeTakeFirst();
        if (!indexed) throw new ModelError("reader-not-indexed");
        const incomplete = await db.selectFrom("embedding_segments as seg").innerJoin("content_blocks as b", "b.id", "seg.block_id")
          .leftJoin("block_embeddings as e", "e.id", "seg.embedding_id").select("seg.id")
          .where("b.generation_id", "=", generationID).where("seg.profile_id", "=", this.embeddings.profile).where("seg.skip_reason", "is", null)
          .where(eb => eb.or([eb("e.id", "is", null), eb("e.state", "!=", "active")])).executeTakeFirst();
        const uncovered = await db.selectFrom("content_blocks as b").leftJoin("embedding_segments as seg", join => join.onRef("seg.block_id", "=", "b.id").on("seg.profile_id", "=", this.embeddings.profile))
          .select(["b.block_type", "b.content_normalized", "b.content_markdown", "b.quality_flags_json"])
          .where("b.generation_id", "=", generationID).where("seg.id", "is", null).execute();
        if (incomplete || uncovered.some(block => !embeddingAdmission(block.block_type, block.content_normalized ?? block.content_markdown, JSON.parse(block.quality_flags_json) as string[]).length)) degraded.push("reader-index-partial");
        await guard();
        const vector = await this.queryVector(query, config, signal, guard);
        channels.push((await this.vector(vector, [source!.resourceID], limit, identity, options, limit)).flatMap(hit => hit.evidence));
      } catch (error) {
        await guard(); if (mode !== "fusion") throw error;
        degraded.push(error instanceof ModelError ? error.code : "provider");
      }
    }
    await guard();
    if (!channels.length) throw new ModelError(degraded[0] ?? "initializing");
    const ranked = new Map<string, { evidence: RetrievalEvidence; score: number; textMatch: boolean; vectorScore?: number }>();
    for (const channel of channels) {
      const seen = new Set<string>();
      for (const [rank, evidence] of channel.entries()) {
        if (evidence.sourceID !== source!.sourceID || evidence.generationID !== generationID || seen.has(evidence.blockID)) continue;
        seen.add(evidence.blockID);
        const row = ranked.get(evidence.blockID) ?? { evidence, score: 0, textMatch: false, vectorScore: undefined as number | undefined };
        if (evidence.channel === "fulltext") row.textMatch = true; else row.vectorScore = evidence.score;
        row.score += 1 / (60 + rank + 1); ranked.set(evidence.blockID, row);
      }
    }
    let passages = [...ranked.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    let reranked = false;
    if ((mode === "enhanced" || mode === "fusion") && passages.length) {
      try {
        await guard();
        if (!config.enabled) throw new ModelError("config");
        const scores: Array<{ index: number; score: number }> = [];
        const size = modelProviders.get(config.rerank.provider).definition.maxRerankDocuments;
        for (let start = 0; start < passages.length; start += size) {
          const rows = await this.embeddings.gateway.rerank(query, passages.slice(start, start + size).map(row => row.evidence.text.slice(0, 7000)), signal, guard);
          scores.push(...rows.map(row => ({ index: row.index + start, score: row.score })));
        }
        await guard(); passages = scores.filter(row => row.score >= config.relevanceThreshold).sort((a, b) => b.score - a.score).map(row => passages[row.index]); reranked = true;
      } catch (error) { await guard(); degraded.push(error instanceof ModelError ? error.code : "provider"); }
    }
    await guard();
    if (!reranked) passages = passages.filter(row => row.textMatch || (row.vectorScore ?? -1) >= config.relevanceThreshold);
    const maximum = 50;
    return { hits: passages.slice(0, maximum).map(row => ({ blockID: row.evidence.blockID, text: row.evidence.text,
      section: row.evidence.section, page: row.evidence.page })), degraded, truncated: passages.length > maximum || passages.length >= limit };
  }
  async search(query: string, mode: RetrievalMode, scope: readonly string[], signal: AbortSignal, scopeKind: "active" | "trash" = "active", options: RetrievalSearchOptions = {}): Promise<RetrievalResult> {
    query = query.trim(); if (!query || query.length > 8000) throw new ModelError("query");
    signal.throwIfAborted();
    await options.guard?.();
    const textReady = this.ready("fulltext"), vectorReady = this.ready(mode === "fusion" ? "semantic" : mode);
    if (mode === "fusion" ? !textReady && !vectorReady : !this.ready(mode)) throw this.unavailable(mode === "fusion" ? "fulltext" : mode);
    const modelConfig = this.embeddings.config.current;
    const config = { ...modelConfig, candidates: options.candidates ?? this.embeddings.config.current.candidates,
      results: options.results ?? this.embeddings.config.current.results, evidence: options.evidence ?? this.embeddings.config.current.evidence }, identity = spaceKey(config), db = this.embeddings.repository.db;
    const allowed = await this.allowedScope(scope, scopeKind);
    const result: RetrievalResult = { query, mode, hits: [], channels: [], degraded: [], threshold: config.relevanceThreshold, timings: { embeddingMs: 0, localMs: 0, rerankMs: 0 }, coverage: { resources: allowed.length, parsed: 0, embedded: 0 } };
    if (!allowed.length) return result;
    const channels: RetrievalHit[][] = [];
    if (mode === "fulltext" || mode === "fusion" && textReady) {
      const start = Date.now(), kind = options.metadataOnly ? "metadata" : "block";
      channels.push(await this.text(query, allowed, kind, config.candidates, scopeKind, options, config.evidence)); result.channels.push(kind === "block" ? "fulltext" : "metadata");
      if (mode === "fusion" && options.metadata !== false) { channels.push(await this.text(query, allowed, "metadata", config.candidates, scopeKind, options, config.evidence)); result.channels.push("metadata"); }
      result.timings.localMs += Date.now() - start;
    }
    if (mode === "fusion" && !textReady) { const error = this.unavailable("fulltext"); result.degraded.push({ channel: "fulltext", code: error.code, details: error.details }); }
    if (mode !== "fulltext") {
      try {
        // Gate each fusion channel separately before query embedding/provider dispatch.
        if (!vectorReady) throw this.unavailable(mode === "fusion" ? "semantic" : mode);
        if (!config.enabled) throw new ModelError("config");
        const start = Date.now(), vector = await this.queryVector(query, modelConfig, signal, options.guard);
        result.timings.embeddingMs = Date.now() - start;
        signal.throwIfAborted();
        await options.guard?.();
        if (identity !== spaceKey(this.embeddings.config.current)) throw new ModelError("config-changed");
        const local = Date.now(); channels.push(await this.vector(vector, allowed, config.candidates, identity, options, config.evidence)); result.timings.localMs += Date.now() - local; result.channels.push("vector");
      } catch (error) {
        await options.guard?.();
        signal.throwIfAborted(); if (mode !== "fusion") throw error;
        result.degraded.push({ channel: "vector", code: error instanceof ModelError ? error.code : "vector", ...(error instanceof ModelError ? { details: error.details } : {}) });
      }
    }
    signal.throwIfAborted();
    await options.guard?.();
    let hits = mode === "fusion" ? reciprocalRankFusion(channels) : channels[0] ?? [];
    hits = hits.slice(0, config.candidates);
    if ((mode === "enhanced" || mode === "fusion" || options.rerank === true) && options.rerank !== false && hits.length) {
      const start = Date.now();
      try {
        if (!config.enabled) throw new ModelError("config");
        const texts = hits.map(hit => Array.from(`${hit.title}\n${hit.evidence.slice(0, config.evidence).map(row => row.text).join("\n")}`).slice(0, 7000).join(""));
        const batchSize = modelProviders.get(config.rerank.provider).definition.maxRerankDocuments, ranked: Array<{ index: number; score: number }> = [];
        for (let offset = 0; offset < texts.length; offset += batchSize) {
          signal.throwIfAborted();
          await options.guard?.();
          const batch = await this.embeddings.gateway.rerank(query, texts.slice(offset, offset + batchSize), signal, options.guard);
          await options.guard?.();
          ranked.push(...batch.map(row => ({ index: row.index + offset, score: row.score })));
        }
        hits = ranked.map(row => ({ ...hits[row.index],
          vectorScore: hits[row.index].vectorScore ?? (hits[row.index].scoreType === "cosine" ? hits[row.index].score : undefined),
          score: row.score, scoreType: "rerank" as const })).sort((a, b) => b.score - a.score);
        result.channels.push("rerank");
      } catch (error) { await options.guard?.(); signal.throwIfAborted(); result.degraded.push({ channel: "rerank", code: error instanceof ModelError ? error.code : "rerank" }); }
      finally { result.timings.rerankMs = Date.now() - start; }
    }
    signal.throwIfAborted();
    if (identity !== spaceKey(this.embeddings.config.current)) throw new ModelError("config-changed");
    // Network work is complete. A short transaction gives membership, evidence
    // validity and coverage one consistent publication boundary.
    return db.transaction().execute(async tx => {
      const currentScope = await this.allowedScope(allowed, scopeKind, tx), permitted = new Set(currentScope);
      const resources = await tx.selectFrom("resource_sources as s").innerJoin("content_generations as g", "g.id", "s.active_generation_id")
        .select(["s.id", "s.resource_id", "g.id as generationID", "g.state"]).where("s.deleted_at", "is", null).where("g.state", "in", ["ready", "partial"])
        .where(sql<boolean>`s.resource_id IN (SELECT value FROM json_each(${JSON.stringify(currentScope)}))`)
        .whereRef("g.source_id", "=", "s.id").whereRef("g.source_version", "=", "s.source_version").whereRef("g.content_version", "=", "s.content_version").execute();
      const sources = new Map(resources.map(row => [row.id, row]));
      // Drop the entire affected candidate: its rank/rerank score may have used
      // the obsolete passage even if another attachment still has valid evidence.
      hits = hits.filter(hit => permitted.has(hit.resourceID) && hit.evidence.every(evidence => {
        const source = sources.get(evidence.sourceID);
        return source?.resource_id === hit.resourceID && source.generationID === evidence.generationID;
      }));
      const parsed = new Set(resources.map(row => row.resource_id)), partial = new Set(resources.filter(row => row.state === "partial").map(row => row.resource_id));
      // Reuse sources already fenced in this transaction. This avoids repeating
      // ownership/version joins for every segment, without caching mutable counts.
      const origins = JSON.stringify(resources.map(row => [row.generationID, row.resource_id]));
      const coverageRows = resources.length ? (await sql<{ resource_id: string; total: number; completed: number; skipped: number }>`
        SELECT json_extract(origin.value, '$[1]') AS resource_id, count(seg.id) AS total,
          sum(CASE WHEN e.state = 'active' THEN 1 ELSE 0 END) AS completed,
          sum(CASE WHEN seg.skip_reason IS NOT NULL THEN 1 ELSE 0 END) AS skipped
        FROM json_each(${origins}) origin
        CROSS JOIN content_blocks b ON b.generation_id = json_extract(origin.value, '$[0]')
        CROSS JOIN embedding_segments seg ON seg.block_id = b.id
          AND seg.profile_id = (SELECT id FROM embedding_profiles WHERE profile_key = ${identity})
        LEFT JOIN block_embeddings e ON e.id = seg.embedding_id
        GROUP BY json_extract(origin.value, '$[1]')`.execute(tx)).rows : [];
      const coverage = new Map(coverageRows.map(row => [row.resource_id, { completed: Number(row.completed), total: Number(row.total), skipped: Number(row.skipped) }]));
      const embedded = new Set(coverageRows.filter(row => row.completed > 0).map(row => row.resource_id));
      result.coverage = { resources: currentScope.length, parsed: currentScope.filter(id => parsed.has(id)).length, embedded: currentScope.filter(id => embedded.has(id)).length };
      // Stable within each group; preserve the incoming ranking and keep possible
      // matches visible instead of silently dropping them at the threshold.
      hits = hits.map(hit => ({ ...hit, relevance: classifyRelevance(hit, config.relevanceThreshold) }))
        .sort((a, b) => Number(a.relevance.group === "possible") - Number(b.relevance.group === "possible"));
      result.hits = hits.slice(0, config.results).map(hit => ({ ...hit, evidence: hit.evidence.slice(0, config.evidence),
        parsed: parsed.has(hit.resourceID), partialContent: partial.has(hit.resourceID), embedded: embedded.has(hit.resourceID),
        embeddingCoverage: coverage.get(hit.resourceID), metadataOnly: hit.evidence.length === 0 }));
      const metadataIDs = result.hits.filter(hit => hit.channels?.includes("metadata")).map(hit => hit.resourceID);
      if (metadataIDs.length) {
        const queryTerms = new Set(searchTokens(query).split(" ").filter(Boolean));
        const metadata = await tx.selectFrom("knowledge_resources").select(["id", "title", "abstract", "contributors_json", "publication_title", "doi", "publication_date", "metadata_json"]).where("id", "in", metadataIDs).execute();
        const flatten = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(flatten).join(" ") : value && typeof value === "object" ? Object.values(value).map(flatten).join(" ") : "";
        for (const hit of result.hits) {
          const row = metadata.find(row => row.id === hit.resourceID); if (!row) continue;
          const extra = JSON.parse(row.metadata_json) as Record<string, unknown>;
          const covered = new Set(["title", "abstractNote", "publicationTitle", "DOI", "date"]);
          const other = extra.fields && typeof extra.fields === "object" ? Object.fromEntries(Object.entries(extra.fields).filter(([key]) => !covered.has(key))) : {};
          const fields: Array<[NonNullable<RetrievalHit["metadataMatches"]>[number]["field"], string]> = [["title", row.title], ["abstract", row.abstract ?? ""], ["contributors", flatten(JSON.parse(row.contributors_json))],
            ["publication", row.publication_title ?? ""], ["doi", row.doi ?? ""], ["date", row.publication_date ?? ""], ["tags", flatten(extra.tags)], ["other", flatten(other)]];
          hit.metadataMatches = fields.filter(([, text]) => searchTokens(text).split(" ").some(term => queryTerms.has(term))).map(([field, text]) => ({ field, text }));
        }
      }
      signal.throwIfAborted(); if (identity !== spaceKey(this.embeddings.config.current)) throw new ModelError("config-changed");
      return result;
    });
  }
  private async allowedScope(scope: readonly string[], scopeKind: "active" | "trash", db: DatabaseContext = this.embeddings.repository.db): Promise<string[]> {
    const admitted = scopeKind === "trash" ? await db.selectFrom("knowledge_trash_resources").select("resource_id").distinct()
      .where(sql<boolean>`resource_id IN (SELECT value FROM json_each(${JSON.stringify(scope)}))`).execute()
      : await db.selectFrom("library_resources as lr").innerJoin("knowledge_libraries as l", "l.id", "lr.library_id")
        .innerJoin("knowledge_resources as r", "r.id", "lr.resource_id")
        .select("lr.resource_id").where("lr.deleted_at", "is", null).where("l.deleted_at", "is", null).where("r.deleted_at", "is", null)
        .where(sql<boolean>`lr.resource_id IN (SELECT value FROM json_each(${JSON.stringify(scope)}))`).execute();
    const permitted = new Set(scope);
    return [...new Set(admitted.map(row => row.resource_id))].filter(id => permitted.has(id));
  }
  private async queryVector(query: string, config: RetrievalConfig, signal: AbortSignal, guard?: () => Promise<void>): Promise<Float32Array> {
    const identity = spaceKey(config);
    if (identity !== spaceKey(this.embeddings.config.current)) throw new ModelError("config-changed");
    const key = `${identity}:${query}`, cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) { this.cache.delete(key); this.cache.set(key, cached); return cached.vector; }
    await guard?.();
    const [vector] = await this.embeddings.gateway.embed([query], signal, true, config, guard); signal.throwIfAborted();
    await guard?.();
    if (identity !== spaceKey(this.embeddings.config.current)) throw new ModelError("config-changed");
    this.cache.set(key, { vector, expires: Date.now() + 600000 });
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!); return vector;
  }
  private async text(query: string, scope: readonly string[], kind: "block" | "metadata", limit: number, scopeKind: "active" | "trash", options: RetrievalSearchOptions, evidenceLimit: number): Promise<RetrievalHit[]> {
    const expression = ftsExpression(query); if (!expression) return [];
    const terms = [...new Set(searchTokens(query).split(" ").filter(Boolean).map(searchKey))];
    const position = sql`coalesce((SELECT min(json_extract(value, '$[1]')) + 1 FROM json_each(d.body_offsets_json) WHERE json_extract(value, '$[0]') IN (${sql.join(terms)})), 1)`;
    const body = kind === "metadata" ? sql`''` : options.textMaxChars ? sql`substr(d.body, max(1, ${position} - ${Math.floor(options.textMaxChars / 4)}), ${options.textMaxChars})` : sql`d.body`;
    const hits: RetrievalHit[] = [], db = this.embeddings.repository.db;
    for (let start = 0; start < scope.length; start += 300) {
      await options.guard?.();
      const ids = scope.slice(start, start + 300);
      const rows = await sql<{ resource_id: string; title: string; block_id: string | null; generation_id: string | null; source_id: string | null; body: string; page_start: number | null; section: string | null; rank: number }>`
        WITH matches AS MATERIALIZED (
        SELECT d.resource_id, r.title, d.block_id, d.generation_id, d.source_id, ${body} AS body, b.page_start, n.label AS section, bm25(search_fts) AS rank
        FROM search_fts JOIN search_documents d ON d.rowid = search_fts.rowid JOIN knowledge_resources r ON r.id = d.resource_id
        LEFT JOIN content_blocks b ON b.id = d.block_id LEFT JOIN structure_nodes n ON n.id = b.structure_node_id
        LEFT JOIN resource_sources s ON s.id = d.source_id
        LEFT JOIN content_generations g ON g.id = d.generation_id
        WHERE search_fts MATCH ${expression} AND d.document_kind = ${kind} AND ${scopeKind === "trash" ? sql`1=1` : sql`r.deleted_at IS NULL`}
        AND d.resource_id IN (${sql.join(ids)}) AND (d.document_kind = 'metadata' OR (${blockPredicate(options)} AND s.active_generation_id = d.generation_id AND s.deleted_at IS NULL
          AND g.state IN ('ready', 'partial') AND g.source_version = s.source_version AND g.content_version = s.content_version))
        ), ranked AS (SELECT *, row_number() OVER (PARTITION BY resource_id ORDER BY rank, block_id) AS evidence_rank FROM matches)
        SELECT * FROM ranked WHERE evidence_rank <= ${evidenceLimit} ORDER BY rank LIMIT ${limit * evidenceLimit}`.execute(db);
      for (const row of rows.rows) {
        const evidence: RetrievalEvidence[] = row.block_id ? [{ blockID: row.block_id, sourceID: row.source_id!, generationID: row.generation_id!, text: row.body,
          section: row.section, page: row.page_start, score: -row.rank, scoreType: "fts", channel: "fulltext" }] : [];
        hits.push({ resourceID: row.resource_id, title: row.title, evidence, channels: [kind === "block" ? "fulltext" : "metadata"], score: -row.rank, scoreType: kind === "block" ? "fts" : "metadata", parsed: false, embedded: false, metadataOnly: !evidence.length });
      }
    } return this.aggregate(hits, limit, evidenceLimit);
  }
  private async vector(vector: Float32Array, scope: readonly string[], limit: number, identity: string, options: RetrievalSearchOptions, evidenceLimit: number): Promise<RetrievalHit[]> {
    const db = this.embeddings.repository.db;
    const session: VectorSearchSession = { filters: options, completeSmallScope: scope.length < limit };
    let count = Math.min(10000, limit * 5), hits: RetrievalHit[] = [];
    while (true) {
      await options.guard?.();
      const rows = await this.embeddings.store.search(vector, scope, count, identity, undefined, session); hits = [];
      const scores = new Map(rows.map(row => [row.embeddingID, row.score]));
      for (let start = 0; start < rows.length; start += 300) {
        await options.guard?.();
        const batch = rows.slice(start, start + 300); if (!batch.length) continue;
        const evidence = await db.selectFrom("embedding_segments as seg").innerJoin("block_embeddings as e", "e.id", "seg.embedding_id")
          .innerJoin("content_blocks as b", "b.id", "seg.block_id").innerJoin("resource_sources as s", "s.active_generation_id", "b.generation_id")
          .innerJoin("content_generations as g", "g.id", "b.generation_id")
          .innerJoin("knowledge_resources as r", "r.id", "s.resource_id").leftJoin("structure_nodes as n", "n.id", "b.structure_node_id")
          .select(["e.id", "r.id as resourceID", "r.title", "b.id as blockID", "b.generation_id", "b.page_start", "s.id as sourceID", "n.label as section", "seg.id as segmentID"])
          .where(sql<boolean>`${blockPredicate(options)}`).where("e.id", "in", batch.map(row => row.embeddingID)).where("e.state", "=", "active").where("s.deleted_at", "is", null)
          .where(sql<boolean>`s.resource_id IN (SELECT value FROM json_each(${JSON.stringify(scope)}))`)
          .where("g.state", "in", ["ready", "partial"]).whereRef("g.source_version", "=", "s.source_version").whereRef("g.content_version", "=", "s.content_version").execute();
        for (const row of evidence) {
          const score = scores.get(row.id)!;
          hits.push({ resourceID: row.resourceID, title: row.title, score, scoreType: "cosine", channels: ["vector"], parsed: true, embedded: true, metadataOnly: false,
            evidence: [{ blockID: row.blockID, segmentID: row.segmentID, sourceID: row.sourceID, generationID: row.generation_id, text: "", section: row.section, page: row.page_start, score, scoreType: "cosine", channel: "vector" }] });
        }
      }
      const grouped = this.aggregate(hits, limit, evidenceLimit);
      if (session.exhausted || grouped.length >= limit || rows.length < count || count >= 10000) {
        const segments = [...new Set(grouped.flatMap(hit => hit.evidence.map(row => row.segmentID!)))], texts = new Map<string, string>();
        for (let start = 0; start < segments.length; start += 300) {
          await options.guard?.();
          const body = await db.selectFrom("embedding_segments").select(["id", "input_text"]).where("id", "in", segments.slice(start, start + 300)).execute();
          for (const row of body) texts.set(row.id, row.input_text);
        }
        return grouped.filter(hit => hit.evidence.every(row => texts.has(row.segmentID!)))
          .map(hit => ({ ...hit, evidence: hit.evidence.map(row => ({ ...row, text: texts.get(row.segmentID!)! })) }));
      }
      count = Math.min(10000, count * 2);
    }
  }
  private aggregate(hits: RetrievalHit[], limit: number, evidenceLimit = this.embeddings.config.current.evidence): RetrievalHit[] {
    hits.sort((a, b) => b.score - a.score || a.resourceID.localeCompare(b.resourceID));
    const unique = new Map<string, RetrievalHit>();
    for (const hit of hits) {
      const existing = unique.get(hit.resourceID);
      if (!existing) unique.set(hit.resourceID, hit);
      else for (const evidence of hit.evidence) if (existing.evidence.length < evidenceLimit && !existing.evidence.some(row => row.blockID === evidence.blockID && row.segmentID === evidence.segmentID)) existing.evidence.push(evidence);
    } return [...unique.values()].slice(0, limit);
  }
  close(): void { this.cache.clear(); }
}
