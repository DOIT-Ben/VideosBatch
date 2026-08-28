export function ExecutionStage({ quoteArtifact, executionArtifact, onOpenCanvas }: { quoteArtifact: any; executionArtifact: any; onOpenCanvas: () => void }) {
  const renderIds = Array.isArray(executionArtifact?.renderIds) ? executionArtifact.renderIds : [];
  const nativeShotIds = Array.isArray(executionArtifact?.nativeShotIds) ? executionArtifact.nativeShotIds : [];
  const ready = executionArtifact?.status === "READY";
  return (
    <section className="vbs-stage-page">
      <div className="vbs-stage-kicker">08 · 视频生成</div>
      <div className="vbs-document-header">
        <div><h2>批量生成视频</h2><p>按最终分镜逐镜头执行。需要精调某个镜头时可以进入制作画布。</p></div>
        <button type="button" className="vbs-secondary" onClick={onOpenCanvas}>在制作画布中打开</button>
      </div>
      {quoteArtifact && <div className="vbs-note-card"><strong>执行快照</strong><p>目标时长 {quoteArtifact.targetDurationSeconds || "—"} 秒 · 资产顺序已锁定 {Array.isArray(quoteArtifact.assetOrder) ? quoteArtifact.assetOrder.length : 0} 项</p></div>}
      {!executionArtifact ? <div className="vbs-empty-card">视频执行尚未开始。</div> : (
        <div className="vbs-execution-summary">
          <div className="vbs-progress-card"><span className={`vbs-progress-dot ${ready ? "ready" : "running"}`} /><div><strong>{ready ? "视频镜头已生成" : "正在生成视频"}</strong><small>{renderIds.length || nativeShotIds.length} 个渲染结果</small></div></div>
          <div className="vbs-task-list">
            {(nativeShotIds.length ? nativeShotIds : renderIds).map((id: string, index: number) => (
              <div className="vbs-task-row" key={id}><span>{String(index + 1).padStart(2, "0")}</span><strong>镜头 {String(index + 1).padStart(2, "0")}</strong><small>{ready ? "✓ 已完成" : "处理中"}</small></div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
