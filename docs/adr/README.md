# VideosBatch ADR 索引

决策状态与实施状态分别记录；Proposed 文档不代表功能已交付。

| ADR | 主题 | 决策状态 | 实施状态来源 |
|---|---|---|---|
| [0001](0001-videosbatch-align-frameflow-contracts.md) | FrameFlow 提示词、产物规格与垫图合同 | Accepted | 原 ADR 阶段记录 |
| [0002](0002-videosbatch-structured-prompt-document.md) | 结构化提示词文档 | Proposed | 尚待决策；不纳入本次自动化计划 |
| [0003](0003-reliability-and-workspace-recovery.md) | 可靠性与工作区恢复 | Accepted | 原 ADR；本地修复验收已完成，生产边界见原文 |
| [0004](0004-durable-production-scheduler.md) | 持久化多任务调度与自动流水线 | Proposed | [P0—P2](automation-workspace-plan.md)，未开始 |
| [0005](0005-realtime-rendering-feedback.md) | 实时状态、渐进渲染与反馈 | Proposed | [P3/P6](automation-workspace-plan.md)，未开始 |
| [0006](0006-multitask-editing-workbench.md) | 多任务管理与编辑保存推进 | Proposed | [P4—P6](automation-workspace-plan.md)，未开始 |

本次自动化方案的[需求原文与解释边界](sources/20260922-automated-production-workspace.md)单独留存。报价确认、价格/费用/积分展示、计费与支付不在改造范围；已有 QUOTE 合同保持不变。

业务合同以 [canonical workflow spec](../../specs/videosbatch-workflow-canonical.md) 和 [UI spec](../../specs/ui-system.md) 为准；提案接受后、实现前同步相关规格。
