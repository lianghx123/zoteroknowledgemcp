import type { McpBlock, McpBlockHeader, McpRepository } from "../../repositories/mcp";
import type { McpCursor } from "../../security/mcp-cursor";
import { chars, strings, number, requireValue, type JsonObject, type Principal } from "../contracts";

export const excludedBlockFlags = ["running_header", "running_footer", "page_number", "low_information", "boilerplate"];

export function isReadableBlock(block: McpBlock | McpBlockHeader): boolean {
  return ["body", "note"].includes(block.role) && !block.quality.some(flag => excludedBlockFlags.includes(flag));
}

export function readingSelection(blocks: McpBlockHeader[], args: JsonObject) {
  const selected = blocks.filter(block => args.includeBoilerplate || isReadableBlock(block));
  const reasons = new Map<string, number>();
  for (const block of blocks) if (!args.includeBoilerplate && !isReadableBlock(block)) for (const flag of block.quality.filter(flag => excludedBlockFlags.includes(flag))) reasons.set(flag, (reasons.get(flag) ?? 0) + 1);
  return { blocks: selected, selection: { availableBlockCount: blocks.length, selectedBlockCount: selected.length, excludedBlockCount: blocks.length - selected.length,
    excludedByReason: [...reasons].map(([reason, count]) => ({ reason, count })), originalNotesIncluded: true, includeBoilerplate: Boolean(args.includeBoilerplate) } };
}

export function blockItem(block: McpBlock | McpBlockHeader): JsonObject {
  return { blockId: block.id, blockType: block.type, contentRole: block.role, structureNodeId: block.nodeId, canonicalOrder: block.order,
    sourceId: block.sourceId, generationId: block.generationId, sourceVersion: block.sourceVersion, contentVersion: block.contentVersion,
    qualityFlags: block.quality, pageStart: block.pageStart, pageEnd: block.pageEnd,
    metadata: { ...block.metadata, sourceId: block.sourceId, generationId: block.generationId, sourceVersion: block.sourceVersion, contentVersion: block.contentVersion } };
}

/** Format already-authorized blocks without changing their order or cursor budget. */
export class McpContentReader {
  constructor(private readonly cursors: McpCursor, private readonly repository: McpRepository) {}

  async render(blocks: McpBlockHeader[], args: JsonObject, context: string, p: Principal, signal: AbortSignal, cursor?: string, maxChars = number(args, "maxChars", 12000), maxBlocks = Infinity): Promise<JsonObject> {
    const position = await this.cursors.decode(cursor, context), start = number(position, "offset"), total = blocks.reduce((sum, block, index) => sum + block.charCount + (index ? 2 : 0), 0);
    requireValue(Number.isSafeInteger(start) && start >= 0 && start <= total, "Invalid text cursor.");
    let offset = 0, returned = 0, text = "";
    const selected: McpBlock[] = [], segments: JsonObject[] = [];
    for (let index = 0; index < blocks.length; index++) {
      signal.throwIfAborted();
      const block = blocks[index], separator = index ? "\n\n" : "", length = separator.length + block.charCount, end = offset + length;
      if (end > start && returned < maxChars && selected.length < maxBlocks) {
        const localStart = Math.max(0, start - offset);
        const delimiter = separator.slice(localStart, localStart + maxChars - returned);
        text += delimiter; returned += delimiter.length;
        const blockStart = Math.max(0, localStart - separator.length), take = Math.min(block.charCount - blockStart, maxChars - returned);
        if (take > 0) {
          const body = await this.repository.readBlock(block, blockStart, take, p, args.responseMode === "full" || strings(args, "includeFields").includes("blockMetadata"));
          const count = chars(body.markdown);
          segments.push({ blockId: block.id, kind: block.annotation ? "annotation" : "content_block", sourceId: block.sourceId || null, generationId: block.generationId || null,
            sourceVersion: block.sourceVersion, contentVersion: block.contentVersion, blockOffset: blockStart, outputOffset: returned, charCount: count });
          text += body.markdown; returned += count; selected.push(body);
        }
      }
      offset = end;
      if (returned >= maxChars || selected.length >= maxBlocks) break;
    }
    const truncated = start + returned < total;
    return { contentMarkdown: text, charCountReturned: returned, totalCharCount: total, blockCountReturned: selected.length, truncated,
      nextCursor: truncated ? await this.cursors.encode(context, { offset: start + returned }) : null,
      blockIds: selected.map(block => block.id), textOffset: start, segments, ...(args.responseMode === "full" || strings(args, "includeFields").includes("blockMetadata") ? { blockMetadata: selected.map(blockItem) } : {}),
      ...(args.responseMode === "full" || strings(args, "includeFields").includes("contentStats") ? { contentStats: { blockCount: blocks.length, charCount: total } } : {}),
      warnings: blocks.some(block => block.partial) ? [{ code: "PARTIAL_CONTENT", message: "The published document content is partial." }] : [] };
  }
}
