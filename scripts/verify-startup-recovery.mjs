// Isolated native startup instrumentation. Production packages contain none of these hooks.
import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { evaluate } from "./verify-vector-native.mjs";

const [action = "state", label = "candidate", reference = ".scaffold/build/zotero-knowledge-mcp.xpi"] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]{0,60}$/.test(label)) throw Error("Use a simple diagnostic label.");
const folder = path.resolve(".scaffold/startup-optimization"), log = path.join(folder, `${label}.jsonl`), archive = path.join(folder, `${label}-probe.xpi`);
await fs.mkdir(folder, { recursive: true });
if (action === "prepare") {
  await fs.writeFile(log, "");
  const zip = new AdmZip(path.resolve(reference)), anchor = "return __toCommonJS(index_exports);";
  let main = zip.readAsText("content/main.js"); if (!main.includes(anchor)) throw Error("Unexpected bundle.");
  main = main.replace(anchor, `
const probeStart = PluginApplication.prototype.start;
PluginApplication.prototype.start = async function(...args) {
  Zotero.__startupRecoveryApp = this;
  const started = Date.now(); await probeStart.apply(this, args);
  Zotero.__startupRecoveryLog("application-ui-ready", {elapsed: Date.now()-started});
  if(this.recovery) {
    const exercise=Zotero.__startupRecoveryExercise;
    if(exercise){const original=this.recovery.steps.index;this.recovery.steps.index=async()=>{if(!exercise.entered){exercise.entered=true;await new Promise(resolve=>{exercise.release=resolve;});if(exercise.failOnce)throw Error("isolated-recovery-failure");}return original();};}
    const publish = () => Zotero.__startupRecoveryLog("recovery",this.recovery.snapshot());
    publish(); this.recovery.subscribe(publish);
  }
};
for (const [type,method,event] of [[EmbeddingRepository,"projectFulltext","fulltext-ready"],[VectorStore,"sync","index-ready"]]) {
 const original=type.prototype[method]; let measured=false;
 type.prototype[method]=async function(...args){const start=Date.now();const value=await original.apply(this,args);if(!measured){measured=true;Zotero.__startupRecoveryLog(event,{elapsed:Date.now()-start});}return value;};
}
` + anchor);
  zip.updateFile("content/main.js", Buffer.from(main));
  zip.updateFile("bootstrap.js", Buffer.from(zip.readAsText("bootstrap.js") + `
var startupProbeTimer, startupProbePoll;
function startupProbeLog(event,data={}) {
 const row=JSON.stringify({event,at:Date.now(),pid:Services.appinfo.processID,...data})+"\\n";
 const file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(${JSON.stringify(log)});
 const stream=Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);stream.init(file,0x02|0x08|0x10,0o600,0);
 const bytes=new TextEncoder().encode(row);try{stream.write(String.fromCharCode(...bytes),bytes.length);}finally{stream.close();}
}
const startupProbeStart=startup,startupProbeStop=shutdown;
startup=async function(...args){
 if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated library required");
 Zotero.__startupRecoveryLog=startupProbeLog;startupProbeLog("bootstrap-start");
 startupProbeTimer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
 const inspect=()=>{const w=Zotero.getMainWindows().find(w=>!w.closed);if(w?.ZoteroPane?.loaded&&w.ZoteroPane.itemsView?.rowProvider?.rowCount>0)startupProbeLog("native-list-ready",{items:w.ZoteroPane.itemsView.rowProvider.rowCount,startup:Services.startup.getStartupInfo()});else startupProbePoll=startupProbeTimer.setTimeout(inspect,10);};inspect();
 try{await startupProbeStart(...args);startupProbeLog("bootstrap-ready");}catch(e){startupProbeLog("startup-error",{error:String(e)});throw e;}
};
shutdown=async function(...args){startupProbeLog("shutdown-start");startupProbeTimer.clearTimeout(startupProbePoll);try{await startupProbeStop(...args);}finally{delete Zotero.__startupRecoveryApp;delete Zotero.__startupRecoveryLog;startupProbeLog("shutdown-end");}};
`));
  zip.writeZip(archive); console.log(archive);
} else if (action === "install") {
  const output = path.join(folder, `${label}-install.json`); await fs.rm(output, { force: true });
  await evaluate(`void(async()=>{const result={};try{
    if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated library required");
    const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"),file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(${JSON.stringify(archive)});
    const install=await AddonManager.getInstallForFile(file);await install.install();result.status="passed";
  }catch(e){result.status="failed";result.error=String(e);}await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(result));})()`);
  console.log(output);
} else if (action === "state") {
  console.log(await evaluate(`JSON.stringify({pid:Services.appinfo.processID,plugin:!!Zotero.__knowledgeMCPBootstrapActive,recovery:Zotero.__knowledgeMCPRetrieval?.startup?.(),index:Zotero.__knowledgeMCPRetrieval?.status(),ui:!!Zotero.getMainWindows()[0]?.document.getElementById("km-search-semantic")})`));
} else if (action === "check") {
  const output = path.join(folder, `${label}-checks.json`); await fs.rm(output, { force: true });
  await evaluate(`void(async()=>{const result={runtime:"Zotero native; query vector stub only"};try{
    const app=Zotero.__startupRecoveryApp,e=app.embeddings,db=e.repository.db,w=Zotero.getMainWindows()[0];
    result.recovery=app.recovery?.snapshot();result.index=e.store.status;result.resources=app.knowledge.snapshot.resources.length;
    result.blocks=Number((await db.selectFrom("content_blocks").select(eb=>eb.fn.countAll().as("count")).executeTakeFirst()).count);
    result.vectors=(await e.repository.activeVectors(e.profile).execute()).length;
    const scope=app.knowledge.snapshot.resources.map(r=>r.id),vector=await e.repository.activeVectors(e.profile).select("e.vector").limit(1).executeTakeFirst();
    const c=new w.AbortController();
    const text=await app.retrieval.search("研究", "fulltext",scope,c.signal);result.fulltext={hits:text.hits.length,channels:text.channels};
    if(vector){const original=e.gateway.embed;try{e.gateway.embed=async()=>[vectorFromBytes(vector.vector)];function vectorFromBytes(value){const bytes=new Uint8Array(value);return new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);}
      const semantic=await app.retrieval.search("isolated startup vector recovery probe", "semantic",scope,c.signal);result.semantic={hits:semantic.hits.length,channels:semantic.channels};if(!semantic.hits.length)throw Error("semantic-empty");
    }finally{e.gateway.embed=original;}}
    if(!w.document.getElementById("km-search-semantic"))throw Error("search-ui-missing");result.status="passed";
  }catch(e){result.status="failed";result.error=String(e);result.stack=e?.stack;}await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(result,null,2));})()`);
  console.log(output);
} else if (action === "early-close") {
  const output = path.join(folder, "early-close.json"); await fs.rm(output, { force: true });
  await evaluate(`void(async()=>{const report={};try{
    if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated library required");
    const previous=Zotero.__startupRecoveryApp,{AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"),file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(${JSON.stringify(archive)});await(await AddonManager.getInstallForFile(file)).install();
    const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    for(let i=0;i<100&&!(Zotero.__startupRecoveryApp&&Zotero.__startupRecoveryApp!==previous&&Zotero.__knowledgeMCPRetrieval?.startup);i++)await new Promise(resolve=>timer.setTimeout(resolve,10));
    report.pid=Services.appinfo.processID;report.recovery=Zotero.__knowledgeMCPRetrieval?.startup?.();report.at=Date.now();
    if(!report.recovery||!["waiting","running"].includes(report.recovery.state))throw Error("Missed startup recovery window");
    report.status="close-dispatched";await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(report,null,2));timer.setTimeout(()=>Zotero.getMainWindows()[0].close(),0);
  }catch(e){report.status="failed";report.error=String(e);await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(report,null,2));}})()`);
  console.log(output);
} else if (action === "close") {
  await evaluate(`(()=>{if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated library required");ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout(()=>Zotero.getMainWindows()[0].close(),100);})()`);
} else throw Error("Use prepare, install, state, check, early-close or close.");
