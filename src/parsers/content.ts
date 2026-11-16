import { decodeHTML } from "entities";

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function normalizeOCRText(markdown: string): string {
  const text = markdown.replace(/<[^>]+>/g, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/^[#>]+\s*/gm, "");
  return decodeHTML(text).replace(/\s+/g, " ").trim();
}
