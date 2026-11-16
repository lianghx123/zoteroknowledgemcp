import { t } from "../../shared/localization";
import { adaptMethod } from "../../core/method-adapter";
import type { KnowledgeLibraryController } from "../../shared/contracts/knowledge-library";
import type { KnowledgeMainWindow, NativeItemsView } from "./native-types";
import { knowledgeContentState } from "../../shared/knowledge-content-state";

export class KnowledgeTitleStatus {
  private readonly restore: () => void;

  constructor(private readonly window: KnowledgeMainWindow, controller: KnowledgeLibraryController) {
    const view = window.ZoteroPane.itemsView;
    this.restore = adaptMethod(view, "_renderCell", (receiver, native, args) => {
      const cell = Reflect.apply(native, receiver, args) as Element;
      const row = (receiver as NativeItemsView).getRow(args[0] as number);
      if ((args[2] as { dataKey: string }).dataKey !== "title" || !row?.isObjectRow || typeof row.ref.id !== "number") return cell;
      const resourceID = controller.snapshot.itemResources.get(row.ref.id);
      if (!resourceID) return cell;
      const text = cell.querySelector(".cell-text");
      if (!text) return cell;
      const marker = window.document.createElementNS("http://www.w3.org/1999/xhtml", "span");
      marker.className = "km-knowledge-status";
      const warning = controller.snapshot.warnings.get(resourceID);
      const contentState = knowledgeContentState(controller.snapshot, resourceID);
      marker.textContent = warning ? "⚠" : contentState === "parsed" ? "●" : contentState === "partial" ? "◐" : "○";
      marker.setAttribute("aria-hidden", "true");
      marker.setAttribute("title", warning ? t("title-warning", { warning }) : t(contentState === "parsed" ? "added-parsed" : contentState === "partial" ? "added-partial" : "title-added"));
      marker.setAttribute("data-km-original-label", text.getAttribute("aria-label") ?? "");
      text.setAttribute("aria-label", t(contentState === "parsed" ? "title-parsed-accessible" : contentState === "partial" ? "title-partial-accessible" : "title-accessible",
        { title: text.getAttribute("aria-label") || text.textContent || "" }));
      text.before(marker);
      return cell;
    });
    try { view.tree.invalidate(); } catch (error) { this.restore(); throw error; }
  }

  refresh(): void {
    try { if (!this.window.closed) this.window.ZoteroPane?.itemsView?.tree?.invalidate(); }
    catch { Zotero.debug("[ZoteroKnowledgeMCP] Title status refresh skipped for a detached tree."); }
  }

  dispose(): void {
    this.restore();
    for (const marker of Array.from(this.window.document.querySelectorAll(".km-knowledge-status"))) {
      const text = marker.nextElementSibling;
      const original = marker.getAttribute("data-km-original-label");
      if (text?.classList.contains("cell-text")) {
        if (original) text.setAttribute("aria-label", original);
        else text.removeAttribute("aria-label");
      }
      marker.remove();
    }
    this.refresh();
  }
}
