import type { Schema } from "../contracts";

const text: Schema = { type: "string" }, integer: Schema = { type: "integer", minimum: 0 }, boolean: Schema = { type: "boolean" };
const nullableId: Schema = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const list = (items: Schema): Schema => ({ type: "array", items });
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties, required, additionalProperties: true });
const warnings = list(object({ code: text, message: text }, ["code", "message"]));
const base = { resourceId: text, resourceVersion: integer, warnings };
const sourceIdentity = { sourceId: text, generationId: text, sourceVersion: integer, contentVersion: integer };
const resource = object({ resourceId: text, title: text, resourceType: text, status: text, version: integer, language: nullable(text), subtitle: nullable(text),
  abstract: { ...nullable(text), description: "Published bibliographic abstract; distinct from the plugin-maintained summary." }, summary: { ...nullable(text), description: "Plugin-maintained research summary." },
  contributors: list(object({ firstName: text, lastName: text, name: text, role: text })), identifiers: list(object({ type: text, value: text }, ["type", "value"])),
  metadata: object({ publicationTitle: nullable(text), publicationDate: nullable(text), doi: nullable(text) }, ["publicationTitle", "publicationDate", "doi"]),
  libraryIds: list(text), memberships: list(object({ libraryId: text }, ["libraryId"])),
  sources: list(object({ sourceId: text, sourceType: text, sourceRole: text, mediaType: nullable(text), availability: text, sourceVersion: integer, contentVersion: integer,
    generationId: nullableId, contentState: nullable(text) }, ["sourceId", "sourceVersion", "contentVersion", "generationId", "contentState"])),
  capabilities: object({ metadata: boolean, content: boolean, structure: boolean, annotations: boolean, references: boolean,
    contentState: { type: "string", enum: ["unavailable", "processing", "ready", "partial"] },
    supportedOperations: object({ read: boolean, annotate: boolean, updateSummary: boolean }, ["read", "annotate", "updateSummary"]) }, ["metadata", "content", "structure", "annotations", "references", "contentState", "supportedOperations"]),
  stats: object({ blockCount: integer, charCount: integer }, ["blockCount", "charCount"]), createdAt: text, updatedAt: text, deletedAt: nullable(text) }, ["resourceId", "title", "resourceType", "status", "version"]);
const block = object({ blockId: text, blockType: text, structureNodeId: nullableId, canonicalOrder: integer, ...sourceIdentity, contentRole: text, qualityFlags: list(text),
  pageStart: nullable(integer), pageEnd: nullable(integer), preview: text, previewTruncated: boolean, metadata: { type: "object" } }, ["blockId", "blockType", "structureNodeId", "canonicalOrder", ...Object.keys(sourceIdentity)]);
const selection = object({ availableBlockCount: integer, selectedBlockCount: integer, excludedBlockCount: integer,
  excludedByReason: list(object({ reason: text, count: integer }, ["reason", "count"])), originalNotesIncluded: boolean, includeBoilerplate: boolean, annotationsIncluded: boolean },
  ["availableBlockCount", "selectedBlockCount", "excludedBlockCount", "excludedByReason", "originalNotesIncluded", "includeBoilerplate"]);
const segments = list(object({ blockId: text, kind: { type: "string", enum: ["content_block", "annotation"] }, sourceId: nullableId, generationId: nullableId,
  sourceVersion: integer, contentVersion: integer, blockOffset: integer, outputOffset: integer, charCount: integer },
  ["blockId", "kind", "sourceId", "generationId", "sourceVersion", "contentVersion", "blockOffset", "outputOffset", "charCount"]));
