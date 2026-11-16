import { recoveryNotice } from "../services/startup-recovery";
import { t } from "../shared/localization";
import { modelProviders } from "../providers/models";
import { ModelError, spaceKey, vectorDimensions, type RetrievalConfig } from "../shared/contracts/retrieval";
import { defaultRetrievalConfig, RetrievalConfigFile, validateRetrievalConfig, type SpaceChangeChoice } from "../services/retrieval-config";
import { ModelCredentials } from "../integrations/zotero/model-credentials";
import { ModelGateway } from "../services/model-gateway";
import { retrievalErrorMessage } from "../shared/retrieval-errors";
import { appendSettingsField, readSettingsScaledNumber } from "./settings-fields";

class SettingsFeedback extends Error {}
type ServiceKind = "embedding" | "rerank";

export async function mountRetrievalSettings(host: HTMLElement): Promise<() => void> {
  const config = new RetrievalConfigFile(); await config.reload();
  let disposed = false, busy = false, dirty = false, draft: RetrievalConfig = JSON.parse(JSON.stringify(config.current));
  const doc = host.ownerDocument, credentials = new ModelCredentials();
  const pendingKeys = new Map<ServiceKind, string>(), tests = new Map<ServiceKind, AbortController>();
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const value = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K]; if (text) value.textContent = text; return value;
  };
  const form = node("form"); form.id = "km-retrieval-settings"; host.append(form);
  const cancelTests = () => { for (const controller of tests.values()) controller.abort(); tests.clear(); };
  const errorText = (error: unknown): string => {
    if (error instanceof SettingsFeedback) return error.message;
    const code = error instanceof ModelError ? error.code : "";
    if (["config-conflict", "credentials-store", "credentials-rollback", "clear-unavailable"].includes(code)) return t(`vector-save-${code}`);
    return t("vector-save-failed");
  };
  let refreshState = () => {};
  const render = (message = "") => {
    cancelTests(); form.replaceChildren();
    const controls = new Map<string, HTMLInputElement | HTMLSelectElement>(), testButtons = new Map<ServiceKind, HTMLButtonElement>(), testStatuses = new Map<ServiceKind, HTMLElement>();
    const keyStatuses = new Map<ServiceKind, HTMLElement>(), savedKeys = new Map<ServiceKind, ReturnType<ModelCredentials["status"]>>(), cancelButtons = new Map<ServiceKind, HTMLButtonElement>();
    for (const kind of ["embedding", "rerank"] as const) savedKeys.set(kind, credentials.status(draft[kind].credentialRef));
    const description = node("p", t("vector-settings-help")); description.className = "km-settings-description"; form.append(description);
    const group = (key: string, help?: string) => {
      const fieldset = node("fieldset"), grid = node("div"); fieldset.append(node("legend", t(key))); grid.className = "km-settings-fields";
      if (help) { const p = node("p", t(help)); p.className = "km-settings-provider-help"; grid.append(p); }
      fieldset.append(grid); form.append(fieldset); return grid;
    };
    const field = (grid: HTMLElement, key: string, value: string | number | boolean, choices?: Array<{ value: string; label: string }>, labelKey = `vector-${key}`) => {
      const label = node("label", t(labelKey)); label.htmlFor = `km-vector-${key}`;
      const input = choices ? node("select") : node("input"); input.id = label.htmlFor;
      if (input instanceof doc.defaultView!.HTMLInputElement) {
        input.type = typeof value === "boolean" ? "checkbox" : typeof value === "number" ? "number" : key.endsWith("-key") ? "password" : "text";
        if (input.type === "checkbox") input.checked = Boolean(value);
        if (input.type === "number") { input.min = "1"; input.step = "1"; }
        if (input.type === "password") input.autocomplete = "new-password";
      }
      if (choices) for (const choice of choices) { const option = node("option", choice.label); option.value = choice.value; input.append(option); }
      input.value = String(value); controls.set(key, input); appendSettingsField(grid, label, input); return input;
    };
    const general = group("vector-settings"), configStatus = node("p"); configStatus.id = "km-vector-config-status"; configStatus.className = "km-settings-provider-help"; configStatus.setAttribute("aria-live", "polite"); general.append(configStatus);
    for (const key of ["enabled", "autoEmbed", "paused"] as const) field(general, key, draft[key]);
    field(general, "dimensions", draft.dimensions, vectorDimensions.map(value => ({ value: String(value), label: String(value) })));
    field(general, "indexMode", draft.indexMode, ["f32", "i8"].map(value => ({ value, label: t(`vector-mode-${value}`) })));
    const modeHelp = node("p", t("vector-mode-help")); modeHelp.className = "km-settings-provider-help"; general.append(modeHelp);
    const threshold = field(general, "relevanceThreshold", draft.relevanceThreshold) as HTMLInputElement;
    threshold.min = "0"; threshold.max = "1"; threshold.step = "0.01";
    const thresholdHelp = node("p", t("vector-threshold-help")); thresholdHelp.className = "km-settings-provider-help"; general.append(thresholdHelp);
    for (const kind of ["embedding", "rerank"] as const) {
      const grid = group(`vector-${kind}`, `vector-${kind}-help`), service = draft[kind];
      const provider = field(grid, `${kind}-provider`, service.provider, modelProviders.list().map(row => ({ value: row.definition.id, label: t(row.definition.labelKey) })));
      field(grid, `${kind}-model`, service.model); field(grid, `${kind}-endpoint`, service.endpoint);
      if (kind === "rerank") field(grid, "shareCredential", draft.shareCredential);
      const input = field(grid, `${kind}-key`, pendingKeys.get(kind) ?? ""), state = node("p"); state.id = `km-vector-${kind}-key-state`; state.className = "km-vector-key-state"; state.setAttribute("aria-live", "polite");
      input.setAttribute("aria-describedby", state.id); input.parentElement!.append(state); keyStatuses.set(kind, state);
      for (const setting of modelProviders.get(service.provider).definition.fields ?? []) field(grid, `${kind}-option-${setting.key}`, service.options?.[setting.key] ?? setting.defaultValue, undefined, setting.labelKey);
      provider.addEventListener("change", () => {
        const selected = provider.value; provider.value = service.provider; collect(); const definition = modelProviders.get(selected).definition;
        draft[kind] = { provider: definition.id, credentialRef: service.credentialRef, model: kind === "embedding" ? definition.embeddingModel : definition.rerankModel,
          endpoint: kind === "embedding" ? definition.embeddingEndpoint : definition.rerankEndpoint,
          options: Object.fromEntries((definition.fields ?? []).map(setting => [setting.key, setting.defaultValue])) }; dirty = true; render(t("vector-unsaved"));
      });
      const row = node("div"), test = node("button", t("vector-test")), cancel = node("button", t("vector-cancel")), status = node("p"); row.className = "km-vector-test-row"; test.type = "button"; test.id = `km-vector-${kind}-test`;
      cancel.type = "button"; cancel.hidden = true; cancel.id = `km-vector-${kind}-test-cancel`; cancelButtons.set(kind, cancel);
      cancel.addEventListener("click", () => { tests.get(kind)?.abort(); tests.delete(kind); test.disabled = false; test.textContent = t("vector-test"); cancel.hidden = true; row.removeAttribute("aria-busy"); status.textContent = t("vector-test-cancelled"); });
      status.id = `km-vector-${kind}-test-status`; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); row.append(test, cancel, status); grid.append(row); testButtons.set(kind, test); testStatuses.set(kind, status);
      test.addEventListener("click", () => { void (async () => {
        tests.get(kind)?.abort(); const controller = new AbortController(); tests.set(kind, controller);
        test.disabled = true; test.textContent = t("vector-testing"); cancel.hidden = false; status.textContent = t("vector-testing-help"); row.setAttribute("aria-busy", "true");
        try {
          collect(); validateService(kind);
          const target = kind === "rerank" && draft.shareCredential ? "embedding" : kind;
          const key = keyFor(target); if (!key) problem(`${target}-key`, t("vector-required"));
          const c: RetrievalConfig = JSON.parse(JSON.stringify(defaultRetrievalConfig)); c[kind] = JSON.parse(JSON.stringify(draft[kind])); c.shareCredential = false;
          if (kind === "embedding") c.dimensions = draft.dimensions;
          c.timeoutMs = 15000;
          validateRetrievalConfig(c); const gateway = new ModelGateway(() => c, () => key, modelProviders, 0);
          if (kind === "embedding") await gateway.embed(["Scientific literature retrieval connection test."], controller.signal, true);
          else await gateway.rerank("scientific research", ["Scientific research methods."], controller.signal);
          if (!disposed && tests.get(kind) === controller) status.textContent = t("vector-test-success");
        } catch (error) {
          if (!disposed && tests.get(kind) === controller) {
            const code = error instanceof ModelError ? error.code : "provider";
            status.textContent = error instanceof SettingsFeedback ? error.message : /^http-\d{3}$/.test(code) ? t("vector-test-http-error", { status: Number(code.slice(5)) })
              : t("vector-test-error", { reason: code === "network" ? t("vector-test-network") : code === "credentials-store" ? t("vector-key-unavailable") : retrievalErrorMessage(code) });
          }
        } finally {
          if (!disposed && tests.get(kind) === controller) { tests.delete(kind); test.disabled = busy; test.textContent = t("vector-test"); cancel.hidden = true; row.removeAttribute("aria-busy"); }
        }
      })(); });
    }
    const limits = group("vector-limits");
    for (const key of ["candidates", "results", "evidence", "concurrency", "batchSize", "timeoutMs", "requestsPerMinute"] as const) {
      const input = field(limits, key, key === "timeoutMs" ? draft[key] / 1000 : draft[key]) as HTMLInputElement;
      if (key === "timeoutMs") { input.min = "1"; input.max = "600"; input.step = "0.001"; }
    }
    const advanced = node("details"); advanced.append(node("summary", t("vector-limits")), limits.parentElement!); form.append(advanced);
    const collect = () => {
      for (const key of ["enabled", "autoEmbed", "paused", "shareCredential"] as const) draft[key] = (controls.get(key) as HTMLInputElement).checked;
      for (const key of ["candidates", "results", "evidence", "concurrency", "batchSize", "timeoutMs", "requestsPerMinute", "relevanceThreshold"] as const) {
        const input = controls.get(key) as HTMLInputElement;
        draft[key] = key === "timeoutMs" ? readSettingsScaledNumber(input, 1000) : Number(input.value);
      }
      draft.dimensions = Number(controls.get("dimensions")!.value) as RetrievalConfig["dimensions"]; draft.indexMode = controls.get("indexMode")!.value as RetrievalConfig["indexMode"];
      for (const kind of ["embedding", "rerank"] as const) {
        for (const key of ["provider", "model", "endpoint"] as const) draft[kind][key] = controls.get(`${kind}-${key}`)!.value.trim();
        pendingKeys.set(kind, controls.get(`${kind}-key`)!.value.trim());
        const fields = modelProviders.get(draft[kind].provider).definition.fields ?? []; draft[kind].options = {};
        for (const setting of fields) { const input = controls.get(`${kind}-option-${setting.key}`) as HTMLInputElement;
          draft[kind].options![setting.key] = setting.type === "boolean" ? input.checked : setting.type === "number" ? Number(input.value) : input.value.trim(); }
      }
    };
    const problem = (key: string, reason: string): never => {
      const input = controls.get(key)!; input.setAttribute("aria-invalid", "true"); const details = input.closest("details"); if (details) details.open = true; input.focus();
      const kind = key.startsWith("embedding-") ? "embedding" : key.startsWith("rerank-") ? "rerank" : undefined;
      throw new SettingsFeedback(t("vector-field-error", { field: kind ? `${t(`vector-${kind}`)} / ${t(`vector-${key}`)}` : t(`vector-${key}`), reason }));
    };
    const keyFor = (kind: ServiceKind) => {
      const value = pendingKeys.get(kind); if (value) return value;
      try { return credentials.get(draft[kind].credentialRef); } catch (error) {
        if (error instanceof ModelError && error.code === "credentials") return "";
        throw new ModelError("credentials-store");
      }
    };
    const validateService = (kind: ServiceKind) => {
      if (!draft[kind].model) problem(`${kind}-model`, t("vector-required"));
      let url: URL; try { url = new URL(draft[kind].endpoint); } catch { return problem(`${kind}-endpoint`, t("vector-url-rule")); }
      if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) problem(`${kind}-endpoint`, t("vector-url-rule"));
    };
    const validate = () => {
      for (const input of controls.values()) input.removeAttribute("aria-invalid");
      validateService("embedding"); validateService("rerank");
      const bounds = { candidates: [1, modelProviders.get(draft.rerank.provider).definition.maxRerankDocuments], results: [1, 200], evidence: [1, 10], concurrency: [1, 8],
        batchSize: [1, modelProviders.get(draft.embedding.provider).definition.maxBatch], timeoutMs: [1000, 600000], requestsPerMinute: [1, 3600] };
      for (const [key, [min, max]] of Object.entries(bounds)) {
        const value = draft[key as keyof typeof bounds];
        if (!Number.isSafeInteger(value) || value < min || value > max) problem(key, key === "timeoutMs"
          ? t("vector-seconds-rule", { min: min / 1000, max: max / 1000 }) : t("vector-number-rule", { min, max }));
      }
      if (draft.candidates < draft.results) problem("candidates", t("vector-candidates-rule", { minimum: draft.results }));
      if (!controls.get("relevanceThreshold")!.value.trim() || !Number.isFinite(draft.relevanceThreshold) || draft.relevanceThreshold < 0 || draft.relevanceThreshold > 1) problem("relevanceThreshold", t("vector-threshold-rule"));
      validateRetrievalConfig(draft);
      if (draft.enabled && !keyFor("embedding")) problem("embedding-key", t("vector-required"));
      if (draft.enabled && !draft.shareCredential && !keyFor("rerank")) problem("rerank-key", t("vector-required"));
    };
    const status = node("p", message || (config.error ? t("vector-save-read-failed") : t("vector-saved-help"))); status.id = "km-vector-save-status"; status.className = "km-vector-feedback"; status.setAttribute("role", "status");
    const actions = node("div"); actions.className = "km-settings-actions km-vector-save-actions";
    const buttons: HTMLButtonElement[] = [], maintenance: HTMLButtonElement[] = [];
    const action = (parent: HTMLElement, key: string, id: string, handler: () => Promise<void>) => {
      const button = node("button", t(key)); button.type = "button"; button.id = id; buttons.push(button); parent.append(button);
      button.addEventListener("click", () => {
        if (busy) return; cancelTests(); busy = true; for (const input of controls.values()) input.disabled = true;
        for (const [kind, test] of testButtons) { test.textContent = t("vector-test"); cancelButtons.get(kind)!.hidden = true; testStatuses.get(kind)!.textContent = ""; test.parentElement!.removeAttribute("aria-busy"); }
        for (const current of [...buttons, ...testButtons.values()]) current.disabled = true;
        status.textContent = t("vector-working"); form.setAttribute("aria-busy", "true");
        void handler().catch(error => { if (!disposed) status.textContent = errorText(error); }).finally(() => {
          busy = false; if (!disposed) { form.removeAttribute("aria-busy"); for (const input of controls.values()) input.disabled = false; for (const current of [...buttons, ...testButtons.values()]) current.disabled = false; refreshState(); form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); }
        });
      }); return button;
    };
    action(actions, "vector-save", "km-vector-save", async () => {
      collect(); validate(); let choice: SpaceChangeChoice | undefined;
      if (spaceKey(draft) !== spaceKey(config.current)) {
        const p = Services.prompt, selected = p.confirmEx(doc.defaultView, t("vector-space-change"), t("vector-space-warning"),
          p.BUTTON_TITLE_IS_STRING * (1 + p.BUTTON_POS_1 + p.BUTTON_POS_2) + p.BUTTON_POS_2_DEFAULT,
          t("vector-keep"), t("vector-clear"), t("vector-cancel"), null, { value: false });
        choice = (["keep", "clear", "cancel"] as const)[selected] ?? "cancel";
        if (choice === "cancel") { status.textContent = t("vector-save-cancelled"); return; }
      }
      const bridge = Zotero.__knowledgeMCPRetrieval, keys = new Map<string, string>();
      for (const kind of ["embedding", "rerank"] as const) { const value = pendingKeys.get(kind); if (value && !(kind === "rerank" && draft.shareCredential)) keys.set(draft[kind].credentialRef, value); }
      await config.save(draft, choice, bridge ? (old, publish) => bridge.clear(old, publish) : undefined, () => credentials.stage(keys));
      draft = JSON.parse(JSON.stringify(config.current)); pendingKeys.clear(); dirty = false;
      if (!disposed) render(t("vector-save-success"));
    });
    action(actions, "vector-reload", "km-vector-reload", async () => {
      await config.reload(); if (config.error) throw new SettingsFeedback(t("vector-save-read-failed"));
      draft = JSON.parse(JSON.stringify(config.current)); pendingKeys.clear(); dirty = false; if (!disposed) render(t("vector-reloaded"));
    });
    form.append(actions, status, node("p", t("vector-reload-help")));
    const repair = node("details"), repairBody = node("div"); repair.className = "km-vector-maintenance"; repair.append(node("summary", t("vector-maintenance")), repairBody); form.append(repair);
    const indexStatus = node("p"); indexStatus.id = "km-vector-index-status"; repairBody.append(indexStatus, node("p", t("vector-index-help")));
    const retryStartup = node("button", t("vector-retry")); retryStartup.type = "button"; retryStartup.hidden = true;
    retryStartup.id = "km-vector-startup-retry"; retryStartup.onclick = () => { Zotero.__knowledgeMCPRetrieval?.retryStartup?.(); refreshState(); }; repairBody.append(retryStartup);
    const maintenanceAction = (key: string, help: string, handler: (bridge: NonNullable<typeof Zotero.__knowledgeMCPRetrieval>) => Promise<void>) => {
      const row = node("div"); row.className = "km-vector-maintenance-row"; repairBody.append(row);
      const button = action(row, key, `km-${key}`, async () => {
        const bridge = Zotero.__knowledgeMCPRetrieval;
        if (dirty || !config.current.enabled || !bridge) throw new SettingsFeedback(t("vector-maintenance-unavailable"));
        await handler(bridge);
        if (!disposed) status.textContent = t(key === "vector-enqueue" ? "vector-queued" : "vector-ready");
      }); maintenance.push(button); row.append(node("p", t(help)));
    };
    maintenanceAction("vector-enqueue", "vector-enqueue-help", bridge => bridge.enqueueAll());
    maintenanceAction("vector-rebuild", "vector-rebuild-help", bridge => bridge.rebuild());
    const updateKeys = () => {
      const shared = (controls.get("shareCredential") as HTMLInputElement).checked;
      (controls.get("rerank-key") as HTMLInputElement).disabled = busy || shared;
      for (const kind of ["embedding", "rerank"] as const) {
        const target = kind === "rerank" && shared ? "embedding" : kind;
        const state = controls.get(`${target}-key`)!.value.trim() ? "pending" : savedKeys.get(target)!;
        keyStatuses.get(kind)!.textContent = kind === "rerank" && shared ? t("vector-key-shared", { state: t(`vector-key-${state}`) }) : t(`vector-key-${state}`);
        (controls.get(`${kind}-key`) as HTMLInputElement).placeholder = t(savedKeys.get(kind) === "saved" ? "vector-key-placeholder" : "vector-key-empty-placeholder");
      }
    };
    refreshState = () => {
      const bridge = Zotero.__knowledgeMCPRetrieval, runtime = bridge?.configuration?.(), state = bridge?.status() ?? "idle";
      const applied = runtime ? runtime.revision === config.current.revision && !runtime.error : false;
      configStatus.textContent = t(config.error || runtime?.error ? "vector-save-read-failed" : !bridge ? "vector-runtime-unavailable" : !applied ? "vector-applying" : !config.current.enabled ? "vector-service-disabled" : config.current.paused ? "vector-service-paused" : "vector-service-enabled");
      const startup = bridge?.startup?.(), notice = recoveryNotice(startup), recovering = Boolean(startup && startup.state !== "ready");
      retryStartup.hidden = startup?.state !== "failed";
      indexStatus.textContent = notice ?? `${t("vector-index-status")}: ${t(`vector-status-${state}`)}`;
      for (const button of maintenance) { button.disabled = busy || dirty || !config.current.enabled || !applied || recovering; button.title = button.disabled ? t("vector-maintenance-unavailable") : ""; }
      updateKeys();
    };
    for (const input of controls.values()) input.addEventListener("input", () => {
      dirty = true; cancelTests(); input.removeAttribute("aria-invalid"); status.textContent = t("vector-unsaved");
      for (const [kind, button] of testButtons) { button.disabled = false; button.textContent = t("vector-test"); cancelButtons.get(kind)!.hidden = true; testStatuses.get(kind)!.textContent = ""; button.parentElement!.removeAttribute("aria-busy"); }
      refreshState();
    });
    form.onsubmit = event => { event.preventDefault(); if (!busy) form.querySelector<HTMLButtonElement>("#km-vector-save")!.click(); };
    refreshState();
  };
  render(); const timer = setInterval(() => { if (!disposed) refreshState(); }, 2000);
  return () => { disposed = true; clearInterval(timer); cancelTests(); form.remove(); void config.close(); };
}
