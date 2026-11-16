import { deflateRawSync } from "node:zlib";

const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
};
export function zip(entries, compress = true) {
  const locals = [], central = []; let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    const payload = compress ? deflateRawSync(bytes) : bytes, crc = crc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(compress ? 8 : 0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(compress ? 8 : 0, 10); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(payload.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, filename, payload); central.push(entry, filename); offset += local.length + filename.length + payload.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+XcAAAAASUVORK5CYII=", "base64");
export const mineruBlocks = [
  { type: "text", text: "Synthetic MinerU paper", text_level: 1, page_idx: 0, bbox: [100, 50, 900, 100] },
  { type: "text", text: "1 Introduction", text_level: 2, page_idx: 0, bbox: [100, 120, 900, 150] },
  { type: "text", text: "A synthetic paragraph with enough words for structured literature.", page_idx: 0, bbox: [100, 170, 900, 200] },
  { type: "text", text: "1.1 Nested topic", text_level: 2, page_idx: 0, bbox: [100, 210, 900, 240] },
  { type: "text", text: "1.1.1 Further detail", text_level: 2, page_idx: 0, bbox: [100, 250, 900, 280] },
  { type: "page_number", text: "1", page_idx: 0, bbox: [490, 950, 510, 980] },
  { type: "table", table_body: "<table><tr><td>42</td></tr></table>", table_caption: ["Table 1. Values"], table_footnote: ["A table note"], page_idx: 1, bbox: [100, 100, 900, 300] },
  { type: "equation", text: "$$E=mc^2$$", page_idx: 1, bbox: [100, 350, 900, 400] },
  { type: "image", img_path: "images/figure.png", image_caption: ["Figure 1. Synthetic"], page_idx: 1, bbox: [100, 450, 900, 600] },
];
export function mineruFiles(blocks = mineruBlocks, pages = [0, 1, 2]) {
  return new Map([
    ["full.md", new TextEncoder().encode("# Synthetic MinerU paper")],
    ["fixture_content_list.json", new TextEncoder().encode(JSON.stringify(blocks))],
    ["layout.json", new TextEncoder().encode(JSON.stringify({ _backend: "hybrid", _version_name: "3.4.4", pdf_info: pages.map(page_idx => ({ page_idx, page_size: [600, 800], para_blocks: [] })) }))],
    ["images/figure.png", png],
  ]);
}
