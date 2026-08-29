import { useEffect, useState } from "react";
import { Pencil, Save, X } from "lucide-react";

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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);

  useEffect(() => {
    setDraft(content);
    setEditing(false);
  }, [content, artifact?.title]);

  const save = async () => {
    if (!draft.trim()) return;
    await onSaveContent?.(draft);
    setEditing(false);
  };

  return (
    <section className="vbs-stage-page vbs-document-stage">
      <div className="vbs-stage-kicker">03 · 故事文稿</div>
      <div className="vbs-document-header">
        <div>
          <h2>{artifact?.title || "故事文稿"}</h2>
          <p>{artifact?.storyType || "课程导入故事"}</p>
        </div>
        <div className="vbs-document-facts">
          <span><strong>{(editing ? draft : content).length}</strong><small>当前字数</small></span>
          <span><strong>{artifact?.storyType || "—"}</strong><small>故事类型</small></span>
        </div>
      </div>
      {artifact?.truthfulnessNote && <div className="vbs-note-card"><strong>真实性说明</strong><p>{artifact.truthfulnessNote}</p></div>}
      {content || editing ? (
        <>
          {editing ? (
            <textarea
              className="vbs-story-editor"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={22}
              aria-label="编辑故事正文"
            />
          ) : (
            <article className="vbs-longform">{content}</article>
          )}
          {onSaveContent && (
            <div className="vbs-document-actions">
              {editing ? (
                <>
                  <button type="button" className="vbs-primary" disabled={busy || !draft.trim()} onClick={() => void save()}><Save size={15} /> 保存正文</button>
                  <button type="button" className="vbs-secondary" disabled={busy} onClick={() => { setDraft(content); setEditing(false); }}><X size={15} /> 取消</button>
                </>
              ) : (
                <button type="button" className="vbs-secondary" disabled={busy} onClick={() => setEditing(true)}><Pencil size={15} /> 编辑故事正文</button>
              )}
            </div>
          )}
        </>
      ) : <div className="vbs-empty-card">故事文稿尚未生成。</div>}
    </section>
  );
}
