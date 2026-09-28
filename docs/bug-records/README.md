# 缺陷索引

真源：本目录每个 BUG 档案；交付状态见 [ADR-0003](../adr/0003-reliability-and-workspace-recovery.md)。

| 编号 | 标题 | 状态 | 影响面 |
|---|---|---|---|
| [BUG-001](BUG-001-local-review-trust.md) | 请求头误触发本地会话共享 | 已闭环（本地） | P1 / P1 |
| [BUG-002](BUG-002-workflow-checkpoints.md) | 长任务无阶段持久化检查点 | 已闭环（本地） | P1 / P2 |
| [BUG-003](BUG-003-start-dedup.md) | 不同初始化输入被合并丢失 | 已闭环（本地） | P2 / P1 |
| [BUG-004](BUG-004-lesson-validation.md) | 空教案产物可标记就绪 | 已闭环（本地） | P2 / P1 |
| [BUG-005](BUG-005-final-version.md) | 新拼接运行中误显示旧成片完成 | 已闭环（本地） | P2 / P2 |
| [BUG-006](BUG-006-editor-drafts.md) | 刷新和离开步骤丢失未保存草稿 | 已闭环（本地） | P2 / P3 |
| [BUG-007](BUG-007-session-isolation.md) | 切项目继承输入及界面状态 | 已闭环（本地） | P2 / P3 |
| [BUG-008](BUG-008-task-navigation.md) | 任务列表误进入作品广场 | 已闭环（本地） | P2 / P3 |
| [BUG-009](BUG-009-production-lazy-import.md) | 生产构建工作台懒加载白屏 | 已闭环（本地） | P1 / P3 |
| [BUG-010](BUG-010-stale-ci-contract-tests.md) / [#7](https://github.com/DOIT-Ben/VideosBatch/issues/7) | CI 旧阶段与折叠状态夹具 | 已闭环（本地及远端 CI） | P1 / CI，DOIT-Ben |
| [BUG-011](BUG-011-verification-coverage-debt.md) / [#8](https://github.com/DOIT-Ben/VideosBatch/issues/8) | 验证覆盖及外部验收缺口 | 未修复，后续独立任务 | P2 / 验证与发布边界，DOIT-Ben |
