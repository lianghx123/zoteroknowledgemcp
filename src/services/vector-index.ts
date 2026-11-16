import type { IndexMode } from "../shared/contracts/retrieval";
import type { VectorMessage } from "../worker/vector-worker/runtime";
import { hostRuntime, hostSetTimeout, hostClearTimeout } from "../core/host-runtime";

interface VectorWorker {
  onmessage: ((event: MessageEvent<{ id: number; value: unknown; error?: string }>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(value: unknown, transfer?: Transferable[]): void; terminate(): void;
}
/** Worker ownership and bounded disk writes are confined to the privileged host. */
export class VectorIndex {
  private worker: VectorWorker | undefined;
  private sequence = 0;
  private waiting = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  private saving = false;
  private scope: number[] | undefined;
  private opening: AbortController | undefined;
  constructor(private readonly rootURI: string) {}
  private call<T>(message: Omit<VectorMessage, "id">, transfer: Transferable[] = []): Promise<T> {
    if (!this.worker) return hostRuntime().Promise.reject(new Error("index-closed"));
    return new (hostRuntime().Promise)<T>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = hostSetTimeout(() => this.fail(new Error("index-timeout")), 600000);
      this.waiting.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.worker!.postMessage({ ...message, id }, transfer); }
      catch (error) { hostClearTimeout(timer); this.waiting.delete(id); reject(error); }
    });
  }
  private fail(error: Error): void {
    this.opening?.abort(); this.opening = undefined;
    this.worker?.terminate(); this.worker = undefined;
    this.scope = undefined;
    for (const row of this.waiting.values()) { hostClearTimeout(row.timer); row.reject(error); } this.waiting.clear();
  }
  async open(dimensions: number, mode: IndexMode): Promise<void> {
    this.close();
    const worker = new ChromeWorker("resource://knowledgemcp-vector/worker.js"), runtime = hostRuntime(), controller = new runtime.AbortController();
    this.worker = worker; this.opening = controller;
    worker.onmessage = event => {
      if (this.worker !== worker) return;
      const row = this.waiting.get(event.data.id); if (!row) return;
      hostClearTimeout(row.timer); this.waiting.delete(event.data.id);
      if (event.data.error) row.reject(new Error(event.data.error)); else row.resolve(event.data.value);
    };
    worker.onerror = () => { if (this.worker === worker) this.fail(new Error("index-worker")); };
    try {
      // Package assets and request timers must remain usable after the last window closes.
      const response = await runtime.fetch(`${this.rootURI}content/vector/usearch.wasm`, { signal: controller.signal });
      if (!response.ok) throw new Error("index-wasm");
      const wasm = new Uint8Array(await response.arrayBuffer());
      controller.signal.throwIfAborted();
      if (this.worker !== worker) throw new Error("index-closed");
      await this.call({ op: "open", dimensions, scalar: mode === "f32" ? 1 : 4, wasm });
    } catch (error) {
      if (this.worker === worker) this.fail(new Error("index-open-failed"));
      throw error;
    } finally { if (this.opening === controller) this.opening = undefined; }
  }
  add(rows: Array<{ label: number; vector: Float32Array }>): Promise<void> { if (this.saving) throw new Error("index-saving"); return this.call({ op: "add", rows }); }
  remove(labels: number[]): Promise<void> { if (this.saving) throw new Error("index-saving"); return this.call({ op: "remove", labels }); }
  async query(vector: Float32Array, labels: number[], limit: number): Promise<Array<{ label: number; score: number }>> {
    if (!labels.length) return [];
    const perform = (exact: boolean): Promise<Array<{ label: number; score: number }>> => {
      const changed = !this.scope || this.scope.length !== labels.length || !labels.every((label, index) => label === this.scope![index]);
      if (changed) this.scope = [...labels];
      // A caller may pass a view into a complete query matrix. Clone only the
      // selected vector, since structured clone otherwise copies its backing buffer.
      return this.call({ op: "query", vector: new Float32Array(vector), labels: changed ? this.scope : undefined, limit, exact });
    };
    const result = await perform(labels.length <= 5000);
    return result.length < Math.min(labels.length, limit) && labels.length > 5000
      ? perform(true) : result;
  }
  stats(): Promise<Record<string, number>> { return this.call({ op: "stats" }); }
  async save(path: string, signal: AbortSignal): Promise<{ hash: string; bytes: number }> {
    this.saving = true; const temporary = `${path}.tmp`;
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash); hash.init(hash.SHA256);
    try {
      const size = await this.call<number>({ op: "save-begin" });
      await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
      await IOUtils.write(temporary, new Uint8Array());
      let chunk: Uint8Array | undefined;
      for (let offset = 0; offset < size; offset += 4 * 1024 * 1024) {
        signal.throwIfAborted(); chunk = await this.call<Uint8Array>({ op: "save-slice", offset, bytes: chunk }, chunk ? [chunk.buffer as ArrayBuffer] : []);
        if (chunk.length !== Math.min(size - offset, 4 * 1024 * 1024)) throw new Error("index-save-length");
        hash.update(chunk, chunk.length);
        if (await IOUtils.write(temporary, chunk, { mode: "append", flush: true }) !== chunk.length) throw new Error("index-write-length");
      }
      signal.throwIfAborted(); await IOUtils.move(temporary, path, { noOverwrite: false });
      return { bytes: size, hash: Array.from(hash.finish(false), c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("") };
    } finally {
      await this.call({ op: "save-end" }).catch(() => {}); this.saving = false;
      await IOUtils.remove(temporary, { ignoreAbsent: true });
    }
  }
  async restore(path: string, expectedHash: string, expectedBytes: number): Promise<void> {
    if ((await IOUtils.stat(path)).size !== expectedBytes) throw new Error("index-snapshot-size");
    const bytes = await IOUtils.read(path), hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash); hash.init(hash.SHA256); hash.update(bytes, bytes.length);
    const actual = Array.from(hash.finish(false), c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    if (actual !== expectedHash) throw new Error("index-snapshot-hash");
    await this.call({ op: "restore", bytes }, [bytes.buffer as ArrayBuffer]);
  }
  close(): void { this.fail(new Error("index-closed")); }
}
