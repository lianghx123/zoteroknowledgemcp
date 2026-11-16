import { t } from "../shared/localization";
import type { AttachmentMarkdown } from "../shared/contracts/knowledge-content";
import type { ReaderContentBlock } from "../shared/contracts/visual-content";
import { ReaderEditorSize } from "./reader-editor-size";
import { renderStructuredContent } from "./rendering/structured-content";
import { ReaderBlockSession, convertReaderBlock, readerBlockType } from "./reader-block-session";
import { ReaderBlockTypeMenu } from "./reader-block-type-menu";
import { ReaderSaveError, type ReaderSaveProvider } from "../shared/contracts/reader-edit";

interface EditableBlock { block: ReaderContentBlock; elements: HTMLElement[]; }
interface ActiveEditor { id: string; card: HTMLElement; input: HTMLTextAreaElement; draft: () => ReaderContentBlock; confirmation: HTMLElement; stopResize: () => void; stopTypeMenu: () => void; }

/** Owns one reader's runtime block drafts and explicit document publication. */
export class ReaderBlockEditor {
  readonly button: HTMLButtonElement;
  readonly undoButton: HTMLButtonElement;
  readonly redoButton: HTMLButtonElement;
  readonly saveButton: HTMLButtonElement;
  readonly documentStatus: HTMLElement;
  private readonly targets = new Map<string, EditableBlock>();
  private readonly drafts = new Map<string, ReaderContentBlock>();
  private session?: ReaderBlockSession;
  private content?: AttachmentMarkdown;
  private active?: ActiveEditor;
  private mode = false;
  private disposed = false;
  private saving = false;
  private sequence = 0;
  get hasChanges(): boolean { return Boolean(this.session?.dirty || this.drafts.size); }
  get currentContent(): AttachmentMarkdown | undefined { return this.session?.snapshot(); }
  private readonly shortcut = (event: KeyboardEvent) => {
    if (this.disposed || this.saving || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const panel = this.article.closest<HTMLElement>(".km-markdown-panel"), target = this.element(event.target);
    if (panel?.hidden || !(panel ?? this.article).contains(target)) return;
    const key = event.key.toLowerCase();
    if (key === "s") { event.preventDefault(); event.stopPropagation(); void this.saveDocument(); }
    else if (!target?.closest("input,textarea,select,[contenteditable=true]") && (key === "z" || key === "y")) {
      event.preventDefault(); event.stopPropagation(); if (key === "y" || event.shiftKey) this.redo(); else this.undo();
    }
  };
  private pointer?: { x: number; y: number };
  private readonly down = (event: PointerEvent) => {
    this.pointer = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
  };
  private readonly click = (event: MouseEvent) => {
    if (!this.mode || event.button !== 0 || event.detail > 1) return;
    const element = this.element(event.target);
    if (element?.closest(".km-block-editor,.km-citation,a,button,input,textarea,select,summary")) return;
    const pointer = this.pointer; this.pointer = undefined;
    if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4) return;
    if (this.article.ownerDocument.defaultView!.getSelection()?.isCollapsed === false) return;
    const id = this.target(event.target);
    if (id) { event.preventDefault(); event.stopPropagation(); this.edit(id); }
  };

