import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate, runtimeRootURI } from "./verify-vector-native.mjs";
const sourceRun = process.argv[2];
if (!/^live-\d+$/.test(sourceRun ?? "")) throw Error("Pass a completed live acceptance run ID.");
const folder = path.resolve(".scaffold/vector-acceptance"), run = `recovery-${Date.now()}`;
await build({ stdin: { loader: "ts", resolveDir: process.cwd(), contents: `
import { initializeDatabase } from "./src/database/client.ts";
import { EmbeddingRepository } from "./src/repositories/embeddings.ts";
import { VectorStore } from "./src/services/vector-store.ts";
import { defaultRetrievalConfig } from "./src/services/retrieval-config.ts";
import { vectorFromBlob } from "./src/providers/models.ts";
export async function run(options){
 const report={run:options.run,runtime:"Zotero native disk/worker recovery",processID:Services.appinfo.processID,rootURI:options.rootURI,started:Date.now(),checks:[],providerCalls:0};let database,store;
 const assert=(value,label)=>{if(!value)throw Error(label);report.checks.push(label);};
 try{
  if(!Zotero.DataDirectory.dir.toLowerCase().includes("\\\\.scaffold\\\\"))throw Error("isolated-library-required");
  const source=JSON.parse(await IOUtils.readUTF8(PathUtils.join(options.folder,options.sourceRun+".json")));if(source.status!=="passed")throw Error("completed-live-run-required");
  const dbPath=PathUtils.join(options.folder,options.run+".sqlite");await IOUtils.copy(PathUtils.join(options.folder,options.sourceRun+".sqlite"),dbPath);
  database=await initializeDatabase(new Zotero.DBConnection(dbPath),dbPath);const repo=new EmbeddingRepository(database.db),config={...JSON.parse(JSON.stringify(defaultRetrievalConfig)),enabled:true};
  const profile=await repo.profile(config),snapshot=await database.db.selectFrom("vector_snapshot_state").selectAll().where("profile_id","=",profile).executeTakeFirstOrThrow();
  const copy=PathUtils.join(options.folder,options.run+"-source.usearch");await IOUtils.copy(snapshot.snapshot_path,copy);
  await database.db.updateTable("vector_snapshot_state").set({snapshot_path:copy}).where("profile_id","=",profile).execute();
  const initial=await repo.activeVectors(profile).execute(),canonical=await database.db.selectFrom("block_embeddings").select(["id","vector"]).where("id","=",initial[0].id).executeTakeFirstOrThrow(),query=vectorFromBlob(canonical.vector,768),scope=[...new Set(initial.map(x=>x.resource_id))],controller=new(Zotero.getMainWindows()[0].AbortController)();
  let expected;
  for(let restart=0;restart<3;restart++){store=new VectorStore(repo,options.rootURI);await store.sync(profile,config,controller.signal);const hits=await store.search(query,scope,20);if(!restart)expected=JSON.stringify(hits);assert(JSON.stringify(hits)===expected,"restart-"+restart+"-consistent");await store.close();}
  await IOUtils.write(copy,new Uint8Array([0,1,2,3]));store=new VectorStore(repo,options.rootURI);await store.sync(profile,config,controller.signal);assert(JSON.stringify(await store.search(query,scope,20))===expected,"corrupted-snapshot-rebuilt-from-local-vectors");
  const orphan=PathUtils.join(options.folder,options.run+"-interrupted.usearch");await IOUtils.write(orphan+".tmp",new Uint8Array([9]));await store.close();store=new VectorStore(repo,options.rootURI);await store.sync(profile,config,controller.signal);assert(JSON.stringify(await store.search(query,scope,20))===expected,"interrupted-unpublished-file-ignored");
  const cancelled=new(Zotero.getMainWindows()[0].AbortController)();cancelled.abort();let rejected=false;try{await store.index.save(orphan,cancelled.signal);}catch{rejected=true;}assert(rejected&&!(await IOUtils.exists(orphan+".tmp")),"cancelled-save-cleans-temporary-file");
  const call=store.index.call.bind(store.index);store.index.call=(message,...transfer)=>{const work=call(message,...transfer);if(message.op==="save-slice")store.index.close();return work;};
  let interrupted=false;try{await store.index.save(orphan,controller.signal);}catch{interrupted=true;}assert(interrupted,"worker-terminated-during-snapshot-request");
  await store.close();store=new VectorStore(repo,options.rootURI);await store.sync(profile,config,controller.signal);assert(JSON.stringify(await store.search(query,scope,20))===expected,"worker-crash-restores-last-published-snapshot");
  const before=await repo.port.hash(canonical.vector);await store.sync(profile,{...config,indexMode:"i8"},controller.signal,true);assert((await store.index.stats()).count===initial.length,"int8-rebuild-preserves-count");assert(await repo.port.hash((await database.db.selectFrom("block_embeddings").select("vector").where("id","=",canonical.id).executeTakeFirstOrThrow()).vector)===before,"mode-switch-preserves-canonical-float32");
  for(let offset=0;offset<Math.min(initial.length,1000);offset+=100)await database.db.updateTable("block_embeddings").set({state:"deleted"}).where("id","in",initial.slice(offset,offset+100).map(x=>x.id)).execute();
  await store.sync(profile,{...config,indexMode:"i8"},controller.signal);assert((await store.index.stats()).count===Math.max(0,initial.length-1000),"deletions-and-compaction-reconcile");
  report.stats=await store.index.stats();report.status="passed";
 }catch(error){report.status="failed";report.error=String(error);report.stack=error?.stack;}
 finally{await store?.close();await database?.close();report.finished=Date.now();await IOUtils.writeUTF8(PathUtils.join(options.folder,options.run+".json"),JSON.stringify(report,null,2));}
}` }, bundle: true, format: "iife", platform: "browser", target: "firefox140", globalName: "VectorRecoveryAcceptance", outfile: path.join(folder, "recovery-probe.js") });
const options = { folder, run, sourceRun, rootURI: await runtimeRootURI() };
await evaluate(`Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(path.join(folder, "recovery-probe.js")).href)});void VectorRecoveryAcceptance.run(${JSON.stringify(options)})`);
console.log(`Dispatched ${run}; only a new copy of the acceptance database is modified.`);
