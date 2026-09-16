import { useEffect, useState } from "react";
import { Pencil, Save, X } from "lucide-react";
import { updateScreenplaySceneFields } from "../contentModel";
import { StageEmpty, StageFact, StagePage } from "../components/StagePage";

const EDITABLE_FIELDS = [
  ["title", "场景标题"],
  ["knowledgeFocus", "知识重点"],
  ["visualAction", "画面 / 动作"],
  ["dialogue", "对白 / 旁白"],
  ["visualPresentation", "呈现方式"],
  ["ambientSound", "环境声"],
  ["effectSound", "音效"],
  ["interactionSound", "交互声"],
  ["voice", "声音说明"],
  ["emotionalPurpose", "情绪目的"]
] as const;

export function ScreenplayStage({
  artifact,
  busy,
  onSaveArtifact
}: {
  artifact: any;
  busy?: boolean;
  onSaveArtifact?: (artifact: any) => Promise<void> | void;
}) {
  const scenes = Array.isArray(artifact?.scenes) ? artifact.scenes : [];
  const duration = Number(artifact?.targetDurationSeconds || 0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<any>(artifact);

  useEffect(() => {
    setDraft(artifact);
    setEditing(false);
  }, [artifact]);

  const draftScenes = Array.isArray(draft?.scenes) ? draft.scenes : [];
  const save = async () => {
    try {
      await onSaveArtifact?.(draft);
      setEditing(false);
    } catch {
      // The studio reports the failure inline; keep the draft open so a rejected
      // save does not silently discard the user's edit.
    }
  };

  return (
    <StagePage
      stepId="screenplay"
      title={artifact?.title || "正式视频剧本"}
      lead="逐场景写出画面、对白和声音，作为后续分镜依据。"
      facts={scenes.length ? (
        <>
          <StageFact value={`${duration || "—"}s`} label="目标时长" />
          <StageFact value={duration ? duration / 10 : "—"} label="预计主分镜" />
        </>
      ) : null}
      actions={scenes.length && onSaveArtifact ? (
        editing ? (
          <>
            <button type="button" className="vbs-primary" disabled={busy} onClick={() => void save()}><Save size={15} /> 保存视频剧本</button>
            <button type="button" className="vbs-secondary" disabled={busy} onClick={() => { setDraft(artifact); setEditing(false); }}><X size={15} /> 取消</button>
          </>
        ) : (
          <button type="button" className="vbs-secondary" disabled={busy} onClick={() => setEditing(true)}><Pencil size={15} /> 编辑视频剧本</button>
        )
      ) : null}
    >
      {!scenes.length ? <StageEmpty>正式视频剧本尚未生成。</StageEmpty> : (
        <div className="vbs-screenplay-list">
          {(editing ? draftScenes : scenes).map((scene: any) => (
            <article className={`vbs-screenplay-scene ${editing ? "editing" : ""}`} key={scene.sequence}>
              <div className="vbs-scene-number">{String(scene.sequence).padStart(2, "0")}</div>
              <div>
                {editing ? (
                  <div className="vbs-structured-editor-grid">
                    {EDITABLE_FIELDS.map(([field, label]) => {
                      const multiline = field === "visualAction" || field === "dialogue";
                      const value = String(scene?.[field] || "");
                      return (
                        <label className={multiline ? "wide" : ""} key={field}>
                          <span>{label}</span>
                          {multiline ? (
                            <textarea
                              value={value}
                              rows={field === "visualAction" ? 4 : 3}
                              onChange={(event) => setDraft((current: any) => updateScreenplaySceneFields(current, scene.sequence, { [field]: event.target.value }))}
                            />
                          ) : (
                            <input
                              value={value}
                              onChange={(event) => setDraft((current: any) => updateScreenplaySceneFields(current, scene.sequence, { [field]: event.target.value }))}
                            />
                          )}
                        </label>
                      );
                    })}
                    {Array.isArray(scene.evidence) && scene.evidence.length > 0 && (
                      <div className="vbs-locked-structure wide"><strong>来源证据已锁定</strong><span>{scene.evidence.length} 条来源证据不会被覆盖。</span></div>
                    )}
                  </div>
                ) : (
                  <>
                    <h3>{scene.title || `场景 ${scene.sequence}`}</h3>
                    {scene.knowledgeFocus && <p><strong>知识重点：</strong>{scene.knowledgeFocus}</p>}
                    {scene.visualAction && <p><strong>画面 / 动作：</strong>{scene.visualAction}</p>}
                    {scene.dialogue && <blockquote>{scene.dialogue}</blockquote>}
                    <div className="vbs-scene-meta">
                      {scene.visualPresentation && <span>呈现：{scene.visualPresentation}</span>}
                      {scene.ambientSound && <span>环境声：{scene.ambientSound}</span>}
                      {scene.effectSound && <span>音效：{scene.effectSound}</span>}
                      {scene.emotionalPurpose && <span>情绪目的：{scene.emotionalPurpose}</span>}
                    </div>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </StagePage>
  );
}
