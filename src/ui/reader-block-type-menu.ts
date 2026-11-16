import { t } from "../shared/localization";
import { readerBlockTypes, type ReaderBlockType } from "../shared/contracts/reader-edit";

/** Themed block-type menu outside the editor's clipping and scrolling surface. */
export class ReaderBlockTypeMenu {
  readonly button: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private readonly label: HTMLElement;
  private readonly items = new Map<ReaderBlockType, HTMLButtonElement>();
  private disposed = false;
  private readonly outside = (event: Event) => {
    const node = event.target as Node | null;
    if (node && !this.menu.contains(node) && !this.button.contains(node)) this.close();
  };
  private readonly reposition = (event: Event) => {
    if (event.type === "resize" || !this.menu.contains(event.target as Node | null)) this.close();
  };

  constructor(private readonly doc: Document, private selected: ReaderBlockType,
    private readonly changed: (type: ReaderBlockType) => void) {
    this.button = doc.createElement("button"); this.button.type = "button";
    this.button.className = "km-block-editor-type"; this.button.title = t("reader-edit-type");
    this.button.setAttribute("aria-haspopup", "menu"); this.button.setAttribute("aria-expanded", "false");
    this.label = doc.createElement("span"); this.button.append(this.label);
    this.menu = doc.createElement("div"); this.menu.className = "km-block-type-menu";
    this.menu.id = "knowledgemcp-block-type-menu"; this.menu.hidden = true;
    this.menu.setAttribute("role", "menu"); this.menu.setAttribute("aria-label", t("reader-edit-type"));
    this.button.setAttribute("aria-controls", this.menu.id);
    for (const value of readerBlockTypes) {
      if (["list", "table", "formula", "footnote"].includes(value)) {
        const separator = doc.createElement("div"); separator.className = "km-block-type-separator";
        separator.setAttribute("role", "separator"); this.menu.append(separator);
      }
      const item = doc.createElement("button"); item.type = "button"; item.tabIndex = -1;
      item.dataset.blockType = value; item.setAttribute("role", "menuitemradio");
      const label = doc.createElement("span"); label.textContent = t(`reader-edit-type-${value}`);
      const check = doc.createElement("span"); check.className = "km-block-type-check";
      check.setAttribute("aria-hidden", "true"); item.append(label, check);
      item.addEventListener("click", () => {
        if (this.disposed) return;
        const previous = this.selected; this.selected = value; this.paint(); this.close(true);
        if (previous !== value) this.changed(value);
      });
      this.items.set(value, item); this.menu.append(item);
    }
    this.paint(); this.doc.body.append(this.menu);
    this.menu.style.visibility = "hidden"; this.menu.style.left = "8px"; this.menu.style.top = "8px";
    this.menu.style.maxHeight = `${Math.max(0, doc.defaultView!.innerHeight - 16)}px`;
    this.menu.hidden = false; this.fitWidth(); this.menu.hidden = true;
    this.menu.style.removeProperty("visibility");
    this.button.addEventListener("click", () => this.menu.hidden ? this.open() : this.close(true));
    this.button.addEventListener("keydown", event => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); this.open(); }
    });
    this.menu.addEventListener("pointerdown", event => event.stopPropagation());
    this.menu.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); });
    this.menu.addEventListener("keydown", event => this.keydown(event));
  }

  private paint(): void {
    const label = t(`reader-edit-type-${this.selected}`); this.label.textContent = label;
    this.button.setAttribute("aria-label", `${t("reader-edit-type")}: ${label}`);
    for (const [value, item] of this.items) {
      item.setAttribute("aria-checked", String(value === this.selected));
      item.lastElementChild!.textContent = value === this.selected ? "✓" : "";
    }
  }

  private open(): void {
    if (this.disposed || !this.menu.hidden) return;
    this.menu.hidden = false; this.button.setAttribute("aria-expanded", "true");
    this.fitWidth();
    const win = this.doc.defaultView!, anchor = this.button.getBoundingClientRect();
    const below = Math.max(0, win.innerHeight - anchor.bottom - 14), above = Math.max(0, anchor.top - 14);
    this.menu.style.maxHeight = `${Math.max(0, win.innerHeight - 16)}px`;
    const natural = this.menu.getBoundingClientRect().height;
    const upward = below < natural && above > below;
    this.menu.style.maxHeight = `${upward ? above : below}px`;
    const bounds = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(anchor.left, win.innerWidth - bounds.width - 8))}px`;
    this.menu.style.top = `${Math.max(8, upward ? anchor.top - bounds.height - 6 : anchor.bottom + 6)}px`;
    this.focus(this.items.get(this.selected)!);
    this.doc.addEventListener("pointerdown", this.outside, true);
    this.doc.addEventListener("focusin", this.outside, true);
    this.doc.addEventListener("scroll", this.reposition, true);
    win.addEventListener("resize", this.reposition);
  }

  private fitWidth(): void {
    if (this.menu.style.width) return;
    const width = this.menu.getBoundingClientRect().width;
    if (width > 0) {
      const size = `${Math.min(180, Math.ceil(width) + 2)}px`;
      this.button.style.width = size; this.menu.style.width = size;
    }
  }

  private focus(element: HTMLElement): void {
    const options: FocusOptions = { preventScroll: true };
    element.focus(typeof Components === "undefined" ? options : Components.utils.cloneInto(options, this.doc.defaultView!));
    if (!this.menu.contains(element)) return;
    const bounds = element.getBoundingClientRect(), viewport = this.menu.getBoundingClientRect();
    if (bounds.top < viewport.top + 5) this.menu.scrollTop += bounds.top - viewport.top - 5;
    else if (bounds.bottom > viewport.bottom - 5) this.menu.scrollTop += bounds.bottom - viewport.bottom + 5;
  }

  private keydown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); this.close(true); return; }
    if (event.key === "Tab") { this.close(true); return; }
    const current = this.doc.activeElement?.getAttribute("data-block-type");
    const index = readerBlockTypes.findIndex(value => value === current);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); if (index >= 0) this.items.get(readerBlockTypes[index])?.click(); return;
    }
    const next = event.key === "Home" ? 0 : event.key === "End" ? readerBlockTypes.length - 1
      : event.key === "ArrowDown" ? (index + 1) % readerBlockTypes.length
        : event.key === "ArrowUp" ? (index + readerBlockTypes.length - 1) % readerBlockTypes.length : -1;
    if (next >= 0) { event.preventDefault(); this.focus(this.items.get(readerBlockTypes[next])!); }
  }

  close(restoreFocus = false): void {
    this.menu.hidden = true; this.button.setAttribute("aria-expanded", "false");
    this.doc.removeEventListener("pointerdown", this.outside, true);
    this.doc.removeEventListener("focusin", this.outside, true);
    this.doc.removeEventListener("scroll", this.reposition, true);
    this.doc.defaultView?.removeEventListener("resize", this.reposition);
    if (restoreFocus && !this.disposed) this.focus(this.button);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.close(); this.menu.remove(); this.button.remove();
  }
}
