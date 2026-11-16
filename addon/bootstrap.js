// Zotero bootstrap entry must remain plain JavaScript.
// The TypeScript entry point is bundled to content/main.js by Scaffold.
var ZoteroKnowledgeMCP;
var chromeHandle;
var localeRegistry;
var ownInstance;
const localeSourceName = "knowledgemcp-owned-locales";

async function registerOwnedLocales(context) {
  const window = Zotero.getMainWindows?.().find(window => !window.closed);
  if (!window?.L10nRegistry || !window.L10nFileSource) return;
  const locales = await (await fetch(context.rootURI + "content/locale-catalog.json")).json();
  const catalogs = new Map(await Promise.all(locales.map(async locale =>
    [locale, await (await fetch(context.rootURI + `locale/${locale}/knowledgemcp.ftl`)).text()])));
  const available = Services.locale.availableLocales;
  const files = available.map(locale => {
    const selected = Zotero.Utilities.Internal.resolveLocale(locale, locales, { silent: true }) || "en-US";
    return { path: `knowledgemcp-owned:${locale}/knowledgemcp.ftl`, source: catalogs.get(selected) };
  });
  // A dedicated complete source survives the host's late unregisterLocales()
  // during rapid disable/enable. It has the same resource IDs and translations.
  const source = window.L10nFileSource.createMock(localeSourceName, "app", available, "knowledgemcp-owned:{locale}/", files);
  localeRegistry = window.L10nRegistry.getInstance();
  if (localeRegistry.hasSource(localeSourceName)) localeRegistry.updateSources([source]);
  else localeRegistry.registerSources([source]);
}
function unregisterOwnedLocales() {
  localeRegistry?.removeSources([localeSourceName]); localeRegistry = undefined;
}

// Zotero can begin a new bootstrap scope before an earlier async shutdown ends.
// Serialize the complete resource lifecycle on the shared host, across bundles.
function lifecycleRuntime() {
  // Main-window promises stop scheduling after the last window is destroyed.
  // The system module global survives both windows and replaced plugin scopes.
  if (typeof Components !== "undefined") {
    const timer = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    return Components.utils.getGlobalForObject(timer.setTimeout);
  }
  return globalThis;
}
function runLifecycle(operation) {
  const RuntimePromise = lifecycleRuntime().Promise;
  const pending = RuntimePromise.resolve(Zotero.__knowledgeMCPBootstrapLifecycle).catch(() => {}).then(operation);
  Zotero.__knowledgeMCPBootstrapLifecycle = pending.then(() => {}, () => {});
  return pending;
}

function install(data, reason) {
  // No installation-specific work is required.
}
function instanceKey(context) { return `${context.id || ""}:${context.version || ""}:${context.rootURI}`; }
function instanceRegistry() {
  const RuntimeMap = lifecycleRuntime().Map;
  return Zotero.__knowledgeMCPBootstrapInstances ||= new RuntimeMap();
}

async function startup(context) {
  return runLifecycle(async () => {
  await Zotero.__knowledgeMCPBootstrapActive?.close();
  const startupService = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
  chromeHandle = startupService.registerChrome(Services.io.newURI(context.rootURI + "manifest.json"),
    [["content", "knowledgemcp", context.rootURI + "content/"]]);
  Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler)
    .setSubstitution("knowledgemcp-vector", Services.io.newURI(context.rootURI + "content/vector/"));
  try {
    await registerOwnedLocales(context);
    Services.scriptloader.loadSubScript(context.rootURI + "content/main.js");
    if (!ZoteroKnowledgeMCP || typeof ZoteroKnowledgeMCP.startup !== "function") {
      throw new Error("ZoteroKnowledgeMCP: content/main.js was not loaded");
    }
    const api = ZoteroKnowledgeMCP, handle = chromeHandle, registry = localeRegistry;
    const instance = { key: instanceKey(context), closed: false, closing: undefined, close() {
      if (instance.closed) return Promise.resolve();
      return instance.closing ||= (async () => {
        try { await api.shutdown?.(); }
        finally {
          instance.closed = true;
          if (Zotero.__knowledgeMCPBootstrapActive === instance) {
            delete Zotero.__knowledgeMCPBootstrapActive;
            registry?.removeSources([localeSourceName]);
            Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler).setSubstitution("knowledgemcp-vector", null);
          }
          handle.destruct();
          if (ZoteroKnowledgeMCP === api) ZoteroKnowledgeMCP = undefined;
          if (chromeHandle === handle) chromeHandle = undefined;
        }
      })();
    } };
    ownInstance = instance; instanceRegistry().set(instance.key, instance); Zotero.__knowledgeMCPBootstrapActive = instance;
    await api.startup(context);
  } catch (error) {
    if (ownInstance && !ownInstance.closed) await ownInstance.close();
    else { unregisterOwnedLocales(); chromeHandle?.destruct(); chromeHandle = undefined;
      Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler).setSubstitution("knowledgemcp-vector", null); }
    throw error;
  }
  });
}

function onMainWindowLoad({ window }) {
  ZoteroKnowledgeMCP?.onMainWindowLoad?.(window);
}

function onMainWindowUnload({ window }) {
  ZoteroKnowledgeMCP?.onMainWindowUnload?.(window);
}

async function shutdown(context) {
  const key = context && instanceKey(context);
  const instance = !context || ownInstance?.key === key ? ownInstance : instanceRegistry().get(key);
  return runLifecycle(async () => {
    await instance?.close();
    if (instance && instanceRegistry().get(instance.key) === instance) instanceRegistry().delete(instance.key);
  });
}

function uninstall(data, reason) {
  // Preserve user data when removing or replacing the plugin.
}
