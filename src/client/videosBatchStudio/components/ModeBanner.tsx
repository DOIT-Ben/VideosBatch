import { useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import type { VideosBatchRuntimeSummary } from "../../../shared/types";

const DISMISS_KEY = "videosbatch:mode-banner-dismissed";

function readDismissed() {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Every stage can run against deterministic stubs, and a stubbed run looks exactly like a broken
 * one: the asset cards sit on "等待图片" forever and nothing on screen explains why. The resolved
 * switches only ever lived in `.env`, so this banner says them out loud.
 *
 * It is dismissible and remembers that for the browser session, so it informs without nagging.
 */
export function ModeBanner({ runtime }: { runtime?: VideosBatchRuntimeSummary }) {
  const [dismissed, setDismissed] = useState(readDismissed);

  if (!runtime || dismissed) return null;

  const stubbed: string[] = [];
  if (runtime.executorMode === "fake") stubbed.push("文本");
  if (runtime.mediaMode === "fake") stubbed.push("图片与视频");
  if (runtime.ttsProvider === "fake") stubbed.push("配音");
  if (!stubbed.length && !runtime.error) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // A blocked storage policy should not stop the user from closing the banner.
    }
  };

  return (
    <div className="vbs-mode-banner" role="status">
      <TriangleAlert size={16} className="vbs-mode-banner-icon" aria-hidden="true" />
      <div className="vbs-mode-banner-body">
        <strong>模拟模式：{stubbed.length ? `${stubbed.join("、")}不会真实生成` : "环境配置有误"}</strong>
        {runtime.error ? (
          <span>环境配置无法解析：{runtime.error}</span>
        ) : (
          <span>
            所以这一步的成果是示例数据，资产卡会一直停在「等待图片」。要真实出片，需把
            <code>VIDEOSBATCH_EXECUTOR_MODE</code> 设为 <code>llm</code>、
            <code>VIDEOSBATCH_MEDIA_MODE</code> 设为 <code>native</code>（真实调用是付费的）。
          </span>
        )}
      </div>
      <button
        type="button"
        className="vbs-mode-banner-close"
        onClick={dismiss}
        title="关闭提示"
        aria-label="关闭提示"
      >
        <X size={14} />
      </button>
    </div>
  );
}
