import { Kysely, sql } from "kysely";
import type { Database } from "./types";
import { ZoteroDialect } from "./zotero-dialect";
import { inspectHistory } from "./migration-service";

/** VACUUM INTO snapshots committed WAL data, unlike copying the live main file. */
export async function createBackup(db: Kysely<Database>, path: string): Promise<void> {
  const backupPath = `${path}.pre-upgrade-${Date.now()}.bak`;
  await sql`VACUUM INTO ${backupPath}`.execute(db);
  const native = new Zotero.DBConnection(backupPath);
  const backup = new Kysely<Database>({ dialect: new ZoteroDialect(native) });
  try {
    await sql`SELECT 1`.execute(backup);
    await native.loadExtension("fts5");
    const result = await sql<{ integrity_check: string }>`PRAGMA integrity_check`.execute(backup);
    if (result.rows.length !== 1 || result.rows[0].integrity_check !== "ok") {
      throw new Error("Pre-upgrade database backup failed integrity validation.");
    }
    await inspectHistory(backup);
  } finally { await backup.destroy(); }
}
