import { ModelError } from "../../shared/contracts/retrieval";

const origin = "chrome://knowledgemcp", realm = "Knowledge MCP model credentials";
export class ModelCredentials {
  status(reference: string): "saved" | "missing" | "unavailable" {
    try { this.get(reference); return "saved"; }
    catch (error) { return error instanceof ModelError && error.code === "credentials" ? "missing" : "unavailable"; }
  }
  /** Runs inside the configuration writer's lock and returns a guarded rollback. */
  async stage(values: ReadonlyMap<string, string>): Promise<() => Promise<void>> {
    const changed: Array<{ reference: string; previous: string; value: string }> = [];
    const rollback = async () => {
      for (const entry of [...changed].reverse()) {
        let current = ""; try { current = this.get(entry.reference); } catch (error) { if (!(error instanceof ModelError) || error.code !== "credentials") throw error; }
        if (current !== entry.value && current !== entry.previous) throw new ModelError("credentials-rollback");
        if (current === entry.value) await this.set(entry.reference, entry.previous);
      }
    };
    try {
      for (const [reference, value] of values) {
        let previous = ""; try { previous = this.get(reference); } catch (error) { if (!(error instanceof ModelError) || error.code !== "credentials") throw error; }
        changed.push({ reference, previous, value }); await this.set(reference, value);
      }
    } catch {
      try { await rollback(); } catch { throw new ModelError("credentials-rollback"); }
      throw new ModelError("credentials-store");
    }
    return rollback;
  }
  get(reference: string): string {
    const login = Services.logins.findLogins(origin, null, realm).find(entry => entry.username === reference);
    if (!login?.password) throw new ModelError("credentials"); return login.password;
  }
  async set(reference: string, value: string): Promise<void> {
    const previous = Services.logins.findLogins(origin, null, realm).find(entry => entry.username === reference);
    if (!value.trim()) { if (previous) Services.logins.removeLogin(previous); return; }
    const { nsLoginInfo } = ChromeUtils.importESModule("resource://gre/modules/LoginInfo.sys.mjs");
    const next = new nsLoginInfo(); next.init(origin, null, realm, reference, value.trim(), "", "");
    if (previous) Services.logins.modifyLogin(previous, next); else await Services.logins.addLoginAsync(next);
  }
}
