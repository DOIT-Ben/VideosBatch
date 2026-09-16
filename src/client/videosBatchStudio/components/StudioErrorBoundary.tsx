import { Component, type ErrorInfo, type ReactNode } from "react";

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
 */
export class StudioErrorBoundary extends Component<
  { children: ReactNode },
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
    return (
      <section className="videosbatch-studio videosbatch-studio-v2" aria-label="VideosBatch 流程制作">
        <main className="vbs-v2-workspace">
          <div className="vbs-inline-error">
            <strong>这一步暂时无法显示。</strong>
            <div>{error.message}</div>
          </div>
          <p>流程数据本身没有丢失。刷新页面即可回到最新的流程状态。</p>
          <button type="button" className="vbs-primary" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </main>
      </section>
    );
  }
}
