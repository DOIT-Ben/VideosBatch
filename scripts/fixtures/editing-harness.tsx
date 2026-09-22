// Browser-only isolated hook contract fixture. No real server/provider calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../../src/client/api";
import { DraftSessionContext, DraftWorkflowContext, useStageDraft } from "../../src/client/videosBatchStudio/useStageDraft";
import { draftKey } from "../../src/client/videosBatchStudio/draftStorage";
import type { ServerDraft } from "../../src/shared/editing";

const drafts = new Map<string, ServerDraft>();
let delay = 0;
let writes = 0;
let publishes = 0;
let lateRelease = false;
api.editingDrafts = async () => [...drafts.values()].filter(item => item.active);
api.syncEditingDraft = async (_session, input) => {
  writes++;
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  const previous = drafts.get(input.id);
  if (previous?.instanceId === "other") throw new Error("这份草稿正在另一页面编辑，请创建独立副本。");
  const result = { ...input, sessionId: "hook", ownerId: "test", active: true, leaseUntil: Date.now() + 45000, updatedAt: new Date().toISOString() };
  drafts.set(input.id, result); return result;
};
api.releaseEditingDraft = async (_session, id, instanceId, clientVersion, discard) => {
  const previous = drafts.get(id);
  if (!previous) throw Object.assign(new Error("草稿不存在"), { status: 404 });
  if (previous.instanceId !== instanceId) throw new Error("不能释放另一页面");
  if (discard ? previous.clientVersion > clientVersion : previous.clientVersion !== clientVersion) throw new Error("草稿版本冲突");
  lateRelease = true; drafts.set(id, { ...previous, clientVersion, active: false }); return { released: true };
};
const artifact = { segments: [{ sequence: 1, visual: "原始画面" }] };
const initial = () => ({ currentStage: "FINAL_STORYBOARD", stages: { FINAL_STORYBOARD: { status: "ready", revision: 1, artifact: structuredClone(artifact) } } } as any);
function Editor({ workflow, update }: { workflow: any; update: (value: any) => void }) {
  const edit = useStageDraft<any>("storyboard", workflow.stages.FINAL_STORYBOARD.artifact);
  api.publishEdit = async (_session, request) => {
    publishes++;
    await new Promise(resolve => setTimeout(resolve, 700));
    const savedArtifact = { ...(request.artifact as any), segments: (request.artifact as any).segments.map((item: any) => ({ ...item, nativeShotId: "normalized-shot" })) };
    const next = { ...workflow, stages: { FINAL_STORYBOARD: { status: "ready", revision: request.expectedRevision + 1, artifact: savedArtifact } } };
    update(next);
    return { workflow: next, savedArtifact, savedRevision: request.expectedRevision + 1, operationId: "test", continuation: { status: "none" } };
  };
  return <section><button onClick={() => edit.setEditing(true)}>进入编辑</button><button onClick={() => { edit.setEditing(true); edit.setEditing(false); }}>立即进入并丢弃</button><button onClick={() => edit.setEditing(false)}>丢弃</button><button onClick={() => void edit.publish?.()}>保存</button>
    {edit.editing && <textarea aria-label="测试分镜画面" value={edit.draft.segments[0].visual} onChange={event => edit.setDraft((previous: any) => ({ ...previous, segments: [{ ...previous.segments[0], visual: event.target.value }] }))} />}
    {edit.notice}<output aria-label="编辑状态">{JSON.stringify({ editing: edit.editing, conflict: edit.conflict, saved: edit.saved, saving: edit.saving, writes, publishes, lateRelease, activeDrafts: [...drafts.values()].filter(item => item.active).length, draft: edit.draft })}</output></section>;
}
function App() {
  const [workflow, setWorkflow] = useState(initial);
  const [version, setVersion] = useState(0);
  const [visible, setVisible] = useState(true);
  const reset = (scenario: string) => {
    drafts.clear(); writes = 0; publishes = 0; lateRelease = false; delay = scenario === "slow" ? 4000 : 0;
    sessionStorage.removeItem(draftKey("hook", "storyboard"));
    if (scenario === "copy") {
      const record = { id: "local-clone", draftId: "cloned", clientVersion: 1, baseRevision: 1, base: JSON.stringify(artifact), value: artifact };
      sessionStorage.setItem(draftKey("hook", "storyboard"), JSON.stringify(record));
      drafts.set("cloned", { id: "cloned", sessionId: "hook", ownerId: "test", stageId: "FINAL_STORYBOARD", instanceId: "other", clientVersion: 1, baseRevision: 1, baseSignature: record.base, value: artifact, leaseUntil: Date.now() + 45000, active: true, updatedAt: new Date().toISOString() });
    }
    setVisible(true); setWorkflow(initial()); setVersion(value => value + 1);
  };
  return <main><h1>P4 隔离编辑状态验收</h1><p>所有接口均为浏览器内测试替身，不访问用户数据。</p><button onClick={() => reset("normal")}>重置普通场景</button><button onClick={() => reset("slow")}>重置慢同步场景</button><button onClick={() => reset("copy")}>复制标签草稿场景</button><button onClick={() => setVisible(value => !value)}>切换挂载</button>
    <DraftSessionContext.Provider value="hook"><DraftWorkflowContext.Provider value={{ workflow, onChange: setWorkflow }}>{visible && <Editor key={version} workflow={workflow} update={setWorkflow} />}</DraftWorkflowContext.Provider></DraftSessionContext.Provider></main>;
}
createRoot(document.getElementById("root")!).render(<App />);
