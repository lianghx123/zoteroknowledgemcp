import { t } from "../../shared/localization";
import { KnowledgeUserError } from "../../shared/knowledge-errors";

export interface NativeLibraryProjection {
  localID: number;
  type: "user" | "group";
  externalID: string | null;
  name: string;
  editable: boolean;
  filesEditable: boolean;
}

export interface NativeAttachmentProjection {
  key: string;
  itemID: number;
  parentKey: string | null;
  title: string;
  mediaType: string | null;
  linkMode: number;
  state: "current" | "trashed";
}

export interface NativeItemProjection {
  library: NativeLibraryProjection;
  itemID: number;
  key: string;
  kind: "regular" | "attachment";
  nativeVersion: number;
  modified: string;
  state: "current" | "trashed";
  title: string;
  itemType: string;
  language: string | null;
  abstract: string | null;
  publicationDate: string | null;
  contributors: Array<Record<string, string | number>>;
  fields: Record<string, string>;
  tags: Array<{ tag: string; type: number }>;
  attachments: NativeAttachmentProjection[];
  metadataFingerprint: string;
  fingerprint: string;
}

export interface NativeKnowledgePort {
  uuid(): string;
  hash(text: string): Promise<string>;
  capture(itemID: number): Promise<NativeItemProjection>;
  lookup(libraryID: number, key: string): Promise<ZoteroItem | false | null>;
}

export class NativeLibraryIdentityError extends KnowledgeUserError {}

export class ZoteroKnowledgeItems implements NativeKnowledgePort {
  private crypto(): Crypto {
    const nativeCrypto = Zotero.getMainWindows?.()[0]?.crypto ?? globalThis.crypto;
    if (!nativeCrypto?.subtle) throw new Error("Native cryptography is unavailable.");
    return nativeCrypto;
  }

  uuid(): string { return this.crypto().randomUUID(); }

  async hash(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const hash = await this.crypto().subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
  }

  async lookup(libraryID: number, key: string): Promise<ZoteroItem | false | null> {
    const library = Zotero.Libraries?.get(libraryID);
    if (!library) return null;
    if (!library.getDataLoaded("item")) await library.waitForDataLoad("item");
    return Zotero.Items.getByLibraryAndKeyAsync?.(libraryID, key) ?? null;
  }

  async capture(itemID: number): Promise<NativeItemProjection> {
    let item = await Zotero.Items.getAsync!(itemID);
    if (!item) throw new KnowledgeUserError(t("error-item-unavailable"));
    if (item.parentItemID) item = await Zotero.Items.getAsync!(item.parentItemID);
    if (!item || (!item.isRegularItem() && !item.isAttachment())) throw new KnowledgeUserError(t("error-select-item"));
    const library = Zotero.Libraries!.get(item.libraryID);
    if (!library || !["user", "group"].includes(library.libraryType)) throw new KnowledgeUserError(t("error-source-library"));
    const fields: Record<string, string> = {};
    for (const fieldID of Zotero.ItemFields!.getItemTypeFields(item.itemTypeID)) {
      const name = Zotero.ItemFields!.getName(fieldID);
      if (!name || /^(attachment|note|annotation|relations|collections|path)/i.test(name)) continue;
      const value = item.getField(name);
      if (typeof value === "string" && value) fields[name] = value;
    }
    const orderedFields = Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));
    const contributors = item.isRegularItem() ? item.getCreators().map(creator => {
      const record: Record<string, string | number> = { role: Zotero.CreatorTypes!.getName(creator.creatorTypeID), fieldMode: creator.fieldMode };
      if (creator.fieldMode === 1) record.name = creator.lastName;
      else { record.firstName = creator.firstName; record.lastName = creator.lastName; }
      return record;
    }) : [];
    const tags = item.getTags().map(tag => ({ tag: tag.tag, type: tag.type ?? 0 })).sort((a, b) => a.tag.localeCompare(b.tag) || a.type - b.type);
    const attachmentIDs = item.isAttachment() ? [item.id] : item.getAttachments(true);
    const attachments: NativeAttachmentProjection[] = [];
    for (const attachmentID of attachmentIDs) {
      const attachment = await Zotero.Items.getAsync!(attachmentID);
      if (!attachment || !attachment.isAttachment()) continue;
      attachments.push({ key: attachment.key, itemID: attachment.id, parentKey: item.isRegularItem() ? item.key : null,
        title: String(attachment.getField("title") || "Attachment"), mediaType: attachment.attachmentContentType || null,
        linkMode: attachment.attachmentLinkMode, state: attachment.deleted ? "trashed" : "current" });
    }
    attachments.sort((a, b) => a.key.localeCompare(b.key));
    const title = String(item.getField("title") || `Untitled ${item.itemType}`);
    if (title.length > 1000) throw new KnowledgeUserError(t("error-title-size"));
    const metadata = { title, itemType: item.itemType, language: fields.language || null, abstract: fields.abstractNote || null,
      publicationDate: fields.date || null, contributors, fields: orderedFields, tags };
    const serialized = JSON.stringify(metadata);
    if (new TextEncoder().encode(serialized).length > 1024 * 1024) throw new KnowledgeUserError(t("error-metadata-size"));
    const metadataFingerprint = await this.hash(serialized);
    const state = item.deleted ? "trashed" : "current";
    return {
      ...metadata, library: { localID: library.libraryID, type: library.libraryType as "user" | "group",
        externalID: library.libraryType === "group" ? String(Zotero.Groups!.getGroupIDFromLibraryID(library.libraryID)) : (Zotero.Users?.getCurrentUserID() ? String(Zotero.Users.getCurrentUserID()) : null),
        name: library.name, editable: library.editable, filesEditable: library.filesEditable },
      itemID: item.id, key: item.key, kind: item.isRegularItem() ? "regular" : "attachment",
      nativeVersion: item.version, modified: String(item.getField("dateModified") || ""), state, attachments,
      metadataFingerprint, fingerprint: await this.hash(JSON.stringify({ metadataFingerprint, state, attachments }))
    };
  }
}
