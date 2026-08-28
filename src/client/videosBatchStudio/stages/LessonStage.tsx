import { useEffect, useState } from "react";

export function LessonStage({
  sessionTitle,
  lessonText,
  busy,
  started,
  onStart
}: {
  sessionTitle: string;
  lessonText?: string;
  busy?: boolean;
  started: boolean;
  onStart: (lessonText: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(lessonText || "");

  useEffect(() => {
    setDraft(lessonText || "");
  }, [lessonText]);

  return (
    <section className="vbs-stage-page vbs-lesson-stage">
      <div className="vbs-stage-kicker">01 · 教案</div>
      <h2>{started ? "课程教案" : "创建课程视频"}</h2>
      <p className="vbs-stage-lead">把一份完整教案变成 90–150 秒的课程导入视频。系统会按步骤生成内容，并在关键节点等待确认。</p>

      <div className="vbs-form-card">
        <label>
          <span>项目名称</span>
          <input value={sessionTitle || "未命名课程视频"} readOnly aria-label="项目名称" />
        </label>
        <label>
          <span>完整教案</span>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={14}
            readOnly={started}
            placeholder="粘贴完整教案，包括教学目标、教学内容、重点难点与课堂流程……"
            aria-label="完整教案"
          />
        </label>
        <div className="vbs-inline-facts">
          <span><strong>16:9</strong><small>视频比例</small></span>
          <span><strong>分步确认</strong><small>生成方式</small></span>
          <span><strong>90–150s</strong><small>目标时长</small></span>
        </div>
        {!started && (
          <button type="button" className="vbs-primary vbs-large-action" disabled={busy || !draft.trim()} onClick={() => onStart(draft.trim())}>
            {busy ? "正在启动…" : "开始生成课程导入 →"}
          </button>
        )}
      </div>
    </section>
  );
}
