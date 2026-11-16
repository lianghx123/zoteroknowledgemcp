// Frozen schema baseline. Append migrations after release; do not edit history.
import { sql, type Kysely } from "kysely";

export const checksum = "22050a3f2aa8e86db6fcd4a6ee4035a3ef4b557fb4f9b2e6b15d0f938e923be6";
export const statements: readonly string[] = [
  "SELECT 'NON_TEXT_BIBLIOGRAPHIC_FIELD' AS cycle\nWHERE EXISTS (\n  SELECT 1 FROM knowledge_resources\n  WHERE coalesce(json_type(metadata_json, '$.fields.publicationTitle'), 'null') NOT IN ('text', 'null')\n     OR coalesce(json_type(metadata_json, '$.fields.volume'), 'null') NOT IN ('text', 'null')\n     OR coalesce(json_type(metadata_json, '$.fields.issue'), 'null') NOT IN ('text', 'null')\n     OR coalesce(json_type(metadata_json, '$.fields.DOI'), 'null') NOT IN ('text', 'null')\n);",
  "ALTER TABLE knowledge_resources ADD COLUMN publication_title TEXT;",
  "ALTER TABLE knowledge_resources ADD COLUMN volume TEXT;",
  "ALTER TABLE knowledge_resources ADD COLUMN issue TEXT;",
  "ALTER TABLE knowledge_resources ADD COLUMN doi TEXT;",
  "UPDATE knowledge_resources\nSET publication_title = nullif(json_extract(metadata_json, '$.fields.publicationTitle'), ''),\n    volume = nullif(json_extract(metadata_json, '$.fields.volume'), ''),\n    issue = nullif(json_extract(metadata_json, '$.fields.issue'), ''),\n    doi = nullif(json_extract(metadata_json, '$.fields.DOI'), ''),\n    metadata_json = json_remove(metadata_json, '$.fields.publicationTitle', '$.fields.volume', '$.fields.issue', '$.fields.DOI'),\n    metadata_schema_version = 2;"
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const statement of statements) {
    const result = await sql.raw(statement).execute(db);
    if (result.rows.length) throw new Error("Bibliographic migration refused nontext fields");
  }
  await sql`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (${"migration-checksum:0005-bibliographic-fields"}, ${JSON.stringify(checksum)}, ${Date.now()})`.execute(db);
}
