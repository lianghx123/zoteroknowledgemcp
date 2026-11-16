import { ParseError } from "../../shared/contracts/parsing";
import type { ParserDefinition } from "../definition";

export const MINERU_NORMALIZER = "mineru-v4-6";
export function minerUOptions(value: Record<string, unknown>): Record<string, unknown> {
  const options = { isOcr: true, enableFormula: true, enableTable: true, language: "ch", ...value };
  if (Object.keys(value).some(key => !["isOcr", "enableFormula", "enableTable", "language"].includes(key))
    || [options.isOcr, options.enableFormula, options.enableTable].some(item => typeof item !== "boolean")
    || typeof options.language !== "string" || !/^[a-zA-Z_]{1,32}$/.test(options.language)) throw new ParseError("config");
  return options;
}
export const minerUDefinition: ParserDefinition = {
  id: "mineru", labelKey: "settings-provider-mineru", helpKey: "settings-mineru-help", adapterKey: "mineru-v4",
  selectionLabelKey: "settings-parser-mineru",
  api: "https://mineru.net/api/v4", model: "vlm", models: ["vlm"], normalizer: MINERU_NORMALIZER,
  normalizeOptions: minerUOptions,
};
