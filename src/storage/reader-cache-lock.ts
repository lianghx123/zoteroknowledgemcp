const operations = new Map<string, Promise<void>>();

/** Cache replacement and reclamation share one lock, including the temporary file. */
export async function withReaderCacheLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = path.replace(/\.tmp$/, "");
  const pending = (operations.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  const tail = pending.then(() => {}, () => {});
  operations.set(key, tail);
  try { return await pending; }
  finally { if (operations.get(key) === tail) operations.delete(key); }
}
