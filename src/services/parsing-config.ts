import { defaultParserProfile, parserProvider } from "../shared/parser-profile";
import { hostRuntime } from "../core/host-runtime";
import { parserCatalog, parserDefinition } from "../parsers/catalog";
import { ParseError, type ParsingConfig, type ParserIdentity } from "../shared/contracts/parsing";

export const defaultParsingConfig: ParsingConfig = {
  version: 1, enabled: false, activeProfile: "paddleocr", profiles: Object.fromEntries([...parserCatalog.keys()].map(id => [id, defaultParserProfile(id)])),
  concurrency: 2, remoteConcurrency: 2, pollIntervalMs: 5000, requestTimeoutMs: 60000, jobTimeoutMs: 3600000,
  maxFileBytes: 100 * 1024 * 1024, maxResultBytes: 100 * 1024 * 1024, maxFailures: 3,
};

export function validateParsingConfig(value: unknown): ParsingConfig {
  const config = value as ParsingConfig;
  if (!config || config.version !== 1 || typeof config.enabled !== "boolean" || typeof config.activeProfile !== "string"
    || !config.profiles || typeof config.profiles !== "object" || Array.isArray(config.profiles)) throw new ParseError("config");
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !profile || typeof profile.api !== "string" || typeof profile.key !== "string"
      || typeof profile.model !== "string" || !profile.model.trim() || !profile.options || typeof profile.options !== "object"
      || Array.isArray(profile.options)) throw new ParseError("config");
    const definition = parserDefinition(parserProvider(profile));
    if (definition.models && !definition.models.includes(profile.model)) throw new ParseError("config");
    let url: URL;
    try { url = new URL(profile.api); } catch { throw new ParseError("config"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ParseError("config");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new ParseError("config");
    if (config.enabled && name === config.activeProfile && !profile.key.trim()) throw new ParseError("config");
  }
  if (!Object.hasOwn(config.profiles, config.activeProfile)) throw new ParseError("config");
  if (config.parserProfiles !== undefined && (!config.parserProfiles || typeof config.parserProfiles !== "object" || Array.isArray(config.parserProfiles))) throw new ParseError("config");
  for (const [provider, name] of Object.entries(config.parserProfiles ?? {})) {
    if (typeof name !== "string" || !Object.hasOwn(config.profiles, name) || parserProvider(config.profiles[name]) !== provider) throw new ParseError("config");
    parserDefinition(provider);
  }
  const limits: Record<string, [number, number]> = { concurrency: [1, 8], remoteConcurrency: [1, 32], pollIntervalMs: [500, 60000],
    requestTimeoutMs: [1000, 600000], jobTimeoutMs: [1000, 86400000], maxFileBytes: [1024, 268435456], maxResultBytes: [1024, 268435456], maxFailures: [1, 20] };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const number = (config as unknown as Record<string, unknown>)[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > max) throw new ParseError("config");
  }
  const normalized = JSON.parse(JSON.stringify(config)) as ParsingConfig;
  for (const profile of Object.values(normalized.profiles)) profile.options = parserDefinition(parserProvider(profile)).normalizeOptions(profile.options);
  normalized.parserProfiles = { ...normalized.parserProfiles };
  for (const [name, profile] of Object.entries(normalized.profiles)) normalized.parserProfiles[parserProvider(profile)] ??= name;
  normalized.parserProfiles[parserProvider(normalized.profiles[normalized.activeProfile])] = normalized.activeProfile;
  return normalized;
}

/** Polling is portable in Zotero; invalid edits retain the last valid snapshot. */
export class ParsingConfigFile {
  readonly path = PathUtils.join(Zotero.DataDirectory.dir, "knowledgemcp", "parsing.json");
  current = validateParsingConfig(defaultParsingConfig);
  error = false;
  private text = "";
  private observedText: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private pending: Promise<void> = Promise.resolve();
  private saving: Promise<void> = Promise.resolve();
  constructor(private readonly changed: () => void = () => {}) {}

  async start(): Promise<void> {
    if (!(await IOUtils.exists(this.path))) {
      await IOUtils.makeDirectory(PathUtils.parent(this.path), { ignoreExisting: true });
      await IOUtils.writeUTF8(this.path, `${JSON.stringify(defaultParsingConfig, null, 2)}\n`, { tmpPath: `${this.path}.tmp` });
    }
    await this.reload(); this.schedule();
  }
  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.pending = this.reload().finally(() => this.schedule());
    }, 2000);
  }
  async reload(): Promise<void> {
    if (this.closed) return;
    try {
      if ((await IOUtils.stat(this.path)).size > 1024 * 1024) throw new ParseError("config");
      const text = await IOUtils.readUTF8(this.path);
      if (this.closed) return;
      this.observedText = text;
      if (text === this.text) { if (this.error) { this.error = false; this.changed(); } return; }
      const stored = JSON.parse(text) as ParsingConfig;
      // Older settings allowed arbitrary models. Only future submissions adopt
      // fixed models; accepted job identities and credential names stay intact.
      for (const profile of Object.values(stored?.profiles ?? {})) {
        if (profile && typeof profile.model === "string") {
          const definition = parserDefinition(parserProvider(profile));
          if (definition.models?.length === 1) profile.model = definition.model;
        }
      }
      const next = validateParsingConfig(stored);
      if (this.closed) return;
      this.current = next; this.text = text; this.error = false; this.changed();
    } catch {
      if (!this.closed && !this.error) { this.error = true; this.changed(); }
    }
  }
  credential(identity: ParserIdentity): string {
    const profile = this.current.profiles[identity.profile];
    if (!profile || profile.api !== identity.api || parserProvider(profile) !== parserProvider(identity) || !profile.key.trim()) throw new ParseError("credentials");
    return profile.key;
  }
  async save(value: unknown): Promise<void> {
    if (this.closed) throw new ParseError("config");
    const next = validateParsingConfig(value);
    // Preference windows load independent bundles. Keep their check/write lock
    // on the shared host object, rather than in one window's module global.
    const path = Zotero.isWin ? this.path.replaceAll("/", "\\").toLowerCase() : this.path;
    // The registry must survive both preference and main-window destruction.
    const { Map: RuntimeMap, Promise: RuntimePromise } = hostRuntime();
    let writes = Zotero.__knowledgeMCPConfigWrites;
    try { writes?.get(path); } catch { writes = undefined; }
    if (!writes) Zotero.__knowledgeMCPConfigWrites = writes = new RuntimeMap<string, Promise<void>>();
    const pending = RuntimePromise.resolve(writes.get(path)).catch(() => {}).then(async () => {
      if (await IOUtils.readUTF8(this.path) !== this.observedText) throw new ParseError("config");
      const text = `${JSON.stringify(next, null, 2)}\n`;
      await IOUtils.writeUTF8(this.path, text, { tmpPath: `${this.path}.tmp` });
      this.observedText = text; this.text = text; this.current = next; this.error = false;
      if (!this.closed) this.changed();
    });
    const tail = pending.then(() => {}, () => {});
    writes.set(path, tail); this.saving = tail;
    try { await pending; }
    finally { if (writes.get(path) === tail) writes.delete(path); }
  }
  async close(): Promise<void> { this.closed = true; clearTimeout(this.timer); await this.pending; await this.saving; }
}
