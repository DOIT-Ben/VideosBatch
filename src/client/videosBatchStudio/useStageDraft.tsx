import { createContext, useContext, useEffect, useRef, useState, type SetStateAction } from "react";
import { draftKey, draftSignature, readDraft, writeDraft, savedDraftStillCurrent, type DraftRecord } from "./draftStorage";
import { api } from "../api";
import type { ServerDraft, EditRequest } from "../../shared/editing";
import type { VideosBatchStageId, VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";
import { updateStoryArtifactContent } from "./contentModel";

export const DraftSessionContext = createContext("");
export const DraftWorkflowContext = createContext<{ workflow?: VideosBatchWorkflowState; onChange: (workflow: VideosBatchWorkflowState) => void } | undefined>(undefined);
const pageInstance = crypto.randomUUID();
const draftWrites = new Map<string, Promise<unknown>>();
const discardingDrafts = new Set<string>();
function sequenceDraft<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const result = (draftWrites.get(id)?.catch(() => undefined) || Promise.resolve()).then(operation);
  draftWrites.set(id, result);
  return result.finally(() => { if (draftWrites.get(id) === result) draftWrites.delete(id); });
}
const stageIds: Record<string, VideosBatchStageId> = { story: "STORY_SCRIPT", screenplay: "SCREENPLAY", storyboard: "FINAL_STORYBOARD" };
function storage() { try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; } }

