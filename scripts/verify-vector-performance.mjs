// Node dispatches the controller; the measured implementation runs in Zotero.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate, runtimeRootURI } from "./verify-vector-native.mjs";
const folder = path.resolve(".scaffold/vector-acceptance"), run = `performance-${Date.now()}`;
await fs.mkdir(folder, { recursive: true });
const compare = process.argv.includes("--compare");
if (compare) {
  const reference = path.join(folder, "reference-code"); await fs.mkdir(reference, { recursive: true });
  const index = (await fs.readFile("src/services/vector-index.ts", "utf8"))
    .replace('resource://knowledgemcp-vector/worker.js', 'resource://knowledgemcp-vector-reference/worker.js')
    .replace('this.worker!.postMessage({ ...message, id }, transfer);', 'this.worker!.postMessage({ ...message, id });')
    .replace('const changed = !this.scope ||', 'const changed = true || !this.scope ||');
  await fs.writeFile(path.join(reference, "vector-index.ts"), index);
  const worker = (await fs.readFile("src/worker/vector-worker/runtime.ts", "utf8"))
    .replace('"../../../addon/content/vector/usearch.mjs"', JSON.stringify(path.resolve("addon/content/vector/usearch.mjs").replaceAll("\\", "/")))
    .replace('releaseBytes(message.bytes);', '')
    .replace('const chunk = message.bytes && message.bytes.length >= bytes ? message.bytes.subarray(0, bytes) : new Uint8Array(bytes);', 'const chunk = new Uint8Array(bytes);')
    .replace('value instanceof Uint8Array ? [value.buffer as ArrayBuffer] : []', '[]');
  await build({ stdin: { contents: worker, loader: "ts", resolveDir: process.cwd() }, bundle: true, format: "iife", platform: "browser", target: "firefox140", define: { "import.meta.url": "'about:blank'" }, outfile: path.join(reference, "worker.js") });
  await evaluate(`Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler).setSubstitution("knowledgemcp-vector-reference",Services.io.newURI(${JSON.stringify(pathToFileURL(reference).href + "/")}))`);
}
await build({ stdin: { loader: "ts", resolveDir: process.cwd(), contents: `
import { VectorIndex } from "./src/services/vector-index.ts";
${compare ? 'import { VectorIndex as ReferenceIndex } from "./.scaffold/vector-acceptance/reference-code/vector-index.ts";' : 'const ReferenceIndex = VectorIndex;'}
export async function run(options){
 const report={run:options.run,runtime:"Zotero ChromeWorker, production VectorIndex RPC",zotero:Zotero.version,gecko:Services.appinfo.platformVersion,dimensions:768,metric:"normalized cosine",queryCount:500,compactQueries:true,compare:options.compare,rows:[],started:Date.now()};
 const memory=Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager),controller=new(Zotero.getMainWindows()[0].AbortController)();
 const write=()=>IOUtils.writeUTF8(PathUtils.join(options.folder,options.run+".json"),JSON.stringify(report,null,2));
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));let timer,peak=0;
 function stats(values){const sorted=[...values].sort((a,b)=>a-b),mean=values.reduce((a,b)=>a+b,0)/values.length;return {p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],p99:sorted[Math.ceil(sorted.length*.99)-1],mean,sd:Math.sqrt(values.reduce((s,x)=>s+(x-mean)**2,0)/values.length),qps:1000/mean};}
 try{
  if(!Zotero.DataDirectory.dir.toLowerCase().includes("\\\\.scaffold\\\\"))throw Error("isolated-library-required");
  const queryBytes=await IOUtils.read(PathUtils.join(options.data,"cosine","queries.fbin")),queries=new Float32Array(queryBytes.buffer,queryBytes.byteOffset+8,queryBytes.length/4-2);
  for(let repetition=0;repetition<3;repetition++)for(const count of [1000,10000,100000])for(const mode of repetition%2?["i8","f32"]:["f32","i8"])for(const implementation of options.compare?(repetition%2?["production","reference"]:["reference","production"]):["production"]){
   const index=new(implementation==="reference"?ReferenceIndex:VectorIndex)(options.rootURI),row={count,mode,repetition,implementation,status:"running"},labels=Array.from({length:count},(_,i)=>i+1);report.rows.push(row);await write();
   try{
    Cu.forceGC();await sleep(100);const before=memory.resident;peak=before;timer=setInterval(()=>{peak=Math.max(peak,memory.resident);},25);
    const begin=Cu.now();await index.open(768,mode);
    const base=PathUtils.join(options.data,"cosine","base-"+count+".fbin");
    for(let offset=0;offset<count;offset+=100){const bytes=await IOUtils.read(base,{offset:8+offset*768*4,maxBytes:Math.min(100,count-offset)*768*4}),values=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);await index.add(Array.from({length:values.length/768},(_,i)=>({label:offset+i+1,vector:values.slice(i*768,(i+1)*768)})));}
    row.buildMs=Cu.now()-begin;row.buildPeakRSS=peak;row.rssBefore=before;Cu.forceGC();await sleep(1000);row.builtRSS=memory.resident;row.extraBuiltRSS=row.builtRSS-before;row.builtStats=await index.stats();
    for(let q=0;q<30;q++)await index.query(queries.subarray(q*768,(q+1)*768),labels,100);
    const truthBytes=await IOUtils.read(PathUtils.join(options.data,"cosine","ground-truth-"+count+".bin"));
    const truth=new Uint32Array(truthBytes.buffer,truthBytes.byteOffset+8,5000*100),samples=[],rankings=[];let correct20=0,correct100=0;
    for(let q=0;q<500;q++){const start=Cu.now(),hits=await index.query(queries.subarray(q*768,(q+1)*768),labels,100);samples.push(Cu.now()-start);const top20=new Set(truth.subarray(q*100,q*100+20)),top100=new Set(truth.subarray(q*100,(q+1)*100));correct20+=hits.slice(0,20).filter(h=>top20.has(h.label-1)).length;correct100+=hits.filter(h=>top100.has(h.label-1)).length;rankings.push(hits.map(h=>h.label));}
    row.queryMs=stats(samples);row.samples=samples;row.recall20=correct20/(500*20);row.recall100=correct100/(500*100);
    const snapshotPath=PathUtils.join(options.folder,options.run+"-"+implementation+"-"+mode+"-"+count+"-"+repetition+".usearch");peak=memory.resident;const save=Cu.now();row.snapshot=await index.save(snapshotPath,controller.signal);row.saveMs=Cu.now()-save;row.savePeakRSS=peak;row.savedStats=await index.stats();index.close();Cu.forceGC();await sleep(1000);row.closedRSS=memory.resident;
    peak=memory.resident;const restore=Cu.now();await index.open(768,mode);await index.restore(snapshotPath,row.snapshot.hash,row.snapshot.bytes);row.restoreMs=Cu.now()-restore;row.restorePeakRSS=peak;Cu.forceGC();await sleep(1000);row.restoredRSS=memory.resident;row.restoredStats=await index.stats();
    row.restoreConsistent=true;for(let q=0;q<10;q++){const hits=await index.query(queries.subarray(q*768,(q+1)*768),labels,100);if(JSON.stringify(hits.map(h=>h.label))!==JSON.stringify(rankings[q]))row.restoreConsistent=false;}
    row.status=row.restoreConsistent?"passed":"failed";
   }catch(error){row.status="failed";row.error=String(error);}finally{clearInterval(timer);index.close();await write();}
  } report.status=report.rows.every(row=>row.status==="passed")?"passed":"failed";
 }catch(error){report.status="failed";report.error=String(error);}finally{report.finished=Date.now();await write();}
}` }, bundle: true, format: "iife", globalName: "VectorPerformanceAcceptance", platform: "browser", target: "firefox140", outfile: path.join(folder, "performance-probe.js") });
const options = { run, folder, compare, rootURI: await runtimeRootURI(), data: path.resolve(".scaffold/vector-retrieval-lab/datasets/wikipedia-cohere-768") };
await evaluate(`Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(path.join(folder, "performance-probe.js")).href)});void VectorPerformanceAcceptance.run(${JSON.stringify(options)})`);
console.log(`Dispatched ${run}; measurements run entirely inside Zotero.`);
