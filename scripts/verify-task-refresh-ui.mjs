// Developer-driven native task notification checks. No documents, jobs or provider settings are saved.
import fs from "node:fs/promises";
import path from "node:path";
import { evaluate } from "./verify-vector-native.mjs";
const output = path.resolve(".scaffold/idle-refresh-diagnostic/task-ui.json"); await fs.rm(output, { force: true });
await evaluate(`void(async()=>{const report={runtime:"Zotero native DOM; in-memory task projection injection",cases:[]};
const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs"),wait=ms=>new Promise(resolve=>timer.setTimeout(resolve,ms));let source,descriptor;
try{
 if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated library required");
 const app=Zotero.__idleRefreshApp,w=Zotero.getMainWindows()[0],v=w.ZoteroPane.itemsView,tree=app.knowledgeUI.windows.get(w).tree,tasks=tree.tasksView,search=app.retrievalUI.windows.get(w);
 source=tasks.source;descriptor=Object.getOwnPropertyDescriptor(source,"snapshot");const original=source.snapshot;let fake;
 source.snapshot=function(){const rows=original.call(this);return fake?[...rows,fake]:rows;};
 for(const mode of ["plain","evidence"]){
  fake=undefined;tasks.refreshTasks();await search.select(undefined);w.document.getElementById("zotero-tb-search").searchTextbox.value="";await w.ZoteroPane.collectionsView.selectByID("Kknowledgemcp:overview");
  if(mode==="evidence"){await search.select("fulltext");w.document.getElementById("zotero-tb-search").searchTextbox.value="研究";await search.submit();}
  await wait(150);const index=v.rowProvider._rows.findIndex(r=>r.isObjectRow&&(mode==="evidence"||r.isContainer?.()&&!r.isContainerEmpty?.()));if(index<0)throw Error("Fixture missing");
  const id=v.rowProvider._rows[index].ref.id;if(mode==="evidence")w.document.querySelector(".km-inline-result .twisty").dispatchEvent(new w.MouseEvent("mouseup",{bubbles:true}));else if(!v.rowProvider._rows[index].isOpen)await v.toggleOpenState(index);await wait(100);
  const open=()=>mode==="evidence"?!!w.document.querySelector(".km-inline-evidence"):v.rowProvider._rows.find(r=>r.isObjectRow&&r.ref.id===id)?.isOpen,baseCount=tasks.activeCount,checks=[];
  const panel=w.document.querySelector(".km-retrieval-panel"),card=panel?.querySelector("details");if(card)card.open=false;
  fake={id:"idle-task-notification-probe",kind:"item",title:"Isolated progress fixture",fileName:"fixture.pdf",target:"Fixture",itemType:"journalArticle",status:"parsing",stage:"parse",pages:{completed:1,total:10}};
  for(const [name,update,count]of [["admitted",()=>{},baseCount+1],["progress",()=>{fake={...fake,pages:{completed:2,total:10}};},baseCount+1],["completed",()=>{fake={...fake,status:"completed",stage:"publish"};},baseCount]]){
   update();tasks.refreshTasks();await wait(150);if(!open()||tasks.activeCount!==count)throw Error(mode+"-"+name+"-expansion-or-count");checks.push(name);
   if(mode==="evidence"&&panel&&(w.document.querySelector(".km-retrieval-panel")!==panel||card?.open))throw Error("Evidence DOM replaced or passage reopened");
  }
  report.cases.push({mode,checks,expanded:true,evidenceDomPreserved:mode==="evidence"?!!panel:undefined});
 }
 await w.ZoteroPane.collectionsView.selectByID("Kknowledgemcp:import-tasks");fake={...fake,status:"parsing",stage:"parse",pages:{completed:3,total:10}};tasks.refreshTasks();
 const row=tasks.list.querySelector('[data-task="idle-task-notification-probe"]');if(!row)throw Error("Active task view failed to render changed projection");report.taskPageUpdates=true;
 report.status="passed";
}catch(e){report.status="failed";report.error=String(e);report.stack=e?.stack;}
finally{
 if(source){if(descriptor)Object.defineProperty(source,"snapshot",descriptor);else delete source.snapshot;const app=Zotero.__idleRefreshApp,w=Zotero.getMainWindows()[0];app?.knowledgeUI.windows.get(w)?.tree.tasksView.refreshTasks();await w.ZoteroPane.collectionsView.selectByID("Kknowledgemcp:overview");}
 await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(report,null,2));}})()`);
console.log(output);
