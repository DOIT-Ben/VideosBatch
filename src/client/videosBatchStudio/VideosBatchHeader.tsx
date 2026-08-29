import { Clapperboard, Sparkles } from "lucide-react";

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
        <span className="vbs-v2-brand-mark" aria-hidden="true"><Sparkles size={20} /></span>
        <div>
          <div className="vbs-v2-brand-title"><strong>VideosBatch</strong><span>课程视频工作台</span></div>
          <p>从教案到课程导入视频，一步步完成内容与媒体制作</p>
        </div>
      </div>

      <div className="vbs-v2-project-meta">
        <Clapperboard size={16} aria-hidden="true" />
        <div><span>当前项目</span><strong>{sessionTitle || "未命名课程视频"}</strong></div>
        <small>{completedCount} / {totalSteps}</small>
      </div>

      <div className="vbs-v2-mode-switch" role="group" aria-label="工作区模式">
        <button type="button" className="active" aria-pressed="true">流程制作</button>
        <button type="button" aria-pressed="false" onClick={onOpenCanvas}>制作画布</button>
      </div>
    </header>
  );
}
