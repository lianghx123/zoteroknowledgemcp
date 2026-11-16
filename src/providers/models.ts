import { ModelError, type ModelServiceConfig } from "../shared/contracts/retrieval";

export interface ProviderDefinition {
  id: string; labelKey: string; embeddingModel: string; rerankModel: string;
  embeddingEndpoint: string; rerankEndpoint: string; dimensions: readonly number[];
  maxInputCharacters: number; maxBatch: number; maxRerankDocuments: number;
  fields?: Array<{ key: string; labelKey: string; type: "string" | "number" | "boolean"; required?: boolean; defaultValue: string | number | boolean }>;
}
export interface ProviderRequest {
  config: ModelServiceConfig; key: string; signal: AbortSignal;
  request(url: string, body: unknown, options?: { headers: Record<string, string> }): Promise<unknown>;
}
export interface EmbeddingProvider { embed(context: ProviderRequest, texts: readonly string[], dimensions: number, query: boolean): Promise<Float32Array[]>; }
export interface RerankProvider { rerank(context: ProviderRequest, query: string, texts: readonly string[]): Promise<Array<{ index: number; score: number }>>; }
export interface ModelProvider { definition: ProviderDefinition; embedding: EmbeddingProvider; rerank: RerankProvider; }
export class ProviderRegistry {
  private entries = new Map<string, ModelProvider>();
  register(provider: ModelProvider): void {
    if (this.entries.has(provider.definition.id)) throw new ModelError("duplicate-provider");
    this.entries.set(provider.definition.id, provider);
  }
  get(id: string): ModelProvider { const value = this.entries.get(id); if (!value) throw new ModelError("provider"); return value; }
  list(): ModelProvider[] { return [...this.entries.values()]; }
}

export function normalizedVector(value: unknown, dimensions: number): Float32Array {
  if ((!Array.isArray(value) && !(value instanceof Float32Array)) || value.length !== dimensions) throw new ModelError("dimensions");
  let norm = 0;
  for (const number of value) { if (typeof number !== "number" || !Number.isFinite(number)) throw new ModelError("vector"); norm += number * number; }
  if (!Number.isFinite(norm) || norm <= 0) throw new ModelError("vector");
  const output = Float32Array.from(value, number => number / Math.sqrt(norm));
  if (output.some(number => !Number.isFinite(number))) throw new ModelError("vector");
  return output;
}
export function vectorBlob(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4), view = new DataView(bytes.buffer);
  vector.forEach((number, index) => view.setFloat32(index * 4, number, true)); return bytes;
}
export function vectorFromBlob(bytes: Uint8Array, dimensions: number): Float32Array {
  if (bytes.byteLength !== dimensions * 4) throw new ModelError("dimensions");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return normalizedVector(Array.from({ length: dimensions }, (_, index) => view.getFloat32(index * 4, true)), dimensions);
}
export const modelProviders = new ProviderRegistry();
modelProviders.register({
  definition: { id: "bailian", labelKey: "vector-provider-bailian", embeddingModel: "qwen3.7-text-embedding", rerankModel: "qwen3.7-text-rerank",
    embeddingEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
    rerankEndpoint: "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank",
    dimensions: [512, 768, 1024, 2048], maxInputCharacters: 8000, maxBatch: 10, maxRerankDocuments: 500 },
  embedding: { async embed(context, texts, dimensions, query) {
    const compatible = /\/embeddings\/?$/.test(new URL(context.config.endpoint).pathname);
    const response = await context.request(context.config.endpoint, compatible
      ? { model: context.config.model, input: texts, dimensions, encoding_format: "float" }
      : { model: context.config.model, input: { texts }, parameters: { dimension: dimensions, text_type: query ? "query" : "document" } }) as {
        data?: Array<{ index: number; embedding: unknown }>; output?: { embeddings?: Array<{ text_index: number; embedding: unknown }> } };
    const rows = compatible ? response?.data?.map(row => ({ text_index: row.index, embedding: row.embedding })) : response?.output?.embeddings;
    if (!Array.isArray(rows) || rows.length !== texts.length) throw new ModelError("embedding-response");
    const result: Float32Array[] = [], seen = new Set<number>();
    for (const row of rows) {
      if (!Number.isInteger(row.text_index) || row.text_index < 0 || row.text_index >= texts.length || seen.has(row.text_index)) throw new ModelError("embedding-response");
      seen.add(row.text_index); result[row.text_index] = normalizedVector(row.embedding, dimensions);
    }
    return result;
  } },
  rerank: { async rerank(context, query, texts) {
    const response = await context.request(context.config.endpoint, { model: context.config.model, input: { query, documents: texts },
      parameters: { top_n: texts.length, return_documents: false } }) as { output?: { results?: Array<{ index: number; relevance_score: number }> } };
    const rows = response?.output?.results, seen = new Set<number>();
    if (!Array.isArray(rows) || rows.length !== texts.length) throw new ModelError("rerank-response");
    return rows.map(row => {
      if (!Number.isInteger(row.index) || row.index < 0 || row.index >= texts.length || seen.has(row.index) || !Number.isFinite(row.relevance_score)) throw new ModelError("rerank-response");
      seen.add(row.index); return { index: row.index, score: row.relevance_score };
    });
  } },
});
