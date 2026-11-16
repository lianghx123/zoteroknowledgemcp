export type VisualRole = "caption" | "note" | "body";
export type VisualPosition = "before" | "after" | "content";
export type VisualEvidence = "provider" | "layout" | "adjacency";

export interface VisualLink {
  id: string;
  visualBlockId: string;
  relatedBlockId: string | null;
  role: VisualRole;
  position: VisualPosition;
  evidence: VisualEvidence;
  ordinal: number;
  markdown: string | null;
}

export interface ReaderContentBlock {
  id: string;
  type: string;
  label: string;
  markdown: string;
  pageStart?: number | null;
  pageEnd?: number | null;
}
