import assert from "node:assert/strict";
import { test } from "node:test";
import { api, parsingFixture } from "./fixtures/parsing.mjs";

const parsed = (id="parse") => ({id,kind:"item",title:"Paper",fileName:"paper.pdf",target:"Folder",itemType:"journalArticle",stage:"publish",status:"completed",parentID:"batch-source",
  processing:{sourceID:"source",generationID:"generation",parseTaskID:id},parser:{provider:"paddleocr",model:"OCR"}});

test("semantic applicability follows configuration without removing existing paused work", () => {
  for (const [config, plan] of [[{ enabled: false }, "disabled"], [{ enabled: true, autoEmbed: false }, "manual"], [{ enabled: true, autoEmbed: true }, "automatic"], [{ enabled: true, autoEmbed: true, paused: true }, "paused"]]) {
    const source = new api.ImportTasksService({ snapshot: () => [parsed()] }, { snapshot: () => [] }, { snapshot: () => [], config: { current: config } });
    assert.equal(source.snapshot()[0].semanticPlan, plan);
    assert.equal(source.snapshot()[0].status, "completed", "presentation does not rewrite durable job state");
  }
});
const vector = (status="queued",id="embed:vector") => ({...parsed(id),parentID:undefined,stage:status==="publishing"||status==="completed"?"index":"embed",status,
  processing:{sourceID:"source",generationID:"generation"},parser:{provider:"bailian",model:"Qwen"},embedding:{dimensions:768,active:true,current:true},counts:{completed:4,skipped:1,failed:0,total:10}});

test("one attachment generation combines parse and vector stages, retaining parser identity and folder grouping",()=>{
  const older={...vector("completed","embed:old"),embedding:{dimensions:512,active:false,current:false}};
  const tasks=api.mergeImportTasks([parsed()],[older,vector("publishing")]);assert.equal(tasks.length,1);
  const task=tasks[0];assert.equal(task.id,"parse");assert.equal(task.parentID,"batch-source");assert.equal(task.stage,"index");assert.equal(task.status,"publishing");
  assert.equal(task.parser.provider,"paddleocr");assert.equal(task.embedding.provider,"bailian");assert.equal(task.embedding.taskID,"embed:vector");assert.equal(task.embedding.dimensions,768);
});

test("different generations do not merge and hidden parse history uses a stable unified workflow identity",()=>{
  const old=parsed();old.processing.generationID="old-generation";
  const tasks=api.mergeImportTasks([old],[vector()]);assert.equal(tasks.length,2);assert.equal(tasks[0].stage,"publish");
  assert.match(tasks[1].id,/^pipeline:/);assert.ok(!tasks[1].id.includes('"'));assert.equal(tasks[1].parser,undefined);
  assert.equal(api.mergeImportTasks([],[vector("completed")])[0].id,tasks[1].id);
});

test("partial parsing warnings do not become vector errors and remain visible after vector completion",()=>{
  const partial={...parsed(),status:"partial",errorCode:"partial"};
  assert.equal(api.mergeImportTasks([partial],[vector("queued")])[0].errorCode,undefined);
  const completed=api.mergeImportTasks([partial],[vector("completed")])[0];assert.equal(completed.status,"partial");assert.equal(completed.errorCode,"partial");
  assert.equal(completed.processing.contentPartial,true);
  assert.equal(api.mergeImportTasks([partial],[{...vector("failed"),errorCode:"network"}])[0].errorCode,"network");
});

test("pipeline retry/cancel operate on vector work without reparsing; completed retry reparses and delete clears both histories",async()=>{
  let vectors=[vector("failed")];const calls=[];
  const source=new api.ImportTasksService({snapshot:()=>[parsed()],runAction:async(...args)=>calls.push(["parse",...args])},{snapshot:()=>[]},
    {snapshot:()=>vectors,runAction:async(...args)=>calls.push(["vector",...args])});
  await source.runAction("parse","retry");await source.runAction("parse","cancel");assert.deepEqual(calls.map(row=>row.slice(0,3)),[["vector","embed:vector","retry"],["vector","embed:vector","cancel"]]);
  vectors=[vector("queued")];await assert.rejects(source.runAction("parse","delete"),/stale/);
  vectors=[vector("completed")];await source.runAction("parse","retry");assert.equal(calls.at(-1)[0],"parse");
  await source.runAction("parse","delete");assert.deepEqual(calls.slice(-2).map(row=>row.slice(0,3)),[["vector","embed:vector","delete"],["parse","parse","delete"]]);
});

test("batch retries route embedding failures to their original pipeline instead of calling the parser again",async()=>{
  const calls=[],folder={id:"batch-source",kind:"folder",mode:"import",title:"Folder",target:"KB",sourceCollection:"Source",status:"completed"};
  const source=new api.ImportTasksService({snapshot:()=>[folder,parsed()],runAction:async(...args)=>calls.push(["parse",...args])},{snapshot:()=>[]},
    {snapshot:()=>[vector("failed")],runAction:async(...args)=>calls.push(["vector",...args])});
  await source.runAction(folder.id,"retry");assert.deepEqual(calls,[["vector","embed:vector","retry"]]);
});

test("real parse and embedding projections join by durable source and generation identities",async t=>{
  const f=await parsingFixture(t);f.input.batch={id:"source",title:"Folder",sourceCollection:"Collection"};await f.enqueue();await f.step();await f.step();
  const knowledge={snapshot:await f.repo.snapshot()},parsing=new api.ParsingService(f.db,knowledge,f.port),embedding=new api.EmbeddingService(f.db,"file:///fixture/");
  f.beforeClose(()=>parsing.close());f.beforeClose(()=>embedding.close());await parsing.refresh();embedding.config.current={...embedding.config.current,enabled:true};
  embedding.profile=await embedding.repository.profile(embedding.config.current);await embedding.repository.reconcile(embedding.profile,embedding.config.current);await embedding.refresh();
  const source=new api.ImportTasksService(parsing,{snapshot:()=>[]},embedding),items=source.snapshot().filter(task=>task.kind==="item");
  assert.equal(items.length,1);assert.equal(items[0].stage,"embed");assert.equal(items[0].parentID,"batch-source");assert.ok(items[0].processing.generationID);assert.ok(items[0].embedding.taskID);
});
