import type { NativeDatabase } from "./zotero-driver";

export interface DatabaseOwnerLease {
  acquire(): Promise<void>;
  assertHeld(): void;
  close(): Promise<void>;
}

/** An OS-backed lock on a separate SQLite file leaves the knowledge WAL readable.
 * Never unlink this file: replacing it could let two processes lock different files.
 * SQLite releases its lock on connection close or process termination.
 */
export function createDatabaseOwner(path: string): DatabaseOwnerLease {
  const native: NativeDatabase = new Zotero.DBConnection(`${path}.owner.sqlite`);
  let held = false;
  let closingRequested = false;
  let closing: Promise<void> | undefined;
  let acquiring: Promise<void> | undefined;
  const close = () => {
    closingRequested = true;
    return closing ??= (async () => {
      // Creation exposes cleanup before acquisition. A concurrent close must
      // drain any acquisition SQL before closing its native connection.
      await acquiring?.catch(() => {});
      await native.closeDatabase(true);
      held = false;
    })().catch(error => {
      closing = undefined;
      throw error;
    });
  };
  return {
    close,
    acquire() {
      if (closingRequested) return Promise.reject(new Error("Knowledge database ownership lease is closing."));
      return acquiring ??= (async () => {
        try {
          for (const statement of [
            "PRAGMA busy_timeout = 0", "PRAGMA locking_mode = EXCLUSIVE", "PRAGMA journal_mode = DELETE",
            "BEGIN EXCLUSIVE", "PRAGMA user_version = 1", "COMMIT",
          ]) await native.queryAsync(statement, [], { noParseParams: true, noCache: true });
          held = true;
        } catch (error) {
          // The caller already owns close(), including when acquisition and
          // native close both fail. Never hide cleanup in a rejected promise.
          throw new Error("Could not acquire knowledge database ownership. Close any other plugin instance using this data directory and try again.", { cause: error });
        }
      })();
    },
    assertHeld() { if (!held || closingRequested) throw new Error("Knowledge database ownership lease is not active."); },
  };
}
