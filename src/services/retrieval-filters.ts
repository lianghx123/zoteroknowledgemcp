import { sql } from "kysely";

export interface RetrievalFilters {
  generationID?: string;
  includeBlockTypes?: string[]; excludeBlockTypes?: string[];
  includeContentRoles?: string[]; excludeContentRoles?: string[];
  excludeQualityFlags?: string[];
}

/** Both text and vector candidates apply these predicates to content_blocks b. */
export function blockPredicate(options: RetrievalFilters) {
  const clauses = [sql`1=1`];
  if (options.generationID) clauses.push(sql`b.generation_id = ${options.generationID}`);
  for (const [key, column, exclude] of [["includeBlockTypes", "block_type", false], ["excludeBlockTypes", "block_type", true], ["includeContentRoles", "content_role", false], ["excludeContentRoles", "content_role", true]] as const) {
    const values = options[key];
    if (values?.length) clauses.push(exclude ? sql`${sql.ref(`b.${column}`)} NOT IN (${sql.join(values)})` : sql`${sql.ref(`b.${column}`)} IN (${sql.join(values)})`);
  }
  if (options.excludeQualityFlags?.length) clauses.push(sql`NOT EXISTS (SELECT 1 FROM json_each(b.quality_flags_json) q WHERE q.value IN (${sql.join(options.excludeQualityFlags)}))`);
  return sql.join(clauses, sql` AND `);
}
