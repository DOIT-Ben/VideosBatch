import { useEffect, useRef, useState } from "react";
import { Accordion, Tabs } from "radix-ui";
import { Check, ChevronDown, Copy, Pencil, Save, X } from "lucide-react";
import { StageEmpty, StageFact, StagePage } from "../components/StagePage";
import { useStageDraft } from "../useStageDraft";
import {
  storyboardSegmentFieldDefinitions,
  storyboardSegmentSubshots,
  storyboardSegmentSummary,
  updateStoryboardSegmentFields,
  updateStoryboardSubshotFields
} from "../contentModel";

const SUBSHOT_FIELDS = [
  ["visual", "画面"],
  ["action", "动作"],
  ["camera", "机位 / 运镜"],
  ["sound", "声音"],
  ["voice", "对白 / 旁白"]
] as const;

async function copyText(text: string) {
  if (!text.trim()) return false;
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  await navigator.clipboard.writeText(text);
  return true;
}

export function StoryboardStage({
  artifact,
  copyablePromptArtifact,
  copyablePromptStatus,
  busy,
  onSaveArtifact
}: {
  artifact: any;
  copyablePromptArtifact?: any;
  copyablePromptStatus?: string;
  busy?: boolean;
  onSaveArtifact?: (artifact: any) => Promise<void> | void;
}) {
  const segments = Array.isArray(artifact?.segments) ? artifact.segments : [];
  const promptSegments = Array.isArray(copyablePromptArtifact?.segments) ? copyablePromptArtifact.segments : [];
  const { editing, setEditing, draft, setDraft, conflict, notice, publish, saving, saved, captureSave, completeSave } = useStageDraft<any>("storyboard", artifact);
  const [copiedKey, setCopiedKey] = useState("");


  const visibleSegments = Array.isArray((editing ? draft : artifact)?.segments)
    ? (editing ? draft : artifact).segments
    : [];

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

  // The "copied" badge clears itself after 1.6s; cancel the pending timer when
  // the step is switched away so it cannot fire into an unmounted tree.
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
  }, []);

  const copy = async (key: string, text: string) => {
    if (!(await copyText(text))) return;
    setCopiedKey(key);
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedKey((current) => current === key ? "" : current), 1600);
  };

  const editActions = editing ? (
    <>
      <button type="button" className="vbs-primary" disabled={busy || saving || saved || conflict} onClick={() => void save()}><Save size={15} /> 保存分镜</button>
            {publish && <button type="button" className="vbs-secondary" disabled={busy || saving || saved || conflict} onClick={() => void save(true)}>保存并继续</button>}
      <button type="button" className="vbs-secondary" disabled={busy || saving} onClick={() => setEditing(false)}><X size={15} /> 丢弃草稿</button>
    </>
  ) : onSaveArtifact && segments.length ? (
    <button type="button" className="vbs-secondary" disabled={busy} onClick={() => setEditing(true)}><Pencil size={15} /> 编辑分镜</button>
  ) : null;

  return (
    <StagePage
      onKeyDown={event => { if (editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)) { event.preventDefault(); void save(); } }}
      stepId="storyboard"
      title={artifact?.title || "最终分镜"}
      lead="逐镜头确认画面、动作和声音。"
      facts={
        <>
          <StageFact value={`${artifact?.targetDuration || "—"}s`} label="总时长" />
          <StageFact value={segments.length} label="主分镜" />
        </>
      }
      actions={editActions}
    >
      {notice}
      <Tabs.Root className="vbs-storyboard-tabs" defaultValue="structure">
        <Tabs.List className="vbs-tabs-list" aria-label="视频分镜视图">
          <Tabs.Trigger className="vbs-tab-trigger" value="structure">分镜结构</Tabs.Trigger>
          <Tabs.Trigger className="vbs-tab-trigger" value="prompt">生成提示词</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content className="vbs-tab-content" value="structure">
          {!visibleSegments.length ? <StageEmpty>最终分镜尚未生成。</StageEmpty> : (
            <Accordion.Root
              className="vbs-storyboard-accordion"
              type="multiple"
              defaultValue={visibleSegments.length ? [`segment-${visibleSegments[0].sequence}`] : []}
            >
              {visibleSegments.map((segment: any) => {
                const start = (Number(segment.sequence || 1) - 1) * 10;
                const references = Array.isArray(segment.references) ? segment.references : [];
                const subshots = storyboardSegmentSubshots(segment);
                const segmentFields = storyboardSegmentFieldDefinitions(editing ? draft : artifact, segment);
                const canonicalFields = segmentFields[0]?.[0] === "scene";
                return (
                  <Accordion.Item className="vbs-shot-card vbs-storyboard-item" key={segment.sequence} value={`segment-${segment.sequence}`}>
                    <Accordion.Header className="vbs-storyboard-header">
                      <Accordion.Trigger className="vbs-storyboard-trigger">
                        <span className="vbs-storyboard-summary">
                          <span><span className="vbs-code">镜头 {String(segment.sequence).padStart(2, "0")}</span><strong>{String(start).padStart(2, "0")}–{String(start + Number(segment.duration || 10)).padStart(2, "0")}s</strong></span>
                          <span className="vbs-storyboard-summary-copy">{storyboardSegmentSummary(segment) || "暂无画面内容"}</span>
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
                            {segmentFields.map(([field, label, wide]) => (
                              <label className={wide ? "wide" : ""} key={field}>
                                <span>{label}</span>
                                <textarea
                                  rows={wide ? 5 : 3}
                                  value={String(segment?.[field] || "")}
                                  onChange={(event) => setDraft((current: any) => updateStoryboardSegmentFields(current, segment.sequence, { [field]: event.target.value }))}
                                />
                              </label>
                            ))}
                          </div>
                          <div className="vbs-locked-structure">
                            <strong>结构锁定</strong>
                            <span>时长 {segment.duration || 10}s · {references.length} 个资产引用 · {subshots.length} 个子镜头，均不可编辑</span>
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
                          {canonicalFields ? (
                            <div className="vbs-storyboard-facts">
                              {segmentFields.map(([field, label]) => String(segment?.[field] || "").trim() ? (
                                <div className="vbs-teaching-purpose" key={field}><strong>{label}</strong><span>{segment[field]}</span></div>
                              ) : null)}
                            </div>
                          ) : (
                            <>
                              <p className="vbs-visual-prompt">{segment.visualPrompt}</p>
                              {segment.teachingPurpose && <div className="vbs-teaching-purpose"><strong>教学目的</strong><span>{segment.teachingPurpose}</span></div>}
                            </>
                          )}
                          <div className="vbs-subshot-list">
                            {subshots.map((subshot: any) => (
                              <div className="vbs-subshot" key={subshot.sequence}>
                                <span>{subshot.duration}s</span>
                                <div><strong>{subshot.visual}</strong><p>{subshot.action}</p><small>{subshot.camera} · {subshot.sound}{subshot.voice ? ` · ${subshot.voice}` : ""}</small></div>
                              </div>
                            ))}
                          </div>
                          {references.length > 0 && <div className="vbs-reference-chips">{references.map((reference: any, index: number) => <span key={`${reference.label || reference.publicAssetId || reference.assetId || "reference"}-${index}`}>{reference.label || reference.publicAssetId || reference.assetId}</span>)}</div>}
                          {(segment.narration || segment.subtitles) && <div className="vbs-dialogue-block">{segment.narration && <p><strong>旁白：</strong>{segment.narration}</p>}{segment.subtitles && <p><strong>字幕：</strong>{segment.subtitles}</p>}</div>}
                        </>
                      )}
                    </Accordion.Content>
                  </Accordion.Item>
                );
              })}
            </Accordion.Root>
          )}
        </Tabs.Content>

        <Tabs.Content className="vbs-tab-content" value="prompt">
          {!copyablePromptArtifact ? (
            <StageEmpty>
              <strong>提示词尚未生成</strong>
              <p>保存分镜后，这里会生成可直接复制的提示词。</p>
            </StageEmpty>
          ) : (
            <div className="vbs-copyable-prompt-view">
              {copyablePromptStatus === "stale" && <div className="vbs-inline-warning">分镜有改动，这份提示词已过期，请重新生成。</div>}
              <section className="vbs-prompt-master-card">
                <header>
                  <div><small>全部镜头</small><strong>提示词全文</strong></div>
                  <button type="button" className="vbs-secondary" onClick={() => void copy("all", String(copyablePromptArtifact.fullText || ""))}>
                    {copiedKey === "all" ? <Check size={15} /> : <Copy size={15} />}
                    {copiedKey === "all" ? "已复制" : "复制全部"}
                  </button>
                </header>
                <pre>{String(copyablePromptArtifact.fullText || "")}</pre>
              </section>

              <div className="vbs-prompt-segment-list">
                {promptSegments.map((segment: any) => {
                  const key = `segment-${segment.sequence}`;
                  const references = Array.isArray(segment.referenceAssetIds) ? segment.referenceAssetIds : [];
                  return (
                    <article className="vbs-prompt-segment-card" key={key}>
                      <header>
                        <div><span className="vbs-code">镜头 {String(segment.sequence).padStart(2, "0")}</span><small>{references.length} 个资产引用</small></div>
                        <button type="button" className="vbs-link-button" onClick={() => void copy(key, String(segment.text || ""))}>
                          {copiedKey === key ? <Check size={14} /> : <Copy size={14} />}
                          {copiedKey === key ? "已复制" : "复制本段"}
                        </button>
                      </header>
                      <pre>{String(segment.text || "")}</pre>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </Tabs.Content>
      </Tabs.Root>
    </StagePage>
  );
}
