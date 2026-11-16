// Node SQLite is only a test double for the native Zotero port.
import { DatabaseSync } from "node:sqlite";

export class MockNativeDatabase {
  constructor(path = ":memory:", options = {}) {
    this.sqlite = new DatabaseSync(path);
    this.closed = false;
    this.queries = [];
    this.maxObservedParameters = 0;
    this.options = options;
  }
  async queryAsync(sql, parameters, options) {
    this.queries.push(sql);
    // Gecko rejects literal LIKE operands; match its guard in the port double.
    if (/\bLIKE\b\s(?![@:?])/i.test(sql)) throw new Error("Please enter a LIKE clause with bindings");
    if (this.options.fail?.(sql)) throw new Error("Injected native query failure");
    if (!options.noParseParams || !options.noCache) throw new Error("Unsafe parameter/cache mode");
    const bindings = Array.isArray(parameters) ? parameters : [parameters];
    const parameterCount = Array.isArray(parameters) ? parameters.length : Object.keys(parameters).length;
    this.maxObservedParameters = Math.max(this.maxObservedParameters, parameterCount);
    if (parameterCount > (this.options.maxParameters ?? Infinity)) throw new Error(`SQLite test parameter budget exceeded: ${parameterCount}`);
    const statement = this.sqlite.prepare(sql);
    const columns = statement.columns();
    if (columns.length) {
      for (const row of statement.all(...bindings)) {
        let cancelled = false;
        options.onRow?.({ getResultByName(name) {
          if (!(name in row)) throw new Error(`Missing column: ${name}`);
          return ArrayBuffer.isView(row[name]) ? Array.from(row[name]) : row[name];
        } }, () => { cancelled = true; });
        if (cancelled) break;
      }
    } else statement.run(...bindings);
  }
  async loadExtension() {}
  async closeDatabase() {
    if (!this.closed) this.sqlite.close();
    this.closed = true;
  }
}

export function mockNativeFactory() {
  const instances = [];
  return { instances, DBConnection: class extends MockNativeDatabase {
    constructor(path) { super(); this.path = path; instances.push(this); }
  } };
}
