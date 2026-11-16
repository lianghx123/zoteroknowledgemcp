export interface ParserDefinition {
  id: string;
  labelKey: string;
  selectionLabelKey?: string;
  helpKey: string;
  adapterKey: string;
  api: string;
  model: string;
  models?: readonly string[];
  normalizer: string;
  normalizeOptions(value: Record<string, unknown>): Record<string, unknown>;
}
