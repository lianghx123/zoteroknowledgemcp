// Emscripten glue is generated from the licensed source under vendor/usearch.
import createUSearch from "../../../addon/content/vector/usearch.mjs";

interface USearchModule {
  HEAPU8: Uint8Array; restoreSource: Uint8Array | null; restoreOffset: number;
  _malloc(bytes: number): number; _free(pointer: number): void; UTF8ToString(pointer: number): string;
  _ul_error(): number; _ul_open(dimensions: number, scalar: number, m: number, ef: number, metric: number): number;
  _ul_reserve(count: number): number; _ul_add(id: number, pointer: number): number; _ul_remove(id: number): number;
  _ul_filtered_search(query: number, count: number, allowed: number, length: number, exact: number): number;
  _ul_key(index: number): number; _ul_distance(index: number): number;
  _ul_size(): number; _ul_save_slice(offset: number, pointer: number, bytes: number): number;
  _ul_load_js(): number; _ul_validate_identity(dimensions: number, scalar: number, metric: number): number;
  _ul_count(): number; _ul_memory(): number; _ul_stat(field: number): number; _ul_close(): void;
}
export interface VectorMessage { id: number; op: string; dimensions?: number; scalar?: number; wasm?: Uint8Array; rows?: Array<{ label: number; vector: Float32Array }>; labels?: number[]; vector?: Float32Array; limit?: number; exact?: boolean; bytes?: Uint8Array; offset?: number; }
let library: USearchModule, pointer = 0, dimensions = 0, scalar = 1, saving = false;
let allowedPointer = 0, allowedCount = 0;
const chunkBytes = 4 * 1024 * 1024;
function releaseBytes(bytes: Uint8Array | undefined): void {
  // Gecko 140 supports transfer(). Detaching releases the owned backing store
  // without depending on the next worker GC after a large snapshot restore.
  (bytes?.buffer as (ArrayBuffer & { transfer?(length: number): ArrayBuffer }) | undefined)?.transfer?.(0);
}
function check(code: number): void { if (code) throw new Error(library.UTF8ToString(library._ul_error()) || "index"); }
function allocate(bytes: number): number { const p = library._malloc(bytes); if (!p) throw new Error("index-memory"); return p; }
function copy(vector: Float32Array): void {
  if (vector.length !== dimensions || vector.some(value => !Number.isFinite(value))) throw new Error("dimensions");
  library.HEAPU8.set(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), pointer);
}
async function execute(message: VectorMessage): Promise<unknown> {
  switch (message.op) {
    case "open": {
      dimensions = message.dimensions!; scalar = message.scalar!;
      if (![512, 768, 1024, 2048].includes(dimensions) || ![1, 4].includes(scalar)) throw new Error("index-profile");
      const compiled = await WebAssembly.compile(new Uint8Array(message.wasm!).buffer);
      library = await createUSearch({ instantiateWasm(imports: WebAssembly.Imports, ready: (instance: WebAssembly.Instance) => void) {
        const instance = new WebAssembly.Instance(compiled, imports); ready(instance); return instance.exports;
      }, print() {}, printErr() {} }) as USearchModule;
      check(library._ul_open(dimensions, scalar, 16, 100, 1)); pointer = allocate(dimensions * 4); return true;
    }
    case "add":
      if (saving) throw new Error("index-saving");
      check(library._ul_reserve(library._ul_count() + message.rows!.length));
      for (const row of message.rows!) { copy(row.vector); check(library._ul_add(row.label, pointer)); } return true;
    case "remove":
      if (saving) throw new Error("index-saving");
      for (const label of message.labels!) if (library._ul_remove(label) < 0) check(1); return true;
    case "query": {
      copy(message.vector!);
      if (message.labels) {
        const labels = Uint32Array.from(message.labels.sort((a, b) => a - b));
        if (allowedPointer) library._free(allowedPointer); allowedCount = labels.length;
        allowedPointer = allowedCount ? allocate(labels.byteLength) : 0;
        if (allowedCount) library.HEAPU8.set(new Uint8Array(labels.buffer), allowedPointer);
      }
      if (!allowedCount) return [];
        const size = library._ul_filtered_search(pointer, message.limit!, allowedPointer, allowedCount, message.exact ? 1 : 0);
        if (size < 0) check(1);
        return Array.from({ length: size }, (_, i) => ({ label: library._ul_key(i), score: 1 - library._ul_distance(i) }));
    }
    case "save-begin": saving = true; return library._ul_size();
    case "save-slice": {
      if (!saving) throw new Error("index-save-state");
      const bytes = Math.min(chunkBytes, library._ul_size() - message.offset!); if (bytes <= 0) return new Uint8Array();
      const output = allocate(bytes);
      try {
        const size = library._ul_save_slice(message.offset!, output, bytes); if (size !== bytes) throw new Error("index-save");
        const chunk = message.bytes && message.bytes.length >= bytes ? message.bytes.subarray(0, bytes) : new Uint8Array(bytes);
        chunk.set(library.HEAPU8.subarray(output, output + bytes)); return chunk;
      }
      finally { library._free(output); }
    }
    case "save-end": saving = false; return true;
    case "restore":
      try {
        library.restoreSource = message.bytes!; library.restoreOffset = 0; check(library._ul_load_js());
        if (library.restoreOffset !== message.bytes!.length) throw new Error("index-length");
        check(library._ul_validate_identity(dimensions, scalar, 1)); return true;
      } finally { library.restoreSource = null; library.restoreOffset = 0; releaseBytes(message.bytes); message.bytes = undefined; }
    case "stats": return { count: library._ul_count(), wasmHeapBytes: library.HEAPU8.length, indexBytes: library._ul_memory(),
      mallocBytes: library._ul_stat(1), vectorsAllocated: library._ul_stat(7), vectorsReserved: library._ul_stat(9) };
    case "close": library._free(pointer); if (allowedPointer) library._free(allowedPointer); library._ul_close(); return true;
    default: throw new Error("index-operation");
  }
}
// Serial dispatch prevents concurrent module initialization and mutation/save races.
let pending = Promise.resolve();
self.onmessage = (event: MessageEvent<VectorMessage>) => {
  const message = event.data;
  pending = pending.then(async () => {
    try {
      const value = await execute(message);
      const scope = self as unknown as { postMessage(value: unknown, transfer: Transferable[]): void };
      scope.postMessage({ id: message.id, value }, value instanceof Uint8Array ? [value.buffer as ArrayBuffer] : []);
    }
    catch (error) { self.postMessage({ id: message.id, error: error instanceof Error ? error.message : "index" }); }
  });
};
