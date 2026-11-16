import { ParseError, type ParserIdentity, type ParseProgress } from "../../shared/contracts/parsing";
import { BrowserParseTransport, resultURL, type ParseTransport } from "../transport";
import { object as record } from "../content";

/** Wire protocol verified against PaddleOCR's official multipart job API. */
export class PaddleOCRProvider {
  constructor(private readonly transport: ParseTransport = new BrowserParseTransport()) {}
  private async json(url: string, init: RequestInit, key: string, timeout: number, signal: AbortSignal): Promise<Record<string, unknown>> {
    const { bytes } = await this.transport.request(url, { ...init, headers: { Authorization: `Bearer ${key}` } }, timeout, 1024 * 1024, signal);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new ParseError("format"); }
    const envelope = record(value);
    if ((envelope.code !== undefined && envelope.code !== 0) || !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) throw new ParseError("provider");
    return record(envelope.data);
  }
  async submit(parser: ParserIdentity, key: string, bytes: Uint8Array, name: string, timeout: number, signal: AbortSignal): Promise<string> {
    const body = this.transport.multipart(parser.model, parser.options, bytes, name);
    const data = await this.json(parser.api, { method: "POST", body }, key, timeout, signal);
    if (typeof data.jobId !== "string" || !data.jobId || data.jobId.length > 512) throw new ParseError("ambiguous");
    return data.jobId;
  }
  async progress(parser: ParserIdentity, key: string, jobID: string, timeout: number, signal: AbortSignal): Promise<ParseProgress> {
    const data = await this.json(`${parser.api.replace(/\/+$/, "")}/${encodeURIComponent(jobID)}`, { method: "GET" }, key, timeout, signal);
    if (typeof data.state !== "string" || !["pending", "running", "done", "failed"].includes(data.state)) throw new ParseError("format");
    const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    const progress = record(data.extractProgress);
    const completed = integer(progress.extractedPages), total = integer(progress.totalPages);
    if (completed !== undefined && total !== undefined && completed > total) throw new ParseError("format");
    return { state: data.state as ParseProgress["state"], completed, total, resultURL: data.state === "done" ? resultURL(record(data.resultUrl).jsonUrl) : undefined };
  }
  async download(url: string, timeout: number, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    // Artifact hosts never receive the API bearer token.
    return (await this.transport.request(resultURL(url), { method: "GET" }, timeout, maxBytes, signal)).bytes;
  }
}
