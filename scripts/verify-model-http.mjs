// Development controller: real requests and connection timings run in Zotero.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate } from "./verify-vector-native.mjs";

const folder = path.resolve(".scaffold/vector-acceptance");
await fs.mkdir(folder, { recursive: true });
const run = `http-${Date.now()}`;
await build({ stdin: { loader: "ts", resolveDir: process.cwd(), contents: `
import { BrowserParseTransport } from "./src/parsers/transport.ts";
import { modelProviders } from "./src/providers/models.ts";
import { readLiveModelSettings } from "./scripts/fixtures/live-model-settings.ts";
export async function run(options) {
 const window=Zotero.getMainWindows()[0],report={run:options.run,runtime:"Zotero native fetch / Gecko connection pool",zotero:Zotero.version,gecko:Services.appinfo.platformVersion,
  started:Date.now(),rows:[],warmups:[],repetitions:12,spacingMs:1100,dimension:768,freshFlagProbe:options.probeFreshFlag},
  write=()=>IOUtils.writeUTF8(PathUtils.join(options.folder,options.run+".json"),JSON.stringify(report,null,2)),
  sleep=ms=>new Promise(resolve=>window.setTimeout(resolve,ms));
 let current,activity,observer,observing=false,activityRegistered=false;
 try {
  if(!Zotero.DataDirectory.dir.toLowerCase().includes("\\\\.scaffold\\\\"))throw Error("isolated-library-required");
  const live=await readLiveModelSettings(),endpoint=live.config.embedding.endpoint;
  const provider=modelProviders.get("bailian"),retained=new BrowserParseTransport(),controller=new window.AbortController();
  const distributor=Cc["@mozilla.org/network/http-activity-distributor;1"].getService(Ci.nsIHttpActivityDistributor);
  activity={get isActive(){return true;},observeActivity(){},QueryInterface:ChromeUtils.generateQI(["nsIHttpActivityObserver"])};
  distributor.addObserver(activity);activityRegistered=true;
  observer={observe(subject){
   if(!current)return;
   try{
    const channel=subject.QueryInterface(Ci.nsIHttpChannel);
    if(channel.URI.spec!==current.url)return;
    current.channels.push(channel);
    if(current.mode==="fresh-connection")channel.loadFlags|=Ci.nsIRequest.LOAD_FRESH_CONNECTION;
   }catch{current.observerError=true;}
  }};
  Services.obs.addObserver(observer,"http-on-modify-request");observing=true;
  let lastStarted=0;
  const execute=async(operation,mode,repetition,warmup=false)=>{
   await sleep(Math.max(0,1100-(Date.now()-lastStarted)));lastStarted=Date.now();
   const row={operation,mode,repetition,warmup,status:"running"},channels=[];
   const url=operation==="embedding"?endpoint:live.config.rerank.endpoint;
   current={url,mode,channels};
   const transport=mode==="new-transport"?new BrowserParseTransport():retained;
   const key=operation==="embedding"?live.embeddingKey:live.rerankKey;
   const context={key,signal:controller.signal,config:{provider:"bailian",model:operation==="embedding"?live.config.embedding.model:live.config.rerank.model,endpoint:url,credentialRef:"probe"},
    request:async(url,body)=>{const response=await transport.request(url,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+key},body:JSON.stringify(body),redirect:"error"},60000,4*1024*1024,controller.signal);return JSON.parse(new TextDecoder().decode(response.bytes));}};
   const start=Cu.now();
   try{
    if(operation==="embedding")await provider.embedding.embed(context,["How do bank inspections affect lending and credit risk?"],768,true);
    else await provider.rerank.rerank(context,"How do bank inspections affect lending and credit risk?",[
     "On-site inspections can change banks' lending decisions and their assessment of credit risk.",
     "Liquidity provision and monitoring are central functions of commercial banks.",
     "Hot air drying changes the thermal and physical properties of algae.",
     "Stock market tick size affects measured transaction costs and liquidity.",
     "Shared equity housing contracts allocate ownership and consumption rights."
    ]);
    row.status="passed";
   }catch(error){row.status="failed";row.error=error?.code??"request-failed";}
   row.elapsedMs=Cu.now()-start;row.observerError=!!current.observerError;row.channels=[];
   for(const channel of channels){
    const sample={};
    try{
     const internal=channel.QueryInterface(Ci.nsIHttpChannelInternal),major={},minor={};internal.getResponseVersion(major,minor);
     sample.httpVersion=major.value+"."+minor.value;sample.localPort=internal.localPort;sample.remotePort=internal.remotePort;
    }catch{sample.endpointUnavailable=true;}
    try{
     const timed=channel.QueryInterface(Ci.nsITimedChannel),fields=["asyncOpen","domainLookupStart","domainLookupEnd","connectStart","tcpConnectEnd","secureConnectionStart","connectEnd","requestStart","responseStart","responseEnd"],times={};
     for(const field of fields)times[field]=timed[field+"Time"];
     sample.relativeMs=Object.fromEntries(fields.map(field=>[field,times[field]&&times.asyncOpen?(times[field]-times.asyncOpen)/1000:null]));
     const delta=(start,end)=>times[start]&&times[end]?(times[end]-times[start])/1000:null;
     sample.dnsMs=delta("domainLookupStart","domainLookupEnd");sample.connectMs=delta("connectStart","connectEnd");
     sample.tlsMs=delta("secureConnectionStart","connectEnd");sample.requestToFirstByteMs=delta("requestStart","responseStart");
    }catch{sample.timingUnavailable=true;}
    row.channels.push(sample);
   }
   current=undefined;(warmup?report.warmups:report.rows).push(row);await write();
  };
  for(const operation of ["embedding","rerank"])await execute(operation,"retained-transport",-1,true);
  // LOAD_FRESH_CONNECTION is an optional diagnostic request, not a guarantee.
  // Confirm an actual new socket/handshake before treating it as a cold sample.
  const modes=["retained-transport","new-transport",...(options.probeFreshFlag?["fresh-connection"]:[])];
  for(let repetition=0;repetition<12;repetition++)for(const operation of repetition%2?["rerank","embedding"]:["embedding","rerank"])
   for(let offset=0;offset<modes.length;offset++)await execute(operation,modes[(offset+repetition)%modes.length],repetition);
  report.status=report.rows.every(row=>row.status==="passed")?"passed":"failed";
  if(observing){Services.obs.removeObserver(observer,"http-on-modify-request");observing=false;}
  if(activityRegistered){distributor.removeObserver(activity);activityRegistered=false;}
 }catch(error){report.status="failed";report.error=["isolated-library-required","bailian-only"].includes(error?.message)?error.message:"native-probe-failed";}
 finally{
  if(observing)Services.obs.removeObserver(observer,"http-on-modify-request");
  if(activityRegistered)Cc["@mozilla.org/network/http-activity-distributor;1"].getService(Ci.nsIHttpActivityDistributor).removeObserver(activity);
  report.finished=Date.now();await write();
 }
}
` }, bundle: true, format: "iife", globalName: "ModelHTTPProbe", platform: "browser", target: "firefox140", outfile: path.join(folder, "http-probe.js") });
if (process.argv.includes("--prepare-only")) {
  console.log("Prepared native HTTP probe; no debugger connection or provider request.");
} else {
  const options = { run, folder, probeFreshFlag: process.argv.includes("--probe-fresh-flag") };
  await evaluate(`Services.scriptloader.loadSubScript(${JSON.stringify(pathToFileURL(path.join(folder, "http-probe.js")).href)});void ModelHTTPProbe.run(${JSON.stringify(options)})`);
  console.log(`Dispatched ${run}; only sanitized timings and connection metadata are saved.`);
}
