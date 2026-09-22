# ADR-0003：工作流可靠性与工作区恢复

- 决策状态：ACCEPTED
- 日期：2026-09-22
- 模式：Execute ADR，串行在 master 实施。
- 授权依据：本轮明确要求记录、建立 ADR 并分阶段修复；沿用本会话“该提交的提交。该推送的推送。”。不含生产部署、付费调用或数据删除。

## Original Requirement and Source

### SRC-1 用户原始请求
> 现在你帮我做好bug记录，然后做好ADR，按照阶段推进修复。

来源：2026-09-22 当前会话；文字摘录保留在本 ADR，无附件。

### SRC-2 原始缺陷证据
上轮基线 a762bb5 的审查结论，逐项事实、阴性对照与未覆盖边界保留于 [BUG 索引](../bug-records/README.md)。部分证据为隔离运行，部分为代码路径确认，不声称线上事故或浏览器验收。后续仓库回归测试作为可复现证据。

## 决策依据与范围
用户明确授权上述缺陷修复。下列具体实现是 agent-made 的常规技术选择，不视为用户逐条设计签字。恢复现有合同，不引入数据库/队列、不调整创作流程和计费策略、不执行 ADR-0002。

- P1：本地共享仅开发态直接回环连接可用，代理头不能授权；初始化按输入去重；教案统一校验。
- P2：保留同步 API，增加阶段开始/结束检查点；启动中断标记，禁止自动重新提交。无法证明 Provider 是否受理的中断要求人工核对；不宣称 exactly-once。最新成片任务和历史下载分开表达。
- P3：项目组件身份隔离；草稿存于当前浏览器 sessionStorage，以项目/阶段命名，保存或明确丢弃后清理；版本冲突保留草稿并提示。增加真实任务列表，作品广场保持独立。

备选：全量异步任务队列、数据库迁移可以改善多进程调度，但超出本次修复且迁移风险更高；本次仍为单进程文件存储，不把检查点宣称为跨进程分布式锁。仅加 UI loading 无法修复状态真实性，拒绝。

## 需求与验收映射

| ID | 来源 | 结果/验收 | 阶段 | 测试 |
|---|---|---|---|---|
| TR-0003-001 | SRC-1/SRC-2 BUG-001 | 伪造头不能跨用户；直接本机兼容 | P1 | smoke:adr0003-api |
| FR-0003-002 | SRC-1/SRC-2 BUG-003/004 | 不同输入不丢；非法教案拒绝且不写入 | P1 | smoke:adr0003-api |
| TR-0003-003 | SRC-1/SRC-2 BUG-002 | running/结果落盘；重启标中断、不自动调用 Provider | P2 | smoke:adr0003-recovery |
| FR-0003-004 | SRC-1/SRC-2 BUG-005 | 当前状态真实，历史下载明确 | P2 | smoke:adr0003-recovery |
| FR-0003-005 | SRC-1/SRC-2 BUG-006/007 | 草稿不因切换或刷新丢失、不串项目；冲突可见 | P3 | smoke:adr0003-workspace |
| FR-0003-006 | SRC-1/SRC-2 BUG-008 | 任务列表包含未发布项目，可继续/新建 | P3 | smoke:adr0003-workspace |

## 阶段计划与证据（唯一交付状态源）

| 阶段 | 状态 | 依赖 | 范围 | 证据/提交 |
|---|---|---|---|---|
| P1 | PASSED | 无 | BUG-001/003/004、档案/spec | API smoke、既有 retry、tsc、specs、secrets 通过；独立审查 R2 PASS |
| P2 | PASSED | P1 | BUG-002/005 | recovery/API smoke、既有相关测试、tsc 通过；R2 PASS |
| P3 | NOT_STARTED | P2 | BUG-006/007/008 | 待验证 |

每阶段：实现 -> 定向测试 -> 独立只读审查（最多三次结论/两次返修）-> 验收及记录 -> 精确范围提交。全部完成后运行 verify:offline 并推送。记录文件自身的提交身份由 Git 历史承载，后续阶段记录前一阶段 hash，避免自引用。

## 测试与回滚边界
测试用临时目录和 fake/stub，不读写真实 data，不调用 Provider。阶段定向测试必须含阴性对照；最终 npm run smoke:specs、smoke:secrets、verify:offline。浏览器交互与真实 Provider 是独立证据层，不能用静态测试冒充。发生回归可 revert 对应阶段 commit；不删除历史媒体/原始用户素材，不迁移数据库。检查点为兼容追加语义，旧 pending 数据无法追溯其历史在途状态。

## 状态迁移日志

- 2026-09-22 / Codex / a762bb5：P1 NOT_STARTED -> PROPOSED -> IN_PROGRESS；授权修复，工作区干净；风险边界与验收已记录。

- 2026-09-22 / Codex + reviewer review_p1 / P1 工作树：IN_PROGRESS -> REVIEW_1 -> REWORK_1（补旧 ready 空教案阻断）-> REVIEW_2 PASS -> ACCEPTANCE -> PASSED；定向/既有测试均 RC=0；本地验收，不推断生产。

- 2026-09-22 / Codex / a7bb30e：P1 已提交；P2 NOT_STARTED -> PROPOSED -> IN_PROGRESS。

- 2026-09-22 / Codex + review_p2 / P2 工作树：IN_PROGRESS -> REVIEW_1 -> REWORK_1（真实 save 故障注入，开始回退/结束保留）-> REVIEW_2 PASS -> ACCEPTANCE -> PASSED；recovery、API、类型及既有相关测试 RC=0。阶段 checkpoint 保存失败是可见故障，不保证磁盘故障中的持久性或外部 exactly-once。
