// Native UI checks in a disposable isolated window; no model calls or library writes.
import fs from "node:fs/promises";
import path from "node:path";
import { evaluate } from "./verify-vector-native.mjs";
import { submitFulltextSearch } from "./native-search-feedback.mjs";
const folder=path.resolve(".scaffold/vector-acceptance");await fs.mkdir(folder,{recursive:true});
const output=path.join(folder,"native-pipeline-scope.json");
await evaluate(`void(async()=>{
 const original=Zotero.getMainWindows(),pref="extensions.zotero.knowledgemcp.retrievalSelection",
  saved={mode:Zotero.Prefs.get(pref,true),native:Zotero.Prefs.get("search.quicksearch-mode")},
  report={runtime:"native pipeline and retrieval scopes; disposable window",started:Date.now(),checks:[],scopes:[],providerCalls:0};
 const state=window=>({query:window.document.getElementById("zotero-tb-search").searchTextbox.value,rows:window.ZoteroPane.itemsView.rowProvider._rows.map(row=>[row.ref.id,row.isOpen]),selected:window.ZoteroPane.getSelectedItems().map(item=>item.id),scrollTop:window.ZoteroPane.itemsView.tree._jsWindow?.targetElement.scrollTop}),originalState=original.map(state);
 const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
 const submitFulltextSearch=${submitFulltextSearch.toString()};
 let window,doc,pane,view,q;
 const wait=ms=>new Promise(resolve=>timer.setTimeout(resolve,ms)),until=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await wait(100);}throw Error("pipeline-ui-timeout");},
  assert=(value,name)=>{if(!value)throw Error(name);report.checks.push(name);},
  select=async id=>{let index=view._rows.findIndex(row=>row.id===id);if(index<0){const root=view._rows.findIndex(row=>row.id==="Kknowledgemcp:overview");if(root<0)throw Error("knowledge-root-missing");if(!view._rows[root].isOpen)await view.toggleOpenState(root);index=view._rows.findIndex(row=>row.id===id);}if(index<0)throw Error("scope-row-missing");await view.selectWait(index);await pane.onCollectionSelected();await until(()=>pane.itemsView.collectionTreeRows.some(row=>row.id===id));},
  submit=async query=>{const result=await submitFulltextSearch(window,q,query);await wait(100);return result;};
 try{
  if(!Zotero.DataDirectory.dir.toLowerCase().includes("\\\\.scaffold\\\\"))throw Error("isolated-library-required");
  assert(!Zotero.startupError,"no-existing-native-fatal-error");
  Zotero.openMainWindow();await until(()=>{window=Zotero.getMainWindows().find(candidate=>!original.includes(candidate));return window?.document.readyState==="complete"&&window.ZoteroPane?.itemsView?.tree?._jsWindow&&window.document.getElementById("zotero-tb-search")?.searchModePopup?.querySelector("#km-search-fulltext")&&window.ZoteroPane.collectionsView?._rows.some(row=>row.id==="Kknowledgemcp:overview");});
  doc=window.document;pane=window.ZoteroPane;view=pane.collectionsView;q=doc.getElementById("zotero-tb-search");
  const failed=new Localization(["knowledgemcp.ftl"],true).formatValueSync("knowledgemcp-vector-search-failed");
  for(const id of ["Kknowledgemcp:overview","Kknowledgemcp:trash"]){
   await select(id);await until(()=>[...q.searchModePopup.querySelectorAll("[data-mode]")].every(menu=>menu.getAttribute("disabled")!=="true"));assert(q.searchModePopup.querySelectorAll("[data-mode]").length===4,id+"-search-menu-entries-enabled");
   const allowed=new Set((await pane.itemsView.collectionTreeRows[0].getItems({unfiltered:true})).map(item=>item.id));
   q.searchModePopup.querySelector("#km-search-fulltext").dispatchEvent(new window.Event("command",{bubbles:true}));await wait(150);
   const result=await submit("liquidity");assert(result.feedback!==failed,id+"-scope-search-completed");
   const hits=pane.itemsView.rowProvider._rows.map(row=>row.ref.id);
   assert(hits.every(id=>allowed.has(id)),id+"-all-result-references-scope-contained");report.scopes.push({id,resultCount:hits.length,allowedItems:allowed.size});
   const empty=await submit("zqvpxunfindable795124");assert(empty.feedback!==failed&&pane.itemsView.rowProvider._rows.length===0,id+"-empty-results-complete");
   const failure=await submit("x".repeat(8001));assert(failure.feedback===failed,id+"-failure-feedback-detected");
   const recovered=await submit("liquidity");assert(recovered.feedback!==failed,id+"-search-recovers-after-error");
  }
  await select("Kknowledgemcp:import-tasks");assert([...q.searchModePopup.querySelectorAll("[data-mode]")].every(menu=>menu.getAttribute("disabled")==="true"),"task-view-still-disables-search");
  await until(()=>doc.getElementById("km-import-tasks"));
  const rows=[...doc.querySelectorAll("#km-import-tasks tr[data-task]")];report.taskRows=rows.length;
  assert(!rows.some(row=>row.dataset.task.startsWith("embed:")),"no-separate-embedding-task-rows");
  const item=rows.find(row=>!row.dataset.task.startsWith("batch-"));assert(!!item,"existing-document-workflow-present");item.querySelector(".km-task-select").click();
  const steps=[...doc.querySelectorAll("#km-import-task-details .km-task-steps li")],l10n=new Localization(["knowledgemcp.ftl"],true);
  assert(steps.length===7,"single-seven-stage-workflow");
  assert(steps[4].textContent.includes(l10n.formatValueSync("knowledgemcp-tasks-step-publish"))&&steps[5].textContent.includes(l10n.formatValueSync("knowledgemcp-tasks-step-embed"))&&steps[6].textContent.includes(l10n.formatValueSync("knowledgemcp-tasks-step-index")),"vector-and-index-follow-publication");
  report.steps=steps.map(step=>({text:step.textContent,state:step.className}));report.locales=[];
  for(const locale of ["en-US","zh-CN","zh-TW","de","fr-FR","es-ES","ja-JP"]){const localized=new Localization(["knowledgemcp.ftl"],true,undefined,[locale]),pending=localized.formatValueSync("knowledgemcp-vector-task-awaiting");assert(!!pending&&!pending.includes("knowledgemcp-"),"pending-stage-native-locale-"+locale);report.locales.push({locale,pending});}
  assert(!Zotero.startupError,"no-native-fatal-error");report.status="passed";
 }catch(error){report.status="failed";report.error=String(error?.message??"pipeline-check-failed");}
 finally{
  try{if(window&&!window.closed)window.close();
   if(saved.mode===undefined)Zotero.Prefs.clear(pref,true);else Zotero.Prefs.set(pref,saved.mode,true);
   if(saved.native===undefined)Zotero.Prefs.clear("search.quicksearch-mode");else Zotero.Prefs.set("search.quicksearch-mode",saved.native);
   report.originalWindowsUnchanged=original.every((window,i)=>!window.closed&&JSON.stringify(state(window))===JSON.stringify(originalState[i]));
   if(!report.originalWindowsUnchanged)throw Error("original-window-state-changed");report.uiRestored=true;
  }catch(error){report.status="failed";report.restoreError=String(error);}
  report.finished=Date.now();await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(report,null,2));
 }
})()`);
console.log(`Dispatched native pipeline/scope checks; read ${output}`);