export function useStageDraft<T>(stage: string, source: T) {
  const sessionId = useContext(DraftSessionContext);
  const context = useContext(DraftWorkflowContext);
  const stageId = stageIds[stage];
  const serverEnabled = Boolean(context && stageId && sessionId);
  const revision = context?.workflow?.stages[stageId]?.revision ?? 0;
  const key = sessionId ? draftKey(sessionId, stage) : "";
  const [record, setRecord] = useState<DraftRecord<T> | undefined>(() => {
    const old = readDraft<T>(storage(), key);
    return old ? { ...old, draftId: old.draftId || crypto.randomUUID(), clientVersion: old.clientVersion || 1, baseRevision: old.baseRevision ?? revision } : undefined;
  });
  const current = useRef(record);
  const mounted = useRef(true);
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const [message, setMessage] = useState("");
  const [recovery, setRecovery] = useState<ServerDraft[]>([]);
  const signature = draftSignature(source);
  const update = (next: DraftRecord<T> | undefined) => {
    current.current = next;
    const ok = !key || writeDraft(storage(), key, next);
    if (mounted.current) { setRecord(next); setStorageFailed(!ok); }
  };
  const sync = async (value: DraftRecord<T>) => {
    const result = await sequenceDraft(value.draftId!, () => {
      if (discardingDrafts.has(value.draftId!)) throw new Error("正在丢弃草稿");
      return api.syncEditingDraft(sessionId, { id: value.draftId!, instanceId: pageInstance, stageId,
        clientVersion: value.clientVersion!, baseRevision: value.baseRevision!, baseSignature: value.base, value: value.value });
    });
    if (mounted.current && current.current?.id === value.id) setMessage("草稿已同步；相关后续任务已暂缓。在途工作仍使用已启动的版本。");
    return result;
  };
  const loadRecovery = () => api.editingDrafts(sessionId).then(items => { if (mounted.current) setRecovery(items.filter(item => item.stageId === stageId && item.id !== current.current?.draftId)); }).catch(() => { if (mounted.current) setMessage("暂时无法读取服务端草稿，可重试恢复。"); });
  useEffect(() => { mounted.current = true; if (serverEnabled) void loadRecovery(); return () => { mounted.current = false; }; }, [sessionId, stageId]);
  useEffect(() => {
    if (!serverEnabled || !record || record.saved || record.pendingRequest) return;
    const send = () => { const value = current.current; if (value && !value.saved && !value.pendingRequest && !discardingDrafts.has(value.draftId!)) void sync(value).catch(error => { if (mounted.current && current.current?.id === value.id) setMessage(`草稿仅保存在本机，自动推进尚未确认暂缓：${error.message}`); }); };
    const timer = setTimeout(send, 350);
    const heartbeat = setInterval(send, 15000);
    const release = () => { const value = current.current; if (value && !value.saved) void api.releaseEditingDraft(sessionId, value.draftId!, pageInstance, value.clientVersion!).catch(() => {}); };
    window.addEventListener("pagehide", release);
    return () => { clearTimeout(timer); clearInterval(heartbeat); window.removeEventListener("pagehide", release); };
  }, [serverEnabled, record?.id, record?.saved, record?.pendingRequest]);
  const setDraft = (value: SetStateAction<T>) => {
    const previous = current.current;
    update({ base: previous?.base ?? signature, baseRevision: previous?.baseRevision ?? revision,
      value: typeof value === "function" ? (value as (previous: T) => T)(previous ? previous.value : source) : value,
      id: crypto.randomUUID(), draftId: !previous || previous.saved ? crypto.randomUUID() : previous.draftId,
      clientVersion: previous?.saved ? 1 : (previous?.clientVersion || 0) + 1 });
    setMessage("未发布；本机草稿已更新，正在同步。");
  };
  const setEditing = (editing: boolean) => {
    if (editing) { if (!current.current) setDraft(source); return; }
    const previous = current.current;
    if (serverEnabled && previous && !previous.saved) {
      const id = previous.draftId!;
      discardingDrafts.add(id);
      void sequenceDraft(id, () => api.releaseEditingDraft(sessionId, id, pageInstance, previous.clientVersion!, true)).then(() => {
        if (current.current?.id === previous.id) { update(undefined); setMessage(""); }
      }).catch(error => {
        if (error.status === 404 && current.current?.id === previous.id) { update(undefined); setMessage(""); }
        else if (mounted.current) setMessage(`丢弃未完成，草稿仍保留：${error.message}`);
      }).finally(() => discardingDrafts.delete(id));
    }
    else update(undefined);
  };
  const publish = serverEnabled ? async (advance = false) => {
    if (pending.current) return;
    const submitted = current.current;
    if (!submitted || submitted.saved) return;
    pending.current = true; setSaving(true); setMessage("正在保存；可以继续输入，新修改会保留。");
    try {
      let request = submitted.pendingRequest;
      if (!request) {
        await sync(submitted);
        const artifact = stageId === "STORY_SCRIPT" ? updateStoryArtifactContent(context!.workflow!.stages.STORY_SCRIPT!.artifact as any, String(submitted.value)) : submitted.value;
        request = { requestId: crypto.randomUUID(), stageId, expectedRevision: submitted.baseRevision!, artifact,
          draftId: submitted.draftId, instanceId: pageInstance, clientVersion: submitted.clientVersion, continue: advance } satisfies EditRequest;
        if (current.current?.id === submitted.id) update({ ...submitted, pendingRequest: request });
      }
      const result = await api.publishEdit(sessionId, request);
      if (mounted.current) context!.onChange(result.workflow);
      const persisted = readDraft<T>(storage(), key);
      const publishedValue = (stageId === "STORY_SCRIPT" ? (result.savedArtifact as any)?.content : result.savedArtifact) as T;
      if (persisted?.id === submitted.id && current.current?.id === submitted.id) update({ ...submitted,
        pendingRequest: result.continuation.status === "pending" ? request : undefined, saved: ["none", "queued"].includes(result.continuation.status),
        value: result.continuation.status === "blocked" ? submitted.value : publishedValue,
        base: result.continuation.status === "blocked" ? submitted.base : draftSignature(publishedValue), baseRevision: result.savedRevision });
      if (mounted.current) setMessage(result.continuation.reason || (result.continuation.status === "queued" ? "已保存并加入执行队列。" : "已保存；后续受影响内容需要重新生成，尚未启动。"));
    } catch (error) { if (mounted.current) setMessage(`保存未确认，草稿已保留，可重试：${error instanceof Error ? error.message : "网络中断"}`); }
    finally { pending.current = false; if (mounted.current) setSaving(false); }
  } : undefined;
  const conflict = Boolean(record && record.base !== signature);
  const recover = async (item: ServerDraft) => {
    try {
      const value = { id: crypto.randomUUID(), draftId: item.id, clientVersion: item.clientVersion, baseRevision: item.baseRevision, base: item.baseSignature, value: item.value as T };
      await sync(value); update(value); setRecovery(items => items.filter(other => other.id !== item.id));
    } catch (error) { setMessage(error instanceof Error ? error.message : "恢复失败"); }
  };
  const rebase = () => { const previous = current.current; if (previous) { update({ ...previous, id: crypto.randomUUID(), pendingRequest: undefined, saved: false, base: signature, baseRevision: revision, clientVersion: (previous.clientVersion || 0) + 1 }); setMessage("已明确改为基于服务器新版；请核对后保存。"); } };
  const fork = () => { const previous = current.current; if (previous) { update({ ...previous, id: crypto.randomUUID(), draftId: crypto.randomUUID(), clientVersion: 1, saved: false, pendingRequest: undefined }); setMessage("已保留全部内容并创建独立草稿；另一页面的草稿不受影响。"); } };
  const notice = <>
    {(record || message) && <DraftNotice conflict={conflict} storageFailed={storageFailed} message={message || (record?.saved ? "已保存。" : undefined)} />}
    {record && !record.saved && <button type="button" className="vbs-secondary" disabled={saving} onClick={fork}>创建独立草稿副本</button>}
    {conflict && <details className="vbs-note-card"><summary>对照服务器新版与我的草稿</summary><label>服务器新版<textarea readOnly value={typeof source === "string" ? source : JSON.stringify(source, null, 2)} /></label><label>我的草稿<textarea readOnly value={typeof record?.value === "string" ? record.value : JSON.stringify(record?.value, null, 2)} /></label><button type="button" onClick={() => void navigator.clipboard?.writeText(typeof record?.value === "string" ? record.value : JSON.stringify(record?.value, null, 2))}>复制我的草稿</button><button type="button" disabled={saving} onClick={rebase}>保留我的修改，基于新版重新编辑</button></details>}
    {serverEnabled && !record && recovery.length > 0 && <div className="vbs-note-card">发现 {recovery.length} 份未发布的服务端草稿。{recovery.map(item => <button type="button" key={item.id} onClick={() => void recover(item)}>恢复 {new Date(item.updatedAt).toLocaleString()}</button>)}</div>}
    {serverEnabled && message.includes("重试恢复") && <button type="button" onClick={() => void loadRecovery()}>重试恢复草稿</button>}
  </>;
  return { draft: record ? record.value : source, setDraft, editing: Boolean(record), setEditing, conflict, storageFailed, notice, publish, saving, saved: Boolean(record?.saved),
    captureSave: () => current.current,
    completeSave: (submitted: DraftRecord<T> | undefined) => { if (submitted && savedDraftStillCurrent(submitted, current.current, readDraft<T>(storage(), key))) update(undefined); }
  };
}

export function DraftNotice({ conflict, storageFailed, message }: { conflict: boolean; storageFailed: boolean; message?: string }) {
  return <p role="status" className="vbs-note-card">{conflict ? "服务器内容已有更新，草稿已保留。请对照新版后再保存。" : storageFailed ? "浏览器无法保存草稿；当前内容仅留在页面，请先复制备份再离开。" : message || "草稿已保存在当前浏览器标签页，尚未提交。"}</p>;
}
