import { useState } from "react";
import { Code2, LoaderCircle, MoreHorizontal, Play, RefreshCw, RotateCcw } from "lucide-react";
import { AlertDialog, DropdownMenu } from "radix-ui";
import { VIDEOS_BATCH_PRODUCT_STEPS, type VideosBatchProductStepId } from "./stageModel";

/**
 * The single workflow control bar: step navigation on the left, run controls on
 * the right. Replaces the older stage toolbar that repeated a step label and
 * status already shown by the top progress rail.
 */
export function WorkflowFooter({
  selectedStepId,
  busy,
  completed,
  canRetry,
  canDebug,
  primaryLabel,
  primaryDisabled,
  hint,
  busyLabel,
  onPrevious,
  onPrimary,
  onRunAll,
  onRestart,
  onRetry,
  onDebug
}: {
  selectedStepId: VideosBatchProductStepId;
  busy?: boolean;
  completed?: boolean;
  canRetry?: boolean;
  canDebug?: boolean;
  primaryLabel: string;
  primaryDisabled?: boolean;
  hint?: string;
  busyLabel?: string;
  onPrevious: () => void;
  onPrimary: () => void;
  onRunAll?: () => void;
  onRestart?: () => void;
  onRetry?: () => void;
  onDebug?: () => void;
}) {
  const index = VIDEOS_BATCH_PRODUCT_STEPS.findIndex((step) => step.id === selectedStepId);
  const [confirm, setConfirm] = useState<"all" | "restart" | null>(null);

  return (
    <footer className="vbs-footer">
      {index > 0 && <button type="button" className="vbs-secondary" onClick={onPrevious}>
        ← 上一步
      </button>}
      <div className="vbs-footer-spacer" role="status">{busy ? <span className="vb-work-status"><LoaderCircle size={16} className="spin" />{busyLabel || "正在处理，请稍候…"}</span> : hint}</div>
      {onRunAll || onRestart || canRetry || canDebug ? (
        <div className="vbs-footer-run">
          {!completed && onRunAll && (
            <button type="button" className="vbs-secondary vbs-v2-auto-run" disabled={busy} onClick={() => setConfirm("all")}>
              <Play size={14} />
              自动运行
            </button>
          )}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="vbs-v2-more-button" aria-label="更多当前步骤操作">
                <MoreHorizontal size={18} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="vbs-v2-menu" align="end" sideOffset={8}>
                {onRestart && <DropdownMenu.Item className="vbs-v2-menu-item" disabled={busy} onSelect={() => setConfirm("restart")}>
                  <RotateCcw size={14} />
                  重新生成本步骤
                </DropdownMenu.Item>}
                {canRetry && <DropdownMenu.Item className="vbs-v2-menu-item" disabled={busy} onSelect={onRetry}>
                  <RefreshCw size={14} />
                  重试本步骤
                </DropdownMenu.Item>}
                {canDebug && <DropdownMenu.Item className="vbs-v2-menu-item" onSelect={onDebug}>
                  <Code2 size={14} />
                  查看原始数据
                </DropdownMenu.Item>}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      ) : null}
      {!primaryDisabled && <button type="button" className="vbs-primary" disabled={busy} onClick={onPrimary}>{primaryLabel}</button>}
      <AlertDialog.Root open={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null); }}>
        <AlertDialog.Portal><AlertDialog.Overlay className="vb-confirm-overlay" /><AlertDialog.Content className="vb-confirm-dialog">
          <AlertDialog.Title>{confirm === "restart" ? `重新生成${VIDEOS_BATCH_PRODUCT_STEPS[index].label}？` : "连续推进制作流程？"}</AlertDialog.Title>
          <AlertDialog.Description>{confirm === "restart" ? "这会重置本步骤及后续进度，后续内容需要重新生成。请先保存需要保留的编辑。" : "系统将继续执行，直到下一个需要你确认的步骤或流程完成。"}使用真实生成服务时，重新生成或连续运行可能产生费用。</AlertDialog.Description>
          <div><AlertDialog.Cancel asChild><button type="button" className="vbs-secondary">暂不执行</button></AlertDialog.Cancel><AlertDialog.Action asChild><button type="button" className="vbs-primary" disabled={busy} onClick={() => { if (confirm === "restart") onRestart?.(); else onRunAll?.(); setConfirm(null); }}>确认{confirm === "restart" ? "重新生成" : "连续运行"}</button></AlertDialog.Action></div>
        </AlertDialog.Content></AlertDialog.Portal>
      </AlertDialog.Root>
    </footer>
  );
}
