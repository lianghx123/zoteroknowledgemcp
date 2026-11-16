import { CompiledQuery, type DatabaseConnection, type Driver, type QueryResult, type TransactionSettings } from "kysely";

/** Verified Zotero 10 DBConnection subset. Never pass Zotero.DB (the native library). */
export interface NativeRow {
  getResultByName(name: string): unknown;
}

export interface NativeDatabase {
  queryAsync(sql: string, parameters: Record<string, unknown> | unknown[], options: {
    noParseParams: true;
    noCache: true;
    onRow?: (row: NativeRow, cancel: () => void) => void;
  }): Promise<unknown>;
  loadExtension(name: "fts5"): Promise<unknown>;
  closeDatabase(permanent: boolean): Promise<void>;
}

function parameter(value: unknown): unknown {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Uint8Array) return value;
  throw new Error("Unsupported SQLite parameter. Use finite numbers, strings, null or Uint8Array.");
}

/** Zotero rows expose named getters, not enumerable records. Repositories must map fields explicitly. */
function resultRow<R>(row: NativeRow): R {
  const values: Record<string, unknown> = Object.create(null);
  return new Proxy(values, {
    get(target, key) {
      if (key === "then" || key === "toJSON" || typeof key !== "string") return undefined;
      if (!Object.hasOwn(target, key)) {
        const value = row.getResultByName(key);
        target[key] = Array.isArray(value) ? Uint8Array.from(value) : value;
      }
      return target[key];
    },
  }) as R;
}

export class ZoteroConnection implements DatabaseConnection {
  constructor(readonly native: NativeDatabase) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const rows: R[] = [];
    let rowError: unknown;
    const bindings = Object.fromEntries(query.parameters.map((value, i) => [`p${i + 1}`, parameter(value)]));
    await this.native.queryAsync(query.sql, bindings, {
      // Keep SQL NULL semantics. Named bindings also avoid Gecko's treating an
      // indexed array whose first element is a BLOB as a batch of parameter sets.
      noParseParams: true, noCache: true,
      onRow(row, cancel) {
        try { rows.push(resultRow<R>(row)); }
        catch (error) { rowError = error; cancel(); }
      },
    });
    if (rowError) throw rowError;
    if (/^\s*(?:insert|update|delete|replace)\b/i.test(query.sql) ||
      ["InsertQueryNode", "UpdateQueryNode", "DeleteQueryNode"].includes(query.query.kind)) {
      let affected = 0;
      await this.native.queryAsync("SELECT changes() AS affected", [], {
        noParseParams: true, noCache: true,
        onRow(row) { affected = Number(row.getResultByName("affected")); },
      });
      return { rows, numAffectedRows: BigInt(affected) };
    }
    return { rows };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("SQLite streaming is unavailable. Use bounded keyset queries.");
  }
}

class ClosingConnection implements DatabaseConnection {
  async executeQuery<R>(): Promise<QueryResult<R>> {
    throw new Error("Knowledge database is closing.");
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Knowledge database is closing.");
  }
}

/** Single-owner FIFO connection. Kysely keeps a reservation for the entire transaction. */
export class ZoteroDriver implements Driver {
  private readonly connection: ZoteroConnection;
  private readonly closingConnection = new ClosingConnection();
  private tail: Promise<void> = Promise.resolve();
  private release: (() => void) | undefined;
  private closing = false;

  constructor(native: NativeDatabase) { this.connection = new ZoteroConnection(native); }
  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    this.release = release;
    // Kysely 0.29.7 does not unlock its single-connection mutex if acquisition
    // rejects. Reject execution instead, so each queued caller releases its
    // reservation normally without touching native storage. Existing leases
    // retain the live connection to finish their query or transaction.
    return this.closing ? this.closingConnection : this.connection;
  }

  async releaseConnection(): Promise<void> {
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    if (settings.isolationLevel && settings.isolationLevel !== "serializable") {
      throw new Error("Only serializable SQLite transactions are supported.");
    }
    if (settings.accessMode) throw new Error("SQLite transaction access modes are not supported.");
    await connection.executeQuery(CompiledQuery.raw("BEGIN IMMEDIATE"));
  }
  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("COMMIT"));
  }
  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
  }
  async destroy(): Promise<void> {
    this.closing = true;
    await this.tail;
    await this.connection.native.closeDatabase(true);
  }
}
