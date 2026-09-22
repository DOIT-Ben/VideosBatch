import { DraftNotice, useStageDraft } from "../useStageDraft";
import { Pencil, Save, X } from "lucide-react";
import { Clamp } from "../components/Clamp";
import { StageEmpty, StageFact, StagePage } from "../components/StagePage";

export function StoryStage({
  artifact,
  busy,
  onSaveContent
}: {
  artifact: any;
  busy?: boolean;
  onSaveContent?: (content: string) => Promise<void> | void;
}) {
  const content = String(artifact?.content || "");
  const { editing, setEditing, draft, setDraft, conflict, storageFailed, captureSave, completeSave } = useStageDraft("story", content);

  const save = async () => {
    if (!draft.trim() || conflict) return;
    const submitted = captureSave();
    try {
      await onSaveContent?.(draft);
      completeSave(submitted);
    } catch {
      // The studio reports the failure inline; keep the draft open so a rejected
      // save does not silently discard the user's edit (same rule as the
      // screenplay and storyboard editors).
    }
  };

  const hasContent = Boolean(content || editing);

  return (
    <StagePage
      stepId="story"
      title={artifact?.title || "故事文稿"}
      lead="课程导入故事的完整文稿，可直接编辑。保存后后续内容都以这一版为准。"
      facts={hasContent ? <StageFact value={(editing ? draft : content).length} label="当前字数" /> : null}
      actions={onSaveContent && hasContent ? (
        editing ? (
          <>
            <button type="button" className="vbs-primary" disabled={busy || conflict || !draft.trim()} onClick={() => void save()}><Save size={15} /> 保存正文</button>
            <button type="button" className="vbs-secondary" disabled={busy} onClick={() => setEditing(false)}><X size={15} /> 丢弃草稿</button>
          </>
        ) : (
          <button type="button" className="vbs-secondary" disabled={busy} onClick={() => setEditing(true)}><Pencil size={15} /> 编辑故事正文</button>
        )
      ) : null}
    >
      {editing && <DraftNotice conflict={conflict} storageFailed={storageFailed} />}
      {artifact?.truthfulnessNote ? (
        <div className="vbs-note-card"><strong>真实性说明</strong><p>{artifact.truthfulnessNote}</p></div>
      ) : null}
      {hasContent ? (
        editing ? (
          <textarea
            className="vbs-story-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={22}
            aria-label="编辑故事正文"
          />
        ) : (
          <Clamp lines={14}><article className="vbs-longform">{content}</article></Clamp>
        )
      ) : <StageEmpty>故事文稿尚未生成。</StageEmpty>}
    </StagePage>
  );
}
