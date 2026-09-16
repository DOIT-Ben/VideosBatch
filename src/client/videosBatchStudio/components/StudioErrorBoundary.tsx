import { Component, type ErrorInfo, type ReactNode } from "react";
import { Rows3 } from "lucide-react";

/**
 * Last-resort boundary for the Guided Studio.
 *
 * The studio derives its rendered step from the workflow cursor. Any invariant
 * gap between the canonical stage list and the product-step projection used to
 * take the entire page down — `deriveCurrentProductStep` throws, React unmounts
 * the whole tree, and the operator sees a blank page with no way back in
 * (2026-09-16: `AUDIO_DELIVERY` had no product step). A missing mapping is a
 * programming error that the product-step smoke now guards, but a rendering
 * failure must never be indistinguishable from "the app is broken" — degrade to
 * an actionable panel instead of unmounting everything.
 *
 * The fallback must carry its own way out. `VideosBatchHeader` — including its
 * 「任务列表」 entry point — is rendered *inside* this boundary, so a caught
 * failure removes it along with everything else. Offering only "reload" would be
 * a dead end for a deterministic render error: the reload reproduces it
 * (2026-09-16 review). So re-render the header's own escape hatch here, using the
 * real header classes, and make "back to the task list" the primary action.
 */
export class StudioErrorBoundary extends Component<
  { children: ReactNode; onBackToSessions?: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the raw failure in the console: the inline panel is for the
    // operator, the stack is for whoever has to fix it.
    console.error("VideosBatch studio render failed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { onBackToSessions } = this.props;
    return (
      <section className="videosbatch-studio videosbatch-studio-v2" aria-label="VideosBatch 流程制作">
        <header className="vbs-v2-header">
          <div className="vbs-v2-header-left">
            {onBackToSessions ? (
              <button
                type="button"
                className="vbs-v2-back"
                onClick={onBackToSessions}
                title="回到任务列表，新建或切换会话"
              >
                <Rows3 size={14} />
                任务列表
              </button>
            ) : null}
          </div>
        </header>
        <main className="vbs-v2-workspace">
          <div className="vbs-inline-error">
            <strong>这一步暂时无法显示。</strong>
            <div>{error.message}</div>
          </div>
          <p>
            流程与素材数据都已保存，不会丢失。这是页面渲染出错，刷新通常仍会复现——
            请先返回任务列表，再重新进入这一步。
          </p>
          {onBackToSessions ? (
            <button type="button" className="vbs-primary" onClick={onBackToSessions}>返回任务列表</button>
          ) : (
            <button type="button" className="vbs-primary" onClick={() => window.location.reload()}>重新加载</button>
          )}
        </main>
      </section>
    );
  }
}
