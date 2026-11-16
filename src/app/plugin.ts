import { cleanupFiles } from "../storage/file-cleanup";
import { createServices } from "./create-services";
import { ReaderUI } from "../ui/register";
import { openKnowledgeDatabase, type KnowledgeDatabase } from "../database/client";
import { KnowledgeLibraryService } from "../services/knowledge-library";
import { KnowledgeLibraryUI } from "../ui/knowledge/register";
import { ParsingService } from "../services/parsing";
import { ProcessedContentReader } from "../repositories/processed-content";
import { ZoteroParsingPort } from "../integrations/zotero/parsing-port";
import { t } from "../shared/localization";
import { CollectionSyncRepository } from "../repositories/collection-sync";
import { CollectionSyncService } from "../services/collection-sync";
import { ImportTasksService } from "../services/import-tasks";
import { EmbeddingService } from "../services/embedding";
import { ModelError } from "../shared/contracts/retrieval";
import { RetrievalService } from "../services/retrieval";
import { StartupRecovery } from "../services/startup-recovery";
import { RetrievalUI } from "../ui/knowledge/retrieval";
import { McpService } from "../services/mcp";
import { VisualContentRepository } from "../repositories/visual-content";
import { ReferenceContentRepository } from "../repositories/reference-content";
import { ReaderEditRepository } from "../repositories/reader-edit";
import { ReaderSaveError } from "../shared/contracts/reader-edit";

export interface PluginContext {
  id: string;
  version: string;
  rootURI: string;
}

export class PluginApplication {
  private readonly services = createServices(() => this.database?.db);
  private readonly ui: ReaderUI;
  private database: KnowledgeDatabase | undefined;
  private started = false;
  private knowledge: KnowledgeLibraryService | undefined;
  private knowledgeUI: KnowledgeLibraryUI | undefined;
  private parsing: ParsingService | undefined;
  private preferencesID: string | undefined;
  private sync: CollectionSyncService | undefined;
  private embeddings: EmbeddingService | undefined;
  private retrieval: RetrievalService | undefined;
  private editor: ReaderEditRepository | undefined;
  private recovery: StartupRecovery | undefined;
  private retrievalUI: RetrievalUI | undefined;
  private mcp: McpService | undefined;

  constructor(private readonly context: PluginContext) {
    this.ui = new ReaderUI(context.id, this.services.content, (attachment, generation, query, mode, signal) => {
      if (!this.retrieval) return Promise.reject(new ModelError("initializing"));
      return this.retrieval.searchReader(attachment, generation, query, mode, signal);
    }, async request => {
      const editor = this.editor;
      if (!editor || !this.started) throw new ReaderSaveError("unavailable");
      const content = await editor.save(request);
      try {
        await this.embeddings?.refreshContent(content.generationID!);
      } catch { Zotero.debug("[ZoteroKnowledgeMCP] Saved content; index refresh will retry."); }
      try { await this.knowledge?.refresh(); } catch { Zotero.debug("[ZoteroKnowledgeMCP] Saved content; view refresh will retry."); }
      return content;
    });
  }

