const operations = new Map<string, Promise<void>>();

/** Publication and reclamation own the final snapshot and its temporary file together. */
export async function withVectorSnapshotLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const base = path.replace(/\.tmp$/, ""), key = Zotero.isWin ? base.toLowerCase() : base;
  const pending = (operations.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  const tail = pending.then(() => {}, () => {});
  operations.set(key, tail);
  try { return await pending; }
  finally { if (operations.get(key) === tail) operations.delete(key); }
}
