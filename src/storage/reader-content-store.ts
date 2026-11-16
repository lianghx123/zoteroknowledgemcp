import { t } from "../shared/localization";
import type { ReaderContentRepository } from "../repositories/reader-content";
import { MAX_MARKDOWN_BYTES, MarkdownContentError, validateAttachment, validateStoredMarkdown } from "../schemas/knowledge-content";
import type { AttachmentIdentity, AttachmentMarkdown } from "../shared/contracts/knowledge-content";
import type { Kysely } from "kysely";
import type { Database } from "../database/types";
import { withReaderCacheLock } from "./reader-cache-lock";
import { prepareCacheReplacement, completeCacheReplacement, readerCacheJournalKey } from "./reader-cache-cleanup";

/** Local import cache only; this is not the planned generation/SQLite database. */
export class ReaderContentStore implements ReaderContentRepository {
  private readonly writes = new Map<string, Promise<void>>();
  private closing: Promise<void> | undefined;
  constructor(private readonly database: () => Kysely<Database> | undefined = () => undefined) {}

  private path(identity: AttachmentIdentity): string {
    validateAttachment(identity);
    return PathUtils.join(Zotero.DataDirectory.dir, "knowledgemcp", "reader-content",
      `${identity.libraryID}-${identity.itemKey}.json`);
  }

  async read(identity: AttachmentIdentity): Promise<AttachmentMarkdown | null> {
    const path = this.path(identity);
    return withReaderCacheLock(path, async () => {
      const db = this.database(), relative = `reader-content/${identity.libraryID}-${identity.itemKey}.json`;
      const queued = db && await db.selectFrom("file_cleanup").select("relative_path").where("relative_path", "=", relative).executeTakeFirst();
      const marker = queued && await db!.selectFrom("plugin_state").select("value_json").where("key", "=", readerCacheJournalKey(relative)).executeTakeFirst();
      if (queued && !marker) return null;
      if (!(await IOUtils.exists(path))) return null;
      if ((await IOUtils.stat(path)).size > MAX_MARKDOWN_BYTES * 6 + 4096) {
        throw new MarkdownContentError(t("error-stored-size"));
      }
      const record = validateStoredMarkdown(JSON.parse(await IOUtils.readUTF8(path)), identity);
      const { cacheWriteToken: token, ...content } = record as typeof record & { cacheWriteToken?: string };
      if (queued && (!token || JSON.stringify(token) !== marker?.value_json)) return null;
      return content;
    });
  }

  async save(content: AttachmentMarkdown): Promise<void> {
    if (this.closing) throw new Error("Reader content store is closing.");
    validateStoredMarkdown(content, content.attachment);
    const path = this.path(content.attachment);
    const snapshot = JSON.parse(JSON.stringify(content)) as typeof content & { cacheWriteToken?: string };
    // Readers of the same attachment share a temporary file; serialize their writes.
    const pending = withReaderCacheLock(path, async () => {
      const db = this.database();
      const relative = `reader-content/${snapshot.attachment.libraryID}-${snapshot.attachment.itemKey}.json`;
      const token = db ? await prepareCacheReplacement(db, relative) : undefined;
      const { cacheWriteToken: _oldToken, ...record } = snapshot;
      const serialized = JSON.stringify({ ...record, ...(token ? { cacheWriteToken: token } : {}) });
      await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
      await IOUtils.writeUTF8(path, serialized, { tmpPath: `${path}.tmp` });
      if (db && token) await db.transaction().execute(tx => completeCacheReplacement(tx, relative, token));
    });
    this.writes.set(path, pending);
    try { await pending; }
    finally { if (this.writes.get(path) === pending) this.writes.delete(path); }
  }

  async flush(): Promise<void> { await Promise.allSettled([...this.writes.values()]); }

  /** Finish accepted writes before another application can use the same cache. */
  close(): Promise<void> {
    return this.closing ??= Promise.allSettled([...this.writes.values()]).then(() => {});
  }
}
