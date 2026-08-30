import type { Shot } from "../../../shared/types";
import { preferredShotVideoUrl } from "../contentModel";

function shotStatusLabel(shot: Shot) {
  if (shot.status === "ready") return "✓ 已完成";
  if (shot.status === "error") return "生成失败";
  if (shot.status === "cancelled") return "已取消";
  if (shot.seedancePhase === "queued") return "排队中";
  if (shot.status === "generating") return "生成中";
  return "待生成";
}

export function ExecutionStage({
  quoteArtifact,
  executionArtifact,
  shots = [],
  onOpenCanvas
}: {
  quoteArtifact: any;
  executionArtifact: any;
  shots?: Shot[];
  onOpenCanvas: () => void;
}) {
  const renderIds = Array.isArray(executionArtifact?.renderIds) ? executionArtifact.renderIds : [];
  const nativeShotIds = Array.isArray(executionArtifact?.nativeShotIds) ? executionArtifact.nativeShotIds : [];
  const orderedShots = [...shots].sort((a, b) => a.index - b.index);
  const readyCount = orderedShots.filter((shot) => shot.status === "ready" && preferredShotVideoUrl(shot)).length;
  const totalCount = orderedShots.length || nativeShotIds.length || renderIds.length;
  const ready = totalCount > 0 && readyCount === totalCount;
  // Execution stage artifact may be READY while the native shot media has not
  // been generated (fake mode, or plan confirmed but generation not started).
  // Say what is actually pending instead of claiming an active generation.
  const anyGenerating = orderedShots.some((shot) => shot.status === "generating" || shot.seedancePhase === "queued");
  const progressLabel = ready ? "视频镜头已生成" : anyGenerating ? "正在生成视频" : "等待视频生成";

  return (
    <section className="vbs-stage-page">
      <div className="vbs-stage-kicker">08 · 视频生成</div>
      <div className="vbs-document-header">
        <div><h2>批量生成视频</h2><p>按最终分镜逐镜头执行。这里直接读取 SeeReel Shot/Render 状态，需要精调时进入制作画布。</p></div>
        <button type="button" className="vbs-secondary" onClick={onOpenCanvas}>在制作画布中打开</button>
      </div>
      {quoteArtifact && <div className="vbs-note-card"><strong>执行快照</strong><p>目标时长 {quoteArtifact.targetDurationSeconds || "—"} 秒 · 资产顺序已锁定 {Array.isArray(quoteArtifact.assetOrder) ? quoteArtifact.assetOrder.length : 0} 项</p></div>}
      {!executionArtifact && !orderedShots.length ? <div className="vbs-empty-card">视频执行尚未开始。</div> : (
        <div className="vbs-execution-summary">
          <div className="vbs-progress-card"><span className={`vbs-progress-dot ${ready ? "ready" : anyGenerating ? "running" : ""}`} /><div><strong>{progressLabel}</strong><small>{readyCount} / {totalCount} 个镜头完成</small></div></div>
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
    </section>
  );
}
