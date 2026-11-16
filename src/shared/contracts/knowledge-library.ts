export interface KnowledgeTarget {
  libraryID: string;
  nodeID: string | null;
}

export interface KnowledgeLibrary {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface KnowledgeFolder {
  id: string;
  libraryID: string;
  parentID: string | null;
  name: string;
}

export interface KnowledgeMembership extends KnowledgeTarget {
  resourceID: string;
}

export interface KnowledgeSource {
  id: string;
  resourceID: string;
  title: string;
  mediaType: string | null;
  availability: string;
  contentState?: string;
  /** Parser of the active published generation, independent of current settings. */
  parser?: { provider: string; model: string };
}

export interface KnowledgeResource {
  id: string;
  title: string;
  itemID: number | null;
  nativeLibraryID: number;
  itemKey: string;
  state: string;
  modifiedAt: number;
  version: number;
}

export interface KnowledgeTrashEntry {
  id: string;
  kind: "item" | "folder" | "library";
  name: string;
  target: KnowledgeTarget;
  location: string;
  resourceIDs: string[];
  deletedAt: number;
}

export interface KnowledgeSnapshot {
  libraries: KnowledgeLibrary[];
  folders: KnowledgeFolder[];
  resources: KnowledgeResource[];
  memberships: KnowledgeMembership[];
  sources: KnowledgeSource[];
  itemResources: Map<number, string>;
  warnings: Map<string, string>;
  trash: KnowledgeTrashEntry[];
  trashedResources: KnowledgeResource[];
}

export interface AdmissionResult {
  itemID: number;
  resourceID?: string;
  error?: string;
}

export interface KnowledgeLibraryController {
  readonly snapshot: KnowledgeSnapshot;
  subscribe(listener: () => void): () => void;
  add(itemIDs: number[], target: KnowledgeTarget): Promise<AdmissionResult[]>;
  remove(itemIDs: number[], target: KnowledgeTarget): Promise<void>;
  moveToTrash(itemIDs: number[], libraryIDs: string[]): Promise<void>;
  createLibrary(name: string): Promise<string>;
  createFolder(name: string, target: KnowledgeTarget): Promise<string>;
  deleteLibrary(libraryID: string, deleteExclusiveResources: boolean): Promise<void>;
  deleteFolder(target: KnowledgeTarget): Promise<void>;
  deleteFolders(targets: KnowledgeTarget[]): Promise<void>;
  restoreTrash(entryIDs: string[]): Promise<void>;
  purgeTrash(entryIDs: string[]): Promise<void>;
  refresh(): Promise<void>;
}

export function emptyKnowledgeSnapshot(): KnowledgeSnapshot {
  return { libraries: [], folders: [], resources: [], memberships: [], sources: [], itemResources: new Map(), warnings: new Map(), trash: [], trashedResources: [] };
}

export function resourceIDsAt(snapshot: KnowledgeSnapshot, target?: KnowledgeTarget): Set<string> {
  if (!target) return new Set(snapshot.resources.map(resource => resource.id));
  const ids = new Set<string>();
  for (const member of snapshot.memberships) {
    if (member.libraryID === target.libraryID && (!target.nodeID || member.nodeID === target.nodeID)) ids.add(member.resourceID);
  }
  return ids;
}
