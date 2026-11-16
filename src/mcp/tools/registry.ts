import { McpError, chars, requireValue, type JsonObject, type Schema } from "../contracts";
import { outputSchema } from "./output-schemas";
import { toolFields, validateFields } from "../presentation";

const text = (maxLength?: number): Schema => ({ type: "string", ...(maxLength ? { maxLength } : {}) });
const id: Schema = { type: "string", format: "uuid" };
const integer = (minimum: number, maximum: number, value: number): Schema => ({ type: "integer", minimum, maximum, default: value });
const enumeration = (values: readonly string[], value?: string): Schema => ({ type: "string", enum: values, ...(value === undefined ? {} : { default: value }) });
const boolean = (value: boolean): Schema => ({ type: "boolean", default: value });
const array = (items: Schema, minItems = 0, maxItems = 100): Schema => ({ type: "array", items, minItems, maxItems, uniqueItems: true });
const page = { limit: integer(1, 100, 20), cursor: text(8192), includeTotal: boolean(false) };
const maxChars = (value: number): Schema => integer(1, 50000, value);
const depth = integer(0, 4, 1);
const roles = ["body", "note"];
const annotationTypes = ["claim", "method", "assumption", "limitation", "evidence", "question", "contradiction", "important", "todo", "summary"];
const referenceTypes = ["bibliography", "citation", "url", "footnote", "cross_reference", "table_reference", "figure_reference", "formula_reference"];
const operationId: Schema = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
const textCursors: Schema = { type: "object", additionalProperties: text(8192) };
export interface ToolDefinition { name: string; description: string; inputSchema: Schema; outputSchema: Schema; annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }; }
const definitions: Array<[string, string, Record<string, Schema>, string[]]> = [
  ["list_libraries", "List authorized local knowledge libraries.", { ...page, status: enumeration(["active", "archived", "deleted"], "active") }, []],
  ["list_folders", "List direct folder children, with bounded descendant expansion.", { ...page, libraryId: id, parentNodeId: id, includeResourceCount: boolean(true), status: enumeration(["active", "archived"], "active"), descendantDepth: depth }, ["libraryId"]],
  ["list_resources", "Discover authorized literature by metadata and folder.", { ...page, libraryId: id, nodeId: id, query: text(8000), resourceType: text(64), status: enumeration(["active", "archived", "deleted"]), language: text(64), nodeDescendantDepth: depth }, []],
  ["get_resources", "Get up to 50 literature details: authors, publication/date, identifiers, abstract, maintained summary and current read availability. Missing or unauthorized IDs are listed together.", { resourceIds: array(id, 1, 50) }, ["resourceIds"]],
  ["get_resource_content", "Read bounded document Markdown, including original scientific footnotes. Continue with nextCursor. Human annotations are a separate opt-in; selection reports exclusions.", { resourceId: id, maxChars: maxChars(12000), cursor: text(8192), includeAnnotations: boolean(false), includeBoilerplate: boolean(false) }, ["resourceId"]],
  ["list_resource_nodes", "List structure children from current attachment generations.", { ...page, resourceId: id, parentNodeId: id, descendantDepth: depth }, ["resourceId"]],
  ["get_resource_nodes", "Read article sections with per-node and aggregate budgets. includeChildren=false reads only directly assigned blocks, which may be just a heading. Each node has its own nextCursor; completed nodes may be removed from retries.", { nodeIds: array(id, 1, 20), includeChildren: boolean(false), maxChars: maxChars(8000), maxBlocks: integer(1, 100, 30), cursors: textCursors, includeBoilerplate: boolean(false), maxTotalChars: integer(1, 200000, 50000) }, ["nodeIds"]],
  ["list_content_blocks", "List block handles and optional previews. includePreview=false suppresses preview fields.", { ...page, resourceId: id, nodeId: id, blockType: text(64), contentRole: enumeration(roles), includePreview: boolean(true), previewMaxChars: integer(1, 1000, 120) }, ["resourceId"]],
  ["get_content_blocks_text", "Read exact evidence blocks within per-block and total budgets. Use each item's nextCursor in cursors[blockId] to read its remaining text; completed blocks may be removed from retries.", { resourceId: id, blockIds: array(id, 1, 100), cursors: textCursors, maxCharsPerBlock: integer(1, 10000, 2000), maxTotalChars: maxChars(10000) }, ["resourceId", "blockIds"]],
  ["list_block_types", "Diagnose current block types and embedding coverage across stored profiles. Not required for ordinary paper reading.", { resourceId: id, nodeId: id }, ["resourceId"]],
  ["search_content", "Search literature and grouped evidence. Start with scopeType, scopeId if needed, query and mode; other tuning is optional. limit counts papers, not passages. Vector search sends the query to configured providers; reranking may send document passages. node scope means a knowledge folder.", {
    scopeType: enumeration(["authorized", "library", "resource", "node"]), query: { ...text(8000), minLength: 1 }, scopeId: id,
    mode: enumeration(["metadata", "fulltext", "vector", "hybrid"], "hybrid"), limit: integer(1, 50, 10), cursor: text(8192),
    candidateLimit: integer(1, 500, 100), maxBlocksPerResource: integer(1, 10, 2), diversify: boolean(true), diversityLambda: { type: "number", minimum: 0, maximum: 1, default: 0.7 },
    includeBlockTypes: array(text(64)), excludeBlockTypes: array(text(64)), includeContentRoles: array(enumeration(roles)), excludeContentRoles: array(enumeration(roles)), excludeQualityFlags: array(text(64)),
    snippetMaxChars: integer(50, 2000, 300), minScore: { type: "number" }, minScoreBasis: enumeration(["vector", "rerank"]), rerank: boolean(false),
    rerankPolicy: enumeration(["best_effort", "required"], "best_effort"), includeDiagnostics: boolean(false), includeMetadataMatches: { type: "boolean" },
  }, ["scopeType", "query"]],
  ["list_references", "List authorized structured references and report document-wide availability. An empty referenceType selection does not mean the document has no structured references; returnedCount/total describe the filtered results.", { ...page, resourceId: id, referenceType: enumeration(referenceTypes) }, ["resourceId"]],
  ["list_annotations", "List or read plugin-owned annotations, quoted evidence and current/historical anchors. Select annotationIds for detail; continue text and quote independently using each item's nextCursor/quoteNextCursor in cursors[annotationId]. Paper footnotes are original document content.", { ...page, resourceId: id, nodeId: id, blockId: id, annotationIds: array(id, 1, 100),
    cursors: { type: "object", additionalProperties: { type: "object", properties: { text: { anyOf: [text(8192), { type: "null" }] }, quote: { anyOf: [text(8192), { type: "null" }] } }, additionalProperties: false } },
    annotationType: enumeration(annotationTypes), textMaxChars: integer(1, 5000, 500), maxTotalChars: maxChars(10000) }, ["resourceId"]],
  ["add_annotation", "Add a plugin-owned annotation. Requires write scope, expectedVersion and a retry-stable operationId.", { resourceId: id, annotationType: enumeration(annotationTypes), text: { ...text(50000), minLength: 1 }, operationId, expectedVersion: { type: "integer", minimum: 1 }, structureNodeId: id, contentBlockId: id, quote: text(50000), confidence: { type: "number", minimum: 0, maximum: 1 } }, ["resourceId", "annotationType", "text", "operationId", "expectedVersion"]],
  ["list_revisions", "Inspect plugin change history, not publication editions or paper versions. Usually unnecessary for ordinary reading.", { ...page, resourceId: id, changeType: text(64), targetType: text(64), sinceVersion: { type: "integer", minimum: 0 } }, ["resourceId"]],
  ["update_summary", "Update only the plugin-owned summary with an idempotent version-checked mutation.", { resourceId: id, summary: { ...text(50000), minLength: 1 }, expectedVersion: { type: "integer", minimum: 1 }, operationId }, ["resourceId", "summary", "expectedVersion", "operationId"]],
];
const descriptions: Record<string, string> = {
  resourceId: "Plugin resource UUID; not a Zotero numeric item ID.", resourceIds: "Plugin resource UUIDs in requested return order; missing and unauthorized IDs share the missing-ID envelope.",
  libraryId: "Authorized knowledge-library UUID.", nodeId: "Article structure-node UUID; for list_resources this is a knowledge-folder UUID.", parentNodeId: "Parent navigation UUID in this tool's tree. Omit for root children.",
  nodeIds: "Article structure-node UUIDs. Omit completed nodes when continuing a batch.", blockIds: "Exact content-block UUIDs belonging to resourceId; returned in requested order.",
  blockId: "Filter by the annotation's content-block anchor, including historical anchors.", contentBlockId: "Current, non-rejected content-block anchor belonging to resourceId.", structureNodeId: "Current article structure-node anchor; mutually exclusive with contentBlockId.",
  annotationIds: "Read only these annotation UUIDs within resourceId; unavailable IDs are returned in missingAnnotationIds.",
  limit: "Maximum returned items per page; search_content counts papers, not evidence passages.", cursor: "Opaque nextCursor from the same tool, authorization and filters; expires in one hour.",
  cursors: "Per-target continuation map. Nodes/blocks map UUID to nextCursor; annotations map UUID to {text: nextCursor, quote: quoteNextCursor}, where null skips a completed stream and omission starts at zero. Continuations bind target, scope and content state, not batch composition or text budgets.",
  includeTotal: "Include an exact total count in the page envelope.", includeResourceCount: "Return exact descendant-subtree resource counts, including in compact mode. False suppresses counts in every mode.",
  includePreview: "Return bounded block previews, including in compact mode. False suppresses previews in every mode.", previewMaxChars: "Per-block preview budget in Unicode code points.",
  includeBoilerplate: "Include blocks flagged as repeated page furniture/boilerplate. Original scientific footnotes are always included; rejected blocks are never returned.",
  includeAnnotations: "Append human/agent annotations after original document content; does not control original paper footnotes.", includeChildren: "Include all descendant article sections; false reads blocks assigned directly to each requested node.",
  maxChars: "Per-document or per-node Unicode code-point budget. nextCursor resumes the remaining text.", maxBlocks: "Maximum materialized blocks per requested node and page.",
  maxCharsPerBlock: "Per-block Unicode code-point budget; use its nextCursor to continue longer blocks.", maxTotalChars: "Aggregate Unicode code-point budget for returned text. Annotation text and quotes both consume this budget.",
  textMaxChars: "Per-annotation-stream Unicode budget (text and quote independently), also bounded by maxTotalChars. Both streams return their own continuation.",
  quote: "Exact substring of the current content block. Requires contentBlockId; preserved separately from annotation text.", text: "Annotation text owned by the plugin, separate from original document content.",
  summary: "Plugin-maintained summary; does not overwrite the published abstract or Zotero metadata.", expectedVersion: "Current resource version from get_resources/read results. Matching operationId retries replay before version checking.",
  operationId: "Retry-stable identifier, unique to the token authority. Retry uncertain writes with the same ID and arguments; different arguments conflict.",
  descendantDepth: "Tree expansion depth: 0 returns no children, 1 direct children, up to 4 levels.", nodeDescendantDepth: "Knowledge-folder depth for list_resources: 0 includes only that folder, up to 4 descendant levels.",
  scopeType: "authorized: all granted libraries; library/resource/node: a single authorized library, resource, or knowledge-folder subtree.", scopeId: "Required for library/resource/node; forbidden for authorized scope.",
  query: "Search text. list_resources matches title, abstract and contributors; search_content uses the chosen retrieval mode.",
  mode: "metadata searches bibliographic fields; fulltext searches document text; vector uses semantic embeddings; hybrid combines available channels and reports degradation.",
  candidateLimit: "Advanced: candidate paper budget before thresholds/diversification, independent of output page size.", maxBlocksPerResource: "Maximum evidence/metadata matches per returned paper.",
  diversify: "Advanced: diversify candidate paper order by title similarity.", diversityLambda: "Advanced: rank-versus-title-diversity weight, between 0 and 1.",
  includeBlockTypes: "Include only these document block types.", excludeBlockTypes: "Exclude these document block types.", includeContentRoles: "Include only original body and/or original note roles.", excludeContentRoles: "Exclude selected original content roles.",
  excludeQualityFlags: "Exclude blocks carrying these flags. Omit for boilerplate exclusions; use [] to disable quality-flag exclusions.",
  snippetMaxChars: "Presentation budget per evidence snippet; does not alter ranking/rerank input budgets.", minScore: "Advanced: threshold in minScoreBasis; requires that basis.", minScoreBasis: "Use vector cosine or rerank scores; rerank requires rerank=true. Unrelated keyword/fusion scores are not interchangeable.",
  rerank: "Opt in to configured provider reranking of candidate document passages.", rerankPolicy: "When reranking is requested: required fails if unavailable; best_effort reports a warning and retains available ranking.",
  includeDiagnostics: "Return retrieval channels, coverage, timing and threshold diagnostics.", includeMetadataMatches: "Include bibliographic evidence alongside content where supported. Defaults off when explicit block/role/quality filters are supplied.",
  resourceType: "Resource type such as journalArticle or book.", status: "Filter lifecycle state; deleted data remains unavailable to personal tokens.", language: "Filter the stored document language.",
  blockType: "Filter stored document block type, e.g. paragraph, formula, table, reference or footnote.", contentRole: "Original document body or note; note includes scientific footnotes, not user annotations.",
  referenceType: "Filter structured reference relationship type; reference-text blocks remain a separate fallback.", annotationType: "Semantic category of the plugin-owned annotation.", confidence: "Optional annotation confidence between 0 and 1.",
  changeType: "Filter plugin revision event type.", targetType: "Filter plugin revision target type.", sinceVersion: "Return revisions strictly newer than this resource version.",
};
export const toolDefinitions: ToolDefinition[] = definitions.map(([name, description, properties, required]) => ({
  name, description,
  inputSchema: { type: "object", properties: { ...Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, { ...(!required.includes(key) && schema.default === undefined ? { anyOf: [schema, { type: "null" }] } : schema), description: descriptions[key] }])),
    responseMode: { ...enumeration(["compact", "standard", "full"], "standard"), description: "Business-field projection; identities, budgets, continuation and missing-item envelopes always remain. Full preserves null/empty values. Fixed-shape tools keep the same fields in every mode." },
    includeFields: { ...array(toolFields(name).length ? enumeration(toolFields(name)) : text(), 0, toolFields(name).length ? 100 : 0), description: "Add declared business fields to the projection. Explicit false inclusion gates still suppress their fields. Empty for fixed-shape tools." } }, required, additionalProperties: false },
  outputSchema: outputSchema(name),
  annotations: { readOnlyHint: !["add_annotation", "update_summary"].includes(name), destructiveHint: name === "update_summary", idempotentHint: true, openWorldHint: name === "search_content" },
}));
export function validate(schema: Schema, value: unknown, path = "arguments"): unknown {
  if (schema.anyOf) {
    for (const branch of schema.anyOf) { try { return validate(branch, value, path); } catch { /* Try the next schema branch. */ } }
    throw new McpError("INVALID_ARGUMENT", `Invalid ${path}.`);
  }
  if (value === undefined && schema.default !== undefined) return schema.default;
  const invalid = () => { throw new McpError("INVALID_ARGUMENT", `Invalid ${path}.`, false, { field: path }); };
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const input = value as JsonObject, output = Object.create(null) as JsonObject;
    for (const key of schema.required ?? []) if (!Object.hasOwn(input, key) || input[key] === undefined) invalid();
    for (const [key, child] of Object.entries(input)) {
      const definition = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key]
        : typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined;
      if (!definition) { if (schema.additionalProperties === false) invalid(); output[key] = child; }
      else output[key] = validate(definition, child, `${path}.${key}`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (!Object.hasOwn(output, key) && child.default !== undefined) output[key] = child.default;
    return output;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return invalid();
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) invalid();
    return value.map((item, index) => validate(schema.items!, item, `${path}[${index}]`));
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || schema.type === "integer" && !Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) invalid();
  } else if (schema.type === "string") {
    if (typeof value !== "string") return invalid();
    if (chars(value) < (schema.minLength ?? 0) || chars(value) > (schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value)) invalid();
    if (schema.format === "uuid" && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) invalid();
  } else if (schema.type === "boolean" && typeof value !== "boolean" || schema.type === "null" && value !== null) invalid();
  if (schema.enum && !schema.enum.includes(value)) invalid();
  return value;
}
export function argumentsFor(name: string, value: unknown): JsonObject {
  const tool = toolDefinitions.find(tool => tool.name === name);
  requireValue(tool, "Unknown tool.");
  if (value && typeof value === "object" && !Array.isArray(value)) {
    validateFields(name, value as JsonObject);
    if (name === "search_content" && (value as JsonObject).scopeType === "run") throw new McpError("KNOWLEDGE_RUN_SCOPE_UNAVAILABLE", "External execution grants are not supported locally.");
  }
  const args = validate(tool.inputSchema, value) as JsonObject;
  for (const key of Object.keys(args)) if (args[key] === null && !tool.inputSchema.required?.includes(key)) delete args[key];
  if (["get_resource_nodes", "get_content_blocks_text"].includes(name) && args.cursors) {
    const requested = args[name === "get_resource_nodes" ? "nodeIds" : "blockIds"] as string[];
    requireValue(Object.keys(args.cursors as JsonObject).every(id => requested.includes(id)), "A cursor refers to an unrequested target.");
  }
  if (name === "add_annotation") {
    requireValue(!(args.structureNodeId && args.contentBlockId), "Choose a node or a block, not both.");
    requireValue(!args.quote || args.contentBlockId, "A quote requires a content block.");
  }
  if (name === "search_content") {
    requireValue(args.scopeType === "authorized" || args.scopeType === "run" ? !args.scopeId : args.scopeId, "Invalid scopeId for scopeType.");
    requireValue(args.minScore === undefined || args.minScoreBasis, "minScore requires minScoreBasis.");
    requireValue(args.minScoreBasis !== "rerank" || args.rerank === true, "minScoreBasis=rerank requires rerank=true; reranking was not requested.", { field: "rerank", requiredValue: true });
    requireValue(String(args.query).trim(), "The query is empty.");
  }
  return args;
}
