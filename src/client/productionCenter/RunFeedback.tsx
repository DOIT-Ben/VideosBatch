import { useEffect, useState } from "react";
import { api } from "../api";
import { useProductionRun, useRunConnection } from "./useRunEvents";
import { runStatusLabel } from "../../shared/productionRuns";

export function RunFeedback({ sessionId }: { sessionId: string }) {
  const run = useProductionRun(sessionId);
  const connection = useRunConnection();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.productionPreview>>>();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const ref = run?.feedback?.previewRef;
  useEffect(() => {
    let active = true;
    if (!ref) { setPreview(undefined); return; }
    api.productionPreview(sessionId, ref).then(value => { if (active) setPreview(value); }).catch(() => { /* a newer preview may already replace this one */ });
    return () => { active = false; };
  }, [sessionId, ref]);
  if (!run && connection !== "recovering") return null;
  const control = async (action: "pause" | "resume" | "stop") => {
    if (!run || pending) return;
    setPending(action); setError("");
    try { await api.controlProduction(sessionId, run.id, action, crypto.randomUUID()); }
    catch (error) { setError(error instanceof Error ? error.message : "操作尚未确认，请重试"); }
    finally { setPending(""); }
  };
  const detail = run?.status === "running" ? ({ working: "正在处理", validating: "正在校验结果", saving: "正在保存结果", saved: "成果已保存", preview: "生成中，预览尚未保存为成果" }[run.feedback?.kind || "working"]) : "";
  return <aside className="vbs-note-card vbs-run-feedback" aria-label="后台任务">
    <div role="status" aria-live="polite">{pending ? "正在发送操作…" : run ? `${runStatusLabel[run.status]}${detail ? ` · ${detail}` : ""}` : ""}
      {run?.feedback?.completedWork ? ` · 本步骤已处理 ${run.feedback.completedWork} 项` : ""}
    </div>
    {connection === "recovering" && <p>连接恢复中，后台任务继续执行。</p>}
    {run?.message && <p>{run.message}</p>}
    {run && <div className="vbs-run-actions">
      {["queued", "running", "waiting_input"].includes(run.status) && <button type="button" disabled={Boolean(pending)} onClick={() => void control("pause")}>暂停后续</button>}
      {run.status === "paused" && <button type="button" disabled={Boolean(pending)} onClick={() => void control("resume")}>继续执行</button>}
      {["queued", "running", "waiting_input", "paused", "pause_requested"].includes(run.status) && <button type="button" disabled={Boolean(pending)} onClick={() => void control("stop")}>停止后续</button>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {preview && preview.itemId === run?.feedback?.itemId && run.feedback.kind !== "saved" && <details><summary>查看生成预览 · 尚未保存为成果</summary>
      <div className="vbs-run-preview">{preview.blocks.map(block => <p key={block.id}>{block.text}</p>)}</div>
    </details>}
  </aside>;
}
