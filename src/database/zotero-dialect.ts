import { SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler,
  type Dialect, type Kysely, type MigrationLockOptions } from "kysely";
import { ZoteroDriver, type NativeDatabase } from "./zotero-driver";

class ZoteroSqliteAdapter extends SqliteAdapter {
  constructor(private readonly assertOwnership?: () => void) { super(); }
  override get supportsTransactionalDdl(): boolean { return true; }

  override async acquireMigrationLock(db: Kysely<any>, options: MigrationLockOptions): Promise<void> {
    if (!this.assertOwnership) throw new Error("Migrations require an active database ownership lease.");
    this.assertOwnership();
    // The separate owner lease covers bootstrap/preflight/backup. This row is
    // an indicator; normal SQLite transactions coordinate the main WAL file.
    await db.updateTable(options.lockTable).set({ is_locked: 1 })
      .where("id", "=", options.lockRowId).execute();
  }

  override async releaseMigrationLock(db: Kysely<any>, options: MigrationLockOptions): Promise<void> {
    await db.updateTable(options.lockTable).set({ is_locked: 0 })
      .where("id", "=", options.lockRowId).execute();
  }
}

class ZoteroQueryCompiler extends SqliteQueryCompiler {
  protected override getCurrentParameterPlaceholder(): string {
    return `:p${this.numParameters}`;
  }
}

export class ZoteroDialect implements Dialect {
  constructor(private readonly native: NativeDatabase, private readonly assertOwnership?: () => void) {}
  createDriver() { return new ZoteroDriver(this.native); }
  createQueryCompiler() { return new ZoteroQueryCompiler(); }
  createAdapter() { return new ZoteroSqliteAdapter(this.assertOwnership); }
  createIntrospector(db: Kysely<any>) { return new SqliteIntrospector(db); }
}