  async start(): Promise<void> {
    this.database = await openKnowledgeDatabase();
    await new VisualContentRepository(this.database.db, new ZoteroParsingPort()).backfill();
    await new ReferenceContentRepository(this.database.db, () => new ZoteroParsingPort().uuid()).backfill();
    if (Zotero.Libraries && Zotero.Items.getAsync && Zotero.getMainWindows) {
      this.knowledge = new KnowledgeLibraryService(this.database.db);
      await this.knowledge.start(false);
      this.parsing = new ParsingService(this.database.db, this.knowledge);
      const contentReader = new ProcessedContentReader(this.database.db, new ZoteroParsingPort());
      this.editor = new ReaderEditRepository(this.database.db, new ZoteroParsingPort());
      this.services.content.setProcessedReader(identity => contentReader.read(identity));
      this.embeddings = new EmbeddingService(this.database.db, this.context.rootURI);
      this.sync = new CollectionSyncService(new CollectionSyncRepository(this.database.db), this.knowledge, this.parsing, this.embeddings);
      this.recovery = new StartupRecovery({
        metadata: () => this.knowledge!.refresh(),
        files: () => cleanupFiles(this.database!.db),
        parsing: () => this.parsing!.start(true),
        embedding: () => this.embeddings!.start(false),
        sync: () => this.sync!.start(),
        fulltext: () => this.embeddings!.repository.projectFulltext(),
        index: () => this.embeddings!.restoreIndex(),
      }, () => {
        this.embeddings!.observe(listener => this.knowledge!.subscribe(listener));
        this.embeddings!.resumeBackground();
      });
      this.parsing.beforeWork = () => this.recovery!.waitFor("parsing");
      this.sync.beforeWork = () => this.recovery!.waitFor("sync");
      this.embeddings.beforeWork = () => this.recovery!.waitFor("index");
      this.retrieval = new RetrievalService(this.embeddings, mode => this.recovery!.isRetrievalReady(mode), mode => this.recovery!.unavailable(mode === "fulltext" ? "fulltext" : "index"));
      this.mcp = new McpService(this.database.db, this.retrieval, this.embeddings, () => this.knowledge!.refreshSnapshot());
      await this.mcp.start();
      Zotero.__knowledgeMCPAccess = this.mcp;
      Zotero.__knowledgeMCPRetrieval = {
        clear: async (config, publish) => { await this.embeddings!.clear(config, publish); await cleanupFiles(this.database!.db); },
        enqueueAll: async () => { await this.embeddings!.enqueue(this.knowledge!.snapshot.resources.map(row => row.id)); },
        rebuild: () => this.embeddings!.rebuild(), status: () => this.embeddings!.store.status,
        startup: () => this.recovery!.snapshot(), retryStartup: () => this.recovery!.retry(),
        configuration: () => ({ revision: this.embeddings!.config.current.revision, error: this.embeddings!.config.error }),
      };
      this.knowledge.afterPurge = async () => {
        await this.parsing?.worker.drainDeleted();
        await this.services.flush();
        if (this.database) await cleanupFiles(this.database.db);
        await this.parsing?.refresh();
        await this.embeddings?.refresh();
      };
      this.preferencesID = await Zotero.PreferencePanes?.register({ pluginID: this.context.id, id: "knowledgemcp-settings",
        label: t("settings-title"), src: `${this.context.rootURI}content/settings.xhtml`, image: `${this.context.rootURI}content/ui/knowledge.svg`,
        scripts: [`${this.context.rootURI}content/settings.js`], stylesheets: [`${this.context.rootURI}content/ui/settings.css`] });
      this.knowledgeUI = new KnowledgeLibraryUI(this.context.id, this.context.rootURI, this.knowledge, this.parsing, this.sync, new ImportTasksService(this.parsing, this.sync, this.embeddings, this.recovery), this.embeddings);
      this.knowledgeUI.start();
      this.retrievalUI = new RetrievalUI(this.context.id, this.context.rootURI, this.knowledge, this.retrieval, this.embeddings, this.recovery);
      this.retrievalUI.start();
    }
    this.ui.start();
    this.started = true;
    this.recovery?.schedule(Zotero.uiReadyPromise);
  }
  loadWindow(window?: Window): void {
    if (!this.started) return;
    this.ui.attachExisting();
    if (window) this.knowledgeUI?.loadWindow(window);
    if (window) this.retrievalUI?.loadWindow(window);
  }
  unloadWindow(window: Window): void { this.retrievalUI?.unloadWindow(window); this.knowledgeUI?.unloadWindow(window); this.ui.unloadWindow(window); }
  async dispose(): Promise<void> {
    this.started = false;
    delete Zotero.__knowledgeMCPAccess;
    const stoppingMcp = this.mcp?.close();
    // Signal all producers before waiting for any one of them. The database
    // remains available until their accepted writes and checkpoints drain.
    const recovery = this.recovery?.close();
    const stopping = Promise.allSettled([stoppingMcp, recovery, this.embeddings?.close(), this.sync?.close(), this.parsing?.close()]);
    delete Zotero.__knowledgeMCPRetrieval;
    let retrievalError: unknown;
    try { this.retrievalUI?.dispose(); } catch (error) { retrievalError = error; }
    finally { this.retrieval?.close(); }
    let preferenceError: unknown;
    try {
      if (this.preferencesID) Zotero.PreferencePanes?.unregister(this.preferencesID);
      this.preferencesID = undefined;
    } catch (error) { preferenceError = error; }
    this.services.content.setProcessedReader(undefined);
    const database = this.database;
    try {
      try { this.knowledgeUI?.dispose(); } finally { this.ui.dispose(); }
    }
    finally {
      try {
        try {
          await this.ui.drain();
          const results = await stopping;
          const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failure) throw failure.reason;
        } finally {
          try { await this.knowledge?.close(); } finally { await this.services.dispose(); }
        }
      }
      finally {
        await database?.close();
        if (this.database === database) this.database = undefined;
      }
    }
    if (preferenceError) throw preferenceError;
    if (retrievalError) throw retrievalError;
  }
}
