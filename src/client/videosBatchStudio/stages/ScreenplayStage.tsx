import { useState } from "react";
import { useStageDraft } from "../useStageDraft";
import * as Accordion from "@radix-ui/react-accordion";
import { ChevronDown, Pencil, Save, X } from "lucide-react";
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
  const { editing, setEditing, draft, setDraft, conflict, notice, publish, saving, saved, captureSave, completeSave } = useStageDraft<any>("screenplay", artifact);
  // Progressive disclosure: collapsed by default except the first scene, so a
  // 12-scene script reads as a table of contents instead of a wall of text.
  // Editing forces every scene open; leaving edit mode restores the user's set.
  const [openScenes, setOpenScenes] = useState<string[] | null>(null);


  const draftScenes = Array.isArray(draft?.scenes) ? draft.scenes : [];
  const save = async (advance = false) => {
    if (saving || saved) return;
    if (publish) { if (!conflict) await publish(advance); return; }
    if (conflict) return;
    const submitted = captureSave();
    try {
      await onSaveArtifact?.(draft);
      completeSave(submitted);
    } catch {
      // The studio reports the failure inline; keep the draft open so a rejected
      // save does not silently discard the user's edit.
    }
  };

  return (
    <StagePage
      onKeyDown={event => { if (editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)) { event.preventDefault(); void save(); } }}
      stepId="screenplay"
      title={artifact?.title || "正式视频剧本"}
      lead="逐场景写出画面、对白和声音，作为后续分镜依据。"
      facts={scenes.length ? <StageFact value={`${duration || "—"}s`} label="目标时长" /> : null}
      actions={(editing ? draftScenes.length : scenes.length) && onSaveArtifact ? (
        editing ? (
          <>
            <button type="button" className="vbs-primary" disabled={busy || saving || saved || conflict} onClick={() => void save()}><Save size={15} /> 保存视频剧本</button>
            {publish && <button type="button" className="vbs-secondary" disabled={busy || saving || saved || conflict} onClick={() => void save(true)}>保存并继续</button>}
            <button type="button" className="vbs-secondary" disabled={busy || saving} onClick={() => setEditing(false)}><X size={15} /> 丢弃草稿</button>
          </>
        ) : (
          <button type="button" className="vbs-secondary" disabled={busy} onClick={() => setEditing(true)}><Pencil size={15} /> 编辑视频剧本</button>
        )
      ) : null}
    >
      {notice}
      {!(editing ? draftScenes.length : scenes.length) ? <StageEmpty>正式视频剧本尚未生成。</StageEmpty> : (
        <Accordion.Root
          className="vbs-storyboard-accordion vbs-screenplay-accordion"
          type="multiple"
          value={editing ? draftScenes.map((scene: any) => `scene-${scene.sequence}`) : (openScenes ?? (scenes.length ? [`scene-${scenes[0].sequence}`] : []))}
          onValueChange={(next: string[]) => { if (!editing) setOpenScenes(next); }}
        >
          {(editing ? draftScenes : scenes).map((scene: any) => (
            <Accordion.Item className="vbs-shot-card vbs-storyboard-item vbs-screenplay-scene" key={scene.sequence} value={`scene-${scene.sequence}`}>
              <Accordion.Header className="vbs-storyboard-header">
                <Accordion.Trigger className="vbs-storyboard-trigger">
                  <span className="vbs-storyboard-summary">
                    <span>
                      <span className="vbs-scene-number">{String(scene.sequence).padStart(2, "0")}</span>
                      <strong>{scene.title || `场景 ${scene.sequence}`}</strong>
                    </span>
                    <span className="vbs-storyboard-summary-copy">{scene.knowledgeFocus || "暂无知识重点"}</span>
                  </span>
                  <span className="vbs-storyboard-trigger-meta">
                    <ChevronDown className="vbs-accordion-chevron" size={17} />
                  </span>
                </Accordion.Trigger>
              </Accordion.Header>
              <Accordion.Content className="vbs-storyboard-content">
                {editing ? (
                  <div className="vbs-storyboard-editor">
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
                  </div>
                ) : (
                  <div className="vbs-screenplay-scene-body">
                    {scene.knowledgeFocus && <p><strong>知识重点：</strong>{scene.knowledgeFocus}</p>}
                    {scene.visualAction && <p><strong>画面 / 动作：</strong>{scene.visualAction}</p>}
                    {scene.dialogue && <blockquote>{scene.dialogue}</blockquote>}
                    <div className="vbs-scene-meta">
                      {scene.visualPresentation && <span>呈现：{scene.visualPresentation}</span>}
                      {scene.ambientSound && <span>环境声：{scene.ambientSound}</span>}
                      {scene.effectSound && <span>音效：{scene.effectSound}</span>}
                      {scene.emotionalPurpose && <span>情绪目的：{scene.emotionalPurpose}</span>}
                    </div>
                  </div>
                )}
              </Accordion.Content>
            </Accordion.Item>
          ))}
        </Accordion.Root>
      )}
    </StagePage>
  );
}
