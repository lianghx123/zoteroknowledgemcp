// Frozen schema baseline. Append migrations after release; do not edit history.
import { sql, type Kysely } from "kysely";

export const checksum = "860fac221afb06ac7527b493f1ce822f88c8ba90b1cfb6dcdfc4de0a78117d42";
export const statements: readonly string[] = [
  "CREATE VIRTUAL TABLE search_fts USING fts5(\n  title,\n  contributors,\n  body,\n  search_text,\n  content = 'search_documents',\n  content_rowid = 'rowid',\n  tokenize = 'unicode61 remove_diacritics 2'\n);",
  "CREATE TRIGGER search_document_insert AFTER INSERT ON search_documents\nBEGIN\n  INSERT INTO search_fts(rowid, title, contributors, body, search_text)\n  VALUES (NEW.rowid, NEW.title, NEW.contributors, NEW.body, NEW.search_text);\nEND;",
  "CREATE TRIGGER search_document_delete AFTER DELETE ON search_documents\nBEGIN\n  INSERT INTO search_fts(search_fts, rowid, title, contributors, body, search_text)\n  VALUES ('delete', OLD.rowid, OLD.title, OLD.contributors, OLD.body, OLD.search_text);\nEND;",
  "CREATE TRIGGER search_document_update AFTER UPDATE ON search_documents\nBEGIN\n  INSERT INTO search_fts(search_fts, rowid, title, contributors, body, search_text)\n  VALUES ('delete', OLD.rowid, OLD.title, OLD.contributors, OLD.body, OLD.search_text);\n  INSERT INTO search_fts(rowid, title, contributors, body, search_text)\n  VALUES (NEW.rowid, NEW.title, NEW.contributors, NEW.body, NEW.search_text);\nEND;",
  "INSERT INTO search_fts(search_fts) VALUES ('rebuild');"
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
  await sql`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (${"migration-checksum:0002-full-text-index"}, ${JSON.stringify(checksum)}, ${Date.now()})`.execute(db);
}
