import { Kysely, sql } from "kysely";
import { ZoteroDialect } from "./zotero-dialect";
import { migrateDatabase } from "./migration-service";
import { createBackup } from "./backup-service";
import type { NativeDatabase } from "./zotero-driver";
import type { Database } from "./types";
import { createDatabaseOwner, type DatabaseOwnerLease } from "./owner-lease";
import { hostRuntime } from "../core/host-runtime";

export interface KnowledgeDatabase {
  readonly db: Kysely<Database>;
  readonly path: string;
  close(): Promise<void>;
}

/** Opens only a plugin-owned file; never the Zotero library connection. */
export async function openKnowledgeDatabase(): Promise<KnowledgeDatabase> {
  const root = PathUtils.join(Zotero.DataDirectory.dir, "knowledgemcp");
  await IOUtils.makeDirectory(root, { ignoreExisting: true });
  const path = PathUtils.join(root, "knowledge.sqlite");
  const native = new Zotero.DBConnection(path);
  return initializeDatabase(native, path);
}

export async function initializeDatabase(native: NativeDatabase, path: string): Promise<KnowledgeDatabase> {
  // Gecko shares a cache within one process; the host registry covers separate
  // bundle globals. A separate SQLite owner file excludes other plugin processes.
  const owners = Zotero.__knowledgeMCPDatabaseOwners ??= new (hostRuntime().Map)<string, { retryClose?: () => Promise<void> }>();
  const key = Zotero.isWin ? path.replaceAll("/", "\\").toLowerCase() : path;
  const previous = owners.get(key);
  if (previous?.retryClose) {
    try { await previous.retryClose(); }
    catch (error) { await native.closeDatabase(true); throw error; }
  }
  if (owners.has(key)) {
    await native.closeDatabase(true);
    throw new Error("Knowledge database already has an active plugin owner.");
  }
  const owner: { retryClose?: () => Promise<void> } = {};
  owners.set(key, owner);
  let lease: DatabaseOwnerLease | undefined;
  let connectionStarted = false;
  const db = new Kysely<Database>({ dialect: new ZoteroDialect(native, () => {
    if (!lease) throw new Error("Knowledge database ownership has not been acquired.");
    lease.assertHeld();
  }) });
  let closing: Promise<void> | undefined;
  let mainClosed = false;
  const close = () => closing ??= (async () => {
    if (!mainClosed) {
      await db.destroy();
      // Kysely skips driver.destroy() if no connection was ever acquired.
      if (!connectionStarted) await native.closeDatabase(true);
      mainClosed = true;
    }
    await lease?.close();
    if (owners.get(key) === owner) owners.delete(key);
  })().catch(error => {
    closing = undefined;
    // Retain a retry path even if a failed addon shutdown unloads its bundle.
    // Active owners have no retry callback and can never be displaced.
    owner.retryClose = close;
    throw error;
  });
  try {
    // Acquire before touching the main file, including preflight/backup/bootstrap.
    lease = createDatabaseOwner(path);
    await lease.acquire();
    connectionStarted = true;
    await sql`PRAGMA busy_timeout = 5000`.execute(db);
    await sql`PRAGMA locking_mode = NORMAL`.execute(db);
    await sql`PRAGMA journal_mode = WAL`.execute(db);
    await sql`PRAGMA foreign_keys = ON`.execute(db);
    await sql`PRAGMA synchronous = FULL`.execute(db);
    await native.loadExtension("fts5");
    const capabilities = await sql<{ json_ok: number; foreign_keys: number }>`SELECT json_valid('{}') AS json_ok, (SELECT foreign_keys FROM pragma_foreign_keys) AS foreign_keys`.execute(db);
    if (capabilities.rows[0]?.json_ok !== 1 || capabilities.rows[0].foreign_keys !== 1) {
      throw new Error("SQLite JSON functions and foreign keys are required.");
    }
    // Prove STRICT, transactional DDL, FTS and BLOB round trips on this connection.
    try {
      await db.transaction().execute(async tx => {
        await sql`CREATE TABLE __knowledge_capability_probe(value BLOB NOT NULL) STRICT`.execute(tx);
        const bytes = new Uint8Array([0, 127, 128, 255]);
        await sql`INSERT INTO __knowledge_capability_probe VALUES (${bytes})`.execute(tx);
        const probe = await sql<{ value: Uint8Array }>`SELECT value FROM __knowledge_capability_probe`.execute(tx);
        if (!probe.rows[0]?.value || bytes.some((value, i) => probe.rows[0].value[i] !== value)) {
          throw new Error("SQLite BLOB round trip failed.");
        }
        await sql`CREATE VIRTUAL TABLE temp.__knowledge_fts_probe USING fts5(body)`.execute(tx);
        throw rollbackProbe;
      });
    } catch (error) { if (error !== rollbackProbe) throw error; }
    const probe = await sql`SELECT name FROM sqlite_schema WHERE name = '__knowledge_capability_probe' UNION ALL SELECT name FROM sqlite_temp_schema WHERE name = '__knowledge_fts_probe'`.execute(db);
    if (probe.rows.length) throw new Error("SQLite transactional DDL rollback is unavailable.");
    await migrateDatabase(db, () => createBackup(db, path));
    return { db, path, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Knowledge database initialization and cleanup failed; cleanup can be retried.");
    }
    throw error;
  }
}

const rollbackProbe = new Error("Expected database capability rollback.");
