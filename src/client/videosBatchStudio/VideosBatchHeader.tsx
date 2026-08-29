import { Sparkles } from "lucide-react";

export function VideosBatchHeader({
  sessionTitle,
  completedCount,
  totalSteps,
  onOpenCanvas
}: {
  sessionTitle: string;
  completedCount: number;
  totalSteps: number;
  onOpenCanvas: () => void;
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

      <div className="vbs-v2-project-meta" aria-label={`当前项目 ${sessionTitle || "未命名课程视频"}，已完成 ${completedCount} / ${totalSteps}`}>
        <strong>{sessionTitle || "未命名课程视频"}</strong>
        <span aria-hidden="true">·</span>
        <small>{completedCount} / {totalSteps}</small>
      </div>

      <div className="vbs-v2-mode-switch" role="group" aria-label="工作区模式">
        <button type="button" className="active" aria-pressed="true">流程制作</button>
        <button type="button" aria-pressed="false" onClick={onOpenCanvas}>制作画布</button>
      </div>
    </header>
  );
}
