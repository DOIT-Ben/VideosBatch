import { useEffect, useMemo, useState } from "react";
import type { VideosBatchStageId, VideosBatchStageState } from "../../shared/videosBatchWorkflow";
import { WORKFLOW_LABELS } from "./workflowLabels";

export function WorkflowArtifactPanel({
  stageId,
  stage,
  onSave,
  onClose
}: {
  stageId: VideosBatchStageId;
  stage?: VideosBatchStageState;
  onSave?: (artifact: unknown) => Promise<void> | void;
  onClose?: () => void;
}) {
  const formatted = useMemo(() => JSON.stringify(stage?.artifact ?? {}, null, 2), [stage?.artifact]);
  const [draft, setDraft] = useState(formatted);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(formatted);
    setEditing(false);
    setError("");
  }, [formatted, stageId]);

  const save = async () => {
    try {
      const artifact = JSON.parse(draft || "{}");
      await onSave?.(artifact);
      setEditing(false);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "JSON 格式错误");
    }
  };

  return (
    <section className="videosbatch-artifact-panel" aria-label={`${WORKFLOW_LABELS[stageId]}产物`}>
      <header>
        <div>
          <strong>{WORKFLOW_LABELS[stageId]}</strong>
          <small>revision {stage?.revision ?? 0}</small>
        </div>
        <div className="videosbatch-artifact-actions">
          <button type="button" onClick={() => setEditing(true)}>编辑</button>
          {onClose && <button type="button" onClick={onClose}>关闭</button>}
        </div>
      </header>
      {editing ? (
        <>
          <textarea
            aria-label={`${WORKFLOW_LABELS[stageId]} JSON`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={14}
          />
          {error && <div className="videosbatch-artifact-error">{error}</div>}
          <div className="videosbatch-artifact-actions">
            <button type="button" className="primary" onClick={save}>保存</button>
            <button type="button" onClick={() => { setDraft(formatted); setEditing(false); setError(""); }}>取消</button>
          </div>
        </>
      ) : (
        <pre>{formatted}</pre>
      )}
    </section>
  );
}
