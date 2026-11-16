import { ParseError, type ParsingPort } from "../../shared/contracts/parsing";

export class ZoteroParsingPort implements ParsingPort {
  private crypto(): Crypto { return Zotero.getMainWindows?.()[0]?.crypto ?? globalThis.crypto; }
  uuid(): string { return this.crypto().randomUUID(); }
  async hash(value: string | Uint8Array): Promise<string> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const hash = await this.crypto().subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
    return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
  }
  async attachment(libraryID: number, key: string, maxBytes: number): Promise<{ bytes: Uint8Array; name: string }> {
    const item = await Zotero.Items.getByLibraryAndKeyAsync?.(libraryID, key);
    if (!item || item.deleted || !item.isAttachment() || item.attachmentContentType !== "application/pdf") throw new ParseError("missing");
    if (item.parentItemID) {
      const parent = await Zotero.Items.getAsync?.(item.parentItemID);
      if (!parent || parent.deleted) throw new ParseError("missing");
    }
    const path = await item.getFilePathAsync();
    if (!path || !(await IOUtils.exists(path))) throw new ParseError("missing");
    if ((await IOUtils.stat(path)).size > maxBytes) throw new ParseError("size");
    const bytes = await IOUtils.read(path, { maxBytes: maxBytes + 1 });
    if (bytes.length > maxBytes) throw new ParseError("size");
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new ParseError("format");
    return { bytes, name: path.split(/[\\/]/).pop() || "document.pdf" };
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
    await IOUtils.write(path, bytes, { tmpPath: `${path}.tmp` });
  }
  read(path: string): Promise<Uint8Array> { return IOUtils.read(path); }
  exists(path: string): Promise<boolean> { return IOUtils.exists(path); }
  async remove(path: string): Promise<void> { await IOUtils.remove(path, { ignoreAbsent: true }); }
}
