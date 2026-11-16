import type { Kysely } from "kysely";
import type { Database } from "../database/types";
import type { AttachmentIdentity, AttachmentMarkdown } from "../shared/contracts/knowledge-content";
import type { ParsingPort } from "../shared/contracts/parsing";
import { imageType } from "../parsers/assets";
import { validateMarkdown } from "../schemas/knowledge-content";
import { parseFilePath } from "../storage/parse-files";
import { readVisualLinks } from "./visual-content";
import { readReferences } from "./reference-content";

export class ProcessedContentReader {
  constructor(private readonly db: Kysely<Database>, private readonly port: ParsingPort) {}
  async read(identity: AttachmentIdentity): Promise<AttachmentMarkdown | null> {
    const row = await this.db.selectFrom("zotero_item_links as z").innerJoin("zotero_libraries as l", "l.id", "z.zotero_library_id")
      .innerJoin("resource_sources as s", "s.id", "z.source_id").innerJoin("content_generations as g", "g.id", "s.active_generation_id")
      .innerJoin("knowledge_resources as r", "r.id", "s.resource_id")
      .select(["g.id", "g.published_at", "g.state"]).where("z.item_key", "=", identity.itemKey).where("l.local_library_id", "=", identity.libraryID)
      .where("z.state", "=", "current").where("l.availability", "=", "available").where("s.deleted_at", "is", null).where("r.status", "=", "active")
      .where("g.state", "in", ["ready", "partial"]).executeTakeFirst();
    if (!row) return null;
    const blocks = await this.db.selectFrom("content_blocks").select(["id", "block_type", "content_markdown", "metadata_json", "page_start", "page_end"])
      .where("generation_id", "=", row.id).orderBy("canonical_order").execute();
    const markdown = blocks.map(block => block.content_markdown).join("\n\n"); validateMarkdown(markdown);
    const files = await this.db.selectFrom("generation_files as g").innerJoin("stored_files as f", "f.id", "g.stored_file_id")
      .select(["g.asset_key", "f.relative_path", "f.sha256", "f.byte_length"]).where("g.generation_id", "=", row.id).where("g.role", "=", "image").where("f.state", "=", "available").execute();
    const assets: Record<string, string> = {}; let total = 0;
    for (const file of files) {
      // Only internally generated paths under the managed parse directory are resolvable.
      if (!/^parse\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\/\d+\.bin$/.test(file.relative_path) || file.byte_length > 10 * 1024 * 1024) continue;
      total += file.byte_length; if (total > 30 * 1024 * 1024) break;
      try {
        const bytes = await this.port.read(parseFilePath(file.relative_path));
        if (bytes.length !== file.byte_length || await this.port.hash(bytes) !== file.sha256) continue;
        const type = imageType(bytes); let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        const window = Zotero.getMainWindows?.().find(window => !window.closed);
        assets[file.asset_key] = `data:${type.mediaType};base64,${window ? window.btoa(binary) : btoa(binary)}`;
      } catch { /* A missing local image does not hide otherwise readable text. */ }
    }
    return { formatVersion: 1, attachment: { ...identity }, markdown, origin: "parse", generationID: row.id, updatedAt: row.published_at!, assets, partial: row.state === "partial",
      blocks: blocks.map(block => ({ id: block.id, type: block.block_type, markdown: block.content_markdown, label: String(JSON.parse(block.metadata_json).ocr_label ?? ""), pageStart: block.page_start, pageEnd: block.page_end })),
      visualLinks: await readVisualLinks(this.db, row.id), references: await readReferences(this.db, row.id) };
  }
}
