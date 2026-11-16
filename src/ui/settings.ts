import { ParsingConfigFile } from "../services/parsing-config";
import type { ParsingConfig } from "../shared/contracts/parsing";
import { defaultParserProfile, parserProvider } from "../shared/parser-profile";
import { parserCatalog, parserDefinition } from "../parsers/catalog";
import { t } from "../shared/localization";
import { mountRetrievalSettings } from "./retrieval-settings";
import { mountMcpSettings } from "./mcp-settings";
import { appendSettingsField, readSettingsScaledNumber } from "./settings-fields";

const megabyte = 1024 * 1024;
const numeric = [
  { key: "concurrency", min: 1, max: 8, scale: 1 },
  { key: "remoteConcurrency", min: 1, max: 32, scale: 1 },
  { key: "pollIntervalMs", min: 500, max: 60000, scale: 1000 },
  { key: "requestTimeoutMs", min: 1000, max: 600000, scale: 1000 },
  { key: "jobTimeoutMs", min: 1000, max: 86400000, scale: 1000 },
  { key: "maxFileBytes", min: 1024, max: 268435456, scale: megabyte },
  { key: "maxResultBytes", min: 1024, max: 268435456, scale: megabyte },
  { key: "maxFailures", min: 1, max: 20, scale: 1 },
] as const;

