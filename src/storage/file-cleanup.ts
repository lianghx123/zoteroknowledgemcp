import type { Kysely } from "kysely";
import type { Database } from "../database/types";
import { cleanupReaderCache } from "./reader-cache-cleanup";
import { withVectorSnapshotLock } from "./vector-snapshot-lock";

/** Only generated paths within the plugin data directory may be reclaimed. */
export async function cleanupFiles(db: Kysely<Database>): Promise<void> {
  for (const row of await db.selectFrom("file_cleanup").select("relative_path").execute()) {
    const relative = row.relative_path;
    if (!/^(?:parse\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+\/(?:\d+\.bin|manifest\.json))?|reader-content\/\d+-[A-Z0-9]+\.json(?:\.tmp)?|vectors\/[a-f0-9-]{36}\.usearch(?:\.tmp)?)$/.test(relative)) continue;
    try {
      if (relative.startsWith("reader-content/")) {
        await cleanupReaderCache(db, relative);
        continue;
      }
      if (relative.startsWith("vectors/")) {
        const absolute = PathUtils.join(Zotero.DataDirectory.dir, "knowledgemcp", ...relative.split("/"));
        await withVectorSnapshotLock(absolute, async () => {
          // The publisher may have consumed this journal while cleanup waited.
          const pending = await db.selectFrom("file_cleanup").select("relative_path").where("relative_path", "=", relative).executeTakeFirst();
          if (!pending) return;
          const active = await db.selectFrom("vector_snapshot_state").select("profile_id").where("snapshot_path", "=", absolute).executeTakeFirst();
          if (!active) await IOUtils.remove(absolute, { ignoreAbsent: true });
          await db.deleteFrom("file_cleanup").where("relative_path", "=", relative).execute();
        });
        continue;
      }
      const referenced = new Set((await db.selectFrom("stored_files").select("relative_path").execute()).map(file => file.relative_path));
      const remove = async (path: string): Promise<void> => {
        const absolute = PathUtils.join(Zotero.DataDirectory.dir, "knowledgemcp", ...path.split("/"));
        if (!await IOUtils.exists(absolute)) return;
        if (/^parse\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)?$/.test(path)) {
          for (const child of await IOUtils.getChildren(absolute)) {
            const name = child.split(/[\\/]/).pop()!;
            if (/^[a-zA-Z0-9-]+$/.test(name) || /^(?:\d+\.bin(?:\.tmp)?|manifest\.json(?:\.tmp)?)$/.test(name)) await remove(`${path}/${name}`);
          }
          // Keep shared attempt directories; remove empty directories only.
          if (!(await IOUtils.getChildren(absolute)).length) await IOUtils.remove(absolute);
        } else if (!referenced.has(path)) await IOUtils.remove(absolute);
      };
      await remove(relative);
      if (relative.startsWith("parse/")) {
        const parts = relative.split("/");
        for (let length = parts.length - 1; length >= 2; length--) {
          const parent = PathUtils.join(Zotero.DataDirectory.dir, "knowledgemcp", ...parts.slice(0, length));
          if (await IOUtils.exists(parent) && !(await IOUtils.getChildren(parent)).length) await IOUtils.remove(parent);
        }
      }
      await db.deleteFrom("file_cleanup").where("relative_path", "=", relative).execute();
    } catch { Zotero.debug("[ZoteroKnowledgeMCP] File cleanup remains pending for retry."); }
  }
}
