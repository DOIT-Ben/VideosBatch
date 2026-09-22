import type { Session } from "../../../shared/types";
import { preferredFinalVideo } from "../contentModel";
import { StagePage } from "../components/StagePage";

export function FinalVideoStage({ artifact, session, onOpenCanvas }: { artifact: any; session?: Session; onOpenCanvas: () => void }) {
  const native = preferredFinalVideo(session);
  const artifactUrl = String(artifact?.finalVideoUrl || "");
  const playbackUrl = native.playbackUrl || (!artifactUrl.startsWith("fake://") ? artifactUrl : "");
  const downloadUrl = native.downloadUrl || playbackUrl;
  const workflowStage = session?.videosBatchWorkflow?.stages.STITCH;
  const workflowIncomplete = Boolean(session?.videosBatchWorkflow && !session.videosBatchWorkflow.completed);
  const status = workflowStage && workflowStage.status !== "ready" ? workflowStage.status
    : native.status !== "idle" ? native.status : String(artifact?.status || "idle").toLowerCase();
  const historical = Boolean(playbackUrl && (native.historical || workflowIncomplete || status !== "ready"));
  const ready = status === "ready" && Boolean(playbackUrl) && !historical;
  // Workflow completed against simulated media (fake provider): the stitch stage
  // is ready but no playable mp4 exists, so avoid claiming/awaiting a real stitch.
  const simulatedReady = !ready && !workflowIncomplete && status === "ready" && artifactUrl.startsWith("fake://");
  const settled = ready || simulatedReady;

  return (
    <StagePage stepId="final" className="vbs-final-stage" title="最终成片" lead="全部镜头按顺序拼接后的交付文件。">
      <div className="vbs-final-delivery">
        <div className="vbs-final-delivery-copy">
          <div className={`vbs-final-check ${settled ? "ready" : ""}`}>{settled ? "✓" : "○"}</div>
          <div className="vbs-final-hero">
            <h2>{ready ? "课程视频已完成" : simulatedReady ? "示例成片已就绪" : status === "running" ? "正在拼接最终视频" : status === "failed" ? "本次拼接未完成" : "等待最终拼接"}</h2>
            <p>{ready ? "可直接下载交付，或进入制作画布继续调整。" : simulatedReady ? "全流程已走完，当前为演示内容。" : native.progress || "完成前面的镜头生成后，系统会把视频按顺序拼接。"}</p>
          </div>
        </div>

        <div className="vbs-final-delivery-media">
          {historical && <p role="status">以下为上一版成片，尚未包含当前修改。</p>}
          {playbackUrl ? (
            <video className="vbs-final-player" src={playbackUrl} controls playsInline preload="metadata" />
          ) : (
            <div className="vbs-final-player-placeholder">
              <span>{artifactUrl.startsWith("fake://") ? "示例成片" : "最终视频预览"}</span>
              {/* Secondary line only when it carries real information — under the fake
                  provider "尚未生成" would just restate the placeholder above it. */}
              {!artifactUrl.startsWith("fake://") && (native.progress || artifactUrl) ? (
                <small>{native.progress || artifactUrl}</small>
              ) : null}
            </div>
          )}
        </div>

        {/* Actions live inside the delivery card: outside it, a lone secondary button
            (no MP4 to download yet) floated detached between the card and the footer. */}
        <div className="vbs-final-actions">
          {downloadUrl && <a className="vbs-primary" href={downloadUrl} download>{historical ? "下载上一版 MP4" : "下载 MP4"}</a>}
          <button type="button" className="vbs-secondary" onClick={onOpenCanvas}>进入制作画布</button>
        </div>
      </div>
    </StagePage>
  );
}
