import type { ParserIdentity, ParserProfile } from "./contracts/parsing";
import { parserDefinition } from "../parsers/catalog";

export function parserProvider(profile: Pick<ParserProfile, "provider">): string {
  return profile.provider ?? "paddleocr";
}
export function defaultParserProfile(provider: string): ParserProfile {
  const definition = parserDefinition(provider);
  return { ...(provider === "paddleocr" ? {} : { provider }), api: definition.api, model: definition.model, key: "", options: definition.normalizeOptions({}) };
}
export function parserIdentity(profile: ParserProfile, name: string): ParserIdentity {
  return { ...(profile.provider ? { provider: profile.provider } : {}), profile: name, api: profile.api, model: profile.model,
    options: profile.options, normalizer: parserDefinition(parserProvider(profile)).normalizer };
}
