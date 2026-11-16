import { FOLDER_PATH_SEPARATOR } from "../../shared/folder-path";
import { t } from "../../shared/localization";
import type { KnowledgeSnapshot } from "../../shared/contracts/knowledge-library";
import { knowledgeContentState } from "../../shared/knowledge-content-state";
import { parserCatalog } from "../../parsers/catalog";

/** Render source values as text in an accessible native-style field/value list. */
export function renderKnowledgeDetails(doc: Document, snapshot: KnowledgeSnapshot, item: ZoteroItem): { content: HTMLElement; resourceID?: string; indexStatus?: HTMLElement } {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "") => {
    const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
    node.className = className;
    return node;
  };
  const content = element("div", "km-knowledge-info");
  const fields = element("dl", "km-knowledge-fields");
  content.append(fields);
  const field = (label: string, values: string[], muted = false) => {
    const name = element("dt"); name.textContent = label;
    const value = element("dd", muted ? "km-knowledge-muted" : "");
    for (const text of values) { const line = element("div", "km-knowledge-value"); line.textContent = text; value.append(line); }
    fields.append(name, value);
    return value;
  };
  const anchorID = item.parentItemID || item.id;
  const resourceID = snapshot.itemResources.get(anchorID) ?? snapshot.resources.find(resource => resource.itemID === anchorID)?.id;
  const resource = snapshot.resources.find(row => row.id === resourceID);
  const contentState = resource ? knowledgeContentState(snapshot, resource.id) : undefined;
  field(t("status"), [resource ? t(contentState === "parsed" ? "added-parsed" : contentState === "partial" ? "added-partial" : "added") : t("not-added")]);
  if (!resource) return { content };

  const folderPath = (nodeID: string | null): string[] => {
    const names: string[] = [];
    const seen = new Set<string>();
    while (nodeID && !seen.has(nodeID)) {
      seen.add(nodeID);
      const folder = snapshot.folders.find(row => row.id === nodeID);
      if (!folder) break;
      names.unshift(folder.name); nodeID = folder.parentID;
    }
    return names;
  };
  const locations = snapshot.memberships.filter(row => row.resourceID === resource.id).map(membership => {
    const library = snapshot.libraries.find(row => row.id === membership.libraryID);
    return [library?.name ?? t("library"), ...folderPath(membership.nodeID)].join(FOLDER_PATH_SEPARATOR);
  });
  field(t("location"), locations);
  const warning = snapshot.warnings.get(resource.id);
  field(t("metadata"), [warning ? t("metadata-warning", { warning }) : t("synchronized")]);
  const stateLabel = (state: string) => {
    const keys: Record<string, string> = { current: "available", available: "available", pending: "file-not-checked",
      missing: "missing", trashed: "trashed", deleted: "deleted", unavailable: "unavailable" };
    return t(keys[state] ?? "unknown-state");
  };
  field(t("source"), [stateLabel(resource.state)]);
  field(t("record-version"), [String(resource.version)]);
  field(t("updated"), [new Date(resource.modifiedAt).toLocaleString()]);
  const sources = snapshot.sources.filter(row => row.resourceID === resource.id);
  const attachmentLabel = element("dt"); attachmentLabel.textContent = t("attachments");
  const attachments = element("dd", "km-knowledge-attachments");
  for (const source of sources) {
    const entry = element("div", "km-knowledge-attachment");
    const title = element("div", "km-knowledge-attachment-title"); title.textContent = source.title;
    const description = element("div", "km-knowledge-muted");
    description.textContent = `${source.mediaType ?? t("unknown-type")} · ${stateLabel(source.availability)}`;
    entry.append(title, description);
    if (source.parser) {
      const definition = parserCatalog.get(source.parser.provider), parser = element("div", "km-knowledge-parser");
      parser.textContent = `${t("tasks-parser")}: ${definition ? t(definition.labelKey) : source.parser.provider} · ${source.parser.model}`;
      entry.append(parser);
    }
    attachments.append(entry);
  }
  if (!sources.length) { attachments.textContent = t("none"); attachments.classList.add("km-knowledge-muted"); }
  fields.append(attachmentLabel, attachments);
  field(t("content"), [t(contentState === "partial" ? "content-partial" : contentState === "parsed" ? "content-parsed" : "not-parsed")], true);
  const indexStatus = field(t("search-index"), [t("not-created")], true);
  return { content, resourceID: resource.id, indexStatus };
}
