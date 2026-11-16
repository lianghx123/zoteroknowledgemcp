// Explicit live acceptance: credentials are read inside Zotero and never returned.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate, runtimeRootURI } from "./verify-vector-native.mjs";
const folder = path.resolve(".scaffold/vector-acceptance"), run = `live-${Date.now()}`;
const resume = process.argv.slice(2).find(value => value !== "--prepare-only");
if (resume && !/^live-\d+$/.test(resume)) throw Error("An optional resume argument must identify a completed live run.");
await fs.mkdir(folder, { recursive: true });
const contents = `
import { initializeDatabase } from "./src/database/client.ts";
import { KnowledgeLibraryRepository } from "./src/repositories/knowledge-library.ts";
import { ProcessingRepository } from "./src/repositories/processing.ts";
import { ZoteroParsingPort } from "./src/integrations/zotero/parsing-port.ts";
import { ZoteroKnowledgeItems } from "./src/integrations/zotero/knowledge-items.ts";
import { ModelCredentials } from "./src/integrations/zotero/model-credentials.ts";
import { EmbeddingService } from "./src/services/embedding.ts";
import { RetrievalService } from "./src/services/retrieval.ts";
import { readLiveModelSettings } from "./scripts/fixtures/live-model-settings.ts";
export async function run(options) {
  const report={runtime:"Zotero 10 / live Bailian",run:options.run,started:Date.now(),queries:[],mapping:[],stages:[],network:[]};
  let database,service; const credentials=new ModelCredentials(), ref="acceptance-"+options.run,rerankRef=ref+"-rerank";
  const write=async()=>IOUtils.writeUTF8(PathUtils.join(options.folder,options.run+".json"),JSON.stringify(report,null,2));
  try {
    if(!Zotero.DataDirectory.dir.toLowerCase().includes("\\\\.scaffold\\\\"))throw Error("isolated-library-required");
    const live=await readLiveModelSettings();
    await credentials.set(ref,live.embeddingKey);await credentials.set(rerankRef,live.rerankKey);
    const databaseRun=options.resume??options.run;
    if(options.resume){const previous=JSON.parse(await IOUtils.readUTF8(PathUtils.join(options.folder,options.resume+".json")));if(previous.status!=="passed")throw Error("completed-run-required");report.mapping=previous.mapping;report.persistedVectorSource=options.resume;}
    database=await initializeDatabase(new Zotero.DBConnection(PathUtils.join(options.folder,databaseRun+".sqlite")),PathUtils.join(options.folder,databaseRun+".sqlite"));
    const port=new ZoteroParsingPort(), repository=new KnowledgeLibraryRepository(database.db,new ZoteroKnowledgeItems()), processing=new ProcessingRepository(database.db,port);
    await repository.initialize(); const target={libraryID:(await repository.snapshot()).libraries[0].id,nodeID:null};
    const corpus=JSON.parse(await IOUtils.readUTF8(options.corpus)), queries=JSON.parse(await IOUtils.readUTF8(options.queries)), grouped=new Map();
    for(const row of corpus){const rows=grouped.get(row.resourceID)??[];rows.push(row);grouped.set(row.resourceID,rows);}
    let index=0;
    for(const [oldID,rows] of grouped){
      if(options.resume)continue;
      index++;const key="VEC"+String(index).padStart(5,"0"),attachmentKey="VEP"+String(index).padStart(5,"0"),nativeLibrary=Zotero.Libraries.userLibraryID;
      const resourceID=await repository.save({library:{localID:nativeLibrary,type:"user",externalID:null,name:"Vector acceptance",editable:true,filesEditable:true},
        itemID:900000+index,key,kind:"regular",nativeVersion:1,modified:"2026-10-24",state:"current",title:rows[0].title,itemType:"journalArticle",language:null,abstract:null,publicationDate:null,
        contributors:[],fields:{},tags:[],metadataFingerprint:await port.hash(rows[0].title),fingerprint:await port.hash(oldID),
        attachments:[{key:attachmentKey,itemID:910000+index,parentKey:key,title:"Acceptance source",mediaType:"application/pdf",linkMode:0,state:"current"}]},target);
      const source=await processing.sourceFor(nativeLibrary,attachmentKey),fingerprint=await port.hash(oldID),input={sourceID:source.id,resourceID,libraryID:nativeLibrary,attachmentKey,title:rows[0].title,itemType:"journalArticle",fileName:"acceptance.pdf",target:"Acceptance",
        parser:{profile:"acceptance",api:"https://example.invalid",model:"snapshot",options:{},normalizer:"acceptance-source-map-1"}};
      await processing.enqueue(input,fingerprint,3);const job=await processing.claim("acceptance");
      const blocks=rows.map(row=>({type:row.type,label:row.type,markdown:row.text,text:row.text,page:row.page??1,sourceID:row.id,bbox:null,metadata:{originalBlockID:row.id,originalGenerationID:row.generationID}}));
      const generation=await processing.publish(job,{normalizerVersion:"acceptance-source-map-1",sectionHierarchy:"heading-levels",pages:[...new Set(blocks.map(b=>b.page))].map(number=>({number,raw:{}})),blocks,total:Math.max(...blocks.map(b=>b.page)),partial:false,warnings:[],markdown:blocks.map(b=>b.markdown).join("\\n\\n")},[]);
      report.mapping.push({originalResourceID:oldID,resourceID,sourceID:source.id,generation,blocks:rows.length});
    }
    service=new EmbeddingService(database.db,options.rootURI);service.config.current={...live.config,enabled:true,autoEmbed:true,paused:false,shareCredential:false,requestsPerMinute:60,
      embedding:{...live.config.embedding,credentialRef:ref},rerank:{...live.config.rerank,credentialRef:rerankRef}};
    service.gateway.onRequest=event=>report.network.push(event);
    await write();
    const started=Date.now();
    for(let i=0;i<grouped.size+1;i++){
      await service.tick(); const jobs=await database.db.selectFrom("processing_jobs").select(["state","error_code"]).where("kind","=","embed").execute();
      report.stages.push({stage:"embedding",elapsedMs:Date.now()-started,jobs:jobs.map(j=>({state:j.state,code:j.error_code}))});await write();
      if(jobs.every(j=>j.state==="succeeded"))break;if(jobs.some(j=>j.state==="failed"))throw Error("embedding-job-failed");
    }
    const retrieval=new RetrievalService(service),scope=report.mapping.map(row=>row.resourceID),controller=new(Zotero.getMainWindows()[0].AbortController)();
    for(const query of queries){
      const start=Date.now(),semantic=await retrieval.search(query.text,"semantic",scope,controller.signal),enhanced=await retrieval.search(query.text,"enhanced",scope,controller.signal);
      const expected=report.mapping.find(row=>row.originalResourceID===query.expectedResourceID)?.resourceID;
      report.queries.push({id:query.id,category:query.category,expectedResourceID:expected,semantic:semantic.hits.map(h=>({id:h.resourceID,score:h.score,evidence:h.evidence.length})),enhanced:enhanced.hits.map(h=>({id:h.resourceID,score:h.score,evidence:h.evidence.length})),channels:enhanced.channels,degraded:enhanced.degraded,semanticTimings:semantic.timings,timings:enhanced.timings,totalMs:Date.now()-start});await write();
    }
    report.fulltext=await retrieval.search(queries[0].text,"fulltext",scope,controller.signal);report.fusion=await retrieval.search(queries[0].text,"fusion",scope,controller.signal);
    report.vectorCount=(await service.repository.activeVectors(service.profile).execute()).length;report.stats=await service.store.index.stats();report.status="passed";
  }catch(error){report.status="failed";report.error=error?.code??String(error);report.stack=error?.stack;}
  finally{await service?.close();await database?.close();await credentials.set(ref,"");await credentials.set(rerankRef,"");report.finished=Date.now();await write();}
}`;
await build({ stdin: { contents, loader: "ts", resolveDir: process.cwd() }, bundle: true, format: "iife", platform: "browser", target: "firefox140", globalName: "VectorLiveAcceptance", outfile: path.join(folder, "live-probe.js") });
if (process.argv.includes("--prepare-only")) {
  console.log("Prepared native live-vector probe; no debugger connection or provider request.");
} else {
  const options = { run, folder, resume, rootURI: await runtimeRootURI(),
    corpus: path.resolve(".scaffold/vector-retrieval-lab/data/corpus.json"), queries: path.resolve(".scaffold/vector-retrieval-lab/data/queries.json") };
  await evaluate(`Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(path.join(folder, "live-probe.js")).href)});void VectorLiveAcceptance.run(${JSON.stringify(options)})`);
  console.log(`Dispatched live run: ${run}. Read the sanitized report in .scaffold/vector-acceptance.`);
}
