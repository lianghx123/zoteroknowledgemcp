import { readReaderPreferences, updateReaderPreferences } from "./reader-preferences";

/** Auto-fit content; only an explicit native resize changes the shared maximum. */
export class ReaderEditorSize {
  private readonly window: Window & typeof globalThis;
  private readonly mutations: MutationObserver;
  private readonly widthObserver?: ResizeObserver;
  private maximum = readReaderPreferences().editorMaxHeight;
  private lastHeight: string;
  private timer?: number;
  private disposed = false;
  private readonly relayout = () => { this.fit(); this.changed(); };
  private readonly inputChanged = () => { this.save(); this.relayout(); };

  constructor(private readonly article: HTMLElement, private readonly card: HTMLElement,
    private readonly input: HTMLTextAreaElement, private readonly changed: () => void) {
    this.window = article.ownerDocument.defaultView!;
    this.lastHeight = input.style.height;
    this.setMaximum();
    this.mutations = new this.window.MutationObserver(() => {
      if (this.input.style.height === this.lastHeight) return;
      this.window.clearTimeout(this.timer);
      this.timer = this.window.setTimeout(() => { this.save(); this.changed(); }, 350);
    });
    // Gecko cannot read plugin-sandbox dictionaries through the reader's Xrays.
    // Create the WebIDL options in the same realm as its MutationObserver.
    const options: MutationObserverInit = { attributes: true, attributeFilter: ["style"] };
    this.mutations.observe(input, typeof Components === "undefined" ? options : Components.utils.cloneInto(options, this.window));
    const doc = article.ownerDocument;
    doc.addEventListener("pointerup", this.save, true); doc.addEventListener("pointercancel", this.save, true);
    this.window.addEventListener("blur", this.save); this.window.addEventListener("resize", this.relayout);
    input.addEventListener("input", this.inputChanged);
    if (this.window.ResizeObserver) {
      let width = article.getBoundingClientRect().width;
      this.widthObserver = new this.window.ResizeObserver(() => {
        const current = article.getBoundingClientRect().width;
        if (Math.abs(current - width) < .5) return;
        width = current; this.relayout();
      });
      this.widthObserver.observe(article);
    }
  }

  private setMaximum(): void {
    if (this.maximum === null) this.card.style.removeProperty("--km-editor-max-height");
    else this.card.style.setProperty("--km-editor-max-height", `${this.maximum}px`);
  }

  fit(): void {
    if (this.disposed || this.input.hidden || this.card.classList.contains("km-block-editor-expanded")) return;
    const scroll = this.input.scrollTop;
    this.input.style.height = "0px";
    const height = Math.max(64, Math.min(this.input.scrollHeight, this.maximum ?? Infinity, this.window.innerHeight * .6));
    this.input.style.height = `${Math.ceil(height)}px`;
    this.lastHeight = this.input.style.height;
    this.input.scrollTop = scroll;
  }

  readonly save = (): void => {
    this.window.clearTimeout(this.timer); this.timer = undefined;
    if (this.disposed || this.card.classList.contains("km-block-editor-expanded") || this.input.style.height === this.lastHeight
      || !/^\d+(?:\.\d+)?px$/.test(this.input.style.height)) return;
    this.lastHeight = this.input.style.height;
    this.maximum = Math.min(2400, Math.max(64, Math.round(parseFloat(this.lastHeight))));
    this.setMaximum();
    if (readReaderPreferences().editorMaxHeight !== this.maximum) updateReaderPreferences({ editorMaxHeight: this.maximum });
    this.fit();
  };

  dispose(): void {
    if (this.disposed) return;
    this.save(); this.disposed = true; this.mutations.disconnect(); this.widthObserver?.disconnect();
    const doc = this.article.ownerDocument;
    doc.removeEventListener("pointerup", this.save, true); doc.removeEventListener("pointercancel", this.save, true);
    this.window.removeEventListener("blur", this.save); this.window.removeEventListener("resize", this.relayout);
    this.input.removeEventListener("input", this.inputChanged);
  }
}
