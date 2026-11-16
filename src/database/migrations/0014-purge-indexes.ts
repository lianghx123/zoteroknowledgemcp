// Frozen schema baseline. Append migrations after release; do not edit history.
import { sql, type Kysely } from "kysely";

export const checksum = "64ad9f9f20580659b769f5d8b1fd50246c7b82da683c432d5317ff20cd8f2ba4";
export const statements: readonly string[] = [
  "CREATE INDEX ix_block_supersedes ON content_blocks(supersedes_block_id);",
  "CREATE INDEX ix_block_parent ON content_blocks(parent_block_id, generation_id);",
  "CREATE INDEX ix_reference_source_block ON resource_references(source_block_id, generation_id);",
  "CREATE INDEX ix_reference_target_block ON resource_references(target_block_id, target_generation_id);",
  "CREATE INDEX ix_annotation_block ON resource_annotations(content_block_id, generation_id);",
  "CREATE INDEX ix_search_block_fk ON search_documents(block_id, generation_id);",
  "CREATE INDEX ix_embedding_generation ON block_embeddings(generation_id);",
  "CREATE INDEX ix_vector_entry_embedding ON vector_index_entries(embedding_id, profile_id);",
  "CREATE INDEX ix_generation_resource ON content_generations(resource_id);",
  "CREATE INDEX ix_parse_resource ON parse_runs(resource_id);",
  "CREATE INDEX ix_source_file ON resource_sources(stored_file_id);",
  "CREATE INDEX ix_generation_file_owner ON generation_files(stored_file_id);",
  "CREATE INDEX ix_artifact_file_owner ON parse_artifacts(stored_file_id);"
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
  await sql`INSERT INTO plugin_state(key, value_json, updated_at) VALUES (${"migration-checksum:0014-purge-indexes"}, ${JSON.stringify(checksum)}, ${Date.now()})`.execute(db);
}
