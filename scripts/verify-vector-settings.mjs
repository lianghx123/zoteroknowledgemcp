// Native form save/reopen and live connection feedback; restore all test settings.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate, runtimeRootURI } from "./verify-vector-native.mjs";
const folder=path.resolve(".scaffold/vector-acceptance"),run=`settings-${Date.now()}`;
await fs.mkdir(folder,{recursive:true});
await build({stdin:{loader:"ts",resolveDir:process.cwd(),contents:`
import { mountRetrievalSettings } from "./src/ui/retrieval-settings.ts";
import { RetrievalConfigFile, defaultRetrievalConfig } from "./src/services/retrieval-config.ts";
import { ModelCredentials } from "./src/integrations/zotero/model-credentials.ts";
import { readLiveModelSettings } from "./scripts/fixtures/live-model-settings.ts";
export async function run(options){
 const window=Zotero.getMainWindows()[0],doc=window.document,config=new RetrievalConfigFile(),credentials=new ModelCredentials(),report={run:options.run,runtime:"native settings DOM, Login Manager and live Bailian",checks:[],started:Date.now(),providerCalls:0};
 const wait=ms=>new Promise(resolve=>window.setTimeout(resolve,ms)),assert=(value,name)=>{if(!value)throw Error(name);report.checks.push(name);};
 const until=async predicate=>{for(let i=0;i<250;i++){if(await predicate())return;await wait(100);}throw Error("settings-state-timeout");};
 const host=doc.createElementNS("http://www.w3.org/1999/xhtml","section"),eRef="settings-probe-e-"+Date.now(),rRef="settings-probe-r-"+Date.now();
 let original,expectedRevision,dispose;
 const input=(key,value)=>{const node=host.querySelector("#km-vector-"+key);if(node.type==="checkbox")node.checked=value;else node.value=value;node.dispatchEvent(new window.Event("input",{bubbles:true}));return node;};
 const save=async()=>{host.querySelector("#km-vector-save").click();await until(()=>!host.querySelector("form").hasAttribute("aria-busy"));await config.reload();expectedRevision=config.current.revision;};
 try{
  if(!Zotero.DataDirectory.dir.toLowerCase().includes("\\\\.scaffold\\\\"))throw Error("isolated-library-required");
  await config.reload();if(config.error)throw Error("original-settings-unreadable");original=JSON.parse(JSON.stringify(config.current));
  const live=await readLiveModelSettings();
  const probe={...JSON.parse(JSON.stringify(defaultRetrievalConfig)),revision:original.revision,enabled:false,paused:true,autoEmbed:false};probe.embedding={...live.config.embedding,credentialRef:eRef};probe.rerank={...live.config.rerank,credentialRef:rRef};
  await config.save(probe,"keep");expectedRevision=config.current.revision;
  host.id="km-settings";host.style.cssText="position:fixed;left:-20000px;top:0;width:720px";doc.documentElement.append(host);
  dispose=await mountRetrievalSettings(host);
  assert(!host.querySelector("#km-vector-embedding-key").value,"empty-key-input-before-save");
  report.initialKeyState=host.querySelector("#km-vector-embedding-key-state").textContent;
  assert(host.querySelector("#km-vector-rerank-key").disabled,"shared-key-field-explicitly-disabled");
  input("embedding-key","local-settings-probe-not-a-real-key");assert(host.querySelector("#km-vector-embedding-key-state").textContent!==report.initialKeyState,"pending-key-feedback");
  await save();assert(credentials.get(eRef)==="local-settings-probe-not-a-real-key","native-key-save-verified");
  report.savedFeedback=host.querySelector("#km-vector-save-status").textContent;report.savedKeyState=host.querySelector("#km-vector-embedding-key-state").textContent;
  assert(!host.textContent.includes("local-settings-probe-not-a-real-key")&&!host.querySelector("#km-vector-embedding-key").value,"saved-secret-not-exposed");
  dispose();dispose=await mountRetrievalSettings(host);assert(host.querySelector("#km-vector-embedding-key-state").textContent===report.savedKeyState,"saved-key-state-survives-reopen");
  input("candidates","1");await save();report.invalidFeedback=host.querySelector("#km-vector-save-status").textContent;assert(host.querySelector("#km-vector-candidates").getAttribute("aria-invalid")==="true","invalid-field-located");
  host.querySelector("#km-vector-reload").click();await until(()=>!host.querySelector("form").hasAttribute("aria-busy"));assert(host.querySelector("#km-vector-candidates").value==="100","restore-saved-values");
  input("shareCredential",false);input("embedding-key",live.embeddingKey);input("rerank-key",live.rerankKey);
  for(const kind of ["embedding","rerank"]){
   const button=host.querySelector("#km-vector-"+kind+"-test"),status=host.querySelector("#km-vector-"+kind+"-test-status");button.click();report.providerCalls++;
   assert(button.disabled&&status.textContent.length>0,"immediate-"+kind+"-progress");
   await until(()=>!button.disabled);report[kind+"TestFeedback"]=status.textContent;
   assert(status.textContent===new Localization(["knowledgemcp.ftl"],true).formatValueSync("knowledgemcp-vector-test-success"),"live-"+kind+"-connection-success");
   const current=JSON.parse(await IOUtils.readUTF8(config.path));assert(current.revision===expectedRevision,"test-"+kind+"-does-not-save");
  }
  assert(credentials.get(eRef)==="local-settings-probe-not-a-real-key","test-does-not-overwrite-saved-key");
  input("shareCredential",false);input("rerank-key","local-separate-key-probe");await save();assert(credentials.get(rRef)==="local-separate-key-probe","separate-rerank-key-saved");
  report.status="passed";
 }catch(error){report.status="failed";report.error=error?.code??"native-settings-check-failed";report.failedCheck=error?.message?.startsWith("live-")?error.message:undefined;}
 finally{
  dispose?.();host.remove();
  try{if(original){await config.reload();if(config.current.revision!==expectedRevision)throw Error("concurrent-edit");original.revision=config.current.revision;await config.save(original,"keep");report.settingsRestored=true;}}
  catch{report.status="failed";report.restoreError="concurrent-edit-or-restore-failed";}
  await credentials.set(eRef,"");await credentials.set(rRef,"");await config.close();report.finished=Date.now();await IOUtils.writeUTF8(PathUtils.join(options.folder,options.run+".json"),JSON.stringify(report,null,2));
 }
}
`},bundle:true,format:"iife",globalName:"VectorSettingsProbe",platform:"browser",target:"firefox140",outfile:path.join(folder,"settings-probe.js")});
if (process.argv.includes("--prepare-only")) {
  console.log("Prepared native settings probe; no debugger connection or provider request.");
} else {
  const options={folder,run,rootURI:await runtimeRootURI()};
  await evaluate(`Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(path.join(folder,"settings-probe.js")).href)});void VectorSettingsProbe.run(${JSON.stringify(options)})`);
  console.log(`Dispatched ${run}; temporary keys and model settings will be restored.`);
}
