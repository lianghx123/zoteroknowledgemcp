import type { VisualEvidence, VisualPosition } from "../shared/contracts/visual-content";

export interface VisualAssociationBlock {
  id: string;
  type: string;
  label: string;
  page: number | null;
  pageEnd: number | null;
  locations: Array<{ page: number; bbox: number[] }>;
}
export interface VisualAssociation {
  visualBlockId: string;
  relatedBlockId: string;
  role: "caption" | "note";
  position: Exclude<VisualPosition, "content">;
  evidence: VisualEvidence;
}
const visual = (block: VisualAssociationBlock) => ["image", "table"].includes(block.type);
const part = (block: VisualAssociationBlock) => ["caption", "footnote"].includes(block.type);
const validBox = (box: number[]) => box.length === 4 && box.every(Number.isFinite) && box[0] < box[2] && box[1] < box[3];

/** Conservative associations use provider categories, never note-prefix guesses. */
export function associateVisualBlocks(blocks: readonly VisualAssociationBlock[]): VisualAssociation[] {
  const heights = new Map<number, number>();
  for (const block of blocks) for (const location of block.locations) {
    if (validBox(location.bbox)) heights.set(location.page, Math.max(heights.get(location.page) ?? 0, location.bbox[3]));
  }
  const links: VisualAssociation[] = [];
  for (const [index, child] of blocks.entries()) {
    if (!part(child)) continue;
    const neighbors: Array<{ anchor: VisualAssociationBlock; index: number }> = [];
    for (const direction of [-1, 1]) for (let offset = 1; offset <= 12; offset++) {
      const candidate = blocks[index + direction * offset];
      if (!candidate || (!visual(candidate) && !part(candidate))) break;
      if (visual(candidate)) neighbors.push({ anchor: candidate, index: index + direction * offset });
    }
    const candidates: Array<VisualAssociation & { score: number }> = [];
    for (const { anchor, index: anchorIndex } of neighbors) {
      if (child.label === "table_title" && anchor.type !== "table") continue;
      if (child.page === null || anchor.page === null || Math.abs(child.page - anchor.page) > 1) continue;
      const samePage = child.page === anchor.page;
      const childBox = child.locations.find(location => location.page === child.page && validBox(location.bbox))?.bbox;
      const anchorBox = anchor.locations.find(location => location.page === child.page && validBox(location.bbox))?.bbox;
      const role = child.type === "caption" ? "caption" : "note";
      if (samePage && childBox && anchorBox) {
        const overlap = Math.max(0, Math.min(childBox[2], anchorBox[2]) - Math.max(childBox[0], anchorBox[0]))
          / Math.min(childBox[2] - childBox[0], anchorBox[2] - anchorBox[0]);
        if (overlap < .35) continue;
        const tolerance = Math.min(childBox[3] - childBox[1], anchorBox[3] - anchorBox[1]) * .15;
        const position = childBox[3] <= anchorBox[1] + tolerance ? "before" : childBox[1] >= anchorBox[3] - tolerance ? "after" : undefined;
        if (!position) continue;
        const height = heights.get(child.page) ?? 1000;
        const distance = Math.max(0, position === "before" ? anchorBox[1] - childBox[3] : childBox[1] - anchorBox[3]);
        if (distance > Math.max(48, height * (role === "caption" ? .09 : .12))) continue;
        candidates.push({ visualBlockId: anchor.id, relatedBlockId: child.id, role, position, evidence: "layout",
          score: distance / height + (1 - overlap) * .03 + Math.abs(index - anchorIndex) * .001 });
      } else if (neighbors.length === 1 && Math.abs(index - anchorIndex) === 1 && (role === "caption" || child.label === "vision_footnote")) {
        // Missing geometry is not evidence of spatial compatibility. Only an
        // unambiguous direct neighbor can use this explicitly weaker fallback.
        candidates.push({ visualBlockId: anchor.id, relatedBlockId: child.id, role,
          position: index < anchorIndex ? "before" : "after", evidence: "adjacency", score: 1 });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    if (!candidates.length || (candidates[1] && candidates[1].score - candidates[0].score < .015)) continue;
    const { score: _score, ...association } = candidates[0]; links.push(association);
  }
  return links;
}
