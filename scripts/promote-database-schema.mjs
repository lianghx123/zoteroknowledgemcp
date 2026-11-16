// Development-only promotion of reviewed fixtures. Never runs inside Zotero.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const definitions = [
  ["0001-local-foundation", "database-schema.sql", "CREATE TABLE plugin_state"],
  ["0002-full-text-index", "database-search-schema.sql", "CREATE VIRTUAL TABLE"],
  ["0003-mcp-storage", "database-mcp-schema.sql", "CREATE TABLE"],
  ["0004-tree-integrity", "database-tree-integrity-schema.sql", "WITH RECURSIVE", true],
  ["0005-bibliographic-fields", "database-bibliographic-schema.sql", "SELECT", "Bibliographic migration refused nontext fields"],
  ["0006-knowledge-trash", "database-trash-schema.sql", "SELECT", "Trash migration refused malformed legacy records"],
  ["0007-sync-purge", "database-sync-purge-schema.sql", "ALTER TABLE"],
  ["0008-sync-folder-exclusions", "database-sync-folder-exclusions-schema.sql", "CREATE TABLE"],
  ["0009-vector-retrieval", "database-vector-schema.sql", "CREATE TABLE"],
  ["0010-search-offsets", "database-search-offsets-schema.sql", "ALTER TABLE"],
  ["0011-reference-backfill", "database-reference-backfill-schema.sql", "INSERT INTO"],
  ["0012-visual-links", "database-visual-links-schema.sql", "CREATE TABLE"],
  ["0013-reference-numbering", "database-reference-numbering-schema.sql", "ALTER TABLE"],
  ["0014-purge-indexes", "database-purge-indexes-schema.sql", "CREATE INDEX"],
  ["0015-mcp-revisions", "database-mcp-revisions-schema.sql", "CREATE TABLE"],
  ["0016-mcp-revision-hotpaths", "database-mcp-revision-hotpaths-schema.sql", "DROP TRIGGER"],
];
const db = new DatabaseSync(":memory:");
const check = process.argv.includes("--check");
function output(path, text) {
  if (check) {
    if (readFileSync(path, "utf8").replaceAll("\r\n", "\n") !== text) {
      throw new Error(`Schema snapshot differs: ${path}`);
    }
  } else writeFileSync(path, text);
}
const migrationNames = [];
for (const [name, fixture, start, rejectRows = false] of definitions) {
  const source = readFileSync(`docs/development/${fixture}`, "utf8").replaceAll("\r\n", "\n");
  const body = source.slice(source.indexOf(start));
  // Reviewed fixture statements start at column zero. Trigger bodies are kept whole.
  // This is deliberately not a semicolon splitter; execution below validates each unit.
  const pattern = name === "0016-mcp-revision-hotpaths" ? /^(?:DROP TRIGGER|CREATE TRIGGER)/gm
    : name === "0015-mcp-revisions" ? /^(?:CREATE (?:TABLE|TRIGGER)|INSERT INTO mcp_library_revisions)/gm
    : name === "0013-reference-numbering" ? /^(?:ALTER TABLE|CREATE (?:TABLE|(?:UNIQUE )?INDEX))/gm
    : name === "0011-reference-backfill" ? /^INSERT INTO resource_references/gm
    : name === "0010-search-offsets" ? /^(?:ALTER TABLE|INSERT INTO plugin_state|CREATE TRIGGER)/gm
    : name === "0007-sync-purge" ? /^(?:ALTER TABLE|DROP TRIGGER|CREATE (?:TABLE|TRIGGER))/gm
    : name === "0006-knowledge-trash"
    ? /^(?:SELECT 'INVALID_TRASH_(?:RECORD|REFERENCE_LIST)'|CREATE (?:TABLE|(?:UNIQUE )?INDEX)|WITH|INSERT INTO knowledge_trash_entries|UPDATE|DELETE FROM)/gm
    : name === "0005-bibliographic-fields"
    ? /^(?:SELECT|ALTER TABLE|UPDATE)/gm
    : /^(?:CREATE (?:TABLE|VIRTUAL TABLE|(?:UNIQUE )?INDEX|TRIGGER)|INSERT INTO search_fts|WITH RECURSIVE)/gm;
  const starts = [...body.matchAll(pattern)].map(m => m.index);
  const statements = starts.map((offset, i) => body.slice(offset, starts[i + 1] ?? body.length)
    .replace(/^--.*$/gm, "").trim());
  for (const statement of statements) db.exec(statement);
  const checksum = createHash("sha256").update(JSON.stringify(statements)).digest("hex");
  const execute = rejectRows === true
    ? '  for (const statement of statements) {\n    const result = await sql.raw<{ cycle: string }>(statement).execute(db);\n    if (result.rows.length) throw new Error(`Tree integrity migration refused existing parent cycles: ${result.rows[0].cycle}`);\n  }'
    : rejectRows
      ? `  for (const statement of statements) {\n    const result = await sql.raw(statement).execute(db);\n    if (result.rows.length) throw new Error(${JSON.stringify(rejectRows)});\n  }`
    : '  for (const statement of statements) await sql.raw(statement).execute(db);';
  const text = `// Frozen schema baseline. Append migrations after release; do not edit history.\nimport { sql, type Kysely } from "kysely";\n\nexport const checksum = ${JSON.stringify(checksum)};\nexport const statements: readonly string[] = ${JSON.stringify(statements, null, 2)};\n\nexport async function up(db: Kysely<any>): Promise<void> {\n${execute}\n  await sql\`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (\${${JSON.stringify(`migration-checksum:${name}`)}}, \${JSON.stringify(checksum)}, \${Date.now()})\`.execute(db);\n}\n`;
  output(`src/database/migrations/${name}.ts`, text);
  migrationNames.push(name);
}
// Kysely owns these shapes in real databases. Include them only in row declarations.
db.exec(`CREATE TABLE kysely_migration(name VARCHAR(255) NOT NULL PRIMARY KEY, timestamp VARCHAR(255) NOT NULL);
CREATE TABLE kysely_migration_lock(id VARCHAR(255) NOT NULL PRIMARY KEY, is_locked INTEGER NOT NULL DEFAULT 0);`);
const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'search_fts_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
let types = '// Generated from reviewed SQLite fixtures; SQL migrations remain authoritative.\nimport type { Generated } from "kysely";\n\nexport interface Database {\n';
for (const { name } of tables) {
  types += `  ${name}: {\n`;
  for (const col of db.prepare(`PRAGMA table_info("${name}")`).all()) {
    let type = /INT|REAL|FLOA|DOUB/i.test(col.type) ? "number" : /BLOB/i.test(col.type) ? "Uint8Array" : "string";
    if (!col.notnull && !col.pk) type += " | null";
    if (col.dflt_value !== null || (col.pk && col.type === "INTEGER")) type = `Generated<${type}>`;
    types += `    ${col.name}: ${type};\n`;
  }
  types += '  };\n';
}
types += '}\n';
output("src/database/types.ts", types);
db.close();
console.log(`${check ? "Verified" : "Promoted"} ${migrationNames.length} migrations and ${tables.length} typed tables.`);
