import { ParseError } from "../shared/contracts/parsing";
import { hostRuntime, hostSetTimeout, hostClearTimeout } from "../core/host-runtime";

export interface ParseTransport {
  request(url: string, init: RequestInit, timeout: number, maxBytes: number, signal: AbortSignal, responseBody?: "required" | "optional"): Promise<{ bytes: Uint8Array; headers: Headers }>;
  multipart(model: string, options: Record<string, unknown>, bytes: Uint8Array, fileName: string): FormData;
}

export class BrowserParseTransport implements ParseTransport {
  multipart(model: string, options: Record<string, unknown>, bytes: Uint8Array, fileName: string): FormData {
    const scope = hostRuntime();
    const body = new scope.FormData(); body.append("model", model); body.append("optionalPayload", JSON.stringify(options));
    body.append("file", new scope.Blob([new Uint8Array(bytes).buffer], { type: "application/pdf" }), fileName); return body;
  }
  async request(url: string, init: RequestInit, timeout: number, maxBytes: number, signal: AbortSignal, responseBody: "required" | "optional" = "required") {
    const scope = hostRuntime();
    const controller = new scope.AbortController(), abort = () => controller.abort();
    if (signal.aborted) controller.abort(); else signal.addEventListener("abort", abort, { once: true });
    const timer = hostSetTimeout(abort, timeout);
    try {
      const authenticated = new scope.Headers(init.headers).has("authorization");
      const response = await scope.fetch(url, { ...init, signal: controller.signal, credentials: "omit", redirect: authenticated ? "error" : init.redirect ?? "follow", referrerPolicy: "no-referrer" });
      if (!authenticated && response.url) resultURL(response.url);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const value = response.headers.get("retry-after"), seconds = Number(value);
        const retry = value === null ? undefined : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
        const denied = response.status === 401 || response.status === 403;
        throw new ParseError(authenticated && denied ? "credentials" : `http-${response.status}`,
          [408, 425, 429].includes(response.status) || response.status >= 500 || (!authenticated && denied),
          retry !== undefined && Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600000) : undefined);
      }
      if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw new ParseError("size"); }
      const reader = response.body?.getReader();
      if (!reader) {
        if (responseBody === "optional") return { bytes: new Uint8Array(), headers: response.headers };
        throw new ParseError("format");
      }
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.byteLength; if (length > maxBytes) throw new ParseError("size"); chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!length && responseBody === "required") throw new ParseError("format");
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { bytes, headers: response.headers };
    } catch (error) { if (error instanceof ParseError) throw error; throw new ParseError("network", true); }
    finally { hostClearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
}

export function resultURL(value: unknown): string {
  if (typeof value !== "string") throw new ParseError("format");
  let url: URL;
  try { url = new URL(value); } catch { throw new ParseError("format"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ParseError("format");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new ParseError("format");
  return url.href;
}
