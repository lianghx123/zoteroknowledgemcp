// Developer-only instrumentation. Never install a probe into a production profile.
import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { evaluate } from "./verify-vector-native.mjs";

const [action="summary",label="candidate",reference=".scaffold/build/zotero-knowledge-mcp.xpi"]=process.argv.slice(2);
if(!/^[a-z][a-z0-9-]{0,60}$/.test(label))throw Error("Use a simple diagnostic label.");
const folder=path.resolve(".scaffold/lifecycle-diagnostic"),log=path.join(folder,`${label}.jsonl`),archive=path.join(folder,`${label}.xpi`);
await fs.mkdir(folder,{recursive:true});
if(action==="prepare"){
  await fs.writeFile(log,"");const zip=new AdmZip(path.resolve(reference));
  zip.updateFile("bootstrap.js",Buffer.from(zip.readAsText("bootstrap.js")+`
// Isolated lifecycle probe; absent from the production package.
const probeFile=${JSON.stringify(log)};
function probeLog(event,data={}){
 const text=JSON.stringify({event,at:Date.now(),pid:Services.appinfo.processID,...data})+"\\n";
 const file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(probeFile);
 const stream=Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);stream.init(file,0x02|0x08|0x10,0o600,0);
 const bytes=new TextEncoder().encode(text);try{stream.write(String.fromCharCode(...bytes),bytes.length);}finally{stream.close();}
}
const probeOriginalStart=startup,probeOriginalStop=shutdown,probeOriginalUnload=onMainWindowUnload;
startup=async function(...args){
 if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated profile required");
 Zotero.__knowledgeMCPLifecycleProbe=probeLog;probeLog("bootstrap-start");
 Services.wm.addListener({onOpenWindow(x){const w=x.docShell.domWindow;probeLog("window-open",{url:w.location.href,width:w.outerWidth,height:w.outerHeight,stack:new Error().stack});w.addEventListener("load",()=>probeLog("window-loaded",{url:w.location.href,width:w.outerWidth,height:w.outerHeight}),{once:true});},onCloseWindow(x){probeLog("window-close",{url:x.docShell.domWindow.location.href});}});
 for(const topic of ["quit-application-granted","quit-application","profile-before-change"])Services.obs.addObserver({observe(){probeLog(topic);}},topic);
 try{await probeOriginalStart(...args);probeLog("bootstrap-ready");}catch(error){probeLog("bootstrap-error",{message:String(error)});throw error;}
};
shutdown=async function(...args){probeLog("bootstrap-shutdown-start");try{await probeOriginalStop(...args);probeLog("bootstrap-shutdown-end");}catch(error){probeLog("shutdown-error",{message:String(error)});throw error;}};
onMainWindowUnload=function(...args){probeLog("main-window-unload-start");try{return probeOriginalUnload(...args);}finally{probeLog("main-window-unload-end");}};
`));zip.writeZip(archive);console.log(archive);
}else if(action==="install"){
  const report=path.join(folder,`${label}-install.json`);await fs.rm(report,{force:true});
  await evaluate(`void(async()=>{const report={started:Date.now()};try{
   if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated profile required");
   const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"),file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(${JSON.stringify(archive)});
   const install=await AddonManager.getInstallForFile(file);await install.install();report.status="passed";
  }catch(error){report.status="failed";report.error=String(error);}finally{await IOUtils.writeUTF8(${JSON.stringify(report)},JSON.stringify(report,null,2));}})()`);
  console.log(`Installation dispatched; inspect ${report}. Probes persist across process restarts; reinstall the production XPI afterward.`);
}else if(action==="close"){
  await evaluate(`(()=>{if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated profile required");
   Zotero.__knowledgeMCPLifecycleProbe?.("developer-close-request");const window=Zotero.getMainWindows()[0];if(!window)throw Error("Main window unavailable");
   ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout(()=>window.close(),200);})()`);
  console.log("Normal last-window close scheduled. Inspect the log and independently verify process exit.");
}else if(action==="state"){
  console.log(await evaluate(`JSON.stringify((()=>{
   if(!Zotero.__knowledgeMCPSchemaProbe){const state=Zotero.__knowledgeMCPSchemaProbe={pending:true,rejected:false};Zotero.Schema.schemaUpdatePromise.then(()=>{state.pending=false;},()=>{state.pending=false;state.rejected=true;});}
   return {pid:Services.appinfo.processID,closing:!!Zotero.closing,pluginActive:!!Zotero.__knowledgeMCPBootstrapActive,
    schemaUpdatePending:Zotero.__knowledgeMCPSchemaProbe.pending,schemaUpdateRejected:Zotero.__knowledgeMCPSchemaProbe.rejected};})())`));
}else if(action==="summary"){
  const events=(await fs.readFile(log,"utf8")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const runs=[...new Set(events.map(row=>row.pid))].map(pid=>{
    const rows=events.filter(row=>row.pid===pid),first=name=>rows.find(row=>row.event===name)?.at;
    const duration=(start,end)=>first(start)!==undefined&&first(end)!==undefined?first(end)-first(start):null;
    const closing=first("developer-close-request")??first("bootstrap-shutdown-start");
    return {pid,startupMs:duration("bootstrap-start","bootstrap-ready"),shutdownMs:duration("bootstrap-shutdown-start","bootstrap-shutdown-end"),
      complete:!!first("bootstrap-shutdown-end"),windowsAfterClose:rows.filter(row=>row.event==="window-open"&&closing!==undefined&&row.at>=closing),
      errors:rows.filter(row=>row.event.endsWith("-error"))};
  });await fs.writeFile(path.join(folder,`${label}-summary.json`),JSON.stringify(runs,null,2)+"\n");console.log(JSON.stringify(runs,null,2));
}else throw Error("Use prepare, install, close, state or summary.");
