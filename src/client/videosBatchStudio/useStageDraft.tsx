import { createContext, useContext, useRef, useState, type SetStateAction } from "react";
import { draftKey, draftSignature, readDraft, writeDraft, savedDraftStillCurrent, type DraftRecord } from "./draftStorage";

export const DraftSessionContext = createContext("");
function storage() {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; }
}

export function useStageDraft<T>(stage: string, source: T) {
  const sessionId = useContext(DraftSessionContext);
  const key = sessionId ? draftKey(sessionId, stage) : "";
  const [record, setRecord] = useState<DraftRecord<T> | undefined>(() => readDraft<T>(storage(), key));
  const current = useRef(record);
  const [storageFailed, setStorageFailed] = useState(false);
  const signature = draftSignature(source);
  const update = (next: DraftRecord<T> | undefined) => {
    if (next) next = { ...next, id: crypto.randomUUID() };
    current.current = next;
    setRecord(next);
    if (key) setStorageFailed(!writeDraft(storage(), key, next));
  };
  const setDraft = (value: SetStateAction<T>) => {
    const previous = current.current;
    update({ base: previous?.base ?? signature, value: typeof value === "function" ? (value as (previous: T) => T)(previous ? previous.value : source) : value });
  };
  const setEditing = (editing: boolean) => {
    if (!editing) update(undefined);
    else if (!current.current) update({ base: signature, value: source });
  };
  return {
    draft: record ? record.value : source, setDraft, editing: Boolean(record), setEditing,
    conflict: Boolean(record && record.base !== signature), storageFailed,
    captureSave: () => current.current,
    completeSave: (submitted: DraftRecord<T> | undefined) => {
      if (submitted && savedDraftStillCurrent(submitted, current.current, readDraft<T>(storage(), key))) update(undefined);
    }
  };
}

export function DraftNotice({ conflict, storageFailed }: { conflict: boolean; storageFailed: boolean }) {
  return <p role="status" className="vbs-note-card">{conflict
    ? "服务器内容已有更新，草稿已保留。请先复制需要的修改，再丢弃草稿并基于新版编辑。"
    : storageFailed ? "浏览器无法保存草稿；当前内容仅留在页面，请先复制备份再离开。"
    : "草稿已保存在当前浏览器标签页，尚未提交。"}</p>;
}
