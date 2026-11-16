import { t } from "../shared/localization";

interface SourceAnchor { element: HTMLElement; start: number; end: number; }

/** One-shot physical-page alignment. Neither scroll surface drives the other continuously. */
export class ReaderPositionSync {
  readonly controls: HTMLElement;
  readonly status: HTMLElement;
  private readonly toPdf: HTMLButtonElement;
  private readonly toMarkdown: HTMLButtonElement;
  private anchors: SourceAnchor[] = [];
  private generation = 0;
  private busy = false;
  private disposed = false;

  constructor(private readonly reader: ZoteroReader, private readonly article: HTMLElement) {
    const doc = article.ownerDocument;
    this.controls = doc.createElement("div"); this.controls.className = "km-reader-sync";
    this.controls.setAttribute("role", "group"); this.controls.setAttribute("aria-label", t("reader-sync"));
    this.status = doc.createElement("span"); this.status.className = "km-reader-status km-reader-sync-status";
    this.status.setAttribute("role", "status");
    const button = (direction: "pdf" | "markdown", arrow: string) => {
      const element = doc.createElement("button"); element.type = "button";
      element.dataset.syncTarget = direction;
      const icon = doc.createElement("span"); icon.textContent = arrow; icon.setAttribute("aria-hidden", "true");
      element.append(icon); element.setAttribute("aria-label", t(direction === "pdf" ? "reader-sync-pdf" : "reader-sync-markdown"));
      element.addEventListener("click", () => { void this.sync(direction); }); return element;
    };
    this.toPdf = button("pdf", "→"); this.toMarkdown = button("markdown", "←");
    this.controls.append(this.toPdf, this.toMarkdown);
    this.controls.addEventListener("pointerdown", event => event.stopPropagation());
    this.controls.addEventListener("pointerenter", () => this.update());
    this.controls.addEventListener("focusin", () => this.update());
    this.update();
  }

  load(): void {
    this.clear();
    this.anchors = Array.from(this.article.querySelectorAll<HTMLElement>("[data-source-page-start]")).flatMap(element => {
      const start = Number(element.dataset.sourcePageStart), end = Number(element.dataset.sourcePageEnd);
      return Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(end) && end >= start ? [{ element, start, end }] : [];
    });
    this.update();
  }

  clear(): void {
    this.generation++; this.anchors = []; this.busy = false;
    this.status.textContent = ""; this.status.classList.remove("km-reader-warning"); this.update();
  }

  private nativeStats() {
    const native = this.reader._internalReader;
    return native?._secondaryView && native._lastView === native._secondaryView ? native._state?.secondaryViewStats : native?._state?.primaryViewStats;
  }

  private pdfPage(): number | null {
    const pageIndex = this.nativeStats()?.pageIndex;
    return Number.isSafeInteger(pageIndex) && pageIndex! >= 0 ? pageIndex! + 1 : null;
  }

  private pageCount(): number | undefined {
    return this.nativeStats()?.pagesCount ?? this.reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument?.numPages;
  }

  private update(): void {
    const mapped = this.anchors.length > 0 && !this.disposed;
    this.toPdf.disabled = !mapped || this.busy || typeof this.reader.navigate !== "function";
    this.toMarkdown.disabled = !mapped || this.busy || this.pdfPage() === null;
    this.controls.title = mapped ? t("reader-sync") : t("reader-sync-no-source");
    this.toPdf.title = !mapped ? t("reader-sync-no-source") : typeof this.reader.navigate !== "function" ? t("reader-sync-unavailable") : t("reader-sync-pdf");
    this.toMarkdown.title = !mapped ? t("reader-sync-no-source") : this.pdfPage() === null ? t("reader-sync-unavailable") : t("reader-sync-markdown");
  }

  private markdownAnchor(): SourceAnchor | undefined {
    const viewport = this.article.getBoundingClientRect();
    const padding = parseFloat(this.article.ownerDocument.defaultView!.getComputedStyle(this.article).paddingTop) || 0;
    const line = viewport.top + padding + 1;
    const visible = this.anchors.filter(anchor => !anchor.element.parentElement?.closest("details:not([open])") && !anchor.element.closest("[hidden]"))
      .map(anchor => ({ anchor, rect: anchor.element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height > 0 && rect.bottom > line && rect.top < viewport.bottom);
    const crossing = visible.filter(({ rect }) => rect.top <= line);
    crossing.sort((a, b) => a.rect.height - b.rect.height);
    visible.sort((a, b) => a.rect.top - b.rect.top);
    return crossing[0]?.anchor ?? visible[0]?.anchor;
  }

  private pageAnchor(page: number): SourceAnchor | undefined {
    const matches = this.anchors.filter(anchor => anchor.start <= page && anchor.end >= page);
    const leaves = matches.filter(anchor => !matches.some(other => other !== anchor && anchor.element.contains(other.element)));
    return leaves.find(anchor => anchor.start === page) ?? leaves[0];
  }

  private async sync(direction: "pdf" | "markdown"): Promise<void> {
    if (this.disposed || this.busy || !this.anchors.length) return;
    const generation = this.generation;
    this.busy = true; this.update(); this.status.classList.remove("km-reader-warning");
    try {
      const page = direction === "pdf" ? this.markdownAnchor()?.start : this.pdfPage();
      const count = this.pageCount();
      if (!page || count !== undefined && (!Number.isSafeInteger(count) || page > count)) throw new Error("source");
      if (direction === "pdf") {
        if (typeof this.reader.navigate !== "function") throw new Error("native");
        await this.reader.navigate({ pageIndex: page - 1 });
      } else {
        const anchor = this.pageAnchor(page); if (!anchor) throw new Error("source");
        for (let element: HTMLElement | null = anchor.element; element && element !== this.article; element = element.parentElement) {
          if (element.matches("details")) (element as HTMLDetailsElement).open = true;
        }
        const rect = anchor.element.getBoundingClientRect(), viewport = this.article.getBoundingClientRect();
        const padding = parseFloat(this.article.ownerDocument.defaultView!.getComputedStyle(this.article).paddingTop) || 0;
        this.article.scrollTop = Math.max(0, this.article.scrollTop + rect.top - viewport.top - padding);
      }
      if (!this.disposed && generation === this.generation) this.status.textContent = t("reader-sync-done", { number: page });
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.status.textContent = error instanceof Error && error.message === "source" ? t("reader-sync-no-match") : t("reader-sync-unavailable");
        this.status.classList.add("km-reader-warning");
      }
    } finally {
      if (!this.disposed && generation === this.generation) { this.busy = false; this.update(); }
    }
  }

  dispose(): void { this.clear(); this.disposed = true; this.controls.remove(); this.status.remove(); }
}
