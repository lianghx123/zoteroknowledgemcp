import { t } from "../shared/localization";
import { scopes } from "../mcp/contracts";
import { appendSettingsField } from "./settings-fields";

type Token = Awaited<ReturnType<NonNullable<typeof Zotero.__knowledgeMCPAccess>["listTokens"]>>[number];
interface TokenDraft { name: string; libraryIds: string[]; scopes: string[]; expiresInDays: number; }

export async function mountMcpSettings(host: HTMLElement): Promise<() => void> {
  const service = Zotero.__knowledgeMCPAccess;
  if (!service) return () => {};
  const doc = host.ownerDocument;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const section = element("section"); section.id = "km-mcp-settings";
  const drafts = new Map<string, TokenDraft>();
  let disposed = false, busy = false, editing: string | undefined, creating = false, secret = "", secretID: string | undefined;
  let createdPreview: Pick<Token, "id" | "name" | "libraryIds" | "scopes"> | undefined;
  let connectionDraft: { enabled: boolean; port: string } | undefined;
  const date = (value: number) => {
    const node = element("time", new Date(value).toLocaleString());
    node.dateTime = new Date(value).toISOString(); return node;
  };
  const render = async (message = "", focusID?: string) => {
    const [allTokens, libraries] = await Promise.all([service.listTokens(), service.libraries()]);
    if (disposed) return;
    const tokens = allTokens.filter(token => token.revokedAt === null);
    if (secretID && allTokens.some(token => token.id === secretID && token.revokedAt !== null)) { secret = ""; secretID = undefined; createdPreview = undefined; }
    const description = element("p", t("mcp-description")); description.className = "km-settings-description";
    section.replaceChildren(description);
    const status = element("p", message); status.id = "km-mcp-status"; status.setAttribute("role", "status");
    const button = (parent: HTMLElement, key: string, action: () => void) => {
      const control = element("button", t(key)); control.type = "button";
      control.addEventListener("click", () => { if (!disposed && !busy) action(); });
      parent.append(control); return control;
    };
    const copyBlock = (value: string, label: string, id: string) => {
      const block = element("div"), actions = element("div"), feedback = element("span");
      block.className = "km-mcp-copy-block"; block.id = id; actions.className = "km-mcp-copy-actions";
      feedback.setAttribute("role", "status");
      const copy = button(actions, label, () => {
        copy.disabled = true; feedback.textContent = "";
        void (async () => {
          try {
            await doc.defaultView!.navigator.clipboard.writeText(value);
            if (!disposed && block.isConnected) feedback.textContent = t("mcp-text-copied");
          } catch {
            if (!disposed && block.isConnected) feedback.textContent = t("mcp-copy-error");
          } finally {
            if (!disposed && block.isConnected) copy.disabled = false;
          }
        })();
      });
      actions.append(feedback); block.append(element("pre", value), actions); return block;
    };
    const perform = (action: () => Promise<void>, errorKey = "mcp-token-error", feedback = status, control?: HTMLButtonElement) => {
      if (busy || disposed) return;
      busy = true; section.setAttribute("aria-busy", "true");
      const controls = Array.from(section.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button"), node => ({ node, disabled: node.disabled }));
      for (const { node } of controls) node.disabled = true;
      const label = control?.textContent; if (control) control.textContent = t("mcp-saving");
      void action().catch(() => {
        if (!disposed) { status.textContent = t(errorKey); feedback.textContent = t(errorKey); }
      }).finally(() => {
        busy = false; if (disposed) return;
        section.removeAttribute("aria-busy");
        for (const { node, disabled } of controls) if (node.isConnected) node.disabled = disabled;
        if (control?.isConnected) control.textContent = label ?? "";
      });
    };
    const field = (parent: HTMLElement, key: string, type: string, value: string | number | boolean) => {
      const label = element("label", t(key)), input = element("input");
      input.type = type; input.id = `km-${key}`; label.htmlFor = input.id;
      if (type === "checkbox") input.checked = Boolean(value); else input.value = String(value);
      appendSettingsField(parent, label, input); return input;
    };
    const snapshot = service.snapshot(), connection = element("section"), connectionSummary = element("div");
    connection.className = "km-mcp-connection-settings"; connectionSummary.className = "km-mcp-connection-heading";
    connectionSummary.append(element("h3", t("mcp-connection-settings")));
    connection.append(connectionSummary);
    const form = element("form"), fields = element("div"); fields.className = "km-settings-fields"; form.append(fields);
    const enabled = field(fields, "mcp-enabled", "checkbox", connectionDraft?.enabled ?? snapshot.enabled);
    const connectionState = snapshot.error ? "failed" : snapshot.status;
    const state = element("span", t("mcp-inline-state", { state: t(`mcp-${connectionState}`) }));
    state.className = "km-mcp-connection-state"; state.dataset.state = connectionState; state.setAttribute("role", "status");
    const enabledRow = enabled.closest(".km-settings-toggle")!;
    enabledRow.classList.add("km-mcp-enabled-row"); enabledRow.append(state);
    const port = field(fields, "mcp-port", "number", connectionDraft?.port ?? snapshot.port); port.min = "1024"; port.max = "65535";
    const rememberConnection = () => { connectionDraft = { enabled: enabled.checked, port: port.value }; };
    enabled.addEventListener("input", rememberConnection); port.addEventListener("input", rememberConnection);
    appendSettingsField(fields, element("span", t("mcp-endpoint")), copyBlock(snapshot.endpoint, "mcp-copy-address", "km-mcp-address"));
    const connectionActions = element("div"); connectionActions.className = "km-settings-actions"; form.append(connectionActions);
    button(connectionActions, "mcp-apply", () => perform(async () => {
      await service.configure(enabled.checked, Number(port.value)); connectionDraft = undefined; await render();
    }, "mcp-error"));
    form.addEventListener("submit", event => event.preventDefault()); connection.append(form); section.append(connection);

    const toolbar = element("div"), heading = element("h3", t("mcp-tokens"));
    toolbar.className = "km-mcp-token-toolbar"; heading.id = "km-mcp-token-heading"; toolbar.append(heading);
    const createHost = element("div"), list = element("ul"), secretHost = element("div");
    createHost.className = "km-mcp-create-slot"; createHost.id = "km-mcp-create-slot"; createHost.hidden = true;
    list.className = "km-mcp-token-list"; list.setAttribute("aria-labelledby", heading.id);
    secretHost.id = "km-mcp-secret-container";
    let activeEditor: { key: string; close: (discard: boolean) => void } | undefined;
    let confirmation: HTMLElement | undefined;
    const refresh = async (feedback: string, id?: string) => {
      try { await render(feedback, id); }
      catch { if (!disposed) status.textContent = t("mcp-token-refresh-error"); }
    };
    const showSecret = () => {
      secretHost.replaceChildren(); secretHost.remove(); if (!secret || disposed || !secretID) return;
      let owner = Array.from(list.children).find(node => (node as HTMLElement).dataset.tokenId === secretID);
      if (!owner && createdPreview?.id === secretID) {
        // Preserve an acknowledged token's secret if refreshing its full record fails.
        const preview = element("li"); preview.className = "km-mcp-token-entry"; preview.dataset.tokenId = createdPreview.id;
        preview.append(element("h4", createdPreview.name)); list.prepend(preview); owner = preview;
      }
      if (!owner) return;
      owner.append(secretHost); list.hidden = false; section.querySelector("#km-mcp-token-empty")?.remove();
      const label = element("label", t("mcp-secret")), input = element("input");
      secretHost.append(element("p", t("mcp-secret-help")));
      input.id = "km-mcp-secret"; label.htmlFor = input.id; input.type = "password"; input.readOnly = true;
      input.autocomplete = "off"; input.value = secret; appendSettingsField(secretHost, label, input);
      const actions = element("div"); actions.className = "km-settings-actions"; secretHost.append(actions);
      button(actions, "mcp-reveal", () => { input.type = input.type === "password" ? "text" : "password"; });
      button(actions, "mcp-copy", () => perform(async () => {
        await doc.defaultView!.navigator.clipboard.writeText(secret); if (!disposed) status.textContent = t("mcp-copied");
      }));
    };
    const libraryNames = new Map(libraries.map(library => [library.id, library.name]));
    const openEditor = (slot: HTMLElement, trigger: HTMLButtonElement, selected?: Token, summary?: HTMLElement) => {
      activeEditor?.close(false);
      const key = selected?.id ?? "new";
      editing = selected?.id; creating = !selected;
      const draft = drafts.get(key) ?? { name: selected?.name ?? "", libraryIds: selected?.libraryIds ?? [],
        scopes: selected?.scopes ?? scopes.slice(0, 2), expiresInDays: 180 };
      const editor = element("form"), editorFields = element("div"), feedback = element("p");
      const triggerText = trigger.textContent, triggerLabel = trigger.getAttribute("aria-label");
      editor.className = "km-mcp-token-editor"; editorFields.className = "km-settings-fields";
      feedback.className = "km-mcp-editor-feedback"; feedback.setAttribute("role", "status");
      slot.replaceChildren(editor); slot.hidden = false; if (summary) summary.hidden = true;
      trigger.setAttribute("aria-expanded", "true");
      trigger.textContent = t("mcp-cancel"); trigger.setAttribute("aria-label", t("mcp-cancel"));
      if (!selected) editor.append(element("h4", t("mcp-create")));
      editor.append(editorFields);
      const name = field(editorFields, "mcp-name", "text", draft.name); name.maxLength = 200;
      const libraryGroup = element("fieldset"); libraryGroup.append(element("legend", t("mcp-libraries")));
      if (selected?.libraryIds.some(id => !libraryNames.has(id))) libraryGroup.append(element("p", t("mcp-libraries-unavailable-help")));
      const libraryControls = libraries.map(library => {
        const label = element("label"), input = element("input"); label.className = "km-settings-checkbox";
        input.type = "checkbox"; input.name = "library"; input.value = library.id; input.checked = draft.libraryIds.includes(library.id);
        label.append(input, doc.createTextNode(library.name)); libraryGroup.append(label); return input;
      });
      const scopeGroup = element("fieldset"); scopeGroup.append(element("legend", t("mcp-scopes")));
      const scopeControls = scopes.map((scope, index) => {
        const label = element("label"), input = element("input"); label.className = "km-settings-checkbox";
        input.type = "checkbox"; input.name = "scope"; input.value = scope; input.checked = draft.scopes.includes(scope);
        label.append(input, doc.createTextNode(t(`mcp-scope-${index}`))); scopeGroup.append(label); return input;
      });
      const expiry = element("select"), expiryLabel = element("label", t("mcp-expiry"));
      expiry.id = "km-mcp-expiry"; expiryLabel.htmlFor = expiry.id;
      for (const days of [30, 90, 180, 365]) { const option = element("option", t("mcp-days", { days })); option.value = String(days); expiry.append(option); }
      expiry.value = String(draft.expiresInDays);
      if (selected) {
        appendSettingsField(editorFields, element("span", t("mcp-expires-at")), date(selected.expiresAt));
        const help = element("p", t("mcp-expiry-unchanged")); help.className = "km-settings-description"; editorFields.append(help);
      } else appendSettingsField(editorFields, expiryLabel, expiry);
      const choices = element("div"); choices.className = "km-mcp-editor-choices"; choices.append(libraryGroup, scopeGroup); editor.append(choices);
      const readDraft = (): TokenDraft => ({ name: name.value, libraryIds: libraryControls.filter(input => input.checked).map(input => input.value),
        scopes: scopeControls.filter(input => input.checked).map(input => input.value), expiresInDays: Number(expiry.value) });
      const remember = () => drafts.set(key, readDraft());
      editor.addEventListener("input", remember); editor.addEventListener("change", remember);
      const close = (discard: boolean) => {
        if (discard) drafts.delete(key); else remember();
        slot.replaceChildren(); slot.hidden = true; if (summary) summary.hidden = false;
        trigger.textContent = triggerText;
        if (triggerLabel === null) trigger.removeAttribute("aria-label"); else trigger.setAttribute("aria-label", triggerLabel);
        trigger.setAttribute("aria-expanded", "false"); editing = undefined; creating = false; activeEditor = undefined;
      };
      activeEditor = { key, close };
      const actions = element("div"); actions.className = "km-settings-actions"; editor.append(actions, feedback);
      const save = button(actions, selected ? "mcp-save-token" : "mcp-create", () => perform(async () => {
        const input = readDraft();
        let savedID = selected?.id;
        if (selected) await service.updateToken(selected.id, { name: input.name, libraryIds: input.libraryIds, scopes: input.scopes });
        else {
          const created = await service.createToken(input); if (disposed) return;
          savedID = created.id; secret = created.secret; secretID = created.id;
          createdPreview = { id: created.id, name: input.name.trim(), libraryIds: input.libraryIds, scopes: input.scopes }; showSecret();
        }
        if (disposed) return;
        close(true); await refresh(t(selected ? "mcp-token-saved" : "mcp-token-created"), savedID);
      }, "mcp-token-error", feedback, save)); save.dataset.action = "save";
      button(actions, "mcp-cancel", () => { close(true); trigger.focus(); });
      editor.addEventListener("submit", event => { event.preventDefault(); save.click(); });
      editor.addEventListener("keydown", event => {
        if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); close(true); trigger.focus(); }
      });
      name.focus();
    };
    const create = button(toolbar, "mcp-new-token", () => {
      if (activeEditor?.key === "new") { activeEditor.close(true); create.focus(); } else openEditor(createHost, create);
    });
    create.id = "km-mcp-new-token"; create.setAttribute("aria-controls", createHost.id); create.setAttribute("aria-expanded", "false");
    section.append(toolbar, status, createHost, list);
    const showEmpty = () => {
      list.hidden = true;
      if (!section.querySelector("#km-mcp-token-empty")) { const empty = element("p", t("mcp-token-empty")); empty.id = "km-mcp-token-empty"; list.after(empty); }
    };
    const entries = new Map<string, { slot: HTMLElement; edit: HTMLButtonElement; summary: HTMLElement }>();
    for (const token of tokens) {
      const revoked = token.revokedAt !== null, state = revoked ? "mcp-revoked" : token.expiresAt <= Date.now() ? "mcp-expired" : "mcp-active";
      const entry = element("li"), header = element("div"), title = element("div"), name = element("h4", token.name);
      entry.className = "km-mcp-token-entry"; entry.dataset.tokenId = token.id; entry.dataset.state = state;
      header.className = "km-mcp-token-header"; title.className = "km-mcp-token-title";
      name.title = t("mcp-last-used", { time: token.lastUsedAt === null ? t("mcp-never-used") : new Date(token.lastUsedAt).toLocaleString() });
      const badge = element("span", t(state)); badge.className = "km-mcp-token-state"; title.append(name, badge); header.append(title);
      const actions = element("div"); actions.className = "km-mcp-token-actions"; header.append(actions);
      const summary = element("div"), details = element("dl"), metadata = element("dl"), slot = element("div");
      summary.className = "km-mcp-token-summary"; details.className = "km-mcp-token-details"; metadata.className = "km-mcp-token-metadata";
      slot.className = "km-mcp-editor-slot"; slot.id = `km-mcp-editor-${token.id}`; slot.hidden = true;
      const detail = (parent: HTMLElement, label: string, content: HTMLElement) => { const group = element("div"), value = element("dd"); value.append(content); group.append(element("dt", t(label)), value); parent.append(group); };
      const libraryList = element("ul"), scopeList = element("ul");
      for (const id of token.libraryIds) libraryList.append(element("li", libraryNames.get(id) ?? t("mcp-library-unavailable", { id })));
      if (!token.libraryIds.length) libraryList.append(element("li", t("mcp-no-libraries")));
      for (const permission of token.scopes) { const index = scopes.findIndex(scope => scope === permission); scopeList.append(element("li", index < 0 ? permission : t(`mcp-scope-${index}`))); }
      detail(details, "mcp-libraries", libraryList); detail(details, "mcp-scopes", scopeList);
      detail(metadata, "mcp-created-at", date(token.createdAt)); detail(metadata, "mcp-expires-at", date(token.expiresAt));
      summary.append(details, metadata); entry.append(header, summary, slot); list.append(entry);
      if (!revoked) {
        const edit = button(actions, "mcp-edit", () => {
          if (activeEditor?.key === token.id) { activeEditor.close(true); edit.focus(); } else openEditor(slot, edit, token, summary);
        });
        edit.dataset.action = "edit"; edit.setAttribute("aria-label", t("mcp-edit-token", { name: token.name }));
        edit.setAttribute("aria-controls", slot.id); edit.setAttribute("aria-expanded", "false");
        entries.set(token.id, { slot, edit, summary });
        const revoke = button(actions, "mcp-revoke", () => {
          confirmation?.remove(); confirmation = element("div"); confirmation.className = "km-mcp-token-confirmation";
          const controls = element("div"); controls.className = "km-settings-actions";
          confirmation.append(element("p", t("mcp-revoke-confirm", { name: token.name })), controls); entry.append(confirmation);
          const confirm = button(controls, "mcp-revoke", () => perform(async () => {
            await service.revokeToken(token.id); if (disposed) return;
            if (activeEditor?.key === token.id) activeEditor.close(true); drafts.delete(token.id);
            if (secretID === token.id) { secret = ""; secretID = undefined; createdPreview = undefined; showSecret(); }
            entry.remove(); if (!list.children.length) showEmpty();
            confirmation?.remove(); confirmation = undefined; await refresh(t("mcp-token-revoked"));
          })); confirm.dataset.action = "confirm-revoke";
          button(controls, "mcp-revoke-cancel", () => { confirmation?.remove(); confirmation = undefined; revoke.focus(); });
          confirm.focus();
        }); revoke.dataset.action = "revoke"; revoke.setAttribute("aria-label", t("mcp-revoke-token", { name: token.name }));
      }
    }
    if (!tokens.length) showEmpty();
    showSecret();
    const connectionHelp = element("section"); connectionHelp.className = "km-mcp-connect-help"; connectionHelp.append(element("h3", t("mcp-connect")), element("p", t("mcp-connect-help")),
      copyBlock(`codex mcp add zotero-knowledge --url ${snapshot.endpoint} --bearer-token-env-var ZOTERO_KNOWLEDGE_MCP_TOKEN`, "mcp-copy-command", "km-mcp-command")); section.append(connectionHelp);
    if (editing && entries.has(editing)) {
      const target = entries.get(editing)!; openEditor(target.slot, target.edit, tokens.find(token => token.id === editing), target.summary);
    } else if (creating) openEditor(createHost, create);
    else if (focusID) (entries.get(focusID)?.edit ?? create).focus();
  };
  host.append(section);
  try { await render(); } catch { section.replaceChildren(element("p", t("mcp-error"))); }
  return () => { disposed = true; secret = ""; createdPreview = undefined; drafts.clear(); section.remove(); };
}