/** Native settings form. The shared config writer validates and atomically saves. */
export async function mountSettings(host: HTMLElement): Promise<() => void> {
  const config = new ParsingConfigFile();
  await config.reload();
  const readDraft = (): ParsingConfig => {
    const value: ParsingConfig = JSON.parse(JSON.stringify(config.current));
    value.parserProfiles = { ...value.parserProfiles };
    for (const id of parserCatalog.keys()) if (!Object.values(value.profiles).some(profile => parserProvider(profile) === id)) {
      let name = id; while (Object.hasOwn(value.profiles, name)) name += "_2";
      value.profiles[name] = defaultParserProfile(id);
      value.parserProfiles[id] = name;
    }
    return value;
  };
  let draft = readDraft(), disposed = false;
  const doc = host.ownerDocument;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const navigation = element("div");
  navigation.className = "km-settings-navigation";
  navigation.setAttribute("role", "tablist");
  navigation.setAttribute("aria-label", t("settings-navigation"));
  navigation.setAttribute("aria-orientation", "horizontal");
  const pages = ["parsing", "retrieval", "mcp"].map((name, index) => {
    const tab = element("button", t(`settings-tab-${name}`)), panel = element("section");
    tab.type = "button"; tab.id = `km-settings-tab-${name}`;
    tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", `km-settings-panel-${name}`);
    tab.setAttribute("aria-selected", String(index === 0)); tab.tabIndex = index === 0 ? 0 : -1;
    panel.id = `km-settings-panel-${name}`; panel.className = "km-settings-panel";
    panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", tab.id);
    panel.hidden = index !== 0;
    navigation.append(tab);
    return { tab, panel };
  });
  const selectPage = (index: number) => {
    const changed = pages[index].panel.hidden;
    for (const [position, page] of pages.entries()) {
      page.tab.setAttribute("aria-selected", String(position === index));
      page.tab.tabIndex = position === index ? 0 : -1;
      page.panel.hidden = position !== index;
    }
    if (changed) {
      for (let container = host.parentElement; container; container = container.parentElement) {
        if (/^(auto|scroll|overlay)$/.test(doc.defaultView?.getComputedStyle(container).overflowY ?? "")) {
          container.scrollTo({ top: 0, behavior: "instant" });
          break;
        }
      }
    }
  };
  const onClick = (event: MouseEvent) => {
    const index = pages.findIndex(page => page.tab === event.target);
    if (index !== -1) selectPage(index);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const index = pages.findIndex(page => page.tab === event.target);
    if (index === -1 || event.altKey || event.ctrlKey || event.metaKey) return;
    let next: number;
    const direction = doc.defaultView?.getComputedStyle(navigation).direction === "rtl" ? -1 : 1;
    if (event.key === "ArrowRight") next = (index + direction + pages.length) % pages.length;
    else if (event.key === "ArrowLeft") next = (index - direction + pages.length) % pages.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = pages.length - 1;
    else return;
    event.preventDefault(); selectPage(next); pages[next].tab.focus({ preventScroll: true });
  };
  navigation.addEventListener("click", onClick);
  navigation.addEventListener("keydown", onKeyDown);
  host.append(navigation, ...pages.map(page => page.panel));
  const parsingHost = pages[0].panel;
  const render = () => {
    parsingHost.querySelector("#km-parsing-settings")?.remove();
    const form = element("form"), controls = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(); form.id = "km-parsing-settings";
    const description = element("p", t("settings-description")); description.className = "km-settings-description"; form.append(description);
    const section = (title: string) => { const fieldset = element("fieldset"); fieldset.append(element("legend", title));
      const grid = element("div"); grid.className = "km-settings-fields"; fieldset.append(grid); form.append(fieldset); return grid; };
    const field = (grid: HTMLElement, key: string, value: string | number | boolean, type = "text") => {
      const label = element("label", t(`settings-${key}`)), input = element("input");
      input.id = `km-setting-${key}`; label.htmlFor = input.id; input.type = type;
      if (type === "checkbox") input.checked = Boolean(value); else input.value = String(value);
      if (type === "number") { input.min = "1"; input.step = "1"; }
      if (type === "password") input.autocomplete = "off";
      appendSettingsField(grid, label, input); controls.set(key, input); return input;
    };
    const general = section(t("settings-parsing"));
    field(general, "enabled", draft.enabled, "checkbox");
    const profile = draft.profiles[draft.activeProfile];
    const definition = parserDefinition(parserProvider(profile));
    const providerLabel = element("label", t("settings-provider")), provider = element("select");
    provider.id = "km-setting-provider"; providerLabel.htmlFor = provider.id;
    for (const entry of parserCatalog.values()) { const option = element("option", t(entry.selectionLabelKey ?? entry.labelKey)); option.value = entry.id; provider.append(option); }
    provider.value = parserProvider(profile); appendSettingsField(general, providerLabel, provider);
    field(general, "api", profile.api, "url");
    field(general, "key", profile.key, "password");
    const optionsLabel = element("label", t("settings-options")), options = element("textarea"); options.id = "km-setting-options"; optionsLabel.htmlFor = options.id;
    options.value = JSON.stringify(profile.options, null, 2); appendSettingsField(general, optionsLabel, options); controls.set("options", options);
    const help = element("p", t(definition.helpKey));
    help.className = "km-settings-provider-help"; general.append(help);
    const advanced = section(t("settings-limits"));
    for (const { key, min, max, scale } of numeric) {
      const input = field(advanced, key, draft[key] / scale, "number");
      input.min = String(min / scale); input.max = String(max / scale);
      input.step = scale === 1000 ? "0.001" : scale === megabyte ? "any" : "1";
      if (scale === megabyte) input.title = t("settings-mb-help");
    }
    const collect = () => {
      draft.enabled = (controls.get("enabled") as HTMLInputElement).checked;
      for (const { key, scale } of numeric) {
        const input = controls.get(key) as HTMLInputElement;
        draft[key] = scale === 1 ? Number(input.value) : readSettingsScaledNumber(input, scale);
      }
      profile.api = controls.get("api")!.value.trim(); profile.model = definition.model; profile.key = controls.get("key")!.value.trim();
      profile.options = JSON.parse(options.value);
    };
    const actions = element("div"); actions.className = "km-settings-actions";
    const status = element("span"); status.setAttribute("role", "status"); status.id = "km-settings-status";
    const action = (key: string, handler: () => void) => { const button = element("button", t(key)); button.type = "button"; button.addEventListener("click", handler); actions.append(button); return button; };
    provider.addEventListener("change", () => {
      try { collect(); draft.activeProfile = draft.parserProfiles![provider.value]; render(); }
      catch { provider.value = parserProvider(profile); status.textContent = t("settings-invalid"); }
    });
    const save = action("settings-save", () => { void (async () => {
      save.disabled = true;
      try { collect(); await config.save(draft); if (!disposed) status.textContent = t("settings-saved"); }
      catch { if (!disposed) status.textContent = t("settings-invalid"); }
      finally { if (!disposed) save.disabled = false; }
    })(); });
    action("settings-reload", () => { void config.reload().then(() => { if (!disposed) { draft = readDraft(); render(); } }); });
    actions.append(status); form.append(actions); form.addEventListener("submit", event => { event.preventDefault(); save.click(); }); parsingHost.append(form);
    if (config.error) status.textContent = t("settings-invalid");
  };
  let disposeRetrieval: (() => void) | undefined, disposeMcp: (() => void) | undefined;
  const cleanup = () => {
    disposed = true; disposeMcp?.(); disposeRetrieval?.();
    navigation.removeEventListener("click", onClick); navigation.removeEventListener("keydown", onKeyDown);
    navigation.remove(); for (const page of pages) page.panel.remove();
    void config.close();
  };
  try {
    render();
    disposeRetrieval = await mountRetrievalSettings(pages[1].panel);
    disposeMcp = await mountMcpSettings(pages[2].panel);
    if (!Zotero.__knowledgeMCPAccess) pages[2].panel.append(element("p", t("settings-mcp-unavailable")));
    return cleanup;
  } catch (error) { cleanup(); throw error; }
}
