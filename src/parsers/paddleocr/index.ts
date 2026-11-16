import { ParseError } from "../../shared/contracts/parsing";
import type { DocumentParser, ParserContext, ParserResult } from "../contracts";
import { PaddleOCRProvider } from "./provider";
import { imageType } from "../assets";
import { rewriteImageSources } from "../image-references";
import { buildCanonicalBlocks, imageReferences, NORMALIZER_VERSION, object, paddlePagesToMarkdown, parsePaddleResult } from "./transform";
import * as legacy from "./legacy-transform";

export type PaddleOCRClient = Pick<PaddleOCRProvider, "submit" | "progress" | "download">;
export class PaddleOCRParser implements DocumentParser {
  readonly id = "paddleocr";
  readonly normalizers = [NORMALIZER_VERSION, "paddleocr-vl-15", "paddleocr-vl-14", "paddleocr-vl-13", "paddleocr-vl-12", "paddleocr-vl-11", "paddleocr-vl-10", "paddleocr-vl-9", "paddleocr-vl-8", "paddleocr-vl-7", "paddleocr-vl-6", "paddleocr-vl-5", "paddleocr-vl-4", "paddleocr-vl-3", "paddleocr-vl-2", legacy.NORMALIZER_VERSION];
  constructor(private readonly client: PaddleOCRClient = new PaddleOCRProvider()) {}
  async process(context: ParserContext): Promise<ParserResult | undefined> {
    const { identity, key, file, limits, signal } = context;
    if (!context.remoteID) {
      await context.submit(async () => ({ remoteID: await this.client.submit(identity, key, file.bytes, file.name, limits.requestTimeoutMs, signal) }));
      return;
    }
    const progress = await this.client.progress(identity, key, context.remoteID, limits.requestTimeoutMs, signal);
    await context.reportProgress(progress);
    if (progress.state === "failed") throw new ParseError("provider");
    if (progress.state !== "done") return;
    const raw = await this.client.download(progress.resultURL!, limits.requestTimeoutMs, limits.maxResultBytes, signal);
    context.assertActive();
    await context.reportPhase?.("organizing");
    let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { throw new ParseError("format"); }
    const legacyRun = identity.normalizer === legacy.NORMALIZER_VERSION;
    const document = (legacyRun ? legacy.parsePaddleResult : parsePaddleResult)(text, progress.total ?? context.expectedPages);
    await context.stage("raw.jsonl", raw, "application/x-ndjson", "raw");
    await context.stage("normalized.json", new TextEncoder().encode(JSON.stringify(document.pages.map(page => page.raw), null, 2)), "application/json", "normalized_json");
    document.pages = JSON.parse(JSON.stringify(document.pages));
    const storedLegacyAssets = new Set<string>();
    for (const [reference, url] of (legacyRun ? legacy.imageReferences : imageReferences)(document)) {
      const bytes = await this.client.download(url, limits.requestTimeoutMs, limits.maxResultBytes, signal), type = imageType(bytes);
      if (legacyRun) {
        const asset = `images/${await context.hash(bytes)}.${type.extension}`;
        if (!storedLegacyAssets.has(asset)) {
          await context.stage(asset, bytes, type.mediaType, "image"); storedLegacyAssets.add(asset);
        }
        for (const block of document.blocks) {
          block.markdown = rewriteImageSources(block.markdown, source => source === url || source === reference ? asset : undefined);
        }
      } else {
        const match = /^(embedded|page|output):(\d+)(?::([\s\S]*))?$/.exec(reference);
        if (!match) throw new ParseError("format");
        const page = document.pages.find(page => page.number === Number(match[2]));
        if (!page) throw new ParseError("page-positions");
        const embedded = match[1] === "embedded", relative = match[3];
        const asset = embedded ? `images/page-${page.number}-${context.artifactCount()}.${type.extension}` : `pages/${page.number}-${context.artifactCount()}.${type.extension}`;
        await context.stage(asset, bytes, type.mediaType, embedded ? "image" : match[1] === "page" ? "page_image" : "output_image", page.number,
          embedded ? { relative_path: relative } : {});
        if (embedded) {
          object(object(page.raw.markdown).images)[relative] = asset;
          const layout = object(page.raw.prunedResult).parsing_res_list;
          if (Array.isArray(layout)) for (const value of layout) {
            const block = object(value);
            if (typeof block.block_content === "string") {
              block.block_content = rewriteImageSources(block.block_content, source => source === url || source === relative ? asset : undefined);
            }
          }
        } else if (match[1] === "page") page.raw.inputImage = asset;
        else object(page.raw.outputImages)[relative] = asset;
      }
    }
    if (legacyRun) document.markdown = document.blocks.map(block => block.markdown).join("\n\n");
    else { document.blocks = buildCanonicalBlocks(document.pages, document.warnings); document.markdown = paddlePagesToMarkdown(document.pages, document.blocks); }
    return { document };
  }
}
