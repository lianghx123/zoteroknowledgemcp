import { ParseError } from "../../shared/contracts/parsing";
import type { DocumentParser, ParserContext, ParserResult } from "../contracts";
import { MinerUProvider } from "./provider";
import { MINERU_NORMALIZER } from "./definition";
import { readMinerUArchive } from "./archive";
import { parseMinerUResult, rewriteMinerUImages } from "./transform";
import { imageType } from "../assets";

export interface MinerUCheckpoint { dataID: string; uploadURL?: string; uploadStarted: boolean; uploaded?: boolean; expiresAt?: number }
export type MinerUClient = Pick<MinerUProvider, "allocate" | "upload" | "progress" | "download">;
export class MinerUParser implements DocumentParser {
  readonly id = "mineru";
  readonly normalizers = [MINERU_NORMALIZER, "mineru-v4-5", "mineru-v4-4", "mineru-v4-3", "mineru-v4-2", "mineru-v4-1"];
  constructor(private readonly client: MinerUClient = new MinerUProvider()) {}
  async process(context: ParserContext): Promise<ParserResult | undefined> {
    const { identity, key, file, limits, signal } = context;
    if (file.bytes.length > 200 * 1024 * 1024) throw new ParseError("size");
    if (!context.remoteID) {
      await context.submit(async () => {
        const allocation = await this.client.allocate(identity, key, file.name, context.uuid(), limits.requestTimeoutMs, signal);
        return { remoteID: allocation.batchID, checkpoint: { phase: "submit", mineru: {
          dataID: allocation.dataID, uploadURL: allocation.uploadURL, uploadStarted: false, expiresAt: Date.now() + 24 * 3600000,
        } satisfies MinerUCheckpoint } };
      });
      return;
    }
    const upload = context.checkpoint.mineru as MinerUCheckpoint | undefined;
    if (upload && !upload.uploadStarted) {
      if (!upload.uploadURL || Date.now() >= (upload.expiresAt ?? 0)) throw new ParseError("timeout");
      await context.saveCheckpoint({ mineru: { dataID: upload.dataID, uploadStarted: true } });
      await context.reportPhase?.("uploading");
      context.assertActive();
      await this.client.upload(upload.uploadURL, file.bytes, limits.requestTimeoutMs, signal);
      context.assertActive();
      await context.saveCheckpoint({ phase: "poll", mineru: { dataID: upload.dataID, uploadStarted: true, uploaded: true } });
      await context.reportPhase?.("remote-queue");
      return;
    }
    const progress = await this.client.progress(identity, key, context.remoteID, upload?.dataID, limits.requestTimeoutMs, signal);
    await context.reportProgress(progress);
    if (progress.state === "failed") throw new ParseError("provider");
    if (progress.state !== "done") return;
    const raw = await this.client.download(progress.resultURL!, limits.requestTimeoutMs, limits.maxResultBytes, signal);
    context.assertActive();
    await context.reportPhase?.("organizing");
    const archive = await readMinerUArchive(raw, limits.maxResultBytes, signal);
    const parsed = parseMinerUResult(archive, progress.total ?? context.expectedPages), document = parsed.document;
    await context.stage("raw.zip", raw, "application/zip", "raw");
    await context.stage("normalized.json", new TextEncoder().encode(JSON.stringify(document.pages.map(page => page.raw), null, 2)), "application/json", "normalized_json");
    const imagePaths = new Map<string, string>(), stored = new Set<string>();
    for (const [name, bytes] of archive) if (/\.(png|jpe?g|webp|gif)$/i.test(name)) {
      const type = imageType(bytes), asset = `images/${await context.hash(bytes)}.${type.extension}`;
      if (!stored.has(asset)) { await context.stage(asset, bytes, type.mediaType, "image"); stored.add(asset); }
      imagePaths.set(name, asset);
    }
    rewriteMinerUImages(document, imagePaths);
    return { document, producerVersion: parsed.version, resultSchema: "mineru-content-list" };
  }
}
