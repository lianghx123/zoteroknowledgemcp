import { t } from "./localization";

export function parsingErrorMessage(code: string): string {
  if (/^http-\d{3}$/.test(code) && code !== "http-429") return t("parse-error-http", { status: code.slice(5) });
  const keys = new Set(["config", "credentials", "missing", "size", "format", "ambiguous", "stale", "timeout", "provider", "network", "empty", "page-positions", "image-format", "interrupted", "edited"]);
  return t(`parse-error-${keys.has(code) ? code : code === "http-429" ? "rate-limit" : "internal"}`);
}
