// Development-only schema inspection. No on-disk database is opened.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../docs/development/", import.meta.url);
const output = new URL("database-field-dictionary.md", root);
const fixtures = [
  { name: "database-schema.sql", stage: "Local data and task foundation (35 ordinary tables)" },
  { name: "database-search-schema.sql", stage: "Step 4 full-text index (1 virtual table)" },
  { name: "database-mcp-schema.sql", stage: "Step 5 credential storage reservation (3 ordinary tables)" },
  { name: "database-tree-integrity-schema.sql", stage: "Tree integrity supplement (no new tables)", note: "Migration 0004 rejects diagnostic rows from existing-cycle checks, then installs three insert-time cycle guards. Table columns and relationships are unchanged." },
  { name: "database-bibliographic-schema.sql", stage: "Bibliographic field supplement (no new tables)", note: "Migration 0005 promotes publication_title, volume, issue and doi into knowledge_resources and removes their old JSON keys. The tables above show the final schema after all supplements." },
  { name: "database-trash-schema.sql", stage: "Knowledge Trash recovery (6 ordinary tables)", note: "Migration 0006 imports legacy knowledge-trash JSON from plugin_state into typed entries and foreign-keyed recovery links, then removes only those legacy keys. Recovery links cascade only from Trash entries; business tombstones and audit history remain." },
  { name: "database-sync-purge-schema.sql", stage: "Sync modes and permanent deletion", note: "Migration 0007 stores sync modes, local exclusions and durable file cleanup. Explicit purge scopes permit deletion of otherwise immutable content only inside the purge transaction." },
  { name: "database-sync-folder-exclusions-schema.sql", stage: "Local folder exclusions", note: "Migration 0008 preserves collection-key exclusions independently of deleted knowledge folders." },
  { name: "database-vector-schema.sql", stage: "Embedding segments and vector recovery", note: "Migration 0009 adds traceable embedding inputs and replaceable index snapshot state without changing published blocks." },
  { name: "database-search-offsets-schema.sql", stage: "Search offsets and revision", note: "Migration 0010 adds original-text Unicode offsets to the derived search projection and transactionally advances its revision on insertion, update and deletion. Existing projections rebuild locally without provider calls." },
  { name: "database-reference-backfill-schema.sql", stage: "Parser reference backfill (no schema changes)", note: "Migration 0011 derives bibliography records from published parser reference blocks, retaining source/generation/block anchors and existing records, including tombstones. It performs no model calls, text correction or target matching." },
  { name: "database-visual-links-schema.sql", stage: "Visual title/note associations", note: "Migration 0012 adds generation-scoped derived relationships and explicit embedded provider parts; canonical content and source generations are unchanged." },
  { name: "database-reference-numbering-schema.sql", stage: "Numbered reference entries", note: "Migration 0013 adds separate original citation numbers, entry order, generation projection checkpoints and multi-block source links. Derived bibliography text excludes its confirmed number prefix; original canonical blocks remain immutable." },
  { name: "database-purge-indexes-schema.sql", stage: "Permanent-deletion lookup indexes (no new tables)", note: "Migration 0014 adds thirteen identity indexes for foreign-key child probes, resource generations, vectors and stored-file ownership checks. It preserves business rows, deletion order, foreign keys and shared-content protections." },
  { name: "database-mcp-revisions-schema.sql", stage: "Transactional MCP library revisions", note: "Migration 0015 maintains monotonic library-scoped revisions through transactional triggers. Revision tombstones survive library deletion; staging generations and source-check timestamps do not invalidate published reads." },
  { name: "database-mcp-revision-hotpaths-schema.sql", stage: "MCP revision write costs", note: "Migration 0016 combines resource-update membership probes and skips inactive content-block trigger bodies. Revision semantics and historical migration checksums are preserved." },
];
const db = new DatabaseSync(":memory:");
const lines = [
  "# Database Field Dictionary", "",
  "Design revision 4, 2026-10-21. Generated from the SQL design fixtures after all migrations; no plugin database is created.", "",
  "See [database-design.md](database-design.md) for ownership, field semantics, transactions, source mapping, and runtime limitations.", "",
  "Regenerate with `node scripts/generate-database-dictionary.mjs`; verify without writing with `node scripts/generate-database-dictionary.mjs --check`.", "",
  "`Required` includes primary-key columns. `PK position` describes composite key order. Defaults are SQL literals. CHECK constraints, partial indexes, and triggers are specified in the linked SQL.", "",
];

function cell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

try {
  for (const fixture of fixtures) db.exec(readFileSync(new URL(fixture.name, root), "utf8"));
  for (const fixture of fixtures) {
    const sql = readFileSync(new URL(fixture.name, root), "utf8");
    const tables = [...sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(\w+)/gi)].map(match => match[1]);
    lines.push(`## ${fixture.stage}`, "", `Source: [${fixture.name}](${fixture.name}).`, "");
    if (fixture.note) lines.push(fixture.note, "");
    for (const table of tables) {
      lines.push(`### ${table}`, "", "| Field | SQLite type | Required | Default | PK position |", "| --- | --- | --- | --- | --- |");
      for (const column of db.prepare(`PRAGMA table_info(${table})`).all()) {
        lines.push(`| ${column.name} | ${column.type || "TEXT (FTS)"} | ${column.notnull || column.pk ? "Yes" : "No"} | ${column.dflt_value === null ? "—" : cell(column.dflt_value)} | ${column.pk || "—"} |`);
      }
      lines.push("");
      const definition = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table).sql;
      const enums = [...definition.matchAll(/\b(\w+)\s+(?:TEXT|INTEGER)\b[^\n]*?CHECK\s*\(\s*\1\s+IN\s*\(([^)]+)\)\)/gi)];
      if (enums.length) {
        lines.push("Allowed category/boolean values (enforced by CHECK):", "");
        for (const [, name, values] of enums) lines.push(`- \`${name}\`: \`${values.trim()}\`.`);
        lines.push("");
      }
      const groups = Map.groupBy(db.prepare(`PRAGMA foreign_key_list(${table})`).all(), key => key.id);
      if (groups.size) {
        lines.push("Foreign-key groups:", "");
        for (const rows of groups.values()) {
          rows.sort((left, right) => left.seq - right.seq);
          lines.push(`- (${rows.map(row => row.from).join(", ")}) -> ${rows[0].table}(${rows.map(row => row.to).join(", ")}).`);
        }
        lines.push("");
      }
      const indexes = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(table);
      if (indexes.length) {
        lines.push("Explicit indexes:", "");
        for (const index of indexes) lines.push(`- \`${index.name}\`: \`${cell(index.sql)}\`.`);
        lines.push("");
      }
    }
  }
  const markdown = lines.join("\n");
  if (process.argv.includes("--check")) {
    assert.equal(readFileSync(output, "utf8").replaceAll("\r\n", "\n"), markdown, "Database dictionary is out of date");
    console.log("Database dictionary matches the SQL fixtures.");
  } else {
    writeFileSync(output, markdown, "utf8");
    console.log("Generated docs/development/database-field-dictionary.md.");
  }
} finally {
  db.close();
}
