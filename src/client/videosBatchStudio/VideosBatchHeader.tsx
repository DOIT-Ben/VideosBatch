import { Check, ChevronDown, Plus, Rows3, Sparkles } from "lucide-react";
import { DropdownMenu } from "radix-ui";

export interface VideosBatchSessionOption {
  id: string;
  title: string;
}

/**
 * One header for both shells of the product.
 *
 * VideosBatch deliberately hides SeeReel's sidebar and topbar, which are the
 * only places holding "new / switch / back to the list". That turned the studio
 * into a room with no exit, so the header now carries its own wayfinding: the
 * session list on the left and a switcher on the project chip.
 */
export function VideosBatchHeader({
  sessionTitle,
  completedCount,
  totalSteps,
  headline,
  activeMode = "workflow",
  sessions = [],
  sessionId,
  onOpenWorkflow,
  onOpenCanvas,
  onBackToSessions,
  onSelectSession,
  onNewSession
}: {
  sessionTitle: string;
  completedCount: number;
  totalSteps: number;
  headline?: string;
  activeMode?: "workflow" | "canvas";
  sessions?: VideosBatchSessionOption[];
  sessionId?: string;
  onOpenWorkflow?: () => void;
  onOpenCanvas?: () => void;
  onBackToSessions?: () => void;
  onSelectSession?: (sessionId: string) => void;
  onNewSession?: () => void;
}) {
  const title = sessionTitle || "未命名课程视频";
  const ariaLabel = `当前项目 ${title}，已完成 ${completedCount} / ${totalSteps}`;

  const meta = (
    <>
      <strong>{title}</strong>
      <span aria-hidden="true">·</span>
      <small>{completedCount} / {totalSteps}</small>
    </>
  );

  return (
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
        <div className="vbs-v2-brand-lockup">
          <span className="vbs-v2-brand-mark" aria-hidden="true"><Sparkles size={19} /></span>
          <div className="vbs-v2-brand-title">
            <strong>VideosBatch</strong>
            <span>AI 课程视频工作室</span>
          </div>
        </div>
      </div>

      {headline ? (
        <div className="vbs-v2-header-headline">
          <h1>{headline}</h1>
        </div>
      ) : <div className="vbs-v2-header-headline-spacer" aria-hidden="true" />}

      {onSelectSession ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="vbs-v2-project-meta"
              aria-label={`${ariaLabel}。打开会话列表`}
              title="切换会话"
            >
              {meta}
              <ChevronDown size={14} className="vbs-v2-project-meta-chevron" aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="vbs-v2-menu vbs-v2-session-menu" align="end" sideOffset={8}>
              <DropdownMenu.Label className="vbs-v2-menu-label">会话</DropdownMenu.Label>
              {sessions.length ? sessions.map((item) => (
                <DropdownMenu.Item
                  key={item.id}
                  className="vbs-v2-menu-item"
                  onSelect={() => onSelectSession(item.id)}
                >
                  <span className="vbs-v2-menu-slot" aria-hidden="true">
                    {item.id === sessionId ? <Check size={13} /> : null}
                  </span>
                  <span className="vbs-v2-menu-title">{item.title || "未命名课程视频"}</span>
                </DropdownMenu.Item>
              )) : (
                <DropdownMenu.Item className="vbs-v2-menu-item" disabled>
                  <span className="vbs-v2-menu-slot" aria-hidden="true" />
                  <span className="vbs-v2-menu-title">暂无其他会话</span>
                </DropdownMenu.Item>
              )}
              {onNewSession ? (
                <>
                  <DropdownMenu.Separator className="vbs-v2-menu-separator" />
                  <DropdownMenu.Item className="vbs-v2-menu-item" onSelect={onNewSession}>
                    <span className="vbs-v2-menu-slot" aria-hidden="true"><Plus size={13} /></span>
                    <span className="vbs-v2-menu-title">新建 Session</span>
                  </DropdownMenu.Item>
                </>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : (
        <div className="vbs-v2-project-meta" aria-label={ariaLabel}>{meta}</div>
      )}

      <div className="vbs-v2-mode-switch" role="group" aria-label="工作区模式">
        <button
          type="button"
          className={activeMode === "workflow" ? "active" : ""}
          aria-pressed={activeMode === "workflow"}
          onClick={onOpenWorkflow}
        >
          流程制作
        </button>
        <button
          type="button"
          className={activeMode === "canvas" ? "active" : ""}
          aria-pressed={activeMode === "canvas"}
          onClick={onOpenCanvas}
        >
          制作画布
        </button>
      </div>
    </header>
  );
}
