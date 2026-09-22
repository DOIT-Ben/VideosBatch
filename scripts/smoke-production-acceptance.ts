import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
const root=process.argv[3] || mkdtempSync(path.join(os.tmpdir(),"videosbatch-acceptance-"));process.chdir(root);
const [{CinemaStore},{registerVideosBatchWorkflowApi},{createPhase1FakeStageRegistry},{createVideosBatchWorkflow},{EditingService}]=await Promise.all([
  import("../src/server/store"),import("../src/server/videosBatchWorkflow/api"),import("../src/server/videosBatchWorkflow/stages"),import("../src/shared/videosBatchWorkflow"),import("../src/server/productionRuns/editingService")]);
let store=new CinemaStore();await store.load();
const registry=createPhase1FakeStageRegistry();
const app=express();app.use(express.json());
let engine=registerVideosBatchWorkflowApi(app,store,registry,{authorizeSession:(session,req)=>session.ownerUserId===req.header("x-user")});await engine.ready;
if(process.argv[2]==="restore"){
  const saved=JSON.parse(readFileSync("expected.json","utf8"));
  for(const value of saved){assert.deepEqual(store.getSession(value.id)?.videosBatchWorkflow,value.workflow);assert.deepEqual(engine.repository.list(value.id),value.runs);}
  assert.equal(engine.repository.journal.pending().length,0);engine.close();console.log("quiescent full backup restored; workflows, revisions and run identities equal");process.exit(0);
}
let editing=new EditingService(engine);
const server=app.listen(0,"127.0.0.1");await once(server,"listening");
const origin=`http://127.0.0.1:${(server.address() as any).port}`;
const post=async(route:string,body:any)=>{const response=await fetch(origin+route,{method:"POST",headers:{"content-type":"application/json","x-user":"owner"},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json() as Promise<any>;};
const batch=async(action:string,ids:string[],key:string)=>post("/api/production/batch",{action,items:await post("/api/production/batch/preview",{action,sessionIds:ids}),requestId:key});
const until=async(check:()=>boolean)=>{for(let i=0;i<500;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail("condition timeout");};
const counts=new Map<string,number>();const ended=new Map<string,number>();const latency:number[]=[];
let holding=false;let failOnce=true;const releases=new Map<string,()=>void>();
for(const stageId of ["ASSET_PLAN","ASSET_CANDIDATES"] as const){const execute=registry[stageId]!.execute;registry[stageId]!.execute=async ctx=>{
  const key=`${ctx.session.id}:${stageId}`;counts.set(key,(counts.get(key)||0)+1);
  if(holding&&stageId==="ASSET_PLAN"&&["A","C"].includes(ctx.session.title))await new Promise<void>(resolve=>releases.set(ctx.session.title,resolve));
  if(ctx.session.title==="C"&&stageId==="ASSET_PLAN"&&failOnce){failOnce=false;throw Object.assign(new Error("synthetic retryable failure"),{retryable:true});}
  const result=await execute(ctx);ended.set(ctx.session.id,performance.now());return result;
};}
function observeQueue(){const update=engine.repository.update.bind(engine.repository);engine.repository.update=(id,patch)=>{const result=update(id,patch);if(patch.status==="queued"&&ended.has(result.sessionId)){latency.push(performance.now()-ended.get(result.sessionId)!);ended.delete(result.sessionId);}return result;};}
observeQueue();
async function create(title:string,confirm=true){const session=await store.createSession({title,shotCount:0} as any,"owner");await store.updateSession(session.id,{videosBatchWorkflow:createVideosBatchWorkflow({projectId:"P001",lessonText:"合成教案：观察水的三态变化。"})});await engine.wait((await engine.start(session.id,"next",`intro:${title}`)).id);if(confirm){await confirmIntro(session.id,false);await engine.wait((await engine.start(session.id,"next",`story:${title}`)).id);}return session.id;}
async function confirmIntro(id:string,advance:boolean){const wf=store.getSession(id)!.videosBatchWorkflow!;const candidate=wf.stages.COURSE_INTRO_CANDIDATES!.artifact.candidates[0];return editing.publish(id,"owner",{requestId:`confirm:${id}`,stageId:"COURSE_INTRO_SELECTION",expectedRevision:0,artifact:{selectedIntroId:candidate.id,confirmedEntry:candidate,selectionMode:"user_selected",selectionReason:"合成验收人工选择",locked:true},continue:advance});}
try{
  const A=await create("A"),B=await create("B",false),C=await create("C"),D=await create("D"),E=await create("E");
  const initial=structuredClone(store.getSession(A)!.videosBatchWorkflow!);
  const story=store.getSession(D)!.videosBatchWorkflow!.stages.STORY_SCRIPT!;
  engine.repository.editing.sync({id:"D-draft",ownerId:"owner",sessionId:D,stageId:"STORY_SCRIPT",instanceId:"browser",clientVersion:1,baseRevision:story.revision,baseSignature:"fixture",value:story.artifact.content+"保留编辑。"});
  holding=true;
  const ar=await engine.start(A,"all","A-auto"),cr=await engine.start(C,"all","C-auto"),dr=await engine.start(D,"all","D-held"),er=await engine.start(E,"all","E-queue");
  await until(()=>releases.size===2);assert.equal(engine.repository.get(er.id)?.status,"queued");assert.equal(engine.repository.get(dr.id)?.status,"waiting_input");
  const paused=await batch("pause",[A,E],"pause-mixed");assert.ok(paused.every((item:any)=>item.ok));
  releases.get("A")!();releases.get("C")!();holding=false;
  await Promise.all([engine.wait(ar.id),engine.wait(cr.id)]);await until(()=>engine.repository.get(ar.id)?.status==="paused");
  assert.equal(engine.repository.get(cr.id)?.status,"failed");assert.equal(counts.get(`${E}:ASSET_PLAN`),undefined);
  // Real authenticated SSE connection, disconnect, then restart the service objects.
  const snapshot=await (await fetch(origin+"/api/production/snapshot",{headers:{"x-user":"owner"}})).json() as any;
  const abort=new AbortController();const events=await fetch(origin+`/api/production/events?cursor=${encodeURIComponent(JSON.stringify(snapshot.cursor))}`,{headers:{"x-user":"owner"},signal:abort.signal});assert.equal(events.status,200);abort.abort();
  await new Promise(resolve=>setTimeout(resolve,50));engine.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  store=new CinemaStore();await store.load();
  const restartedApp=express();restartedApp.use(express.json());engine=registerVideosBatchWorkflowApi(restartedApp,store,registry);await engine.ready;editing=new EditingService(engine);observeQueue();
  assert.equal(engine.repository.get(ar.id)?.status,"paused");assert.equal(engine.repository.get(er.id)?.status,"paused");assert.equal(engine.repository.editing.draft("D-draft")?.value,story.artifact.content+"保留编辑。");
  await engine.control(cr.id,"resume","retry-C");
  const saved=await editing.publish(D,"owner",{requestId:"D-save-continue",stageId:"STORY_SCRIPT",expectedRevision:story.revision,artifact:{...story.artifact,content:story.artifact.content+"保留编辑。"},draftId:"D-draft",instanceId:"browser",clientVersion:1,continue:true});
  const confirmed=await confirmIntro(B,true);
  await engine.control(ar.id,"resume","resume-A");await engine.control(er.id,"resume","resume-E");
  await Promise.all([ar.id,cr.id,er.id,saved.continuation.runId!,confirmed.continuation.runId!].map(id=>engine.wait(id)));
  for(const id of [A,B,C,D,E])assert.equal(store.getSession(id)!.videosBatchWorkflow!.currentStage,"ASSET_CONFIRMATION");
  assert.equal(counts.get(`${A}:ASSET_PLAN`),1,"successful A stage never repeated");assert.equal(counts.get(`${C}:ASSET_PLAN`),2,"only failed C stage retried");assert.equal(counts.get(`${E}:ASSET_PLAN`),1);
  assert.equal(store.getSession(D)!.videosBatchWorkflow!.stages.STORY_SCRIPT!.revision,story.revision+1);assert.ok(store.getSession(D)!.videosBatchWorkflow!.stages.STORY_SCRIPT!.artifact.content.endsWith("保留编辑。"));
  // 30+ unblocked stage-completion -> durable successor queue samples.
  latency.length=0;
  for(let i=0;i<32;i++){const session=await store.createSession({title:`sample-${i}`,shotCount:0} as any,"owner");await store.updateSession(session.id,{videosBatchWorkflow:structuredClone(initial)});await engine.wait((await engine.start(session.id,"all",`sample-${i}`)).id);}
  assert.ok(latency.length>=30);const sorted=[...latency].sort((a,b)=>a-b);const p95=sorted[Math.ceil(sorted.length*.95)-1];assert.ok(p95<=1000,`queue p95 ${p95}`);
  const expected=[A,B,C,D,E].map(id=>({id,workflow:store.getSession(id)!.videosBatchWorkflow,runs:engine.repository.list(id)}));
  // Pause/settle all dispatch, close SQLite, copy the complete isolated data tree.
  engine.close();const backup=path.join(root,"backup");cpSync(path.join(root,"data"),path.join(backup,"data"),{recursive:true});writeFileSync(path.join(backup,"expected.json"),JSON.stringify(expected));
  const restore=spawnSync(process.execPath,["--import",import.meta.resolve("tsx"),fileURLToPath(import.meta.url),"restore",backup],{encoding:"utf8",windowsHide:true,timeout:15000});assert.equal(restore.status,0,restore.stderr+restore.stdout);
  // Legacy waiting adapter still uses the same engine after the UI closes.
  const legacyApp=express();legacyApp.use(express.json());engine=registerVideosBatchWorkflowApi(legacyApp,store,registry,{authorizeSession:(session,req)=>session.ownerUserId===req.header("x-user")});await engine.ready;
  await engine.control(engine.repository.list(B)[0].id,"stop","rollback-stop");
  const legacyServer=legacyApp.listen(0,"127.0.0.1");await once(legacyServer,"listening");
  const legacy=await fetch(`http://127.0.0.1:${(legacyServer.address() as any).port}/api/sessions/${B}/videosbatch/run-next`,{method:"POST",headers:{"content-type":"application/json","x-user":"owner"},body:"{}"});assert.equal(legacy.status,200);const legacyValue=await legacy.json() as any;assert.equal(legacyValue.currentStage,"ASSET_CONFIRMATION");
  legacyServer.closeAllConnections();await new Promise<void>(resolve=>legacyServer.close(()=>resolve()));
  writeFileSync(path.join(root,"acceptance.json"),JSON.stringify({projects:[A,B,C,D,E],latency:{n:latency.length,p95,max:Math.max(...latency)},counts:[...counts],backup},null,2));
  console.log("five-project story, SSE disconnect/restart, scoped retry, save-continue, full backup restore and legacy downgrade passed",JSON.stringify({root,queueSamples:latency.length,p95}));
}finally{for(const release of releases.values())release();server.closeAllConnections();server.close();try { engine.close(); } catch (error) { if ((error as any).code !== "ERR_INVALID_STATE") throw error; }}
