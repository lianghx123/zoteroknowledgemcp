// Install only in the isolated development instance; restore model settings.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate } from "./verify-vector-native.mjs";
const folder=path.resolve(".scaffold/vector-acceptance");await fs.mkdir(folder,{recursive:true});
const xpi=path.join(folder,`packaged-${Date.now()}.xpi`);await fs.copyFile(path.resolve(".scaffold/build/zotero-knowledge-mcp.xpi"),xpi);
await build({stdin:{loader:"ts",resolveDir:process.cwd(),contents:`
import { RetrievalConfigFile } from "./src/services/retrieval-config.ts";
import { ModelCredentials } from "./src/integrations/zotero/model-credentials.ts";
export async function run(options){
 const report={runtime:"installed XPI in isolated Zotero",activeReplacement:options.activeReplacement,checks:[],cycles:[],started:Date.now(),providerCalls:0};
 const config=new RetrievalConfigFile(),credentials=new ModelCredentials(),reference="lifecycle-probe-"+Date.now();let original,revision;
 const wait=ms=>new Promise(resolve=>Zotero.getMainWindows()[0].setTimeout(resolve,ms));
 const until=async check=>{for(let i=0;i<150;i++){if(await check())return;await wait(100);}throw Error("native-state-timeout");};
 const assert=(value,label)=>{if(!value)throw Error(label);report.checks.push(label);};
 const workers=()=>{const manager=Cc["@mozilla.org/dom/workers/workerdebuggermanager;1"].getService(Ci.nsIWorkerDebuggerManager),enumerator=manager.getWorkerDebuggerEnumerator();let count=0;
  while(enumerator.hasMoreElements()){const worker=enumerator.getNext().QueryInterface(Ci.nsIWorkerDebugger);if(worker.url.startsWith("resource://knowledgemcp-vector/"))count++;}return count;};
  const ui=()=>{const doc=Zotero.getMainWindows()[0].document,quick=doc.getElementById("zotero-tb-search"),menus=[...quick.searchModePopup.querySelectorAll('[id^="km-search-"][data-mode]')];return {menuSets:doc.querySelectorAll("#km-search-semantic").length,menus:menus.length,fulltext:quick.searchModePopup.querySelectorAll("#km-search-fulltext").length,translated:menus.every(node=>!node.getAttribute("label").includes("knowledgemcp-"))};};
 try{
  if(!Zotero.DataDirectory.dir.toLowerCase().includes("\\\\.scaffold\\\\"))throw Error("isolated-library-required");
  const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"),file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(options.xpi);
  const previous=await AddonManager.getAddonByID("zotero-knowledge-mcp@local.dev");if(previous?.isActive&&!options.activeReplacement){await previous.disable();await until(()=>!Zotero.__knowledgeMCPRetrieval&&(!Zotero.__knowledgeMCPDatabaseOwners||Zotero.__knowledgeMCPDatabaseOwners.size===0));}
  let addon=await AddonManager.installTemporaryAddon(file);report.rootURI=addon.getResourceURI().spec;assert(report.rootURI.startsWith("jar:")&&report.rootURI.includes(".xpi!/"),"actual-xpi-root");
  await until(()=>ui().menus===4);assert(ui().menuSets===1&&ui().fulltext===1,"one-set-of-four-search-menu-entries");
  assert(Zotero.__knowledgeMCPDatabaseOwners?.size===1,"one-database-owner-after-installation");
  await config.reload();original=JSON.parse(JSON.stringify(config.current));const probe=JSON.parse(JSON.stringify(original));
  probe.enabled=true;probe.autoEmbed=false;probe.paused=true;probe.embedding.credentialRef=reference;probe.rerank.credentialRef=reference;probe.shareCredential=true;
  await credentials.set(reference,"local-lifecycle-probe-no-network");await config.save(probe);revision=config.current.revision;
  await until(()=>Zotero.__knowledgeMCPRetrieval?.status()==="ready"&&workers()===1);assert(workers()===1,"application-owned-worker-active-with-background-work-paused");
  for(let cycle=0;cycle<2;cycle++){
   await addon.disable();await until(()=>ui().menus===0&&workers()===0);report.cycles.push({cycle,disabled:ui(),disabledWorkers:workers()});
   await addon.enable();await until(()=>ui().menus===4&&workers()===1);const state=ui();assert(state.menuSets===1&&state.fulltext===1&&state.translated,"reload-"+cycle+"-no-duplicate-and-localized-ui");report.cycles.at(-1).enabled=state;report.cycles.at(-1).enabledWorkers=workers();
  }
  report.status="passed";
 }catch(error){report.status="failed";report.error=String(error);report.stack=error?.stack;}
 finally{
  try{if(original){await config.reload();if(config.current.revision!==revision)throw Error("settings-changed-concurrently");original.revision=config.current.revision;await config.save(original);if(!original.enabled)await until(()=>workers()===0);report.settingsRestored=true;}}
  catch(error){report.status="failed";report.restoreError=String(error);}
  await credentials.set(reference,"");await config.close();report.finished=Date.now();await IOUtils.writeUTF8(PathUtils.join(options.folder,"native-xpi.json"),JSON.stringify(report,null,2));
 }
}`},bundle:true,format:"iife",globalName:"VectorXPIAcceptance",platform:"browser",target:"firefox140",outfile:path.join(folder,"xpi-probe.js")});
await evaluate(`Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(path.join(folder,"xpi-probe.js")).href)});void VectorXPIAcceptance.run(${JSON.stringify({folder,xpi,activeReplacement:process.argv.includes("--replace-active")})})`);
console.log("Dispatched packaged-XPI and active-worker reload checks; model settings will be restored.");
