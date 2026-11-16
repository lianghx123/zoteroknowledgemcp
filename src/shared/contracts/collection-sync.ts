export type CollectionSyncMode = "mirror" | "flexible" | "append";
import type { KnowledgeTarget } from "./knowledge-library";
export interface CollectionSyncBinding {
  id: string;
  nativeLibraryID: number;
  collectionKey: string;
  target: KnowledgeTarget;
  enabled: boolean;
  mode: CollectionSyncMode;
  folders: { nodeID: string; collectionKey: string }[];
  title: string;
  location: string;
  error: boolean;
  added: number;
  removed: number;
}
export interface CollectionSyncController {
  snapshot(): readonly CollectionSyncBinding[];
  subscribe(listener: () => void): () => void;
  link(collectionIDs: number[], target: KnowledgeTarget, mode?: CollectionSyncMode): Promise<void>;
  configure(id: string, mode: CollectionSyncMode, enabled: boolean, resetExclusions?: boolean): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  unlink(id: string): Promise<void>;
}
