/** Zotero registers addon/locale/<locale>/*.ftl before plugin startup. */
let localization: Localization | undefined;

/** Use the host's locale negotiation and Fluent formatting, including plural rules. */
export function t(key: string, args?: Record<string, string | number>): string {
  localization ??= new Localization(["knowledgemcp.ftl"], true);
  const id = `knowledgemcp-${key}`;
  const [message] = localization.formatMessagesSync([{ id, args }]);
  // Native XUL messages must only set attributes: a value replaces their children.
  return message?.value ?? message?.attributes?.find(attribute => attribute.name === "label")?.value ?? id;
}
