import type { Shot } from "../../../shared/types";
import { preferredShotVideoUrl } from "../contentModel";
import { StageEmpty, StageFact, StagePage } from "../components/StagePage";

function shotStatusLabel(shot: Shot) {
  if (shot.status === "ready") return "✓ 已完成";
  if (shot.status === "error") return "生成失败";
  if (shot.status === "cancelled") return "已取消";
  if (shot.seedancePhase === "queued") return "排队中";
  if (shot.status === "generating") return "生成中";
  return "待生成";
}

export function ExecutionStage({
  executionArtifact,
  shots = [],
  onOpenCanvas
}: {
  executionArtifact: any;
  shots?: Shot[];
  onOpenCanvas: () => void;
}) {
  const renderIds = Array.isArray(executionArtifact?.renderIds) ? executionArtifact.renderIds : [];
  const nativeShotIds = Array.isArray(executionArtifact?.nativeShotIds) ? executionArtifact.nativeShotIds : [];
  const orderedShots = [...shots].sort((a, b) => a.index - b.index);
  const readyCount = orderedShots.filter((shot) => shot.status === "ready" && preferredShotVideoUrl(shot)).length;
  const totalCount = orderedShots.length || nativeShotIds.length || renderIds.length;

  return (
    <StagePage
      stepId="execution"
      title="批量生成视频"
      lead="按分镜逐镜头生成视频，可随时进入制作画布精调。"
      facts={totalCount ? <StageFact value={`${readyCount} / ${totalCount}`} label="镜头完成" /> : null}
      actions={<button type="button" className="vbs-secondary" onClick={onOpenCanvas}>在制作画布中打开</button>}
    >
      {!executionArtifact && !orderedShots.length ? <StageEmpty>视频执行尚未开始。</StageEmpty> : (
        <div className="vbs-execution-summary">
          {orderedShots.length ? (
            <div className="vbs-video-shot-grid">
              {orderedShots.map((shot, position) => {
                const url = preferredShotVideoUrl(shot);
                return (
                  <article className={`vbs-video-shot-card ${shot.status}`} key={shot.id}>
                    <div className="vbs-video-shot-preview">
                      {url ? <video src={url} controls playsInline preload="metadata" /> : <div className="vbs-video-shot-placeholder"><span>{shot.seedancePhase === "queued" ? "排队中" : shot.status === "generating" ? "生成中" : "等待视频"}</span></div>}
                    </div>
                    <div className="vbs-video-shot-copy">
                      <div><span className="vbs-code">{String(position + 1).padStart(2, "0")}</span><strong>{shot.title || `镜头 ${position + 1}`}</strong></div>
                      <small>{shotStatusLabel(shot)}</small>
                      {shot.error && <p className="vbs-inline-error">{shot.error}</p>}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="vbs-task-list">
              {(nativeShotIds.length ? nativeShotIds : renderIds).map((id: string, index: number) => (
                <div className="vbs-task-row" key={id}><span>{String(index + 1).padStart(2, "0")}</span><strong>镜头 {String(index + 1).padStart(2, "0")}</strong><small>{executionArtifact?.status === "READY" ? "✓ 已完成" : "处理中"}</small></div>
              ))}
            </div>
          )}
        </div>
      )}
    </StagePage>
  );
}
