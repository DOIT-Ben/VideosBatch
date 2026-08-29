import { Code2, MoreHorizontal, Play, RotateCcw } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { StageStatus } from "./StageStatus";
import type { VideosBatchProductStatus } from "../stageModel";

export function StudioStageToolbar({
  stepLabel,
  status,
  workflowStarted,
  completed,
  busy,
  canDebug,
  onRunAll,
  onRestart,
  onDebug
}: {
  stepLabel: string;
  status: VideosBatchProductStatus;
  workflowStarted: boolean;
  completed: boolean;
  busy: boolean;
  canDebug: boolean;
  onRunAll: () => void;
  onRestart: () => void;
  onDebug: () => void;
}) {
  return (
    <div className="vbs-v2-stage-toolbar">
      <div className="vbs-v2-stage-toolbar-copy">
        <span>当前查看</span>
        <strong>{stepLabel}</strong>
        <StageStatus status={status} />
      </div>
      {workflowStarted && (
        <div className="vbs-v2-stage-toolbar-actions">
          <button type="button" className="vbs-secondary vbs-v2-auto-run" disabled={busy || completed} onClick={onRunAll}>
            <Play size={14} />
            自动运行到确认点
          </button>
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
                <DropdownMenu.Item className="vbs-v2-menu-item" disabled={!canDebug} onSelect={onDebug}>
                  <Code2 size={14} />
                  查看原始数据
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}
    </div>
  );
}
