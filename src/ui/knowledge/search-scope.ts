import type { NativeSearch } from "./native-types";

/** Keep one whole-library scope without an OR condition for every item. */
export async function searchKnowledgeScope(search: NativeSearch, libraryID: number, ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  // Zotero's tempTable search condition expects "id"; the default itemID column
  // is for result tables returned to native item views instead.
  const table = await Zotero.Search!.idsToTempTable([...new Set(ids)], { idColumn: "id" });
  if (!/^tmpSearchResults_[A-Za-z0-9]+$/.test(table)) throw new Error("Unexpected native search table identity.");
  try {
    const scope = new Zotero.Search!(); scope.libraryID = libraryID;
    scope.addCondition("tempTable", "is", table);
    search.setScope(scope);
    return await search.search();
  } finally {
    // Only drop the table created above. Never cache it across filters/reloads.
    await Zotero.DB!.queryAsync(`DROP TABLE IF EXISTS temp.${table}`, false, { noCache: true });
  }
}