const rendered = { contentMarkdown: text, charCountReturned: integer, totalCharCount: integer, blockCountReturned: integer, truncated: boolean, nextCursor: nullableId, blockIds: list(text), textOffset: integer, segments, warnings };
const nodeText = object({ ...base, ...rendered, nodeId: text, includeChildren: boolean, selection }, ["resourceId", "resourceVersion", "nodeId", "contentMarkdown", "charCountReturned", "truncated", "nextCursor", "blockIds", "textOffset", "segments", "selection"]);
function page(items: Schema, extra: Record<string, Schema> = {}): Schema {
  return object({ ...extra, items: list(items), returnedCount: integer, hasMore: boolean, nextCursor: nullableId, total: integer, warnings }, ["items", "returnedCount", "hasMore", "nextCursor"]);
}
const definitions: Record<string, Schema> = {
  list_libraries: page(object({ libraryId: text, name: text, status: text, resourceCount: integer }, ["libraryId", "name", "status", "resourceCount"])),
  list_folders: page(object({ nodeId: text, parentNodeId: nullableId, name: text, nodeType: text, hasChildren: boolean, childCount: integer, resourceCount: integer }, ["nodeId", "parentNodeId", "name", "hasChildren"])),
  list_resources: page(resource),
  get_resources: object({ items: list(resource), missingResourceIds: list(text), returnedCount: integer, warnings }, ["items", "missingResourceIds", "returnedCount", "warnings"]),
  get_resource_content: object({ ...base, ...rendered, selection }, ["resourceId", "resourceVersion", "contentMarkdown", "charCountReturned", "totalCharCount", "truncated", "nextCursor", "blockIds", "warnings", "textOffset", "segments", "selection"]),
  list_resource_nodes: page(object({ nodeId: text, parentNodeId: nullableId, title: text, level: integer, path: text, childCount: integer, blockCount: integer, charCount: integer, hasChildren: boolean }, ["nodeId", "parentNodeId", "title", "level", "path", "childCount", "blockCount", "charCount", "hasChildren"]), base),
  get_resource_nodes: object({ items: list(nodeText), missingNodeIds: list(text), omittedNodeIds: list(text), totalCharsReturned: integer, warnings }, ["items", "missingNodeIds", "omittedNodeIds", "totalCharsReturned", "warnings"]),
  list_content_blocks: page(block, base),
  get_content_blocks_text: object({ ...base, items: list(object({ ...block.properties, contentMarkdown: text, originalCharCount: integer, truncated: boolean, nextCursor: nullableId, textOffset: integer, charCountReturned: integer },
    ["blockId", "blockType", "structureNodeId", "contentMarkdown", "originalCharCount", "truncated", "nextCursor", "textOffset", "charCountReturned", ...Object.keys(sourceIdentity)])),
    missingBlockIds: list(text), omittedBlockIds: list(text), totalCharsReturned: integer }, ["resourceId", "resourceVersion", "items", "missingBlockIds", "omittedBlockIds", "totalCharsReturned", "warnings"]),
  list_block_types: object({ ...base, items: list(object({ blockType: text, count: integer, estimatedChars: integer }, ["blockType", "count", "estimatedChars"])), totalBlocks: integer, estimatedChars: integer, embeddedBlockCount: integer, unembeddedBlockCount: integer }, ["resourceId", "resourceVersion", "items", "totalBlocks", "estimatedChars", "embeddedBlockCount", "unembeddedBlockCount", "warnings"]),
  search_content: page(object({ resourceId: text, resourceVersion: integer, resourceTitle: text, resourceScore: { type: "number" }, scoreType: { type: "string", enum: ["final"] }, matches: list(object({ contentBlockId: nullableId, matchSource: text, channel: text, snippet: text, snippetTruncated: boolean, scoreType: text, finalScore: { type: "number" } }, ["matchSource", "channel", "snippet", "snippetTruncated", "scoreType", "finalScore"])) }, ["resourceId", "resourceVersion", "resourceTitle", "scoreType", "matches"])),
  list_references: page(object({ referenceId: text, referenceType: text, targetResourceId: nullableId, targetBlockId: nullableId,
    referenceNumber: { anyOf: [integer, { type: "null" }] }, entryOrder: { anyOf: [integer, { type: "null" }] }, sourceBlockIds: list(text),
    canonicalOrder: { anyOf: [integer, { type: "null" }] }, pageStart: { anyOf: [integer, { type: "null" }] }, pageEnd: { anyOf: [integer, { type: "null" }] },
    locations: list(object({ page: integer, bbox: list({ type: "number" }), sourceID: text }, ["page", "bbox"])) },
    ["referenceId", "referenceType", "targetResourceId", "targetBlockId"]), { ...base, referenceBlocksAvailable: integer,
    structuredReferencesAvailable: { ...boolean, description: "Whether the authorized current document has any structured references, independent of referenceType or pagination. Counts and items describe the filtered selection." } }),
  list_annotations: page(object({ annotationId: text, annotationType: text, text, textTruncated: boolean, quote: nullable(text), quoteTruncated: boolean, targetNodeId: nullableId, targetBlockId: nullableId,
    resourceVersion: integer, sourceId: nullableId, generationId: nullableId, anchorState: text, nextCursor: nullableId, quoteNextCursor: nullableId,
    textOffset: integer, quoteOffset: integer, originalCharCount: integer, originalQuoteCharCount: integer, charCountReturned: integer, quoteCharsReturned: integer, confidence: nullable({ type: "number", minimum: 0, maximum: 1 }), createdAt: text },
    ["annotationId", "annotationType", "text", "textTruncated", "quote", "quoteTruncated", "targetNodeId", "targetBlockId", "resourceVersion", "sourceId", "generationId", "anchorState", "nextCursor", "quoteNextCursor",
      "textOffset", "quoteOffset", "originalCharCount", "originalQuoteCharCount", "charCountReturned", "quoteCharsReturned"]), { ...base, missingAnnotationIds: list(text), totalCharsReturned: integer }),
  list_revisions: page(object({ revisionId: text, changeType: text, targetType: text, versionAfter: integer, createdAt: text, targetId: nullableId }, ["revisionId", "changeType", "targetType", "versionAfter", "createdAt"]), base),
};
const mutation = object({ operationId: text, resourceId: text, version: integer, replayed: boolean, annotationId: text, warnings }, ["operationId", "resourceId", "version", "replayed", "warnings"]);
definitions.list_annotations.required!.push("resourceId", "resourceVersion", "warnings", "missingAnnotationIds", "totalCharsReturned");
definitions.add_annotation = mutation; definitions.update_summary = mutation;
export function outputSchema(name: string): Schema { return definitions[name]; }
