import { ParseError } from "../../shared/contracts/parsing";

/** ZIP names are identifiers only; they are never used as local filesystem paths. */
export function archiveName(name: string): string {
  if (!name || name.length > 1024 || /[\\\x00-\x1f\x7f:#?%]/.test(name) || name.startsWith("/")
    || name.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new ParseError("format");
  return name;
}
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff; for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0;
}

/** Bounded in-memory ZIP decoding through Gecko's native streaming inflater. */
export async function readMinerUArchive(bytes: Uint8Array, maxBytes: number, signal: AbortSignal): Promise<Map<string, Uint8Array>> {
  if (bytes.length > maxBytes) throw new ParseError("size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder("utf-8", { fatal: true });
  const u16 = (offset: number) => view.getUint16(offset, true), u32 = (offset: number) => view.getUint32(offset, true);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 65557 || end + 22 + u16(end + 20) !== bytes.length
    || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) throw new ParseError("format");
  const count = u16(end + 10), centralSize = u32(end + 12), centralStart = u32(end + 16);
  if (!count || count > 2000 || centralStart + centralSize !== end) throw new ParseError("format");
  const entries: Array<{ name: string; size: number; compressed: number; method: number; crc: number; local: number; start: number; end: number; directory: boolean }> = [];
  const names = new Set<string>(); let offset = centralStart, expanded = 0;
  try {
    for (let index = 0; index < count; index++) {
      if (signal.aborted) throw new ParseError("interrupted");
      if (offset + 46 > end || u32(offset) !== 0x02014b50) throw new ParseError("format");
      const flags = u16(offset + 8), method = u16(offset + 10), compressed = u32(offset + 20), size = u32(offset + 24);
      const nameLength = u16(offset + 28), extra = u16(offset + 30), comment = u16(offset + 32), local = u32(offset + 42);
      const next = offset + 46 + nameLength + extra + comment;
      if (next > end || u16(offset + 34) || flags & 1 || ![0, 8].includes(method)
        || [size, compressed, local].includes(0xffffffff)) throw new ParseError("format");
      const rawName = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)), directory = rawName.endsWith("/");
      const name = archiveName(directory ? rawName.slice(0, -1) : rawName), folded = name.toLowerCase();
      const kind = (u32(offset + 38) >>> 16) & 0xf000;
      if (names.has(folded) || ![0, 0x8000, 0x4000].includes(kind) || (directory && size !== 0)) throw new ParseError("format");
      names.add(folded); expanded += size; if (expanded > maxBytes) throw new ParseError("size");
      if (local + 30 > centralStart || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) throw new ParseError("format");
      const localNameLength = u16(local + 26), localExtra = u16(local + 28), start = local + 30 + localNameLength + localExtra;
      if (start + compressed > centralStart || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== rawName) throw new ParseError("format");
      if (entries.some(entry => local < entry.end && start + compressed > entry.local)) throw new ParseError("format");
      entries.push({ name, size, compressed, method, crc: u32(offset + 16), local, start, end: start + compressed, directory }); offset = next;
    }
    if (offset !== end) throw new ParseError("format");
    const scope = Zotero.getMainWindows?.().find(window => !window.closed) as (Window & typeof globalThis) | undefined;
    if (!scope) throw new ParseError("network", true);
    const files = new Map<string, Uint8Array>();
    for (const entry of entries) {
      if (signal.aborted) throw new ParseError("interrupted");
      if (entry.directory || !/\.(json|md|png|jpe?g|webp|gif)$/i.test(entry.name)) continue;
      const compressed = bytes.subarray(entry.start, entry.end);
      let output: Uint8Array;
      if (entry.method === 0) output = new Uint8Array(compressed);
      else {
        const reader = new scope.Blob([new Uint8Array(compressed).buffer]).stream().pipeThrough(new scope.DecompressionStream("deflate-raw")).getReader();
        const chunks: Uint8Array[] = []; let length = 0;
        const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener("abort", abort, { once: true });
        try {
          while (true) {
            if (signal.aborted) throw new ParseError("interrupted");
            const { done, value } = await reader.read(); if (done) break;
            length += value.length; if (length > entry.size || length > maxBytes) throw new ParseError("size"); chunks.push(value);
          }
          output = new Uint8Array(length); let cursor = 0;
          for (const chunk of chunks) { output.set(chunk, cursor); cursor += chunk.length; }
        } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      if (output.length !== entry.size || crc32(output) !== entry.crc) throw new ParseError("format");
      files.set(entry.name, output);
    }
    if (signal.aborted) throw new ParseError("interrupted");
    return files;
  } catch (error) { if (error instanceof ParseError) throw error; throw new ParseError("format"); }
}
