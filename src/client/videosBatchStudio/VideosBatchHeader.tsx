import { BarChart3, Check, ChevronDown, Download, Languages, MoreHorizontal, Plus, Rows3, Sparkles } from "lucide-react";
import { DropdownMenu } from "radix-ui";

export interface VideosBatchSessionOption {
  id: string;
  title: string;
  /** Short progress label such as "4 / 9 步", so the switcher can be scanned at a glance. */
  progress?: string;
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
  language = "zh",
  onOpenWorkflow,
  onOpenCanvas,
  onBackToSessions,
  onSelectSession,
  onNewSession,
  onDownloadSession,
  onToggleUsage,
  onToggleLanguage
}: {
  sessionTitle: string;
  completedCount: number;
  totalSteps: number;
  headline?: string;
  activeMode?: "workflow" | "canvas";
  sessions?: VideosBatchSessionOption[];
  sessionId?: string;
  language?: "zh" | "en";
  onOpenWorkflow?: () => void;
  onOpenCanvas?: () => void;
  onBackToSessions?: () => void;
  onSelectSession?: (sessionId: string) => void;
  onNewSession?: () => void;
  /** SeeReel's topbar holds these but the studio hides it, so the header offers them itself. */
  onDownloadSession?: () => void;
  onToggleUsage?: () => void;
  onToggleLanguage?: () => void;
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
                  {item.progress ? <span className="vbs-v2-menu-progress">{item.progress}</span> : null}
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

      {/* SeeReel's topbar carries these, but the studio hides the topbar — so they live here now,
          otherwise download / usage / language are simply unreachable inside the workbench. */}
      {(onDownloadSession || onToggleUsage || onToggleLanguage) ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="vbs-v2-more" aria-label="更多功能" title="更多功能">
              <MoreHorizontal size={16} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="vbs-v2-menu vbs-v2-more-menu" align="end" sideOffset={8}>
              {onToggleUsage ? (
                <DropdownMenu.Item className="vbs-v2-menu-item" onSelect={onToggleUsage}>
                  <span className="vbs-v2-menu-slot" aria-hidden="true"><BarChart3 size={13} /></span>
                  <span className="vbs-v2-menu-title">查看用量</span>
                </DropdownMenu.Item>
              ) : null}
              {onDownloadSession ? (
                <DropdownMenu.Item className="vbs-v2-menu-item" onSelect={onDownloadSession}>
                  <span className="vbs-v2-menu-slot" aria-hidden="true"><Download size={13} /></span>
                  <span className="vbs-v2-menu-title">下载 Session</span>
                </DropdownMenu.Item>
              ) : null}
              {onToggleLanguage ? (
                <>
                  <DropdownMenu.Separator className="vbs-v2-menu-separator" />
                  <DropdownMenu.Item className="vbs-v2-menu-item" onSelect={onToggleLanguage}>
                    <span className="vbs-v2-menu-slot" aria-hidden="true"><Languages size={13} /></span>
                    <span className="vbs-v2-menu-title">{language === "en" ? "切换为中文" : "Switch to English"}</span>
                  </DropdownMenu.Item>
                </>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
    </header>
  );
}
