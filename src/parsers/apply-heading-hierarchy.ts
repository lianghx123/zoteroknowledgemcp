import type { ParsedBlock } from "../shared/contracts/parsing";
import { analyzeDocument } from "./heading-hierarchy";

export const HEADING_HIERARCHY_VERSION = 1;

/** Refine provider-labelled titles only; retain their text and source anchors. */
export function applyHeadingHierarchy(blocks: ParsedBlock[], warnings: string[] = []): ParsedBlock[] {
  const { rows } = analyzeDocument({ blocks: blocks.map((block, index) => ({
    id: String(index), canonical_order: index, block_type: block.type, content_normalized: block.text,
    content_markdown: block.markdown, page_start: block.page, metadata: { ocr_label: block.label },
  })) });
  for (const row of rows) {
    if (row.status === "protected" || row.status === "unchanged") continue;
    const block = blocks[Number(row.id)];
    block.metadata = { ...block.metadata, heading_hierarchy: {
      version: HEADING_HIERARCHY_VERSION, status: row.status, reason: row.reason,
      style: row.numbering?.kind, depth: row.depth,
      parent_order: row.parent === null ? null : Number(row.parent),
      parent_source_id: row.parent === null ? null : blocks[Number(row.parent)].sourceID,
    } };
    if (row.status === "automatic") {
      const level = row.depth! + 1;
      block.headingParentOrder = row.parent === null ? null : Number(row.parent);
      if (block.headingLevel !== level) {
        block.metadata.original_heading_level = block.headingLevel;
        block.metadata.heading_level_inferred = true;
        block.qualityFlags = [...new Set([...(block.qualityFlags ?? []), "heading_level_inferred"])].sort();
        if (!warnings.includes("heading-level-inferred")) warnings.push("heading-level-inferred");
      }
      block.headingLevel = level;
      block.markdown = `${"#".repeat(level)} ${block.markdown.replace(/^\s*#{1,6}\s*/, "")}`;
    } else if (row.status === "excluded") {
      block.type = "paragraph";
      block.headingLevel = undefined;
      block.markdown = block.markdown.replace(/^\s*#{1,6}\s*/, "");
    } else {
      block.qualityFlags = [...new Set([...(block.qualityFlags ?? []), "heading_hierarchy_uncertain"])].sort();
      const warning = `heading-hierarchy-review:${block.sourceID}:${row.reason}`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }
  return blocks;
}
