import type { ParserDefinition } from "../definition";
import { paddleOCROptions } from "./options";

export const PADDLEOCR_NORMALIZER = "paddleocr-vl-16";

export const paddleOCRDefinition: ParserDefinition = {
  id: "paddleocr", labelKey: "settings-provider-paddleocr", helpKey: "settings-provider-help", adapterKey: "paddleocr-jobs",
  selectionLabelKey: "settings-parser-paddleocr",
  api: "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs", model: "PaddleOCR-VL-1.6", models: ["PaddleOCR-VL-1.6"], normalizer: PADDLEOCR_NORMALIZER,
  normalizeOptions: paddleOCROptions,
};
