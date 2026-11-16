import { RetrievalConfigFile } from "../../src/services/retrieval-config";
import { ModelCredentials } from "../../src/integrations/zotero/model-credentials";
import { modelProviders } from "../../src/providers/models";

/** Developer probes read secrets inside the isolated host, never through Node. */
export async function readLiveModelSettings(
  file: Pick<RetrievalConfigFile, "path" | "reload" | "current" | "error" | "close"> = new RetrievalConfigFile(),
  credentials: Pick<ModelCredentials, "get"> = new ModelCredentials(),
) {
  try {
    if (!await IOUtils.exists(file.path)) throw new Error("configure-plugin-models-first");
    await file.reload();
    if (file.error) throw new Error("plugin-model-settings-unreadable");
    const config = JSON.parse(JSON.stringify(file.current)) as typeof file.current;
    const provider = modelProviders.get("bailian").definition;
    if (config.dimensions !== 768 || config.embedding.provider !== provider.id || config.rerank.provider !== provider.id
      || config.embedding.model !== provider.embeddingModel || config.rerank.model !== provider.rerankModel) {
      throw new Error("bailian-default-models-768-required");
    }
    for (const service of [config.embedding, config.rerank]) {
      const url = new URL(service.endpoint);
      if (url.protocol !== "https:" || url.hostname !== "dashscope.aliyuncs.com"
        || url.username || url.password || url.search || url.hash) throw new Error("bailian-only");
    }
    const embeddingKey = credentials.get(config.embedding.credentialRef);
    const rerankKey = credentials.get(config.shareCredential ? config.embedding.credentialRef : config.rerank.credentialRef);
    return { config, embeddingKey, rerankKey };
  } finally {
    await file.close();
  }
}
