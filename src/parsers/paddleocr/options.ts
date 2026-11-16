import { ParseError } from "../../shared/contracts/parsing";

/** Matches integration/shared/config/models.py and PaddleOCRClient._options_payload. */
export const defaultPaddleOCROptions: Readonly<Record<string, unknown>> = {
  markdownIgnoreLabels: ["header", "header_image", "footer", "footer_image", "number", "footnote", "aside_text"],
  useDocOrientationClassify: false, useDocUnwarping: false, useLayoutDetection: true,
  useChartRecognition: false, useSealRecognition: false, useOcrForImageBlock: false,
  mergeTables: true, relevelTitles: true, layoutShapeMode: "auto", promptLabel: "ocr",
  repetitionPenalty: 1, temperature: 0, topP: 1, minPixels: 147384, maxPixels: 2822400,
  layoutNms: true, restructurePages: true,
};

export function paddleOCROptions(value: Record<string, unknown>): Record<string, unknown> {
  const options = { ...defaultPaddleOCROptions, ...value };
  for (const key of ["useDocOrientationClassify", "useDocUnwarping", "useLayoutDetection", "useChartRecognition", "useSealRecognition", "useOcrForImageBlock", "mergeTables", "relevelTitles", "layoutNms", "restructurePages"]) {
    if (typeof options[key] !== "boolean") throw new ParseError("config");
  }
  for (const key of ["repetitionPenalty", "temperature", "topP", "minPixels", "maxPixels"]) {
    if (typeof options[key] !== "number" || !Number.isFinite(options[key])) throw new ParseError("config");
  }
  if ((options.repetitionPenalty as number) < 0 || (options.temperature as number) < 0 || (options.topP as number) <= 0 || (options.topP as number) > 1
    || !Number.isSafeInteger(options.minPixels) || !Number.isSafeInteger(options.maxPixels) || (options.minPixels as number) <= 0
    || (options.minPixels as number) > (options.maxPixels as number)) throw new ParseError("config");
  if (!["layoutShapeMode", "promptLabel"].every(key => typeof options[key] === "string")
    || !Array.isArray(options.markdownIgnoreLabels) || !options.markdownIgnoreLabels.every(label => typeof label === "string")) throw new ParseError("config");
  return JSON.parse(JSON.stringify(options)) as Record<string, unknown>;
}
