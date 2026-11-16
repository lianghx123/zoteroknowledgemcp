import type { KnowledgeFolder } from "../../shared/contracts/knowledge-library";

/** Preserve snapshot order and keep root folders scoped to their own library. */
export function indexFolders(folders: readonly KnowledgeFolder[]): Map<string, Map<string | null, KnowledgeFolder[]>> {
  const libraries = new Map<string, Map<string | null, KnowledgeFolder[]>>();
  for (const folder of folders) {
    let parents = libraries.get(folder.libraryID);
    if (!parents) libraries.set(folder.libraryID, parents = new Map());
    let children = parents.get(folder.parentID);
    if (!children) parents.set(folder.parentID, children = []);
    children.push(folder);
  }
  return libraries;
}
