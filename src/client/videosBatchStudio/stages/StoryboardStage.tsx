import { useEffect, useState } from "react";
import { Accordion } from "radix-ui";
import { ChevronDown, Pencil, Save, X } from "lucide-react";
import { updateStoryboardSegmentFields, updateStoryboardSubshotFields } from "../contentModel";

const SEGMENT_FIELDS = [
  ["visualPrompt", "画面 Prompt"],
  ["teachingPurpose", "教学目的"],
  ["narration", "旁白"],
  ["subtitles", "字幕"],
  ["transition", "转场"]
] as const;

const SUBSHOT_FIELDS = [
  ["visual", "画面"],
  ["action", "动作"],
  ["camera", "机位 / 运镜"],
  ["sound", "声音"],
  ["voice", "对白 / 旁白"]
] as const;

export function StoryboardStage({
  artifact,
  busy,
  onSaveArtifact
}: {
  artifact: any;
  busy?: boolean;
  onSaveArtifact?: (artifact: any) => Promise<void> | void;
}) {
  const segments = Array.isArray(artifact?.segments) ? artifact.segments : [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<any>(artifact);

  useEffect(() => {
    setDraft(artifact);
    setEditing(false);
  }, [artifact]);

  const visibleSegments = Array.isArray((editing ? draft : artifact)?.segments)
    ? (editing ? draft : artifact).segments
    : [];

  const save = async () => {
    await onSaveArtifact?.(draft);
    setEditing(false);
  };

  return (
    <section className="vbs-stage-page">
      <div className="vbs-stage-kicker">07 · 视频分镜</div>
      <div className="vbs-document-header">
        <div><h2>{artifact?.title || "最终 10 秒分镜"}</h2><p>正式分镜是事实源。使用结构化编辑器修改主分镜和子镜头；10 秒时长、稳定资产引用与来源证据保持锁定。</p></div>
        <div className="vbs-document-facts">
          <span><strong>{artifact?.targetDuration || "—"}s</strong><small>总时长</small></span>
          <span><strong>{segments.length}</strong><small>主分镜</small></span>
        </div>
      </div>
      {!segments.length ? <div className="vbs-empty-card">最终分镜尚未生成。</div> : (
        <>
          <div className="vbs-document-actions vbs-document-actions-top">
            {editing ? (
              <>
                <button type="button" className="vbs-primary" disabled={busy} onClick={() => void save()}><Save size={15} /> 保存分镜</button>
                <button type="button" className="vbs-secondary" disabled={busy} onClick={() => { setDraft(artifact); setEditing(false); }}><X size={15} /> 取消</button>
              </>
            ) : onSaveArtifact ? (
              <button type="button" className="vbs-secondary" disabled={busy} onClick={() => setEditing(true)}><Pencil size={15} /> 编辑分镜</button>
            ) : null}
          </div>

          <Accordion.Root
            className="vbs-storyboard-accordion"
            type="multiple"
            defaultValue={visibleSegments.length ? [`segment-${visibleSegments[0].sequence}`] : []}
          >
            {visibleSegments.map((segment: any) => {
              const start = (Number(segment.sequence || 1) - 1) * 10;
              const references = Array.isArray(segment.references) ? segment.references : [];
              const subshots = Array.isArray(segment.subshots) ? segment.subshots : [];
              return (
                <Accordion.Item className="vbs-shot-card vbs-storyboard-item" key={segment.sequence} value={`segment-${segment.sequence}`}>
                  <Accordion.Header className="vbs-storyboard-header">
                    <Accordion.Trigger className="vbs-storyboard-trigger">
                      <span className="vbs-storyboard-summary">
                        <span><span className="vbs-code">镜头 {String(segment.sequence).padStart(2, "0")}</span><strong>{String(start).padStart(2, "0")}–{String(start + Number(segment.duration || 10)).padStart(2, "0")}s · {segment.duration || 10}s</strong></span>
                        <span className="vbs-storyboard-summary-copy">{segment.visualPrompt || "暂无画面 Prompt"}</span>
                      </span>
                      <span className="vbs-storyboard-trigger-meta">
                        {segment.nativeShotId && <span className="vbs-native-pill">已同步制作画布</span>}
                        <ChevronDown className="vbs-accordion-chevron" size={17} />
                      </span>
                    </Accordion.Trigger>
                  </Accordion.Header>
                  <Accordion.Content className="vbs-storyboard-content">
                    {editing ? (
                      <div className="vbs-storyboard-editor">
                        <div className="vbs-structured-editor-grid">
                          {SEGMENT_FIELDS.map(([field, label]) => (
                            <label className={field === "visualPrompt" ? "wide" : ""} key={field}>
                              <span>{label}</span>
                              <textarea
                                rows={field === "visualPrompt" ? 5 : 3}
                                value={String(segment?.[field] || "")}
                                onChange={(event) => setDraft((current: any) => updateStoryboardSegmentFields(current, segment.sequence, { [field]: event.target.value }))}
                              />
                            </label>
                          ))}
                        </div>
                        <div className="vbs-locked-structure">
                          <strong>结构锁定</strong>
                          <span>主分镜时长 {segment.duration || 10}s · {references.length} 个稳定资产引用 · {subshots.length} 个子镜头</span>
                        </div>
                        <div className="vbs-subshot-editor-list">
                          {subshots.map((subshot: any) => (
                            <section className="vbs-subshot-editor" key={subshot.sequence}>
                              <header><strong>子镜头 {subshot.sequence}</strong><span>{subshot.duration}s · 时长锁定</span></header>
                              <div className="vbs-structured-editor-grid compact">
                                {SUBSHOT_FIELDS.map(([field, label]) => (
                                  <label className={field === "action" ? "wide" : ""} key={field}>
                                    <span>{label}</span>
                                    <textarea
                                      rows={field === "action" ? 3 : 2}
                                      value={String(subshot?.[field] || "")}
                                      onChange={(event) => setDraft((current: any) => updateStoryboardSubshotFields(current, segment.sequence, subshot.sequence, { [field]: event.target.value }))}
                                    />
                                  </label>
                                ))}
                              </div>
                            </section>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="vbs-visual-prompt">{segment.visualPrompt}</p>
                        {segment.teachingPurpose && <div className="vbs-teaching-purpose"><strong>教学目的</strong><span>{segment.teachingPurpose}</span></div>}
                        <div className="vbs-subshot-list">
                          {subshots.map((subshot: any) => (
                            <div className="vbs-subshot" key={subshot.sequence}>
                              <span>{subshot.duration}s</span>
                              <div><strong>{subshot.visual}</strong><p>{subshot.action}</p><small>{subshot.camera} · {subshot.sound}{subshot.voice ? ` · ${subshot.voice}` : ""}</small></div>
                            </div>
                          ))}
                        </div>
                        {references.length > 0 && <div className="vbs-reference-chips">{references.map((reference: any) => <span key={reference.publicAssetId || reference.assetId}>{reference.label || reference.publicAssetId || reference.assetId}</span>)}</div>}
                        {(segment.narration || segment.subtitles) && <div className="vbs-dialogue-block">{segment.narration && <p><strong>旁白：</strong>{segment.narration}</p>}{segment.subtitles && <p><strong>字幕：</strong>{segment.subtitles}</p>}</div>}
                      </>
                    )}
                  </Accordion.Content>
                </Accordion.Item>
              );
            })}
          </Accordion.Root>
        </>
      )}
    </section>
  );
}
