// Read the completed acceptance database into a new copy; never modify its source.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate, runtimeRootURI } from "./verify-vector-native.mjs";
const sourceRun=process.argv[2];if(!/^live-\d+$/.test(sourceRun??""))throw Error("Pass a completed live acceptance run ID.");
const folder=path.resolve(".scaffold/vector-acceptance"),run=`scopes-${Date.now()}`;await fs.mkdir(folder,{recursive:true});
await build({stdin:{loader:"ts",resolveDir:process.cwd(),contents:`
import { initializeDatabase } from "./src/database/client.ts";
import { KnowledgeLibraryRepository } from "./src/repositories/knowledge-library.ts";
import { ZoteroKnowledgeItems } from "./src/integrations/zotero/knowledge-items.ts";
import { EmbeddingService } from "./src/services/embedding.ts";
import { RetrievalService } from "./src/services/retrieval.ts";
import { defaultRetrievalConfig } from "./src/services/retrieval-config.ts";
import { vectorFromBlob } from "./src/providers/models.ts";
export async function run(options){
 const report={run:options.run,runtime:"Zotero native SQLite, FTS and USearch; copied acceptance corpus",started:Date.now(),checks:[],providerCalls:0,queryVector:"existing canonical Float32; no API"};let database,service;
 const assert=(value,name)=>{if(!value)throw Error(name);report.checks.push(name);};
 try{
  if(!Zotero.DataDirectory.dir.toLowerCase().includes("\\\\.scaffold\\\\"))throw Error("isolated-library-required");
  const source=JSON.parse(await IOUtils.readUTF8(PathUtils.join(options.folder,options.sourceRun+".json")));if(source.status!=="passed")throw Error("completed-run-required");
  const file=PathUtils.join(options.folder,options.run+".sqlite");await IOUtils.copy(PathUtils.join(options.folder,options.sourceRun+".sqlite"),file);database=await initializeDatabase(new Zotero.DBConnection(file),file);
  const knowledge=new KnowledgeLibraryRepository(database.db,new ZoteroKnowledgeItems());service=new EmbeddingService(database.db,options.rootURI);
  service.config.current={...JSON.parse(JSON.stringify(defaultRetrievalConfig)),enabled:true,paused:true,autoEmbed:false};service.profile=await service.repository.profile(service.config.current);await service.repository.projectFulltext();
  const row=await service.repository.activeVectors(service.profile).orderBy("e.id").executeTakeFirstOrThrow(),embedding=await database.db.selectFrom("block_embeddings").select("vector").where("id","=",row.id).executeTakeFirstOrThrow(),segment=await database.db.selectFrom("embedding_segments").select("input_text").where("embedding_id","=",row.id).executeTakeFirstOrThrow();
  const vector=vectorFromBlob(embedding.vector,768),query=segment.input_text.match(/[A-Za-z]{4,}/)?.[0]??Array.from(segment.input_text).slice(0,4).join("");
  service.gateway.embed=async()=>[vector];service.gateway.rerank=async(_query,texts)=>texts.map((_,index)=>({index,score:1/(index+1)}));
  const signal=new(Zotero.getMainWindows()[0].AbortController)().signal;await service.store.sync(service.profile,service.config.current,signal);const retrieval=new RetrievalService(service),id=row.resource_id;
  const relation=await database.db.selectFrom("library_resources").select("library_id").where("resource_id","=",id).where("deleted_at","is",null).executeTakeFirstOrThrow();
  await knowledge.moveToTrash([id],[relation.library_id]);
  assert((await retrieval.search(query,"semantic",[id],signal)).hits.length===0,"active-scope-excludes-removed-paper");
  for(const mode of ["fulltext","semantic","enhanced","fusion"]){const result=await retrieval.search(query,mode,[id,"outside"],signal,"trash");assert(result.hits.length===1&&result.hits[0].resourceID===id,"trash-"+mode+"-scoped-hit");}
  const entries=(await knowledge.snapshot()).trash.filter(entry=>entry.resourceIDs.includes(id));await knowledge.restoreTrash(entries.map(entry=>entry.id));
  assert((await retrieval.search(query,"semantic",[id],signal,"trash")).hits.length===0,"restored-paper-leaves-trash-scope");
  assert((await retrieval.search(query,"semantic",[id],signal)).hits[0]?.resourceID===id,"restored-paper-returns-to-active-scope");
  await knowledge.deleteLibrary(relation.library_id,true);
  assert((await retrieval.search(query,"fulltext",[id],signal,"trash")).hits[0]?.resourceID===id,"deleted-library-retains-searchable-published-content");
  assert((await retrieval.search(query,"semantic",[id],signal,"trash")).hits[0]?.resourceID===id,"deleted-library-retains-scoped-vector-search");
  report.status="passed";
 }catch(error){report.status="failed";report.error=String(error?.message??"scope-check-failed");}
 finally{await service?.close();await database?.close();report.finished=Date.now();await IOUtils.writeUTF8(PathUtils.join(options.folder,options.run+".json"),JSON.stringify(report,null,2));}
}
`},bundle:true,format:"iife",globalName:"VectorScopeProbe",platform:"browser",target:"firefox140",outfile:path.join(folder,"scope-probe.js")});
const options={folder,run,sourceRun,rootURI:await runtimeRootURI()};
await evaluate(`Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(path.join(folder,"scope-probe.js")).href)});void VectorScopeProbe.run(${JSON.stringify(options)})`);
console.log(`Dispatched ${run}; only the newly copied database is modified.`);
