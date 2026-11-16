import { ParseError, type ParsingPort } from "../shared/contracts/parsing";

/** PathUtils requires individual components on Windows. Never join provider paths. */
export function parseFilePath(relative: string): string {
  if (!/^parse\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\/(?:\d+\.bin|manifest\.json)$/.test(relative)) throw new ParseError("format");
  return PathUtils.join(Zotero.DataDirectory.dir, "knowledgemcp", ...relative.split("/"));
}

/** Reclaim uncommitted attempt files after a crash, without touching published files. */
export async function recoverParseFiles(port: ParsingPort, referenced: Set<string>): Promise<void> {
  const root = PathUtils.join(Zotero.DataDirectory.dir, "knowledgemcp", "parse");
  if (!(await port.exists(root))) return;
  const groups = await IOUtils.getChildren(root);
  for (const group of groups) {
    const id = group.split(/[\\/]/).pop()!; if (!/^[a-zA-Z0-9-]+$/.test(id)) continue;
    const attempts = await IOUtils.getChildren(group).catch(() => []);
    for (const attempt of attempts) {
      const token = attempt.split(/[\\/]/).pop()!; if (!/^[a-zA-Z0-9-]+$/.test(token)) continue;
      const manifest = parseFilePath(`parse/${id}/${token}/manifest.json`);
      try {
        // Startup runs before claims under the database owner lease. Also reclaim
        // legacy orphan attempts whose failed cleanup already removed the manifest.
        for (const path of await IOUtils.getChildren(attempt)) {
          const name = path.split(/[\\/]/).pop()!;
          const relative = `parse/${id}/${token}/${name}`;
          if (/^\d+\.bin(?:\.tmp)?$/.test(name) && !referenced.has(relative)) await port.remove(path);
        }
        if (await port.exists(manifest)) await port.remove(manifest);
        if (await port.exists(`${manifest}.tmp`)) await port.remove(`${manifest}.tmp`);
      } catch {
        // A locked attempt must not prevent startup or recovery of other attempts.
        Zotero.debug("[ZoteroKnowledgeMCP] Parse artifact recovery will retry on startup.");
      }
    }
  }
}
