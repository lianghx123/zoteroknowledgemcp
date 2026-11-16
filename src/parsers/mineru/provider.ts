import { ParseError, type ParserIdentity, type ParseProgress } from "../../shared/contracts/parsing";
import { BrowserParseTransport, resultURL, type ParseTransport } from "../transport";
import { minerUOptions } from "./definition";

export interface MinerUAllocation { batchID: string; dataID: string; uploadURL: string }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Authenticated v4 API; signed upload/download hosts never receive the API key. */
export class MinerUProvider {
  constructor(private readonly transport: ParseTransport = new BrowserParseTransport()) {}
  async download(url: string, timeout: number, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    return (await this.transport.request(resultURL(url), { method: "GET" }, timeout, maxBytes, signal)).bytes;
  }
  private async json(parser: ParserIdentity, path: string, key: string, timeout: number, signal: AbortSignal, payload?: unknown) {
    const { bytes } = await this.transport.request(`${parser.api.replace(/\/+$/, "")}${path}`, {
      method: payload ? "POST" : "GET", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    }, timeout, 1024 * 1024, signal);
    let envelope: Record<string, unknown>;
    try { envelope = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { throw new ParseError("format"); }
    if (envelope.code !== 0) {
      const code = envelope.code;
      if (["A0202", "A0211", "A0220"].includes(String(code))) throw new ParseError("credentials", false, undefined, true);
      if ([-60009, -60018, -60019].includes(Number(code))) throw new ParseError("http-429", true, Number(code) === -60009 ? 60000 : 3600000, true);
      if ([-10001, -60001, -60007].includes(Number(code))) throw new ParseError("provider", true, undefined, true);
      throw new ParseError("provider", false, undefined, envelope.code !== undefined);
    }
    if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) throw new ParseError("format");
    return record(envelope.data);
  }
  async allocate(parser: ParserIdentity, key: string, name: string, dataID: string, timeout: number, signal: AbortSignal): Promise<MinerUAllocation> {
    const options = minerUOptions(parser.options);
    const data = await this.json(parser, "/file-urls/batch", key, timeout, signal, {
      files: [{ name: name.replace(/^.*[\\/]/, ""), data_id: dataID, is_ocr: options.isOcr }], model_version: parser.model,
      enable_formula: options.enableFormula, enable_table: options.enableTable, language: options.language,
    });
    if (typeof data.batch_id !== "string" || !data.batch_id || data.batch_id.length > 512
      || !Array.isArray(data.file_urls) || data.file_urls.length !== 1) throw new ParseError("ambiguous");
    return { batchID: data.batch_id, dataID, uploadURL: resultURL(data.file_urls[0]) };
  }
  async upload(url: string, bytes: Uint8Array, timeout: number, signal: AbortSignal): Promise<void> {
    await this.transport.request(resultURL(url), { method: "PUT", body: new Uint8Array(bytes).buffer, redirect: "error" }, timeout, 1024 * 1024, signal, "optional");
  }
  async progress(parser: ParserIdentity, key: string, batchID: string, dataID: string | undefined, timeout: number, signal: AbortSignal): Promise<ParseProgress> {
    const data = await this.json(parser, `/extract-results/batch/${encodeURIComponent(batchID)}`, key, timeout, signal);
    if (!Array.isArray(data.extract_result)) throw new ParseError("format");
    if (!data.extract_result.length) return { state: "pending" };
    const entries = data.extract_result.map(record);
    const matches = dataID ? entries.filter(entry => entry.data_id === dataID) : entries.length === 1 ? entries : [];
    if (matches.length !== 1) throw new ParseError("format");
    const entry = matches[0], state = entry.state;
    if (!["waiting-file", "converting", "pending", "running", "done", "failed"].includes(String(state))) throw new ParseError("format");
    const progress = record(entry.extract_progress);
    const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    const completed = integer(progress.extracted_pages), total = integer(progress.total_pages);
    if (completed !== undefined && total !== undefined && completed > total) throw new ParseError("format");
    return { state: state === "done" || state === "failed" || state === "running" ? state : "pending", completed, total,
      phase: state === "converting" || state === "waiting-file" ? "remote-preparing" : state === "pending" ? "remote-queue" : state === "running" ? "parsing" : undefined,
      resultURL: state === "done" ? resultURL(entry.full_zip_url) : undefined };
  }
}
