import { modelProviders, type ProviderRegistry, type ProviderRequest } from "../providers/models";
import { ModelError, type ModelServiceConfig, type RetrievalConfig } from "../shared/contracts/retrieval";
import { BrowserParseTransport } from "../parsers/transport";
import { ParseError } from "../shared/contracts/parsing";
import { hostSetTimeout, hostClearTimeout } from "../core/host-runtime";

interface Waiter { provider: string; priority: number; signal: AbortSignal; resolve(): void; reject(error: unknown): void; abort(): void; }
/** A shared queue gives foreground requests precedence over queued background work. */
export class ModelGateway {
  onRequest: ((event: { operation: "document-embedding" | "query-embedding" | "rerank"; attempt: number; networkMs: number; succeeded: boolean }) => void) | undefined;
  private active = 0;
  private queue: Waiter[] = [];
  private next = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private transport = new BrowserParseTransport();
  constructor(private readonly config: () => RetrievalConfig, private readonly credential: (reference: string) => string, readonly providers: ProviderRegistry = modelProviders, private readonly maximumRetries = 3) {}
  private acquire(provider: string, signal: AbortSignal, priority: number): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry: Waiter = { provider, priority, signal, resolve, reject, abort: () => {
        this.queue = this.queue.filter(row => row !== entry); reject(new ModelError("cancelled")); this.pump();
      } };
      signal.addEventListener("abort", entry.abort, { once: true }); this.queue.push(entry); this.queue.sort((a, b) => b.priority - a.priority); this.pump();
    });
  }
  private pump(): void {
    hostClearTimeout(this.timer); this.timer = undefined;
    while (this.active < this.config().concurrency && this.queue.length) {
      const now = Date.now(), position = this.queue.findIndex(row => (this.next.get(row.provider) ?? 0) <= now);
      if (position < 0) {
        const due = Math.min(...this.queue.map(row => this.next.get(row.provider) ?? now));
        this.timer = hostSetTimeout(() => this.pump(), Math.max(1, due - now)); return;
      }
      const [entry] = this.queue.splice(position, 1); entry.signal.removeEventListener("abort", entry.abort);
      if (entry.signal.aborted) { entry.reject(new ModelError("cancelled")); continue; }
      this.next.set(entry.provider, now + 60000 / this.config().requestsPerMinute);
      this.active++; entry.resolve();
    }
  }
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => { hostClearTimeout(timer); reject(new ModelError("cancelled")); };
      const timer = hostSetTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private context(service: ModelServiceConfig, signal: AbortSignal, foreground: boolean, reference = service.credentialRef, operation: "document-embedding" | "query-embedding" | "rerank" = foreground ? "query-embedding" : "document-embedding", beforeRequest?: () => Promise<void>): ProviderRequest {
    const key = this.credential(reference);
    return { config: service, key, signal, request: async (url, body, options) => {
      for (let attempt = 0; ; attempt++) {
        await this.acquire(service.provider, signal, foreground ? 1 : 0);
        let retryDelay = 0;
        try {
          await beforeRequest?.();
          signal.throwIfAborted();
          const c = this.config();
          const started = Date.now(); let succeeded = false;
          let response: Awaited<ReturnType<BrowserParseTransport["request"]>>;
          try {
            response = await this.transport.request(url, { method: "POST", headers: { "Content-Type": "application/json", ...(options?.headers ?? { Authorization: `Bearer ${key}` }) }, body: JSON.stringify(body), redirect: "error" }, c.timeoutMs, 32 * 1024 * 1024, signal);
            succeeded = true;
          } finally { try { this.onRequest?.({ operation, attempt, networkMs: Date.now() - started, succeeded }); } catch { /* Measurement cannot change request outcome. */ } }
          try { return JSON.parse(new TextDecoder().decode(response.bytes)) as unknown; } catch { throw new ModelError("protocol"); }
        } catch (error) {
          if (signal.aborted) throw new ModelError("cancelled");
          const failure = error instanceof ParseError ? new ModelError(error.code, error.retryable, error.retryAfterMs) : error;
          if (!(failure instanceof ModelError) || !failure.retryable || attempt >= this.maximumRetries) throw failure;
          retryDelay = Math.max(failure.retryAfterMs, 500 * 2 ** attempt);
          if (failure.retryAfterMs) this.next.set(service.provider, Math.max(this.next.get(service.provider) ?? 0, Date.now() + failure.retryAfterMs));
        } finally { this.active--; this.pump(); }
        if (retryDelay) await this.sleep(retryDelay, signal);
      }
    } };
  }
  embed(texts: readonly string[], signal: AbortSignal, query = false, snapshot = this.config(), beforeRequest?: () => Promise<void>): Promise<Float32Array[]> {
    const c = snapshot, provider = this.providers.get(c.embedding.provider);
    if (!texts.length || texts.length > provider.definition.maxBatch || texts.some(text => !text.trim() || text.length > provider.definition.maxInputCharacters)) throw new ModelError("input-limit");
    return provider.embedding.embed(this.context(c.embedding, signal, query, c.embedding.credentialRef, query ? "query-embedding" : "document-embedding", beforeRequest), texts, c.dimensions, query);
  }
  rerank(query: string, texts: readonly string[], signal: AbortSignal, beforeRequest?: () => Promise<void>): Promise<Array<{ index: number; score: number }>> {
    const c = this.config(), provider = this.providers.get(c.rerank.provider);
    if (!texts.length || texts.length > provider.definition.maxRerankDocuments) throw new ModelError("input-limit");
    return provider.rerank.rerank(this.context(c.rerank, signal, true, c.shareCredential ? c.embedding.credentialRef : c.rerank.credentialRef, "rerank", beforeRequest), query, texts);
  }
}
