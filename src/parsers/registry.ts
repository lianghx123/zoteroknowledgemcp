import { ParseError, type ParserIdentity } from "../shared/contracts/parsing";
import { parserProvider } from "../shared/parser-profile";
import type { DocumentParser } from "./contracts";
import { PaddleOCRParser } from "./paddleocr";
import { MinerUParser } from "./mineru";

export class ParserRegistry {
  private readonly parsers = new Map<string, DocumentParser>();
  constructor(parsers: readonly DocumentParser[] = [new PaddleOCRParser(), new MinerUParser()]) {
    for (const parser of parsers) this.register(parser);
  }
  register(parser: DocumentParser): void {
    if (!parser.id || this.parsers.has(parser.id)) throw new ParseError("config");
    this.parsers.set(parser.id, parser);
  }
  resolve(identity: ParserIdentity): DocumentParser {
    const parser = this.parsers.get(parserProvider(identity));
    if (!parser || !parser.normalizers.includes(identity.normalizer)) throw new ParseError("format");
    return parser;
  }
}
