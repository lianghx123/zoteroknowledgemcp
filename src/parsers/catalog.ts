import { ParseError } from "../shared/contracts/parsing";
import type { ParserDefinition } from "./definition";
import { paddleOCRDefinition } from "./paddleocr/definition";
import { minerUDefinition } from "./mineru/definition";

/** Lightweight provider metadata shared by configuration, identities and settings. */
export const parserCatalog = new Map<string, ParserDefinition>([paddleOCRDefinition, minerUDefinition].map(definition => [definition.id, definition]));
export function parserDefinition(provider: string): ParserDefinition {
  const definition = parserCatalog.get(provider); if (!definition) throw new ParseError("config"); return definition;
}
