export type JsonObject = Record<string, unknown>;
export const applicationContract = "2.4.0";
export interface Schema {
  type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean | Schema;
  items?: Schema; enum?: readonly unknown[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  minItems?: number; maxItems?: number; uniqueItems?: boolean; pattern?: string; format?: string; default?: unknown;
  anyOf?: Schema[]; description?: string;
}
export class McpError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly details: JsonObject = {}) { super(message); }
}
export const scopes = ["knowledge:search", "knowledge:read", "knowledge:annotate", "knowledge:update-summary"] as const;
export interface Principal { id: string; authorizationVersion: number; libraries: string[]; scopes: string[]; }
export interface ToolResult { content: Array<{ type: "text"; text: string }>; structuredContent: JsonObject; isError?: boolean; }
export function success(value: JsonObject): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
export function failure(error: unknown): ToolResult {
  const safe = error instanceof McpError ? error : new McpError("INTERNAL_ERROR", "The operation failed.", true);
  return { ...success({ error: { code: safe.code, message: safe.message, retryable: safe.retryable, details: safe.details } }), isError: true };
}
export const chars = (text: string): number => Array.from(text).length;
export const slice = (text: string, start: number, end?: number): string => Array.from(text).slice(start, end).join("");
export const string = (args: JsonObject, key: string): string | undefined => typeof args[key] === "string" ? args[key] as string : undefined;
export const number = (args: JsonObject, key: string, fallback = 0): number => typeof args[key] === "number" ? args[key] as number : fallback;
export const strings = (args: JsonObject, key: string): string[] => Array.isArray(args[key]) ? args[key] as string[] : [];
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function requireValue(condition: unknown, message: string, details: JsonObject = {}): asserts condition {
  if (!condition) throw new McpError("INVALID_ARGUMENT", message, false, details);
}
