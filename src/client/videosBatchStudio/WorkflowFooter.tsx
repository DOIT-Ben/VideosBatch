import { Code2, MoreHorizontal, Play, RefreshCw, RotateCcw } from "lucide-react";
import { DropdownMenu } from "radix-ui";
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
  onPrevious: () => void;
  onPrimary: () => void;
  onRunAll?: () => void;
  onRestart?: () => void;
  onRetry?: () => void;
  onDebug?: () => void;
}) {
  const index = VIDEOS_BATCH_PRODUCT_STEPS.findIndex((step) => step.id === selectedStepId);

  return (
    <footer className="vbs-footer">
      <button type="button" className="vbs-secondary" disabled={busy || index <= 0} onClick={onPrevious}>
        ← 上一步
      </button>
      <div className="vbs-footer-spacer" />
      {onRunAll ? (
        <div className="vbs-footer-run">
          {!completed && (
            <button type="button" className="vbs-secondary vbs-v2-auto-run" disabled={busy} onClick={onRunAll}>
              <Play size={14} />
              自动运行到确认点
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
                <DropdownMenu.Item className="vbs-v2-menu-item" disabled={busy} onSelect={onRestart}>
                  <RotateCcw size={14} />
                  重新生成本步骤
                </DropdownMenu.Item>
                <DropdownMenu.Item className="vbs-v2-menu-item" disabled={busy || !canRetry} onSelect={onRetry}>
                  <RefreshCw size={14} />
                  修复后重试本阶段
                </DropdownMenu.Item>
                <DropdownMenu.Item className="vbs-v2-menu-item" disabled={!canDebug} onSelect={onDebug}>
                  <Code2 size={14} />
                  查看原始数据
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      ) : null}
      <button type="button" className="vbs-primary" disabled={busy || primaryDisabled} onClick={onPrimary}>
        {busy ? "处理中…" : primaryLabel}
      </button>
    </footer>
  );
}
