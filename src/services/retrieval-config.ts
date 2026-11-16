import { modelProviders } from "../providers/models";
import { hostRuntime } from "../core/host-runtime";
import { ModelError, spaceKey, vectorDimensions, type RetrievalConfig } from "../shared/contracts/retrieval";

const bailian = modelProviders.get("bailian").definition;
export const defaultRetrievalConfig: RetrievalConfig = {
  version: 1, revision: 0, enabled: false, autoEmbed: true, paused: false,
  embedding: { provider: bailian.id, model: bailian.embeddingModel, endpoint: bailian.embeddingEndpoint, credentialRef: "embedding" },
  rerank: { provider: bailian.id, model: bailian.rerankModel, endpoint: bailian.rerankEndpoint, credentialRef: "rerank" },
  shareCredential: true, dimensions: 768, indexMode: "f32", candidates: 100, results: 20, evidence: 3, relevanceThreshold: 0.5,
  concurrency: 2, batchSize: 10, timeoutMs: 60000, requestsPerMinute: 60,
};
export function validateRetrievalConfig(value: unknown): RetrievalConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelError("config");
  const c: RetrievalConfig = { ...value as RetrievalConfig, relevanceThreshold: (value as RetrievalConfig).relevanceThreshold === undefined ? 0.5 : (value as RetrievalConfig).relevanceThreshold };
  if (!c || c.version !== 1 || !Number.isSafeInteger(c.revision) || c.revision < 0 || !vectorDimensions.includes(c.dimensions)
    || !["f32", "i8"].includes(c.indexMode)) throw new ModelError("config");
  for (const key of ["enabled", "autoEmbed", "paused", "shareCredential"] as const) if (typeof c[key] !== "boolean") throw new ModelError("config");
  for (const service of [c.embedding, c.rerank]) {
    if (!service || typeof service.model !== "string" || !service.model.trim() || typeof service.credentialRef !== "string"
      || !/^[a-zA-Z0-9_-]{1,80}$/.test(service.credentialRef)) throw new ModelError("config");
    const definition = modelProviders.get(service.provider).definition;
    const fields = new Map((definition.fields ?? []).map(field => [field.key, field]));
    if (service.options !== undefined && (!service.options || typeof service.options !== "object" || Array.isArray(service.options))) throw new ModelError("config");
    for (const [key, option] of Object.entries(service.options ?? {})) {
      const field = fields.get(key);
      if (!field || typeof option !== field.type || (typeof option === "number" && !Number.isFinite(option))) throw new ModelError("config");
    }
    for (const field of fields.values()) if (field.required && (service.options?.[field.key] === undefined || service.options[field.key] === "")) throw new ModelError("config");
    let url: URL; try { url = new URL(service.endpoint); } catch { throw new ModelError("config"); }
    if (url.username || url.password || url.hash || url.search || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new ModelError("config");
  }
  if (!modelProviders.get(c.embedding.provider).definition.dimensions.includes(c.dimensions)) throw new ModelError("dimensions");
  const limits = { candidates: [1, modelProviders.get(c.rerank.provider).definition.maxRerankDocuments], results: [1, 200], evidence: [1, 10],
    concurrency: [1, 8], batchSize: [1, modelProviders.get(c.embedding.provider).definition.maxBatch], timeoutMs: [1000, 600000], requestsPerMinute: [1, 3600] };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const n = c[key as keyof RetrievalConfig];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) throw new ModelError("config");
  }
  if (c.candidates < c.results) throw new ModelError("config");
  if (typeof c.relevanceThreshold !== "number" || !Number.isFinite(c.relevanceThreshold) || c.relevanceThreshold < 0 || c.relevanceThreshold > 1) throw new ModelError("config");
  return JSON.parse(JSON.stringify(c)) as RetrievalConfig;
}
export type SpaceChangeChoice = "keep" | "clear" | "cancel";
/** Credentials have their own secure store; this file only contains references. */
export class RetrievalConfigFile {
  readonly path = PathUtils.join(Zotero.DataDirectory.dir, "knowledgemcp", "retrieval.json");
  current = validateRetrievalConfig(defaultRetrievalConfig);
  private observed: string | undefined;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private epoch = 0;
  private operations = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;
  error = false;
  constructor(private readonly changed: (previous: RetrievalConfig) => void = () => {}) {}
  start(): Promise<void> {
    if (this.closed) return hostRuntime().Promise.reject(new ModelError("config"));
    return this.track(this.initialize());
  }
  private async initialize(): Promise<void> {
    if (!(await IOUtils.exists(this.path))) {
      await IOUtils.makeDirectory(PathUtils.parent(this.path), { ignoreExisting: true });
      await IOUtils.writeUTF8(this.path, `${JSON.stringify(this.current, null, 2)}\n`, { tmpPath: `${this.path}.tmp` });
    }
    await this.reload(); this.poll();
  }
  private poll(): void {
    if (!this.closed) this.timer = setTimeout(() => { void this.reload().finally(() => this.poll()); }, 2000);
  }
  private track(pending: Promise<void>): Promise<void> {
    const operation = hostRuntime().Promise.resolve(pending);
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }
  reload(): Promise<void> {
    if (this.closed) return hostRuntime().Promise.resolve();
    return this.track(this.read(++this.epoch));
  }
  private async read(epoch: number): Promise<void> {
    try {
      if (!(await IOUtils.exists(this.path))) {
        if (!this.closed && epoch === this.epoch && this.observed !== undefined) this.error = true;
        return;
      }
      if ((await IOUtils.stat(this.path)).size > 65536) throw new ModelError("config");
      const text = await IOUtils.readUTF8(this.path);
      // A newer read or an accepted local publication owns application order.
      if (this.closed || epoch !== this.epoch) return;
      if (text === this.observed) { this.error = false; return; }
      const next = validateRetrievalConfig(JSON.parse(text)), previous = this.current;
      this.current = next; this.observed = text; this.error = false; this.changed(previous);
    } catch { if (!this.closed && epoch === this.epoch) this.error = true; }
  }
  async save(value: unknown, choice?: SpaceChangeChoice, clear?: (oldConfig: RetrievalConfig, publish: () => Promise<void>) => Promise<void>, prepare?: () => Promise<() => Promise<void>>): Promise<boolean> {
    if (this.closed) throw new ModelError("config");
    const next = validateRetrievalConfig(value), previous = this.current, observed = this.observed;
    if (spaceKey(next) !== spaceKey(previous)) {
      if (!choice) throw new ModelError("space-choice-required");
      if (choice === "cancel") return false;
      if (choice === "clear" && !clear) throw new ModelError("clear-unavailable");
    }
    const { Map: RuntimeMap, Promise: RuntimePromise } = hostRuntime();
    let writes = Zotero.__knowledgeMCPConfigWrites;
    try { writes?.get(this.path); } catch { writes = undefined; }
    if (!writes) Zotero.__knowledgeMCPConfigWrites = writes = new RuntimeMap<string, Promise<void>>();
    const lock = Zotero.isWin ? this.path.toLowerCase() : this.path;
    const work = RuntimePromise.resolve(writes.get(lock)).catch(() => {}).then(async () => {
      const existing = await IOUtils.exists(this.path) ? await IOUtils.readUTF8(this.path) : undefined;
      if (existing !== observed || this.current !== previous || next.revision !== previous.revision) throw new ModelError("config-conflict");
      let rollback: (() => Promise<void>) | undefined, published = false;
      const publish = async () => {
        if (published) return;
        this.epoch++;
        next.revision++;
        const text = `${JSON.stringify(next, null, 2)}\n`;
        await IOUtils.makeDirectory(PathUtils.parent(this.path), { ignoreExisting: true });
        try { await IOUtils.writeUTF8(this.path, text, { tmpPath: `${this.path}.tmp` }); }
        catch (error) {
          // A completed atomic replacement can lose its acknowledgement.
          if (await IOUtils.readUTF8(this.path).catch(() => undefined) !== text) throw error;
        }
        published = true;
        // Also invalidate reads started during the atomic file replacement.
        this.epoch++;
        this.current = next; this.observed = text; this.error = false;
        if (!this.closed) this.changed(previous);
      };
      try {
        rollback = await prepare?.();
        // The runtime owns the scheduling pause through publication and reload.
        if (choice === "clear" && spaceKey(next) !== spaceKey(previous)) await clear!(previous, publish);
        await publish();
      } catch (error) {
        if (!published && rollback) { try { await rollback(); } catch { throw new ModelError("credentials-rollback"); } }
        throw error;
      }
    });
    const tail = work.then(() => {}, () => {}); writes.set(lock, tail); this.track(tail);
    try { await work; return true; } finally { if (writes.get(lock) === tail) writes.delete(lock); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.epoch++; clearTimeout(this.timer);
    return this.closing = hostRuntime().Promise.allSettled([...this.operations]).then(() => {});
  }
}
