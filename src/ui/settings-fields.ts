/** Keep controls and their labels together across all native settings pages. */
export function appendSettingsField(parent: HTMLElement, label: HTMLElement, control: HTMLElement): HTMLElement {
  const doc = parent.ownerDocument;
  const row = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  row.className = "km-settings-field";
  if (control.getAttribute("type") === "checkbox") {
    const text = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    text.textContent = label.textContent;
    label.className = "km-settings-checkbox";
    label.replaceChildren(control, text);
    row.append(label);
    row.classList.add("km-settings-toggle");
  } else {
    row.append(label);
    if (control.localName === "select") {
      const wrapper = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      wrapper.className = "km-settings-select";
      wrapper.append(control); row.append(wrapper);
    } else row.append(control);
  }
  parent.append(row);
  return row;
}

/** Convert displayed units without losing integer precision on a save/reopen cycle. */
export function readSettingsScaledNumber(input: HTMLInputElement, scale: number): number {
  if (!input.value.trim() || input.validity.badInput || input.validity.stepMismatch) return NaN;
  const value = Number(input.value) * scale;
  return Number.isFinite(value) ? Math.round(value) : NaN;
}
