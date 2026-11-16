export const vectorDimensions = [512, 768, 1024, 2048] as const;
export type VectorDimensions = typeof vectorDimensions[number];
export type IndexMode = "f32" | "i8";
export type RetrievalMode = "fulltext" | "semantic" | "enhanced" | "fusion";
export type RetrievalChannel = "metadata" | "fulltext" | "vector" | "rerank";
export interface ModelServiceConfig { provider: string; model: string; endpoint: string; credentialRef: string; options?: Record<string, string | number | boolean>; }
export interface RetrievalConfig {
  version: 1; revision: number; enabled: boolean; autoEmbed: boolean; paused: boolean;
  embedding: ModelServiceConfig; rerank: ModelServiceConfig; shareCredential: boolean;
  dimensions: VectorDimensions; indexMode: IndexMode; candidates: number; results: number; evidence: number; relevanceThreshold: number;
  concurrency: number; batchSize: number; timeoutMs: number; requestsPerMinute: number;
}
export interface EmbeddingSpace {
  provider: string; endpoint: string; model: string; dimensions: number;
  normalization: "l2"; inputVersion: string; admissionVersion: string;
  options?: Record<string, string | number | boolean>;
}
export interface RetrievalEvidence {
  blockID: string; segmentID?: string; sourceID: string; generationID: string;
  text: string; section: string | null; page: number | null; channel: "fulltext" | "vector";
  score: number; scoreType: "cosine" | "fts";
}
export interface RetrievalHit {
  resourceID: string; title: string; evidence: RetrievalEvidence[];
  score: number; scoreType: "cosine" | "fts" | "rrf" | "rerank" | "metadata";
  parsed: boolean; embedded: boolean; metadataOnly: boolean;
  channels?: Array<"metadata" | "fulltext" | "vector">;
  vectorScore?: number;
  relevance?: { group: "matched" | "possible"; basis: "cosine" | "rerank" | "keyword"; score?: number };
  metadataMatches?: Array<{ field: "title" | "abstract" | "contributors" | "publication" | "doi" | "date" | "tags" | "other"; text: string }>;
  partialContent?: boolean;
  embeddingCoverage?: { completed: number; total: number; skipped: number };
}
export interface RetrievalResult {
  query: string; mode: RetrievalMode; hits: RetrievalHit[]; channels: RetrievalChannel[];
  degraded: Array<{ channel: RetrievalChannel; code: string; details?: Record<string, unknown> }>;
  timings: { embeddingMs: number; localMs: number; rerankMs: number };
  coverage: { resources: number; parsed: number; embedded: number };
  threshold: number;
}
export class ModelError extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly retryAfterMs = 0, readonly details: Record<string, unknown> = {}) { super(code); }
}
export function embeddingSpace(config: RetrievalConfig): EmbeddingSpace {
  const options = Object.fromEntries(Object.entries(config.embedding.options ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return { provider: config.embedding.provider, endpoint: config.embedding.endpoint, model: config.embedding.model,
    dimensions: config.dimensions, normalization: "l2", inputVersion: "segments-1", admissionVersion: "2.1.0",
    ...(Object.keys(options).length ? { options } : {}) };
}
export function spaceKey(config: RetrievalConfig): string { return JSON.stringify(embeddingSpace(config)); }
