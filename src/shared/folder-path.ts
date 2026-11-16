import type { KnowledgeSnapshot, KnowledgeTarget } from "./contracts/knowledge-library";

/** Match Zotero's displayed collection hierarchy, independently of filesystem paths. */
export const FOLDER_PATH_SEPARATOR = " › ";

/** Resolve every ancestor rather than abbreviating a location to its leaf folder. */
export function knowledgeFolderPath(snapshot: KnowledgeSnapshot, target: KnowledgeTarget): string {
  const names: string[] = [], seen = new Set<string>();
  for (let nodeID = target.nodeID; nodeID && !seen.has(nodeID);) {
    seen.add(nodeID);
    const folder = snapshot.folders.find(row => row.id === nodeID && row.libraryID === target.libraryID);
    if (!folder) break;
    names.unshift(folder.name); nodeID = folder.parentID;
  }
  const library = snapshot.libraries.find(row => row.id === target.libraryID);
  return [library?.name, ...names].filter(Boolean).join(FOLDER_PATH_SEPARATOR);
}

/** Historical task/Trash locations were saved as preformatted display strings. */
export function displayStoredFolderPath(path: string): string {
  return path.replaceAll(" / ", FOLDER_PATH_SEPARATOR);
}
