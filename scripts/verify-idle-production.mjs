// Native UI check against the ordinary packaged addon, without an instrumented application bundle.
import path from "node:path";
import { evaluate } from "./verify-vector-native.mjs";
const output = path.resolve(".scaffold/idle-refresh-diagnostic/production-ui.json");
await evaluate(`void(async()=>{const report={runtime:"Zotero native UI; ordinary production XPI",cases:[]};
const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs"),wait=ms=>new Promise(resolve=>timer.setTimeout(resolve,ms));
const until=async fn=>{for(let i=0;i<300;i++){if(fn())return;await wait(50);}throw Error("UI completion timeout");};
try{
 if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated library required");
 const w=Zotero.getMainWindows()[0],q=w.document.getElementById("zotero-tb-search"),v=w.ZoteroPane.itemsView;
 if(Zotero.__idleRefreshApp)throw Error("Instrumented bundle is still loaded");
 await until(()=>Zotero.__knowledgeMCPRetrieval?.startup?.().state==="ready");
 await w.ZoteroPane.collectionsView.selectByID("Kknowledgemcp:overview");
 for(const mode of ["plain","evidence"]){
  if(mode==="plain"){q.searchModePopup.querySelector('[value="everything"]').dispatchEvent(new w.Event("command",{bubbles:true}));q.searchTextbox.value="";await w.ZoteroPane.search(true);await wait(500);await v.refreshAndMaintainSelection();await wait(100);}
  else{q.searchModePopup.querySelector("#km-search-fulltext").dispatchEvent(new w.Event("command",{bubbles:true}));await wait(100);q.searchTextbox.value="研究";q.searchTextbox.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Enter",bubbles:true}));await until(()=>w.document.querySelector(".km-inline-result .twisty"));}
  const index=v.rowProvider._rows.findIndex(r=>r.isObjectRow&&(mode==="evidence"||r.isContainer?.()&&!r.isContainerEmpty?.()));if(index<0)throw Error("Expandable fixture row missing");
  const id=v.rowProvider._rows[index].ref.id;if(mode==="evidence")w.document.querySelector(".km-inline-result .twisty").dispatchEvent(new w.MouseEvent("mouseup",{bubbles:true}));else if(!v.rowProvider._rows[index].isOpen)await v.toggleOpenState(index);
  const states=[];for(let i=0;i<10;i++){await wait(1000);states.push(mode==="evidence"?!!w.document.querySelector(".km-inline-evidence"):!!v.rowProvider._rows.find(r=>r.isObjectRow&&r.ref.id===id)?.isOpen);}
  if(!states.every(Boolean))throw Error(mode+"-expansion-changed");report.cases.push({mode,seconds:10,expanded:states});
 }
 report.status="passed";
}catch(e){report.status="failed";report.error=String(e);report.stack=e?.stack;}
finally{const w=Zotero.getMainWindows()[0],q=w.document.getElementById("zotero-tb-search");q.searchModePopup.querySelector('[value="everything"]')?.dispatchEvent(new w.Event("command",{bubbles:true}));q.searchTextbox.value="";await w.ZoteroPane.search(true);await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(report,null,2));}})()`);
console.log(output);
