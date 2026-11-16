import { sql, type Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { migrationProvider, migrations } from "./migration-provider";
import type { Database } from "./types";

const names = Object.keys(migrations).sort() as (keyof typeof migrations)[];
const managerTables = new Set(["kysely_migration", "kysely_migration_lock"]);
// The unreleased 0006 importer was optimized without changing its DDL or data
// semantics. Keep already-upgraded development databases readable, without
// rewriting their history or accepting unknown/other migrations' checksums.
const compatibleChecksums: Partial<Record<keyof typeof migrations, readonly string[]>> = {
  "0006-knowledge-trash": [
    "9be1daf18124bce33b286616f2fa08381cc9410330bfba64a00d98f49a6c1c97",
    "fed21552d1b87c6635b8616cf272083d291c0a4b7d28da38473033d196ebb060"
  ]
};

/** Preflight also accepts interrupted Kysely bootstrap, but never adopts business tables. */
export async function inspectHistory(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE ${"sqlite_%"}`.execute(db);
  const tables = new Set(rows.map(row => row.name));
  const history = tables.has("kysely_migration")
    ? await db.selectFrom("kysely_migration").select(["name", "timestamp"]).orderBy("name").execute() : [];
  if (!history.length && [...tables].some(name => !managerTables.has(name))) {
    throw new Error("Refusing a nonempty unversioned knowledge database.");
  }
  history.forEach((row, i) => {
    if (row.name !== names[i] || !Number.isFinite(Date.parse(row.timestamp))) {
      throw new Error("Unsupported, newer or out-of-order migration history.");
    }
  });
  for (const row of history) {
    const name = row.name as keyof typeof migrations;
    const record = await db.selectFrom("plugin_state").select("value_json")
      .where("key", "=", `migration-checksum:${name}`).executeTakeFirst();
    const checksum: unknown = record ? JSON.parse(record.value_json) : undefined;
    if (checksum !== migrations[name].checksum && !compatibleChecksums[name]?.some(known => known === checksum)) {
      throw new Error(`Migration checksum mismatch: ${name}`);
    }
  }
  return history.map(row => row.name);
}

export async function migrateDatabase(db: Kysely<Database>, backup: () => Promise<void>): Promise<void> {
  const applied = await inspectHistory(db);
  if (applied.length && applied.length < names.length) await backup();
  const result = await new Migrator({ db, provider: migrationProvider, allowUnorderedMigrations: false }).migrateToLatest();
  // Migrator reports errors in a resolved result object.
  if (result.error) throw result.error;
  const final = await inspectHistory(db);
  if (final.length !== names.length) throw new Error("Incomplete database migration.");
  const integrity = await sql<{ integrity_check: string }>`PRAGMA integrity_check`.execute(db);
  if (integrity.rows.length !== 1 || integrity.rows[0].integrity_check !== "ok") {
    throw new Error("Knowledge database integrity check failed.");
  }
  const foreignKeys = await sql`PRAGMA foreign_key_check`.execute(db);
  if (foreignKeys.rows.length) throw new Error("Knowledge database foreign-key check failed.");
}
