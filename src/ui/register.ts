import type { ContentReadService } from "../services/content-read";
import type { ReaderSearchProvider, ReaderSearchResult } from "../shared/contracts/reader-search";
import { ModelError } from "../shared/contracts/retrieval";
import { ReaderSaveError, type ReaderSaveProvider } from "../shared/contracts/reader-edit";
import type { AttachmentMarkdown } from "../shared/contracts/knowledge-content";
import { MarkdownReaderView } from "./views/content-reader";

export class ReaderUI {
  private active = false;
  private readonly searches = new Set<Promise<ReaderSearchResult>>();
  private readonly saves = new Set<Promise<AttachmentMarkdown>>();
  private readonly save: ReaderSaveProvider = request => {
    const pending = this.active && this.saveProvider ? this.saveProvider(request) : Promise.reject(new ReaderSaveError("unavailable"));
    this.saves.add(pending);
    void pending.then(content => {
      this.saves.delete(pending);
      if (this.active) for (const view of this.views.values()) {
        try { view.acceptSaved(content); } catch { Zotero.debug("[ZoteroKnowledgeMCP] Could not refresh a saved reader view."); }
      }
    }, () => this.saves.delete(pending));
    return pending;
  };
  private readonly search: ReaderSearchProvider = (...args) => {
    const pending = this.provider ? this.provider(...args) : Promise.reject(new ModelError("initializing"));
    this.searches.add(pending);
    void pending.then(() => this.searches.delete(pending), () => this.searches.delete(pending));
    return pending;
  };
  private readonly views = new Map<Document, MarkdownReaderView>();
  private readonly renderToolbar = (event: ZoteroReaderEvent) => this.attach(event.reader, event.doc);

  constructor(private readonly pluginID: string,
    private readonly content: ContentReadService, private readonly provider?: ReaderSearchProvider, private readonly saveProvider?: ReaderSaveProvider) {}

  start(): void {
    if (this.active || !Zotero.Reader) return;
    this.active = true;
    Zotero.Reader.registerEventListener("renderToolbar", this.renderToolbar, this.pluginID);
    this.attachExisting();
  }

  attachExisting(): void {
    if (!this.active) return;
    for (const reader of Zotero.Reader?._readers || []) {
      if (reader._iframeWindow) this.attach(reader, reader._iframeWindow.document);
      else void reader._initPromise?.then(() => {
        if (this.active && reader._iframeWindow) this.attach(reader, reader._iframeWindow.document);
      }).catch(error => Zotero.debug(`[ZoteroKnowledgeMCP] Reader initialization failed: ${String(error)}`));
    }
  }

  private attach(reader: ZoteroReader, doc: Document): void {
    if (!this.active || reader._type !== "pdf" || this.views.has(doc)
      || !doc.getElementById("sidebarToggle") || !doc.getElementById("split-view")) return;
    try {
      this.views.set(doc, new MarkdownReaderView(reader, doc, this.content,
        () => this.views.delete(doc), this.search, this.saveProvider ? this.save : undefined));
    } catch (error) {
      Zotero.debug(`[ZoteroKnowledgeMCP] Could not attach Markdown reader: ${String(error)}`);
    }
  }

  unloadWindow(window: Window): void {
    for (const view of [...this.views.values()]) {
      if (view.reader._window === window || view.doc.defaultView?.top === window) view.dispose();
    }
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.searches, ...this.saves]); }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    Zotero.Reader?.unregisterEventListener("renderToolbar", this.renderToolbar);
    for (const view of [...this.views.values()]) view.dispose();
    this.views.clear();
  }
}
