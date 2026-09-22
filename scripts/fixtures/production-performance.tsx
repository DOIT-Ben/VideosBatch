// Browser acceptance fixture: real production components/event reader, synthetic transport.
// Build with NODE_ENV=production. Never loaded by the application entry point.
import React, { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { TaskList } from "../../src/client/videosBatchStudio/TaskList";
import { VideosBatchStudio } from "../../src/client/videosBatchStudio/VideosBatchStudio";
import { I18nProvider } from "../../src/client/i18n";
import { api } from "../../src/client/api";
import { mergeProductionView } from "../../src/client/App";
import { productionRuns } from "../../src/client/productionCenter/runStore";
import { useRunEvents } from "../../src/client/productionCenter/useRunEvents";
import { createVideosBatchWorkflow } from "../../src/shared/videosBatchWorkflow";
import type { Session } from "../../src/shared/types";
import type { ProductionRun, RunPacket } from "../../src/shared/productionRuns";
import "../../src/client/styles.css";
import "../../src/client/videosBatchStudio/tokens.css";
import "../../src/client/videosBatchStudio/guidedStudioV2.css";
import "../../src/client/videosBatchStudio/guidedStudioV2Focus.css";
import "../../src/client/videosBatchStudio/experience.css";
const sessions = Array.from({length:1000},(_,i)=> {
  const workflow=createVideosBatchWorkflow({projectId:`P${i}`,lessonText:"合成验收教案"});
  workflow.currentStage="STORY_SCRIPT";
  workflow.stages.STORY_SCRIPT={...workflow.stages.STORY_SCRIPT!,status:"ready",revision:1,artifact:{title:"性能验收正文",content:"合成正文".repeat(5000)}};
  return {id:`perf-${i}`,title:`验收项目 ${String(i).padStart(4,"0")}`,createdAt:"2026-09-22T00:00:00Z",updatedAt:"2026-09-22T00:00:00Z",videosBatchWorkflow:workflow,
    assets:[],shots:i<5?Array.from({length:12},(_,j)=>({id:`shot-${i}-${j}`,sessionId:`perf-${i}`,index:j+1,prompt:"合成镜头"})):[]} as unknown as Session;
});
const runs:ProductionRun[]=sessions.slice(0,5).map(s=>({id:`run-${s.id}`,sessionId:s.id,ownerId:"fixture",mode:"all",status:"running",stageId:"STORY_SCRIPT",inputVersion:"v1",createdAt:s.createdAt,updatedAt:s.createdAt,priority:0,completedItems:0}));
let sequence=0; let stream:ReadableStreamDefaultController<Uint8Array>|undefined; let measuring=false;
const samples={input:[] as number[],switch:[] as number[],event:[] as number[],long:[] as number[]};
const stats=(values:number[])=>({n:values.length,p95:[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*.95)-1)]||0,max:Math.max(0,...values)});
let report=()=>{};
const painted=(kind:"input"|"switch"|"event",start:number)=>requestAnimationFrame(()=>requestAnimationFrame(()=>{if(measuring)samples[kind].push(performance.now()-start);}));
document.addEventListener("input",()=>{if(measuring)painted("input",performance.now());},true);
document.addEventListener("click",event=>{if(measuring && !(event.target as HTMLElement).closest("[data-switch]"))painted("input",performance.now());},true);
new PerformanceObserver(list=>{if(measuring)samples.long.push(...list.getEntries().map(e=>e.duration));}).observe({type:"longtask",buffered:false});
api.productionSnapshot=async()=>({kind:"snapshot",cursor:{scope:"fixture",offsets:{fixture:sequence}},runs});
api.productionView=async(id)=>{
  const session=sessions.find(s=>s.id===id)!;
  const workflow=structuredClone(session.videosBatchWorkflow!);
  workflow.stages.STORY_SCRIPT!.artifact.title=`性能验收正文 · 更新${sequence}`;
  return {workflow,shots:structuredClone(session.shots),assets:[]} as any;
};
api.editingDrafts=async()=>[];
api.syncEditingDraft=async(sessionId,draft)=>({...draft,sessionId,ownerId:"fixture",active:true,leaseUntil:Date.now()+45000,updatedAt:new Date().toISOString()});
api.releaseEditingDraft=async()=>({released:true});
const originalFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
  if(String(input).startsWith("/api/production/events"))return new Response(new ReadableStream({start(controller){stream=controller;init?.signal?.addEventListener("abort",()=>{try{controller.close();}catch{}});}}),{headers:{"content-type":"text/event-stream"}});
  return originalFetch(input,init);
};
function emit(){
  if(!stream)return;
  const previous={scope:"fixture",offsets:{fixture:sequence}};sequence++;
  const index=sequence%5; runs[index]={...runs[index],completedItems:sequence,message:`已接收事件 ${sequence}`};
  const packet:RunPacket={kind:"delta",previous,cursor:{scope:"fixture",offsets:{fixture:sequence}},events:[{sequence,run:runs[index]}]};
  const start=performance.now();
  const stop=productionRuns.subscribe(()=>{if(productionRuns.cursor?.offsets.fixture===sequence){stop();painted("event",start);}});
  stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(packet)}\n\n`));
}
async function measure(){
  if(measuring)return; Object.values(samples).forEach(values=>values.length=0); measuring=true;report();
  const steady=setInterval(emit,100);
  const burstStart=setTimeout(()=>{const burst=setInterval(emit,10);setTimeout(()=>clearInterval(burst),1000);},30000);
  await new Promise(resolve=>setTimeout(resolve,60000));clearInterval(steady);clearTimeout(burstStart);
  await new Promise(resolve=>setTimeout(resolve,150));measuring=false;report();
}
function App(){
  const [id,setId]=useState("");const [,refresh]=useState(0); report=()=>refresh(n=>n+1);
  const [state,setState]=useState({sessions,assets:[],shots:sessions.flatMap(s=>s.shots),gallery:[]} as any);
  useRunEvents((sessionId,view)=>setState((previous:any)=>mergeProductionView(previous,sessionId,view)));
  const revision=useSyncExternalStore(productionRuns.subscribe,()=>productionRuns.revision,()=>0);
  const selected=state.sessions.find((s:Session)=>s.id===id) as Session|undefined;
  const select=(next:string)=>{const start=performance.now();setId(next);if(measuring)painted("switch",start);};
  return <I18nProvider><nav aria-label="验收工具" style={{position:"sticky",top:0,zIndex:100,background:"white",display:"flex",flexWrap:"wrap",gap:8,padding:8}}>
    <button onClick={()=>void measure()} disabled={measuring}>开始60秒固定负载</button><button data-switch onClick={()=>select("")}>千任务列表</button>{sessions.slice(0,5).map((s,i)=><button data-switch key={s.id} onClick={()=>select(s.id)}>切换项目{i+1}</button>)}
    <output aria-label="性能报告">{JSON.stringify({running:measuring,sequence,revision,input:stats(samples.input),switch:stats(samples.switch),event:stats(samples.event),long:stats(samples.long),viewport:[innerWidth,innerHeight],agent:navigator.userAgent})}</output></nav>
    {selected?<VideosBatchStudio key={id} sessionId={id} sessionTitle={selected.title} session={selected} workflow={selected.videosBatchWorkflow} nativeAssets={state.assets} nativeShots={state.shots.filter((shot:any)=>shot.sessionId===id)} onWorkflowChange={()=>{}} onOpenCanvas={()=>{}} onBackToSessions={()=>select("")} onSelectSession={select} sessions={sessions.slice(0,5).map(s=>({id:s.id,title:s.title}))}/>:<TaskList sessions={state.sessions} onSelect={select} onCreate={()=>{}} onGallery={()=>{}}/>}
  </I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<App/>);
