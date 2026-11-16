import type { KnowledgeSnapshot } from "./contracts/knowledge-library";

export function knowledgeContentState(snapshot: KnowledgeSnapshot, resourceID: string): "parsed" | "partial" | undefined {
  const sources = snapshot.sources.filter(source => source.resourceID === resourceID && source.mediaType === "application/pdf");
  if (!sources.some(source => ["ready", "partial"].includes(source.contentState ?? ""))) return;
  return sources.every(source => source.contentState === "ready") ? "parsed" : "partial";
}
