import type { AttachmentIdentity } from "./knowledge-content";
import type { RetrievalMode } from "./retrieval";

export interface ReaderSearchHit {
  blockID: string;
  text: string;
  section: string | null;
  page: number | null;
}
export interface ReaderSearchResult {
  hits: ReaderSearchHit[];
  degraded: string[];
  truncated: boolean;
}
export type ReaderSearchProvider = (attachment: AttachmentIdentity, generationID: string,
  query: string, mode: RetrievalMode, signal: AbortSignal) => Promise<ReaderSearchResult>;
