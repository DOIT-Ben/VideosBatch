import { Sparkles } from "lucide-react";

export function VideosBatchHeader({
  sessionTitle,
  completedCount,
  totalSteps,
  headline,
  activeMode = "workflow",
  onOpenWorkflow,
  onOpenCanvas
}: {
  sessionTitle: string;
  completedCount: number;
  totalSteps: number;
  headline?: string;
  activeMode?: "workflow" | "canvas";
  onOpenWorkflow?: () => void;
  onOpenCanvas?: () => void;
}) {
  return (
    <header className="vbs-v2-header">
      <div className="vbs-v2-brand-lockup">
        <span className="vbs-v2-brand-mark" aria-hidden="true"><Sparkles size={19} /></span>
        <div className="vbs-v2-brand-title">
          <strong>VideosBatch</strong>
          <span>AI 课程视频工作室</span>
        </div>
      </div>

      {headline ? (
        <div className="vbs-v2-header-headline">
          <h1>{headline}</h1>
        </div>
      ) : <div className="vbs-v2-header-headline-spacer" aria-hidden="true" />}

      <div className="vbs-v2-project-meta" aria-label={`当前项目 ${sessionTitle || "未命名课程视频"}，已完成 ${completedCount} / ${totalSteps}`}>
        <strong>{sessionTitle || "未命名课程视频"}</strong>
        <span aria-hidden="true">·</span>
        <small>{completedCount} / {totalSteps}</small>
      </div>

      <div className="vbs-v2-mode-switch" role="group" aria-label="工作区模式">
        <button
          type="button"
          className={activeMode === "workflow" ? "active" : ""}
          aria-pressed={activeMode === "workflow"}
          onClick={onOpenWorkflow}
        >
          流程制作
        </button>
        <button
          type="button"
          className={activeMode === "canvas" ? "active" : ""}
          aria-pressed={activeMode === "canvas"}
          onClick={onOpenCanvas}
        >
          制作画布
        </button>
      </div>
    </header>
  );
}
