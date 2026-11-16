import { FOLDER_PATH_SEPARATOR } from "../../shared/folder-path";
import type { CollectionSyncBinding, CollectionSyncController, CollectionSyncMode } from "../../shared/contracts/collection-sync";
import type { KnowledgeSnapshot, KnowledgeTarget } from "../../shared/contracts/knowledge-library";
import { t } from "../../shared/localization";

export interface SyncSettingsOptions {
  sync: CollectionSyncController;
  snapshot: KnowledgeSnapshot;
  collectionIDs: number[];
  bindings: readonly CollectionSyncBinding[];
  defaultTarget: KnowledgeTarget;
}

export function mountSyncSettings(window: Window, options: SyncSettingsOptions): void {
  const doc = window.document, host = doc.getElementById("km-sync-settings")!;
  doc.title = t("sync-settings-title");
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
    if (text !== undefined) node.textContent = text; return node;
  };
  const bindingSelect = el("select");
  for (const binding of options.bindings) { const option = el("option", binding.location); option.value = binding.id; bindingSelect.append(option); }
  if (options.collectionIDs.length) { const option = el("option", t("sync-new-link")); option.value = ""; bindingSelect.append(option); }
  const label = (key: string, input: HTMLElement) => { const row = el("label", t(key)); row.style.display = "block"; row.style.marginBlock = "12px"; row.append(el("br"), input); host.append(row); };
  label("sync-relationship", bindingSelect);
  const target = el("select"), targets: KnowledgeTarget[] = [];
  const appendTarget = (name: string, destination: KnowledgeTarget) => { const option = el("option", name); option.value = String(targets.length); targets.push(destination); target.append(option); };
  for (const library of options.snapshot.libraries) {
    appendTarget(library.name, { libraryID: library.id, nodeID: null });
    const visit = (parentID: string | null, prefix: string, seen: Set<string>) => {
      for (const folder of options.snapshot.folders.filter(row => row.libraryID === library.id && row.parentID === parentID)) {
        if (seen.has(folder.id)) continue; seen.add(folder.id);
        const path = `${prefix}${FOLDER_PATH_SEPARATOR}${folder.name}`; appendTarget(path, { libraryID: library.id, nodeID: folder.id }); visit(folder.id, path, seen);
      }
    }; visit(null, library.name, new Set());
  }
  label("sync-destination", target);
  const mode = el("select");
  for (const name of ["mirror", "flexible", "append"] as const) { const option = el("option", t(`sync-mode-${name}`)); option.value = name; mode.append(option); }
  label("sync-mode", mode);
  const description = el("p"); description.style.maxWidth = "480px"; host.append(description);
  const enabled = el("input"); enabled.type = "checkbox"; label("sync-enabled", enabled);
  const reset = el("input"); reset.type = "checkbox"; const resetRow = el("label", t("sync-reset-exclusions")); resetRow.prepend(reset); host.append(resetRow);
  const stop = el("button", t("sync-stop")); stop.type = "button"; stop.style.display = "block"; stop.style.marginTop = "16px"; host.append(stop);
  const status = el("p"); status.setAttribute("role", "status"); host.append(status);
  const refreshDescription = () => { description.textContent = t(`sync-description-${mode.value}`); };
  const render = () => {
    const binding = options.bindings.find(row => row.id === bindingSelect.value), destination = binding?.target ?? options.defaultTarget;
    target.value = String(targets.findIndex(row => row.libraryID === destination.libraryID && row.nodeID === destination.nodeID));
    target.disabled = Boolean(binding); mode.value = binding?.mode ?? "flexible"; enabled.checked = binding?.enabled ?? true;
    enabled.disabled = !binding; reset.checked = false; resetRow.hidden = !binding; stop.hidden = !binding; refreshDescription();
  };
  bindingSelect.addEventListener("change", render); mode.addEventListener("change", refreshDescription); render();
  let busy = false;
  const run = async (action: () => Promise<void>) => {
    if (busy) return; busy = true; status.textContent = t("sync-saving");
    try { await action(); window.close(); }
    catch { if (!window.closed) status.textContent = t("sync-save-failed"); }
    finally { busy = false; }
  };
  doc.addEventListener("dialogaccept", event => {
    event.preventDefault();
    void run(async () => {
      if (bindingSelect.value) await options.sync.configure(bindingSelect.value, mode.value as CollectionSyncMode, enabled.checked, reset.checked);
      else {
        const destination = targets[Number(target.value)]; if (!destination) throw Error("Missing destination");
        await options.sync.link(options.collectionIDs, destination, mode.value as CollectionSyncMode);
      }
    });
  });
  doc.addEventListener("dialogcancel", event => { if (busy) event.preventDefault(); });
  stop.addEventListener("click", () => { void run(() => options.sync.unlink(bindingSelect.value)); });
}
