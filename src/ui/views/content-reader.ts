import { t } from "../../shared/localization";
import { DisposableStore } from "../../core/disposable-store";
import { MarkdownContentError } from "../../schemas/knowledge-content";
import type { ContentReadService } from "../../services/content-read";
import type { AttachmentIdentity, AttachmentMarkdown } from "../../shared/contracts/knowledge-content";
import { renderStructuredContent } from "../rendering/structured-content";
import { CitationPreview } from "../rendering/citation-preview";
import { readerSelection } from "../rendering/reader-text";
import { ReaderSearch } from "../reader-search";
import { ReaderBlockEditor } from "../reader-block-editor";
import type { ReaderSearchProvider } from "../../shared/contracts/reader-search";
import type { ReaderSaveProvider } from "../../shared/contracts/reader-edit";
import { ReaderDepthMenu } from "../reader-depth-menu";
import { ReaderPositionSync } from "../reader-sync";
import { ReaderOutline, type ReaderOutlineTarget } from "../reader-outline";
import { readReaderPreferences, updateReaderPreferences } from "../reader-preferences";
import { nativeCitationHints } from "../../integrations/zotero/citation-evidence";
import readerStyles from "../../../addon/content/ui/markdown-reader.css";

export class MarkdownReaderView {
  readonly button: HTMLButtonElement;
  private readonly resources = new DisposableStore();
  private readonly panel: HTMLElement;
  private readonly article: HTMLElement;
  private readonly contents: HTMLElement;
  private readonly status: HTMLElement;
  private readonly copyStatus: HTMLElement;
  private readonly sync: ReaderPositionSync;
  private copyReady = false;
  private copying = false;
  private copyMenu?: Element & { hidePopup(): void };
  private disposed = false;
  private request = 0;
  private open = false;
  private ratio = 0.5;
  private stopDrag: (() => void) | null = null;
  private citations?: CitationPreview;
  private outline?: ReaderOutline;
  private readonly search: ReaderSearch;
  private readonly editor: ReaderBlockEditor;
  private readonly depthMenu: ReaderDepthMenu;
  private contentsDepth: number;

