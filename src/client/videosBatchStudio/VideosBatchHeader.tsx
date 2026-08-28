import type { VideosBatchProductStatus } from "./stageModel";
import { StageStatus } from "./components/StageStatus";

export function VideosBatchHeader({
  sessionTitle,
  stepLabel,
  status,
  onOpenCanvas
}: {
  sessionTitle: string;
  stepLabel: string;
  status: VideosBatchProductStatus;
  onOpenCanvas: () => void;
}) {
  return (
    <header className="vbs-header">
      <div className="vbs-brand-block">
        <div className="vbs-brand-line">
          <strong className="vbs-brand">VideosBatch</strong>
          <span className="vbs-project-title">{sessionTitle || "未命名课程视频"}</span>
        </div>
        <div className="vbs-header-meta">
          <span>当前步骤：{stepLabel}</span>
          <StageStatus status={status} />
        </div>
      </div>
      <div className="vbs-mode-switch" role="group" aria-label="工作区模式">
        <button type="button" className="active" aria-pressed="true">流程制作</button>
        <button type="button" aria-pressed="false" onClick={onOpenCanvas}>制作画布</button>
      </div>
    </header>
  );
}
