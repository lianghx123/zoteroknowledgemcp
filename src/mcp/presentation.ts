import { McpError, type JsonObject } from "./contracts";

// One field catalog drives discovery, validation and projection, including empty results.
const fields: Record<string, { core: string[]; standard: string[]; extra: string[] }> = {
  library: { core: ["libraryId", "name", "status", "resourceCount"], standard: ["description", "createdAt", "updatedAt"], extra: ["deletedAt"] },
  folder: { core: ["nodeId", "parentNodeId", "name", "nodeType", "hasChildren", "childCount"], standard: ["resourceCount", "countStatus", "description", "sortOrder"], extra: ["queryDefinition", "createdAt", "updatedAt"] },
  resource: { core: ["resourceId", "title", "resourceType", "status", "version"], standard: ["language", "contributors", "identifiers", "metadata", "capabilities"],
    extra: ["subtitle", "abstract", "summary", "libraryIds", "stats", "sources", "memberships", "createdAt", "updatedAt", "deletedAt"] },
  resourceDetail: { core: ["resourceId", "title", "resourceType", "status", "version"], standard: ["language", "contributors", "identifiers", "metadata", "subtitle", "abstract", "summary", "capabilities"],
    extra: ["libraryIds", "stats", "sources", "memberships", "createdAt", "updatedAt", "deletedAt"] },
  node: { core: ["nodeId", "parentNodeId", "title", "level", "path", "childCount", "blockCount", "charCount", "hasChildren"], standard: [], extra: ["metadata"] },
  block: { core: ["blockId", "blockType", "structureNodeId", "canonicalOrder", "sourceId", "generationId", "sourceVersion", "contentVersion"],
    standard: ["contentRole", "preview", "previewTruncated", "qualityFlags", "pageStart", "pageEnd"], extra: ["metadata"] },
  blockText: { core: ["blockId", "blockType", "structureNodeId", "contentMarkdown", "originalCharCount", "truncated", "nextCursor", "textOffset", "charCountReturned", "sourceId", "generationId", "sourceVersion", "contentVersion"],
    standard: ["contentRole", "qualityFlags", "pageStart", "pageEnd"], extra: ["canonicalOrder", "metadata"] },
  annotation: { core: ["annotationId", "annotationType", "text", "textTruncated", "targetNodeId", "targetBlockId", "resourceVersion", "sourceId", "generationId", "anchorState",
    "quote", "quoteTruncated", "nextCursor", "quoteNextCursor", "textOffset", "quoteOffset", "originalCharCount", "originalQuoteCharCount", "charCountReturned", "quoteCharsReturned"],
    standard: ["createdAt", "confidence"], extra: ["metadata"] },
  revision: { core: ["revisionId", "changeType", "targetType", "versionAfter", "createdAt"], standard: ["targetId"], extra: ["createdBy", "changes"] },
  reference: { core: ["referenceId", "referenceType", "sourceBlockId", "targetResourceId", "targetBlockId"], standard: ["rawText", "label", "referenceNumber", "matchStatus", "confidence"],
    extra: ["sourceId", "generationId", "sourceBlockIds", "entryOrder", "canonicalOrder", "pageStart", "pageEnd", "locations", "createdAt"] },
};
export function availableFields(kind: string): string[] {
  const definition = fields[kind];
  return definition ? [...definition.core, ...definition.standard, ...definition.extra] : [];
}
const toolKinds: Record<string, string> = { list_libraries: "library", list_folders: "folder", list_resources: "resource", get_resources: "resourceDetail",
  list_resource_nodes: "node", list_content_blocks: "block", get_content_blocks_text: "blockText", list_annotations: "annotation", list_revisions: "revision", list_references: "reference" };
const searchResourceCore = ["resourceId", "resourceVersion", "resourceTitle", "resourceScore", "scoreType", "matches"];
const searchResourceExtra = ["partialContent", "embeddingCoverage"];
const searchMatchCore = ["contentBlockId", "evidenceBlockId", "matchSource", "channel", "snippet", "snippetTruncated", "scoreType", "finalScore", "metadata"];
const searchMatchExtra = ["evidenceBlockIds", "evidenceExpanded", "structureNodeId", "nodeLabel", "blockType", "contentRole", "qualityFlags", "rawScore", "pageStart", "pageEnd", "metadataField"];
export function toolFields(name: string): string[] {
  if (name === "search_content") return [...searchResourceCore, ...searchResourceExtra, ...[...searchMatchCore, ...searchMatchExtra].map(key => `matches.${key}`)];
  if (["get_resource_content", "get_resource_nodes"].includes(name)) return ["resourceContext", "blockMetadata", "contentStats", ...(name === "get_resource_nodes" ? ["nodePath", "nodeTitle"] : [])];
  return availableFields(toolKinds[name]);
}
export function validateFields(name: string, args: JsonObject): void {
  if (!Array.isArray(args.includeFields)) return;
  const allowed = new Set(toolFields(name));
  if (args.includeFields.some(key => typeof key === "string" && !allowed.has(key))) throw new McpError("INVALID_FIELD", "An includeFields entry is unavailable for this tool.");
}
export function projectionFields(kind: string, available: readonly string[], args: JsonObject): string[] {
  const definition = fields[kind];
  if (!definition) return [...available];
  const extra = (args.includeFields ?? []) as string[], known = new Set(availableFields(kind));
  if (extra.some(field => !known.has(field))) throw new McpError("INVALID_FIELD", "An includeFields entry is unavailable for this tool.");
  const selected = args.responseMode === "full" ? [...available] : [...definition.core, ...(args.responseMode === "compact" ? [] : definition.standard), ...extra];
  if (kind === "folder" && args.includeResourceCount) selected.push("resourceCount", "countStatus");
  if (kind === "block" && args.includePreview) selected.push("preview", "previewTruncated");
  return [...new Set(selected)];
}
export function project(kind: string, item: JsonObject, args: JsonObject): JsonObject {
  const selected = projectionFields(kind, Object.keys(item), args);
  return Object.fromEntries(selected.filter(key => Object.hasOwn(item, key) && item[key] !== undefined).map(key => [key, item[key]]));
}
export function validateSearchFields(args: JsonObject): void { validateFields("search_content", args); }
export function projectSearch(item: JsonObject, args: JsonObject): JsonObject {
  validateSearchFields(args);
  const extra = (args.includeFields ?? []) as string[], mode = args.responseMode;
  const choose = (value: JsonObject, keys: string[]) => Object.fromEntries([...new Set(keys)].filter(key => Object.hasOwn(value, key) && value[key] !== undefined).map(key => [key, value[key]]));
  const selected = mode === "full" ? [...searchResourceCore, ...searchResourceExtra] : [...searchResourceCore, ...extra.filter(key => !key.startsWith("matches."))];
  const matches = (item.matches as JsonObject[]).map(match => choose(match, [...searchMatchCore,
    ...(mode === "compact" ? [] : searchMatchExtra), ...extra.filter(key => key.startsWith("matches.")).map(key => key.slice(8))]));
  return { ...choose(item, selected), matches };
}
