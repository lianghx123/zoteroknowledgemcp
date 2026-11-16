// Developer-driven native checks; isolated profile only, no model requests or saved configuration edits.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate } from "./verify-vector-native.mjs";
const folder = path.resolve(".scaffold/startup-optimization"), output = path.join(folder, "native-ui.json");
await fs.rm(output, { force: true });
const bundle = path.join(folder, "locale-ui.js");
await build({ stdin: { contents: `
import { mountRetrievalSettings } from "./src/ui/retrieval-settings.ts";
import { recoveryNotice } from "./src/services/startup-recovery.ts";
export async function check(host) {
  const dispose=await mountRetrievalSettings(host);
  try { return { notice:recoveryNotice(Zotero.__knowledgeMCPRetrieval.startup()), index:host.querySelector("#km-vector-index-status").textContent,
    repairDisabled:host.querySelector("#km-vector-rebuild").disabled, retryVisible:!host.querySelector("#km-vector-startup-retry").hidden }; }
  finally{dispose();}
}`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, format: "iife", globalName: "StartupLocaleProbe", platform: "browser", target: "firefox140", outfile: bundle });
await evaluate(`void(async()=>{const report={runtime:"Zotero native DOM; injected recovery failure; no model calls",checks:[],locales:[]},assert=(value,name)=>{if(!value)throw Error(name);report.checks.push(name);};
const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs"),wait=ms=>new Promise(resolve=>timer.setTimeout(resolve,ms));
const until=async fn=>{for(let i=0;i<300;i++){if(fn())return;await wait(50);}throw Error("native-ui-timeout");};
const w=Zotero.getMainWindows()[0],doc=w.document,pref="extensions.zotero.knowledgemcp.retrievalSelection",saved=Zotero.Prefs.get(pref,true),quick=doc.getElementById("zotero-tb-search"),input=quick.searchTextbox.value;
let originalEmbed,originalBridge;
try{
  if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated library required");
  Zotero.Prefs.set(pref,"semantic",true);const exercise=Zotero.__startupRecoveryExercise={failOnce:true};
  const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"),file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(${JSON.stringify(path.join(folder, "candidate-probe.xpi"))});await(await AddonManager.getInstallForFile(file)).install();
  await until(()=>exercise.entered);
  const app=Zotero.__startupRecoveryApp,e=app.embeddings;originalEmbed=e.gateway.embed;let calls=0;e.gateway.embed=async()=>{calls++;throw Error("unexpected-network");};
  assert(app.recovery.isReady("fulltext")&&!app.recovery.isReady("index"),"fulltext-before-semantic");
  assert(quick.searchModePopup.querySelector("#km-search-fulltext").getAttribute("disabled")==="false","fulltext-entry-enabled");
  assert(doc.querySelector('[data-mode="semantic"]').disabled,"semantic-entry-disabled");
  const count=w.ZoteroPane.itemsView.rowProvider.rowCount;quick.searchTextbox.value="startup recovery probe";quick.searchTextbox.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Enter",bubbles:true}));await wait(100);
  assert(calls===0&&w.ZoteroPane.itemsView.rowProvider.rowCount===count,"waiting-enter-preserves-list-without-network");
  report.waiting=quick.searchTextbox.getAttribute("title");assert(!doc.getElementById("km-search-status"),"search-footer-absent");assert(report.waiting.includes("恢复语义索引"),"native-chinese-progress");
  exercise.release();await until(()=>app.recovery.snapshot().state==="failed");
  report.failure=quick.searchTextbox.getAttribute("title");assert(report.failure.includes("启动恢复失败")&&report.failure.includes("插件设置"),"failure-hint-points-to-settings");
  Zotero.__knowledgeMCPRetrieval.retryStartup();await until(()=>app.recovery.snapshot().state==="ready");
  assert(!doc.querySelector('[data-mode="semantic"]').disabled&&calls===0,"retry-restores-index-without-model-call-or-automatic-query");
  e.gateway.embed=originalEmbed;originalEmbed=undefined;delete Zotero.__startupRecoveryExercise;
  originalBridge=Zotero.__knowledgeMCPRetrieval;
  const snapshot={state:"failed",stage:"index",completed:["metadata","files","parsing","embedding","sync","fulltext"]};
  Zotero.__knowledgeMCPRetrieval={...originalBridge,startup:()=>snapshot};
  for(const locale of ["en-US","zh-CN","zh-TW","de","es-ES","fr-FR","ja-JP"]){
    const host=doc.createElementNS("http://www.w3.org/1999/xhtml","section");host.style.cssText="position:fixed;left:-20000px;width:720px";doc.documentElement.append(host);
    try{
      function ScopedLocalization(ids,sync){return new Localization(ids,sync,undefined,[locale]);}
      const target={Zotero,Services,PathUtils,IOUtils,Localization:ScopedLocalization,ChromeUtils,Components,AbortController:w.AbortController,setTimeout:timer.setTimeout,clearTimeout:timer.clearTimeout,setInterval:w.setInterval.bind(w),clearInterval:w.clearInterval.bind(w),URL,Map,Promise};
      Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(bundle).href)},target);const result=await target.StartupLocaleProbe.check(host);
      assert(result.notice===result.index&&result.repairDisabled&&result.retryVisible,"settings-recovery-"+locale);report.locales.push({locale,...result});
    }finally{host.remove();}
  }
  report.status="passed";
}catch(e){report.status="failed";report.error=String(e);report.stack=e?.stack;}
finally{
  if(originalEmbed&&Zotero.__startupRecoveryApp)Zotero.__startupRecoveryApp.embeddings.gateway.embed=originalEmbed;
  Zotero.__startupRecoveryExercise?.release?.();delete Zotero.__startupRecoveryExercise;
  if(originalBridge)Zotero.__knowledgeMCPRetrieval=originalBridge;
  Zotero.Prefs.set(pref,saved??"",true);quick.searchTextbox.value=input;
  quick.searchModePopup.querySelector('[value="everything"]')?.dispatchEvent(new w.Event("command",{bubbles:true}));
  Zotero.Prefs.set(pref,saved??"",true);
  await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(report,null,2));
}})()`);
console.log(output);