  constructor(
    readonly reader: ZoteroReader,
    readonly doc: Document,
    private readonly service: ContentReadService,
    private readonly onDispose: () => void,
    searchProvider?: ReaderSearchProvider,
    saveProvider?: ReaderSaveProvider,
  ) {
    const sidebar = doc.getElementById("sidebarToggle");
    const pdf = doc.getElementById("split-view");
    if (!sidebar || !pdf || !doc.defaultView) throw new Error("Unsupported PDF reader layout.");
    const preferences = readReaderPreferences();
    this.contentsDepth = preferences.contentsDepth;

    const makeButton = (label: string, title: string, action: () => void) => {
      const button = doc.createElement("button");
      button.type = "button"; button.textContent = label; button.title = title;
      button.setAttribute("aria-label", title);
      button.addEventListener("click", action);
      return button;
    };
    this.button = makeButton("M", t("reader-toggle"), () => this.toggle());
    this.button.id = "knowledgemcp-markdown-toggle";
    this.button.className = "toolbar-button km-markdown-toggle";
    this.button.setAttribute("aria-pressed", "false");
    this.button.setAttribute("aria-controls", "knowledgemcp-markdown-panel");
    sidebar.after(this.button);

    const stylesheet = doc.createElement("style");
    stylesheet.dataset.knowledgemcp = "markdown-reader";
    stylesheet.textContent = readerStyles;
    doc.head.append(stylesheet);
    this.resources.add(() => stylesheet.remove());

    this.panel = doc.createElement("section");
    this.panel.id = "knowledgemcp-markdown-panel";
    this.panel.className = "km-markdown-panel";
    this.panel.setAttribute("aria-label", t("reader-panel"));
    this.panel.hidden = true;
    this.status = doc.createElement("span"); this.status.className = "km-reader-status";
    this.status.setAttribute("role", "status");

    this.copyStatus = doc.createElement("span"); this.copyStatus.className = "km-reader-status km-reader-copy-status";
    this.copyStatus.setAttribute("role", "status");
    // The native reader's bubbling pointerdown handler cancels default text selection.
    // Keep native selection and focus inside this plugin-owned surface.
    this.panel.addEventListener("pointerdown", event => event.stopPropagation());

    const body = doc.createElement("div"); body.className = "km-reader-body";
    const directory = doc.createElement("aside"); directory.className = "km-contents";
    directory.hidden = !preferences.contentsVisible;
    const heading = doc.createElement("div"); heading.className = "km-contents-heading";
    heading.textContent = t("reader-contents");
    const directoryHeader = doc.createElement("div"); directoryHeader.className = "km-contents-header";
    this.depthMenu = new ReaderDepthMenu(doc, depth => {
      this.contentsDepth = depth;
      this.outline?.setDepth(depth);
      updateReaderPreferences({ contentsDepth: depth });
    });
    directoryHeader.append(heading, this.depthMenu.button);
    this.contents = doc.createElement("nav"); this.contents.setAttribute("aria-label", t("reader-contents-label"));
    directory.append(directoryHeader, this.contents);
    this.article = doc.createElement("article");
    this.article.className = "km-markdown-content"; this.article.tabIndex = 0;
    this.article.addEventListener("contextmenu", event => {
      event.preventDefault(); event.stopPropagation(); this.showCopyMenu(event.screenX, event.screenY, event.target);
    });
    const toolbar = doc.createElement("div"); toolbar.className = "km-reader-toolbar";
    toolbar.setAttribute("role", "group"); toolbar.setAttribute("aria-label", t("reader-toolbar"));
    directory.id = "knowledgemcp-reader-contents";
    const contentsButton = makeButton("", t("reader-contents-label"), () => {
      this.depthMenu.close();
      if (this.search.isOpen) { this.search.close(); if (!directory.hidden) return; }
      directory.hidden = !directory.hidden;
      contentsButton.setAttribute("aria-expanded", String(!directory.hidden));
      updateReaderPreferences({ contentsVisible: !directory.hidden });
      this.outline?.refresh(true);
    });
    const contentsIcon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    contentsIcon.setAttribute("viewBox", "0 0 20 20");
    contentsIcon.setAttribute("width", "18"); contentsIcon.setAttribute("height", "18");
    contentsIcon.setAttribute("aria-hidden", "true"); contentsIcon.setAttribute("focusable", "false");
    const iconPath = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    iconPath.setAttribute("d", "M3 3.5h14v13H3z M7 3.5v13 M10 7h4 M10 10h4 M10 13h4");
    iconPath.setAttribute("fill", "none"); iconPath.setAttribute("stroke", "currentColor");
    iconPath.setAttribute("stroke-width", "1.3"); iconPath.setAttribute("stroke-linejoin", "round");
    iconPath.setAttribute("stroke-linecap", "round");
    contentsIcon.append(iconPath); contentsButton.append(contentsIcon);
    contentsButton.setAttribute("aria-controls", directory.id);
    contentsButton.setAttribute("aria-expanded", String(preferences.contentsVisible));
    let fontSize = preferences.fontSize;
    const setFontSize = (size: number, persist = true) => {
      fontSize = Math.min(23, Math.max(12, size));
      this.article.style.setProperty("--km-reader-font-size", `${fontSize}px`);
      smaller.disabled = fontSize === 12; larger.disabled = fontSize === 23;
      if (persist) updateReaderPreferences({ fontSize });
    };
    const smaller = makeButton("A−", t("reader-font-smaller"), () => setFontSize(fontSize - 1));
    const reset = makeButton("Aa", t("reader-font-reset"), () => setFontSize(15));
    const larger = makeButton("A+", t("reader-font-larger"), () => setFontSize(fontSize + 1));
    setFontSize(fontSize, false);
    const separator = doc.createElement("span"); separator.className = "km-reader-toolbar-separator";
    separator.setAttribute("aria-hidden", "true");
    const top = makeButton("", t("reader-back-top"), () => { this.article.scrollTop = 0; });
    top.className = "km-reader-back-top";
    const topIcon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    topIcon.setAttribute("viewBox", "0 0 20 20");
    topIcon.setAttribute("width", "18"); topIcon.setAttribute("height", "18");
    topIcon.setAttribute("aria-hidden", "true"); topIcon.setAttribute("focusable", "false");
    const topPath = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    topPath.setAttribute("d", "M10 16V4 M5 9l5-5 5 5");
    topPath.setAttribute("fill", "none"); topPath.setAttribute("stroke", "currentColor");
    topPath.setAttribute("stroke-width", "1.4"); topPath.setAttribute("stroke-linecap", "round");
    topPath.setAttribute("stroke-linejoin", "round");
    topIcon.append(topPath); top.append(topIcon);
    this.search = new ReaderSearch(this.article, directory, body, () => {
      if (this.search.isOpen) this.editor?.pause();
      this.depthMenu.close(); this.outline?.refresh(true);
    }, searchProvider);
    this.editor = new ReaderBlockEditor(this.article, () => {
      this.search.close(); this.depthMenu.close();
    }, () => this.outline?.refresh(), (content, focusID) => {
      if (this.disposed || !this.open) return;
      const scroll = this.article.scrollTop;
      this.request++; this.clearCopy(); this.search.close(); this.depthMenu.close();
      this.show(content, true); this.article.scrollTop = scroll;
      if (focusID) this.editor.edit(focusID);
    }, saveProvider);
    toolbar.append(contentsButton, this.search.button, this.editor.button, this.editor.undoButton, this.editor.redoButton, this.editor.saveButton, separator, smaller, reset, larger, top);
    if (doc.defaultView.ResizeObserver) {
      const geometry = new doc.defaultView.ResizeObserver(() => this.panel.style.setProperty("--km-toolbar-height", `${Math.ceil(toolbar.getBoundingClientRect().height)}px`));
      geometry.observe(toolbar); this.resources.add(() => geometry.disconnect());
    }
    body.append(directory, this.article);
    this.sync = new ReaderPositionSync(reader, this.article);

    const divider = doc.createElement("div"); divider.className = "km-reader-divider";
    divider.tabIndex = 0; divider.setAttribute("role", "separator");
    divider.setAttribute("aria-label", t("reader-resize"));
    divider.setAttribute("aria-orientation", "vertical");
    divider.setAttribute("aria-valuemin", "25"); divider.setAttribute("aria-valuemax", "75");
    divider.setAttribute("aria-valuenow", "50");
    const setRatio = (ratio: number, persist = true) => {
      this.ratio = Math.min(0.75, Math.max(0.25, ratio));
      this.doc.body.style.setProperty("--km-markdown-ratio", String(this.ratio));
      divider.setAttribute("aria-valuenow", String(Math.round(this.ratio * 100)));
      if (persist) updateReaderPreferences({ ratio: this.ratio });
    };
    setRatio(preferences.ratio, false);
    divider.addEventListener("keydown", event => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); setRatio(this.ratio + (event.key === "ArrowLeft" ? -0.05 : 0.05));
      }
    });
    divider.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); this.stopDrag?.();
      const initialRatio = this.ratio;
      divider.setPointerCapture?.(event.pointerId);
      const move = (moveEvent: PointerEvent) => {
        const panelRect = this.panel.getBoundingClientRect();
        const pdfRect = pdf.getBoundingClientRect();
        const width = pdfRect.right - panelRect.left;
        if (width > 0) setRatio((moveEvent.clientX - panelRect.left) / width, false);
      };
      const stop = () => {
        doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", stop);
        doc.removeEventListener("pointercancel", stop); this.stopDrag = null;
        if (divider.hasPointerCapture?.(event.pointerId)) divider.releasePointerCapture(event.pointerId);
        if (this.ratio !== initialRatio) updateReaderPreferences({ ratio: this.ratio });
      };
      this.stopDrag = stop;
      doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", stop);
      doc.addEventListener("pointercancel", stop);
    });
    this.panel.append(toolbar, body, this.status, this.copyStatus, this.sync.status, this.editor.documentStatus, divider, this.sync.controls);
    pdf.before(this.panel);
    const unload = () => this.dispose();
    doc.defaultView.addEventListener("unload", unload, { once: true });
    this.resources.add(() => doc.defaultView?.removeEventListener("unload", unload));
    if (preferences.open) this.toggle(true, false);
  }

  toggle(open = !this.open, persist = true): void {
    if (this.disposed) return;
    this.depthMenu.close();
    if (!open) { this.search.close(); this.editor.pause(); }
    this.open = open;
    this.panel.hidden = !open;
    this.doc.body.classList.toggle("knowledgemcp-markdown-open", open);
    this.button.classList.toggle("active", open);
    this.button.setAttribute("aria-pressed", String(open));
    if (persist) updateReaderPreferences({ open });
    if (open && this.editor.hasChanges && this.editor.currentContent) this.show(this.editor.currentContent, true);
    else if (open) void this.load();
    else { this.request++; this.clearCopy(); this.sync.clear(); this.stopDrag?.(); this.citations?.dispose(); this.citations = undefined; this.outline?.dispose(); this.outline = undefined; }
  }

  private clearCopy(): void {
    this.copyReady = false; this.copying = false; this.copyStatus.textContent = "";
    this.copyStatus.classList.remove("km-reader-warning"); this.closeCopyMenu();
  }

  private closeCopyMenu(): void {
    const menu = this.copyMenu; this.copyMenu = undefined;
    menu?.hidePopup(); menu?.remove();
  }

  private showCopyMenu(x: number, y: number, target: EventTarget | null = null): void {
    if (this.disposed || !this.open) return;
    this.closeCopyMenu();
    const doc = this.reader._window?.document as (Document & { createXULElement?(name: string): Element }) | undefined;
    if (!doc?.createXULElement) return;
    const menu = doc.createXULElement("menupopup") as Element & { openPopupAtScreen(x: number, y: number, context: boolean): void; hidePopup(): void };
    menu.setAttribute("data-knowledgemcp", "reader-copy-menu"); this.copyMenu = menu;
    const selection = this.copyReady && !this.copying ? readerSelection(this.article) : null;
    const request = this.request;
    for (const [key, value] of [["reader-copy-text", selection?.text], ["reader-copy-markdown", selection?.markdown]] as const) {
      const item = doc.createXULElement("menuitem"); item.setAttribute("label", t(key));
      item.setAttribute("disabled", String(!value));
      item.addEventListener("command", () => {
        if (!value || this.disposed || !this.open || request !== this.request || !this.copyReady || this.copying) return;
        this.closeCopyMenu(); void this.copy(value);
      }); menu.append(item);
    }
    const blockID = this.copyReady ? this.editor.target(target) : undefined;
    const edit = doc.createXULElement("menuitem"); edit.setAttribute("label", t("reader-edit-context"));
    edit.setAttribute("disabled", String(!blockID));
    edit.addEventListener("command", () => {
      if (!blockID || this.disposed || !this.open || request !== this.request || !this.copyReady) return;
      this.closeCopyMenu(); this.editor.edit(blockID);
    }); menu.append(edit);
    for (const [key, action] of [["reader-edit-insert", () => this.editor.insertAfter(blockID)], ["reader-edit-delete", () => this.editor.requestDelete(blockID!)]] as const) {
      const item = doc.createXULElement("menuitem"); item.setAttribute("label", t(key)); item.setAttribute("disabled", String(!blockID));
      item.addEventListener("command", () => {
        if (!blockID || this.disposed || !this.open || request !== this.request || !this.copyReady) return;
        this.closeCopyMenu(); action();
      }); menu.append(item);
    }
    menu.addEventListener("popuphidden", () => { menu.remove(); if (this.copyMenu === menu) this.copyMenu = undefined; }, { once: true });
    (this.reader._popupset ?? doc.getElementById("mainPopupSet") ?? doc.documentElement).append(menu);
    menu.openPopupAtScreen(x, y, true);
  }

  private async copy(value: string): Promise<void> {
    const request = this.request; this.copying = true;
    this.copyStatus.textContent = "";
    this.copyStatus.classList.remove("km-reader-warning");
    try {
      await this.doc.defaultView!.navigator.clipboard.writeText(value);
      if (!this.disposed && this.open && request === this.request) this.copyStatus.textContent = t("reader-copied");
    } catch {
      if (!this.disposed && this.open && request === this.request) {
        this.copyStatus.textContent = t("reader-copy-failed"); this.copyStatus.classList.add("km-reader-warning");
      }
    } finally {
      if (!this.disposed && request === this.request) this.copying = false;
    }
  }

  private identity(): AttachmentIdentity {
    const item = Zotero.Items.get(this.reader.itemID);
    if (!item || item.attachmentReaderType !== "pdf") throw new MarkdownContentError(t("error-pdf-unavailable"));
    return { libraryID: item.libraryID, itemKey: item.key };
  }

  private message(title: string, detail: string): void {
    this.setDepthOptions(0);
    this.citations?.dispose(); this.citations = undefined;
    this.status.classList.remove("km-reader-warning");
    const heading = this.doc.createElement("h2"); heading.textContent = title;
    const description = this.doc.createElement("p"); description.textContent = detail;
    this.article.replaceChildren(heading, description); this.contents.replaceChildren();
  }

  private show(content: AttachmentMarkdown, sessionPreview = false): void {
    this.outline?.dispose(); this.outline = undefined;
    this.citations?.dispose(); this.citations = undefined;
    const rendered = content.markdown.trim() ? renderStructuredContent(this.doc, content, url => Zotero.launchURL(url))
      : { fragment: this.doc.createDocumentFragment(), headings: [] };
    if (!content.blocks?.length && sessionPreview) {
      const message = this.doc.createElement("p"); message.textContent = t("reader-edit-empty-document");
      const add = this.doc.createElement("button"); add.className = "km-block-add-first"; add.type = "button";
      add.textContent = t("reader-edit-add-first"); add.addEventListener("click", () => this.editor.insertAfter());
      rendered.fragment.append(message, add);
    }
    this.article.replaceChildren(rendered.fragment);
    this.citations = new CitationPreview(this.article, url => Zotero.launchURL(url));
    this.article.dataset.citationEvidence = "local";
    if (content.origin === "parse" && !sessionPreview) {
      const request = this.request;
      this.article.dataset.citationEvidence = "pending";
      void nativeCitationHints(this.reader).then(hints => {
        if (this.disposed || !this.open || request !== this.request) return;
        this.article.dataset.citationEvidence = hints.length ? "pdf" : "local";
        if (!hints.length) return;
        const scroll = this.article.scrollTop;
        this.citations?.dispose(); this.citations = new CitationPreview(this.article, url => Zotero.launchURL(url), hints);
        this.article.scrollTop = scroll;
      }).catch(() => {
        if (!this.disposed && this.open && request === this.request) this.article.dataset.citationEvidence = "local";
      });
    }
    this.article.scrollTop = 0;
    this.contents.replaceChildren();
    const headings = (sessionPreview ? rendered.headings : rendered.headings.slice(1)).filter(heading => !heading.isDocumentTitle);
    const firstLevel = headings.length ? Math.min(...headings.map(heading => heading.level)) : 1;
    const targets: ReaderOutlineTarget[] = [];
    for (const heading of headings) {
      const button = this.doc.createElement("button"); button.type = "button";
      button.textContent = heading.title;
      button.dataset.headingId = heading.id;
      button.style.paddingInlineStart = `${8 + (heading.level - firstLevel) * 12}px`;
      button.addEventListener("click", () => {
        const target = this.article.querySelector<HTMLElement>(`#${heading.id}`);
        for (let parent = target?.parentElement; parent; parent = parent.parentElement) {
          if (parent.matches("details.km-reader-note")) (parent as HTMLDetailsElement).open = true;
        }
        target?.scrollIntoView({ block: "start", behavior: "smooth" });
      });
      this.contents.append(button);
      const target = this.article.querySelector<HTMLElement>(`#${heading.id}`);
      if (target) targets.push({ heading: target, button, level: heading.level });
    }
    if (targets.length) this.outline = new ReaderOutline(this.article, this.contents.parentElement!,
      this.panel.querySelector<HTMLElement>(".km-reader-toolbar")!, targets, this.contentsDepth);
    this.setDepthOptions(this.outline?.maxDepth ?? 0);
    if (!headings.length) this.contents.textContent = t("reader-no-headings");
    this.status.textContent = content.partial ? t("content-partial") : "";
    this.status.classList.toggle("km-reader-warning", !!content.partial);
    this.search.setContent(content.markdown.trim() ? content : undefined);
    if (sessionPreview) this.editor.bind(content); else this.editor.setContent(content);
    this.copyReady = true;
    this.sync.load();
  }

  private setDepthOptions(maximum: number): void {
    this.depthMenu.setOptions(maximum, this.contentsDepth);
  }

  acceptSaved(content: AttachmentMarkdown): void {
    if (this.disposed || !this.open || this.editor.hasChanges) return;
    const identity = this.identity();
    if (identity.libraryID !== content.attachment.libraryID || identity.itemKey !== content.attachment.itemKey) return;
    this.request++; this.show(content);
  }

  private async load(): Promise<void> {
    this.editor.setContent();
    this.search.setContent();
    this.outline?.dispose(); this.outline = undefined;
    this.clearCopy();
    this.sync.clear();
    this.citations?.dispose(); this.citations = undefined;
    const request = ++this.request;
    this.status.classList.remove("km-reader-warning");
    this.status.textContent = t("reader-loading");
    try {
      const content = await this.service.readAttachment(this.identity());
      if (this.disposed || !this.open || request !== this.request) return;
      if (content) this.show(content);
      else {
        this.status.textContent = t("reader-not-processed");
        this.message(t("reader-empty-title"), t("reader-empty-detail"));
      }
    } catch (error) {
      if (this.disposed || !this.open || request !== this.request) return;
      this.status.textContent = t("unavailable");
      this.message(t("reader-load-failed"), error instanceof MarkdownContentError ? error.message : t("reader-unavailable"));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.request++;
    this.clearCopy();
    this.search.dispose();
    this.editor.dispose();
    this.depthMenu.dispose();
    this.sync.dispose();
    this.outline?.dispose(); this.outline = undefined;
    this.citations?.dispose(); this.citations = undefined;
    this.stopDrag?.();
    this.doc.body?.classList.remove("knowledgemcp-markdown-open");
    this.doc.body?.style.removeProperty("--km-markdown-ratio");
    this.panel.remove(); this.button.remove(); this.resources.dispose(); this.onDispose();
  }
}
