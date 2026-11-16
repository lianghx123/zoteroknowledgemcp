/** Visible citation labels are source content, not localized interface messages. */
export function referenceEntryElement(doc: Document, number: number, body: DocumentFragment | Node[], originalNumber: number | null = null, numberStyle: "round" | "bracket" = "bracket"): HTMLElement {
  const entry = doc.createElement("div"); entry.className = "km-reference-entry";
  entry.dataset.referenceNumber = String(number);
  if (originalNumber !== null) { entry.dataset.originalReferenceNumber = String(originalNumber); entry.dataset.referenceNumberStyle = numberStyle; }
  const label = doc.createElement("span"); label.className = "km-reference-number"; label.textContent = `[${number}]`;
  const content = doc.createElement("div"); content.className = "km-reference-body";
  if (Array.isArray(body)) content.append(...body); else content.append(body);
  entry.append(label, content); return entry;
}
