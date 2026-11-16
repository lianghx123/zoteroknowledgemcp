import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { evaluate } from "./verify-vector-native.mjs";
import { createFeed, validatedUpdate } from "./update-feed.mjs";
const folder = path.resolve(".scaffold/stable-update-native"), debugPort = Number(process.env.ZOTERO_DEBUG_PORT ?? 19879), httpPort = 8767;
await mkdir(folder, { recursive: true });
const original = await readFile(".scaffold/build/zotero-knowledge-mcp.xpi");
const initial = new AdmZip(original), target = new AdmZip(original);
const manifest = JSON.parse(target.readAsText("manifest.json"));
manifest.version = "0.2.0";
target.updateFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
const hooks = "function install(){} function startup(data){Zotero.__stableUpdateFixtureVersion=data.version;} function shutdown(){} function uninstall(){}";
target.updateFile("bootstrap.js", Buffer.from(hooks));
const bytes = target.toBuffer(), hash = createHash("sha256").update(bytes).digest("hex");
const release = { tag_name: "v0.2.0", draft: false, prerelease: false, published_at: new Date().toISOString() };
const update = validatedUpdate(release, bytes, `${hash}  zotero-knowledge-mcp.xpi\n`);
update.update_link = `http://127.0.0.1:${httpPort}/target.xpi`;
const oldManifest = JSON.parse(initial.readAsText("manifest.json"));
oldManifest.version = "0.2.0-preview.1";
oldManifest.applications.zotero.update_url = `http://127.0.0.1:${httpPort}/updates.json`;
initial.updateFile("manifest.json", Buffer.from(JSON.stringify(oldManifest)));
initial.updateFile("bootstrap.js", Buffer.from(hooks));
const oldPath = path.join(folder, "initial.xpi"); await writeFile(oldPath, initial.toBuffer());
let advertised = { ...update, update_hash: `sha256:${"0".repeat(64)}` };
const requests = [], server = createServer((request, response) => {
  requests.push(request.url);
  if (request.url === "/updates.json") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(createFeed([advertised]))); }
  else if (request.url === "/target.xpi") { response.setHeader("Content-Type", "application/x-xpinstall"); response.end(bytes); }
  else { response.statusCode = 404; response.end(); }
});
const dataDirectory = path.join(folder, "data");
const state = JSON.parse(await evaluate('(()=>{const {Zotero}=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");return JSON.stringify({data:Zotero.DataDirectory.dir,version:Zotero.version});})()', debugPort));
assert.equal(state.data, dataDirectory);
const run = async source => {
  await evaluate(`void(async()=>{const {Zotero}=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");try{Zotero.__updateProbeResult=null;const value=await(async()=>{${source}})();Zotero.__updateProbeResult=JSON.stringify({ok:true,value});}catch(error){Zotero.__updateProbeResult=JSON.stringify({ok:false,error:String(error),stack:error.stack});}})()`, debugPort);
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await evaluate('(()=>{const {Zotero}=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");return Zotero.__updateProbeResult;})()', debugPort);
    if (typeof result === "string") { const parsed = JSON.parse(result); assert.equal(parsed.ok, true, JSON.stringify(parsed)); return parsed.value; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error("Native update timeout");
};
const prefix = 'const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");';
const checks = [];
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(httpPort, "127.0.0.1", resolve); });
  const installed = await run(`${prefix}const file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(${JSON.stringify(oldPath)});const install=await AddonManager.getInstallForFile(file);await install.install();const addon=await AddonManager.getAddonByID(${JSON.stringify(manifest.applications.zotero.id)});return {version:addon.version,active:addon.isActive};`);
  assert.equal(installed.version, oldManifest.version); checks.push({ initialInstall: installed });
  const preference = await run(`${prefix}const addon=await AddonManager.getAddonByID(${JSON.stringify(manifest.applications.zotero.id)});addon.applyBackgroundUpdates=AddonManager.AUTOUPDATE_DISABLE;const disabled=AddonManager.shouldAutoUpdate(addon);addon.applyBackgroundUpdates=AddonManager.AUTOUPDATE_ENABLE;return {disabled,enabled:AddonManager.shouldAutoUpdate(addon)};`);
  assert.deepEqual(preference, { disabled: false, enabled: true }); checks.push({ userUpdatePreference: preference });
  const find = `${prefix}const addon=await AddonManager.getAddonByID(${JSON.stringify(manifest.applications.zotero.id)});const install=await new Promise((resolve,reject)=>{let found;addon.findUpdates({onUpdateAvailable(a,i){found=i;},onUpdateFinished(a,error){if(error)reject(Error("Update check "+error));else resolve(found);}},AddonManager.UPDATE_WHEN_USER_REQUESTED);});`;
  const rejected = await run(`${find}if(!install)throw Error("Expected update offer");let failed=false;try{await install.install();}catch(error){failed=true;}const current=await AddonManager.getAddonByID(addon.id);return {failed,error:install.error,version:current.version};`);
  assert.equal(rejected.failed, true); assert.equal(rejected.version, oldManifest.version); checks.push({ badHashRejected: rejected });
  advertised = { ...update, applications: { zotero: { strict_min_version: "11.0", strict_max_version: "11.0.*" } } };
  const incompatible = await run(`${find}return {offered:Boolean(install),version:addon.version};`);
  assert.equal(incompatible.offered, false); checks.push({ incompatibleNotOffered: incompatible });
  advertised = update;
  const upgraded = await run(`${find}if(!install)throw Error("Expected stable update");await install.install();const current=await AddonManager.getAddonByID(addon.id);return {version:current.version,active:current.isActive};`);
  assert.equal(upgraded.version, "0.2.0"); assert.equal(upgraded.active, true); checks.push({ stableUpgrade: upgraded });
  const report = { runtime: state.version, dataDirectory, sourceVersion: oldManifest.version, targetVersion: "0.2.0", sha256: hash,
    kind: "Native AddonManager install/findUpdates/download/upgrade in empty profile; fixture bootstrap avoids application/provider activity", checks, requests };
  await writeFile(path.join(folder, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally {
  server.close();
  await evaluate(`(()=>{const {Zotero}=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");if(Zotero.DataDirectory.dir!==${JSON.stringify(dataDirectory)})throw Error("Unexpected profile");setTimeout(()=>Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit),200);return "shutdown";})()`, debugPort).catch(error => console.error(String(error)));
}
