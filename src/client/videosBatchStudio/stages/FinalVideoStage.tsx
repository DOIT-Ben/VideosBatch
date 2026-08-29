import type { Session } from "../../../shared/types";
import { preferredFinalVideo } from "../contentModel";

export function FinalVideoStage({ artifact, session, onOpenCanvas }: { artifact: any; session?: Session; onOpenCanvas: () => void }) {
  const native = preferredFinalVideo(session);
  const artifactUrl = String(artifact?.finalVideoUrl || "");
  const playbackUrl = native.playbackUrl || (!artifactUrl.startsWith("fake://") ? artifactUrl : "");
  const downloadUrl = native.downloadUrl || playbackUrl;
  const status = native.status !== "idle" ? native.status : String(artifact?.status || "idle").toLowerCase();
  const ready = status === "ready" && Boolean(playbackUrl);

  return (
    <section className="vbs-stage-page vbs-final-stage">
      <div className="vbs-stage-kicker">09 · 最终成片</div>
      <div className="vbs-final-hero">
        <div className={`vbs-final-check ${ready ? "ready" : ""}`}>{ready ? "✓" : "○"}</div>
        <h2>{ready ? "课程视频已完成" : status === "running" ? "正在拼接最终视频" : "等待最终拼接"}</h2>
        <p>{ready ? "当前播放器直接读取 SeeReel StitchJob 的最终成片。" : native.progress || "完成视频执行后，系统会把已确认镜头按顺序拼接。"}</p>
      </div>
      {playbackUrl ? (
        <video className="vbs-final-player" src={playbackUrl} controls playsInline preload="metadata" />
      ) : (
        <div className="vbs-final-player-placeholder"><span>{artifactUrl.startsWith("fake://") ? "模拟成片尚未映射为真实媒体" : "最终视频预览"}</span><small>{native.progress || artifactUrl || "尚未生成"}</small></div>
      )}
      <div className="vbs-final-actions">
        {downloadUrl && <a className="vbs-primary" href={downloadUrl} download>下载 MP4</a>}
        <button type="button" className="vbs-secondary" onClick={onOpenCanvas}>进入制作画布</button>
      </div>
    </section>
  );
}
