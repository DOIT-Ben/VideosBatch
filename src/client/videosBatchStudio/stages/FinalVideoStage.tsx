export function FinalVideoStage({ artifact, onOpenCanvas }: { artifact: any; onOpenCanvas: () => void }) {
  const url = String(artifact?.finalVideoUrl || "");
  const ready = artifact?.status === "READY" && Boolean(url);
  return (
    <section className="vbs-stage-page vbs-final-stage">
      <div className="vbs-stage-kicker">09 · 最终成片</div>
      <div className="vbs-final-hero">
        <div className={`vbs-final-check ${ready ? "ready" : ""}`}>{ready ? "✓" : "○"}</div>
        <h2>{ready ? "课程视频已完成" : "等待最终拼接"}</h2>
        <p>{ready ? "所有镜头已经拼接为最终视频。" : "完成视频执行后，系统会把已确认镜头按顺序拼接。"}</p>
      </div>
      {url && !url.startsWith("fake://") ? (
        <video className="vbs-final-player" src={url} controls preload="metadata" />
      ) : (
        <div className="vbs-final-player-placeholder"><span>{url.startsWith("fake://") ? "模拟成片" : "最终视频预览"}</span><small>{url || "尚未生成"}</small></div>
      )}
      <div className="vbs-final-actions">
        {url && !url.startsWith("fake://") && <a className="vbs-primary" href={url} download>下载 MP4</a>}
        <button type="button" className="vbs-secondary" onClick={onOpenCanvas}>进入制作画布</button>
      </div>
    </section>
  );
}
