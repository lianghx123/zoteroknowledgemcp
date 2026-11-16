import { sql, type Kysely } from "kysely";
import type { Database } from "../database/types";
import type { DatabaseContext } from "../database/unit-of-work";
import { MAX_MARKDOWN_BYTES, validateStoredMarkdown } from "../schemas/knowledge-content";
import { withReaderCacheLock } from "./reader-cache-lock";

export function readerCacheJournalKey(relative: string): string {
  return `reader-cache-replacement:${relative.replace(/\.tmp$/, "")}`;
}

/** Persist replacement intent before I/O, retaining the old deletion journal. */
export async function prepareCacheReplacement(db: Kysely<Database>, relative: string): Promise<string | undefined> {
  return db.transaction().execute(async tx => {
    const pending = await tx.selectFrom("file_cleanup").select("relative_path")
      .where("relative_path", "in", [relative, `${relative}.tmp`]).executeTakeFirst();
    if (!pending) return;
    const result = await sql<{ token: string }>`SELECT lower(hex(randomblob(16))) AS token`.execute(tx);
    const token = result.rows[0].token;
    await tx.insertInto("plugin_state").values({ key: readerCacheJournalKey(relative), value_json: JSON.stringify(token), updated_at: Date.now() })
      .onConflict(conflict => conflict.column("key").doUpdateSet({ value_json: JSON.stringify(token), updated_at: Date.now() })).execute();
    return token;
  });
}

/** A later purge invalidates the token, so an old writer cannot cancel it. */
export async function completeCacheReplacement(tx: DatabaseContext, relative: string, token: string): Promise<void> {
  const marker = await tx.selectFrom("plugin_state").select("value_json").where("key", "=", readerCacheJournalKey(relative)).executeTakeFirst();
  if (marker?.value_json !== JSON.stringify(token)) return;
  await tx.deleteFrom("file_cleanup").where("relative_path", "in", [relative, `${relative}.tmp`]).execute();
  await tx.deleteFrom("plugin_state").where("key", "=", readerCacheJournalKey(relative)).execute();
}

/** Recover either side of an interrupted atomic replacement under the same lock. */
export async function cleanupReaderCache(db: Kysely<Database>, relative: string): Promise<void> {
  const base = relative.replace(/\.tmp$/, "");
  const absolute = PathUtils.join(Zotero.DataDirectory.dir, "knowledgemcp", ...base.split("/"));
  await withReaderCacheLock(absolute, () => db.transaction().execute(async tx => {
    const rows = await tx.selectFrom("file_cleanup").select("relative_path").where("relative_path", "in", [base, `${base}.tmp`]).execute();
    if (!rows.length) return;
    const marker = await tx.selectFrom("plugin_state").select("value_json").where("key", "=", readerCacheJournalKey(base)).executeTakeFirst();
    let replaced = false;
    if (marker && await IOUtils.exists(absolute) && (await IOUtils.stat(absolute)).size <= MAX_MARKDOWN_BYTES * 6 + 4096) {
      // Read failures retain the journal. Invalid/unfinished files are reclaimable.
      const text = await IOUtils.readUTF8(absolute);
      try {
        const record = JSON.parse(text), identity = /^reader-content\/(\d+)-([A-Z0-9]+)\.json$/.exec(base)!;
        validateStoredMarkdown(record, { libraryID: Number(identity[1]), itemKey: identity[2] });
        replaced = typeof record.cacheWriteToken === "string" && JSON.stringify(record.cacheWriteToken) === marker.value_json;
      } catch { /* An old or incomplete cache does not confirm a replacement. */ }
    }
    for (const row of rows) {
      if (row.relative_path === base && replaced) continue;
      const path = row.relative_path === base ? absolute : `${absolute}.tmp`;
      if (await IOUtils.exists(path)) await IOUtils.remove(path);
    }
    await tx.deleteFrom("file_cleanup").where("relative_path", "in", [base, `${base}.tmp`]).execute();
    await tx.deleteFrom("plugin_state").where("key", "=", readerCacheJournalKey(base)).execute();
  }));
}