  constructor(private readonly article: HTMLElement, private readonly opening: () => void,
    private readonly layout: () => void, private readonly publish?: (content: AttachmentMarkdown, focusID?: string) => void,
    private readonly saveProvider?: ReaderSaveProvider) {
    const doc = article.ownerDocument;
    this.button = this.makeButton("", "reader-edit-toggle", () => this.setMode(!this.mode));
    this.button.className = "km-reader-edit-toggle";
    this.button.setAttribute("aria-pressed", "false"); this.button.disabled = true;
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("width", "18"); svg.setAttribute("height", "18");
    svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m4 12 8.5-8.5a1.8 1.8 0 0 1 2.5 2.5L6.5 14.5 3 16z M11 5l2.5 2.5 M3 17h14");
    path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.3"); path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round"); svg.append(path); this.button.append(svg);
    this.undoButton = this.iconButton("km-reader-undo", "reader-edit-undo", "M7 5 3 9l4 4 M3 9h8a5 5 0 0 1 5 5v2", () => this.undo());
    this.redoButton = this.iconButton("km-reader-redo", "reader-edit-redo", "m13 5 4 4-4 4 M17 9H9a5 5 0 0 0-5 5v2", () => this.redo());
    this.saveButton = this.iconButton("km-reader-save-document", "reader-edit-save-document", "M3 3h12l2 2v12H3z M6 3v5h8V3 M6 17v-6h8v6", () => { void this.saveDocument(); });
    this.documentStatus = doc.createElement("span"); this.documentStatus.className = "km-reader-status km-reader-document-status"; this.documentStatus.setAttribute("role", "status");
    this.updateCommands(); doc.addEventListener("keydown", this.shortcut, true);
    article.addEventListener("pointerdown", this.down, true);
    article.addEventListener("click", this.click, true);
  }

  private element(target: EventTarget | null): Element | null {
    const node = target as Node | null;
    return node?.nodeType === 1 ? node as Element : node?.parentElement ?? null;
  }

  target(target: EventTarget | null): string | undefined {
    const element = this.element(target);
    if (element?.closest(".km-block-editor")) return;
    const id = element?.closest<HTMLElement>("[data-km-edit-block]")?.dataset.kmEditBlock;
    return id && this.targets.has(id) ? id : undefined;
  }

  setContent(content?: AttachmentMarkdown): void {
    this.sequence++;
    this.pause();
    this.drafts.clear();
    this.session = content?.origin === "parse" && content.blocks
      && content.blocks.map(block => block.markdown).join("\n\n") === content.markdown
      && new Set(content.blocks.map(block => block.id)).size === content.blocks.length ? new ReaderBlockSession(content) : undefined;
    this.bind(content);
  }

  bind(content?: AttachmentMarkdown): void {
    this.close();
    for (const target of this.targets.values()) for (const element of target.elements) {
      delete element.dataset.kmEditBlock; delete element.dataset.kmEditDraft;
    }
    this.targets.clear(); this.content = content;
    for (const placeholder of Array.from(this.article.querySelectorAll(".km-block-empty"))) placeholder.remove();
    const blocks = content?.blocks;
    // Empty inserted blocks still need a visible, keyboard-accessible edit target.
    for (const [index, block] of (blocks ?? []).entries()) {
      if (block.markdown.trim() || !this.session) continue;
      const placeholder = this.article.ownerDocument.createElement("div"); placeholder.className = "km-block-empty";
      placeholder.textContent = t("reader-edit-placeholder"); placeholder.tabIndex = 0;
      placeholder.setAttribute("role", "button"); placeholder.dataset.sourceBlockIds = JSON.stringify([block.id]);
      placeholder.addEventListener("click", () => this.edit(block.id));
      placeholder.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.edit(block.id); } });
      const nextIDs = new Set(blocks!.slice(index + 1).map(block => block.id));
      let anchor = Array.from(this.article.querySelectorAll<HTMLElement>("[data-source-block-ids]")).find(element => {
        try { return (JSON.parse(element.dataset.sourceBlockIds!) as string[]).some(id => nextIDs.has(id)); } catch { return false; }
      });
      while (anchor?.parentElement && anchor.parentElement !== this.article) anchor = anchor.parentElement;
      if (anchor) anchor.before(placeholder); else this.article.append(placeholder);
    }
    if (!this.disposed && content?.origin === "parse" && blocks?.length
      && blocks.map(block => block.markdown).join("\n\n") === content.markdown) {
      const candidates = Array.from(this.article.querySelectorAll<HTMLElement>("[data-source-block-ids]"));
      const sources = new Map(candidates.map(element => {
        let ids: string[] = [];
        try { const value: unknown = JSON.parse(element.dataset.sourceBlockIds!); if (Array.isArray(value) && value.every(id => typeof id === "string")) ids = value; } catch { /* Ignore malformed display provenance. */ }
        return [element, ids] as const;
      }));
      for (const block of blocks) {
        if (!readerBlockType(block.type)
          || block.markdown.length > 100000) continue;
        const mapped = candidates.filter(element => sources.get(element)!.includes(block.id));
        // A displayed group can contain several canonical blocks; never guess its edit boundary.
        if (!mapped.length || mapped.some(element => sources.get(element)!.length !== 1)) continue;
        const elements = mapped.filter(element => !mapped.some(parent => parent !== element && parent.contains(element)));
        this.targets.set(block.id, { block, elements });
        for (const element of elements) {
          element.dataset.kmEditBlock = block.id; element.toggleAttribute("data-km-edit-draft", this.drafts.has(block.id));
        }
      }
    }
    this.button.disabled = !this.targets.size;
    this.button.title = t(this.targets.size ? "reader-edit-toggle" : "reader-edit-unavailable");
    this.updateCommands();
  }

  private setMode(enabled: boolean): void {
    if (this.disposed || this.saving || (enabled && !this.targets.size)) return;
    if (enabled) this.opening(); else this.close();
    this.mode = enabled;
    this.article.classList.toggle("km-block-edit-mode", enabled);
    this.button.setAttribute("aria-pressed", String(enabled));
  }

  pause(): void { this.setMode(false); }

  insertAfter(id?: string): void {
    if (this.disposed || this.saving || !this.session) return;
    this.close(); const next = this.session.insertAfter(id);
    if (next) this.emit(next);
  }

  requestDelete(id: string): void {
    if (this.saving) return;
    this.edit(id);
    if (this.active?.id === id) { this.active.confirmation.hidden = false; const button = this.active.confirmation.querySelector<HTMLButtonElement>("button"); if (button) this.focus(button); }
  }

  private emit(focusID?: string): void {
    if (!this.session) return;
    const content = this.session.snapshot();
    if (this.publish) this.publish(content, focusID);
    else {
      this.article.replaceChildren(content.markdown.trim() ? renderStructuredContent(this.article.ownerDocument, content, url => Zotero.launchURL(url)).fragment : this.article.ownerDocument.createDocumentFragment());
      this.bind(content); if (focusID) this.edit(focusID);
    }
  }

  private updateCommands(): void {
    this.undoButton.disabled = this.saving || !(this.session?.canUndo || this.drafts.size);
    this.redoButton.disabled = this.saving || !this.session?.canRedo || this.drafts.size > 0;
    this.saveButton.disabled = this.saving || !this.saveProvider || !this.session?.baseGenerationID || !this.hasChanges;
    this.saveButton.title = this.saving ? t("reader-edit-saving") : !this.hasChanges && this.documentStatus.textContent === t("reader-edit-saved") ? t("reader-edit-saved") : t("reader-edit-save-document");
    this.saveButton.setAttribute("aria-busy", String(this.saving));
    this.button.disabled = this.saving || !this.targets.size;
  }

  private flushDrafts(): void {
    this.close();
    for (const [id, draft] of this.drafts) this.session?.replace(id, draft);
    this.drafts.clear(); this.updateCommands();
  }

  undo(): void {
    if (this.disposed || this.saving || !this.session) return;
    try { this.flushDrafts(); if (this.session.undo()) this.emit(); this.updateCommands(); }
    catch { this.documentError("reader-edit-failed"); }
  }
  redo(): void {
    if (this.disposed || this.saving || !this.session || this.drafts.size) return;
    this.close(); if (this.session.redo()) this.emit(); this.updateCommands();
  }

  async saveDocument(): Promise<void> {
    if (this.disposed || this.saving || !this.session?.baseGenerationID || !this.saveProvider) return;
    const sequence = this.sequence;
    try {
      this.flushDrafts(); if (!this.session.dirty) return;
      const content = this.session.snapshot();
      if (!content.blocks?.length || content.blocks.some(block => !block.markdown.trim())) { this.documentError("reader-edit-save-invalid"); return; }
      this.saving = true; this.updateCommands(); this.documentStatus.classList.remove("km-reader-warning"); this.documentStatus.textContent = t("reader-edit-saving");
      const saved = await this.saveProvider({ attachment: content.attachment, baseGenerationID: this.session.baseGenerationID!, blocks: content.blocks });
      if (this.disposed || sequence !== this.sequence) return;
      this.saving = false; this.setContent(saved); this.publish?.(saved);
      this.documentStatus.textContent = t("reader-edit-saved");
    } catch (error) {
      if (!this.disposed && sequence === this.sequence) this.documentError(error instanceof ReaderSaveError && error.code === "conflict" ? "reader-edit-save-conflict" : "reader-edit-save-failed");
    } finally { this.saving = false; if (!this.disposed) this.updateCommands(); }
  }

  private documentError(key: string): void { this.documentStatus.textContent = t(key); this.documentStatus.classList.add("km-reader-warning"); }

  edit(id: string): void {
    if (this.disposed || this.saving || !this.targets.has(id)) return;
    if (this.active?.id === id) { this.focus(this.active.input); return; }
    this.close(); this.setMode(true);
    const { block, elements } = this.targets.get(id)!;
    let draft = { ...(this.drafts.get(id) ?? block) };
    const doc = this.article.ownerDocument;
    const card = doc.createElement("section"); card.className = "km-block-editor";
    const isActive = () => !this.disposed && !this.saving && this.active?.card === card;
    card.setAttribute("aria-label", t("reader-edit-block"));
    const header = doc.createElement("div"); header.className = "km-block-editor-header";
    const expand = this.makeButton("", "reader-edit-expand", () => {
      if (!isActive()) return;
      type.close();
      sizing.save();
      const expanded = card.classList.toggle("km-block-editor-expanded");
      expand.textContent = t(expanded ? "reader-edit-collapse" : "reader-edit-expand");
      expand.title = expand.textContent; expand.setAttribute("aria-label", expand.textContent);
      expand.setAttribute("aria-expanded", String(expanded)); sizing.fit(); this.layout();
    });
    expand.className = "km-block-editor-expand"; expand.textContent = t("reader-edit-expand");
    expand.setAttribute("aria-expanded", "false");
    const tabs = doc.createElement("div"); tabs.className = "km-block-editor-tabs";
    tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", t("reader-edit-view"));
    const type = new ReaderBlockTypeMenu(doc, readerBlockType(draft.type)!, selected => {
      if (!isActive()) return;
      draft = convertReaderBlock({ ...draft, markdown: input.value }, selected); input.value = draft.markdown; remember();
      if (!preview.hidden) select(true); else sizing.fit();
    });
    const input = doc.createElement("textarea"); input.className = "km-block-editor-input";
    input.id = "knowledgemcp-block-editor-source"; input.spellcheck = false; input.maxLength = 100000;
    input.setAttribute("aria-label", t("reader-edit-source"));
    input.value = draft.markdown;
    input.rows = 1;
    const preview = doc.createElement("div"); preview.className = "km-block-editor-preview"; preview.hidden = true;
    preview.id = "knowledgemcp-block-editor-preview"; preview.setAttribute("role", "tabpanel");
    const sizing = new ReaderEditorSize(this.article, card, input, this.layout);
    const feedback = doc.createElement("span"); feedback.className = "km-reader-status";
    feedback.setAttribute("role", "status");
    const remember = () => {
      feedback.classList.remove("km-reader-warning");
      draft = { ...draft, markdown: input.value };
      this.drafts.delete(id);
      if (draft.markdown !== block.markdown || draft.type !== block.type || draft.label !== block.label) this.drafts.set(id, { ...draft });
      feedback.textContent = t(this.drafts.has(id) ? "reader-edit-draft-kept" : "reader-edit-original");
      for (const element of elements) element.toggleAttribute("data-km-edit-draft", this.drafts.has(id));
      this.updateCommands();
    };
    input.addEventListener("input", () => { if (isActive()) remember(); }); remember();
    const select = (showPreview: boolean) => {
      if (!isActive()) return;
      sizing.save();
      input.hidden = showPreview; preview.hidden = !showPreview;
      sourceTab.setAttribute("aria-selected", String(!showPreview)); previewTab.setAttribute("aria-selected", String(showPreview));
      sourceTab.tabIndex = showPreview ? -1 : 0; previewTab.tabIndex = showPreview ? 0 : -1;
      if (showPreview) {
        preview.replaceChildren();
        try {
          if (!input.value.trim()) preview.textContent = t("reader-edit-empty");
          else {
            const rendered = renderStructuredContent(doc, { ...this.content!, markdown: input.value, blocks: [{ ...draft, markdown: input.value }], visualLinks: [], references: [] }, url => Zotero.launchURL(url));
            for (const element of Array.from(rendered.fragment.querySelectorAll("[id]"))) element.removeAttribute("id");
            preview.append(rendered.fragment);
          }
        } catch { preview.textContent = t("reader-edit-invalid"); }
      } else this.focus(input);
      sizing.fit(); this.layout();
    };
    const sourceTab = this.makeButton(t("reader-edit-source"), "reader-edit-source", () => select(false));
    const previewTab = this.makeButton(t("reader-edit-preview"), "reader-edit-preview", () => select(true));
    for (const [tab, name] of [[sourceTab, "source"], [previewTab, "preview"]] as const) {
      tab.id = `knowledgemcp-block-editor-tab-${name}`; tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", `knowledgemcp-block-editor-${name}`);
      tab.addEventListener("keydown", event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault(); const next = event.key === "End" || (event.key !== "Home" && tab === sourceTab);
          select(next); this.focus(next ? previewTab : sourceTab);
        }
      });
    }
    preview.setAttribute("aria-labelledby", previewTab.id); tabs.append(sourceTab, previewTab);
    sourceTab.setAttribute("aria-selected", "true"); previewTab.setAttribute("aria-selected", "false"); previewTab.tabIndex = -1;
    const note = doc.createElement("span"); note.className = "km-reader-status"; note.textContent = t("reader-edit-session");
    note.id = "knowledgemcp-block-editor-description"; card.setAttribute("aria-describedby", note.id);
    const actions = doc.createElement("div"); actions.className = "km-block-editor-actions";
    const discard = this.makeButton(t("reader-edit-discard"), "reader-edit-discard", () => {
      if (!isActive()) return;
      draft = { ...block }; input.value = block.markdown; this.drafts.delete(id); this.close(); this.focus(this.article);
      if (this.session?.isNew(id) && !block.markdown.trim()) { this.session.cancelInsertion(id); this.emit(); }
      this.updateCommands();
    }); discard.className = "km-block-editor-discard";
    const apply = () => {
      if (!isActive()) return;
      remember();
      try {
        const changed = this.session?.replace(id, draft); this.close(); this.drafts.delete(id);
        if (changed) this.emit(); this.updateCommands(); this.focus(this.article);
      } catch { feedback.textContent = t("reader-edit-failed"); feedback.classList.add("km-reader-warning"); }
    };
    const keep = this.makeButton(t("reader-edit-keep"), "reader-edit-keep", apply);
    keep.className = "km-block-editor-keep"; keep.title = t("reader-edit-session");
    const insert = this.makeButton("+", "reader-edit-insert", () => { if (isActive()) this.insertAfter(id); }); insert.className = "km-block-editor-insert";
    const remove = this.makeButton(t("reader-edit-delete"), "reader-edit-delete", () => { if (isActive()) this.requestDelete(id); }); remove.className = "km-block-editor-delete";
    const confirmation = doc.createElement("div"); confirmation.className = "km-block-delete-confirm"; confirmation.hidden = true;
    const question = doc.createElement("span"); question.textContent = t("reader-edit-delete-confirm");
    const cancelDelete = this.makeButton(t("reader-edit-cancel"), "reader-edit-cancel", () => { if (isActive()) { confirmation.hidden = true; this.focus(input); } });
    const confirmDelete = this.makeButton(t("reader-edit-delete"), "reader-edit-delete", () => {
      if (!isActive()) return;
      this.close(); this.drafts.delete(id); if (this.session?.remove(id)) this.emit(); this.focus(this.article);
    }); confirmDelete.className = "km-block-confirm-delete"; confirmation.append(question, cancelDelete, confirmDelete);
    keep.setAttribute("aria-describedby", note.id); actions.append(discard, keep, insert, remove, expand);
    header.append(tabs, type.button, actions); card.append(header, confirmation, input, preview, note, feedback);
    card.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); apply(); }
      else if (event.key === "Escape") {
        event.preventDefault(); if (!confirmation.hidden) confirmation.hidden = true;
        else { remember(); this.close(); this.focus(this.article); }
      }
    });
    card.addEventListener("contextmenu", event => event.stopPropagation());
    elements[0].before(card); for (const element of elements) element.classList.add("km-block-editor-original");
    this.active = { id, card, input, draft: () => ({ ...draft, markdown: input.value }), confirmation, stopResize: () => sizing.dispose(), stopTypeMenu: () => type.dispose() }; sizing.fit();
    const bounds = card.getBoundingClientRect(), viewport = this.article.getBoundingClientRect();
    const inset = parseFloat(doc.defaultView!.getComputedStyle(card).scrollMarginTop) || 64;
    const top = viewport.top + inset, bottom = viewport.bottom - 12;
    // At the document end, scrollIntoView also scrolls the native reader's ancestors.
    // Clamp naturally within the Markdown viewport instead of moving those ancestors.
    if (bounds.top < top || bounds.height > bottom - top) this.article.scrollTop += bounds.top - top;
    else if (bounds.bottom > bottom) this.article.scrollTop += bounds.bottom - bottom;
    this.focus(input);
    this.layout();
  }

  private focus(element: HTMLElement): void {
    const options: FocusOptions = { preventScroll: true };
    element.focus(typeof Components === "undefined" ? options : Components.utils.cloneInto(options, this.article.ownerDocument.defaultView!));
  }

  private close(): void {
    const active = this.active; if (!active) return;
    this.active = undefined;
    active.stopResize();
    active.stopTypeMenu();
    const target = this.targets.get(active.id);
    if (target) {
      const draft = active.draft();
      if (draft.markdown === target.block.markdown && draft.type === target.block.type && draft.label === target.block.label) this.drafts.delete(active.id);
      else this.drafts.set(active.id, draft);
      for (const element of target.elements) {
        element.classList.remove("km-block-editor-original"); element.toggleAttribute("data-km-edit-draft", this.drafts.has(active.id));
      }
    }
    active.card.remove(); this.layout();
    this.updateCommands();
  }

  private iconButton(className: string, key: string, shape: string, action: () => void): HTMLButtonElement {
    const button = this.makeButton("", key, action); button.className = className;
    const doc = this.article.ownerDocument, svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg"), path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("width", "18"); svg.setAttribute("height", "18"); svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", shape); path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.3");
    path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round"); svg.append(path); button.append(svg); return button;
  }

  private makeButton(label: string, key: string, action: () => void): HTMLButtonElement {
    const button = this.article.ownerDocument.createElement("button");
    button.type = "button"; button.textContent = label; button.title = t(key);
    button.setAttribute("aria-label", t(key)); button.addEventListener("click", action); return button;
  }

  dispose(): void {
    if (this.disposed) return;
    this.setContent(); this.disposed = true;
    this.article.removeEventListener("pointerdown", this.down, true);
    this.article.removeEventListener("click", this.click, true); this.button.remove();
    this.article.ownerDocument.removeEventListener("keydown", this.shortcut, true);
    this.undoButton.remove(); this.redoButton.remove(); this.saveButton.remove(); this.documentStatus.remove();
  }
}
