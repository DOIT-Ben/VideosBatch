import { useEffect, useState } from "react";
import { Pencil, Save, X } from "lucide-react";
import { updateScreenplaySceneFields } from "../contentModel";

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
    await onSaveArtifact?.(draft);
    setEditing(false);
  };

  return (
    <section className="vbs-stage-page vbs-document-stage">
      <div className="vbs-stage-kicker">06 · 视频剧本</div>
      <div className="vbs-document-header">
        <div><h2>{artifact?.title || "正式视频剧本"}</h2><p>把故事转换成可执行的视频表达结构。编辑后会保存为新的正式剧本，并使下游分镜进入待更新状态。</p></div>
        <div className="vbs-document-facts">
          <span><strong>{duration || "—"}s</strong><small>目标时长</small></span>
          <span><strong>{duration ? duration / 10 : "—"}</strong><small>预计主分镜</small></span>
        </div>
      </div>
      {!scenes.length ? <div className="vbs-empty-card">正式视频剧本尚未生成。</div> : (
        <>
          <div className="vbs-document-actions vbs-document-actions-top">
            {editing ? (
              <>
                <button type="button" className="vbs-primary" disabled={busy} onClick={() => void save()}><Save size={15} /> 保存视频剧本</button>
                <button type="button" className="vbs-secondary" disabled={busy} onClick={() => { setDraft(artifact); setEditing(false); }}><X size={15} /> 取消</button>
              </>
            ) : onSaveArtifact ? (
              <button type="button" className="vbs-secondary" disabled={busy} onClick={() => setEditing(true)}><Pencil size={15} /> 编辑视频剧本</button>
            ) : null}
          </div>
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
                        <div className="vbs-locked-structure wide"><strong>来源证据已锁定</strong><span>{scene.evidence.length} 条 evidence 不会被表单编辑覆盖。</span></div>
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
        </>
      )}
    </section>
  );
}
