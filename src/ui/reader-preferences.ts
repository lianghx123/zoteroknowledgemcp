/** Profile-wide reading preferences; document positions belong to separate state. */
export interface ReaderPreferences {
  open: boolean;
  ratio: number;
  contentsVisible: boolean;
  fontSize: number;
  contentsDepth: number;
  editorMaxHeight: number | null;
}

const preference = "extensions.zotero.knowledgemcp.readerPreferences";
const defaults: ReaderPreferences = { open: false, ratio: 0.5, contentsVisible: true, fontSize: 15, contentsDepth: 0, editorMaxHeight: null };

export function readReaderPreferences(): ReaderPreferences {
  try {
    const raw: unknown = JSON.parse(String(Zotero.Prefs?.get(preference, true)));
    if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1) return { ...defaults };
    const saved = raw as Partial<ReaderPreferences>;
    const maximum = "editorMaxHeight" in raw ? saved.editorMaxHeight : (raw as { editorHeight?: unknown }).editorHeight;
    return {
      open: typeof saved.open === "boolean" ? saved.open : defaults.open,
      ratio: typeof saved.ratio === "number" && Number.isFinite(saved.ratio) && saved.ratio >= 0.25 && saved.ratio <= 0.75 ? saved.ratio : defaults.ratio,
      contentsVisible: typeof saved.contentsVisible === "boolean" ? saved.contentsVisible : defaults.contentsVisible,
      fontSize: typeof saved.fontSize === "number" && Number.isInteger(saved.fontSize) && saved.fontSize >= 12 && saved.fontSize <= 23 ? saved.fontSize : defaults.fontSize,
      contentsDepth: typeof saved.contentsDepth === "number" && Number.isInteger(saved.contentsDepth) && saved.contentsDepth >= 0 && saved.contentsDepth <= 6 ? saved.contentsDepth : defaults.contentsDepth,
      editorMaxHeight: typeof maximum === "number" && Number.isInteger(maximum) && maximum >= 64 && maximum <= 2400 ? maximum : defaults.editorMaxHeight,
    };
  } catch { return { ...defaults }; }
}

/** Merge only the changed fields, so another open reader cannot save stale fields. */
export function updateReaderPreferences(changes: Partial<ReaderPreferences>): void {
  try {
    Zotero.Prefs?.set(preference, JSON.stringify({ version: 1, ...readReaderPreferences(), ...changes }), true);
  } catch (error) {
    Zotero.debug(`[ZoteroKnowledgeMCP] Could not save reading preferences: ${String(error)}`);
  }
}
