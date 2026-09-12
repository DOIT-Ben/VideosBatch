# Planner 总控与 Worker 调度

本文件定义 Codex 如何接管 VideosBatch 的长流程。它只定义执行编排，不重新定义阶段字段、Schema、业务合同或 Provider 参数；这些内容唯一见 `specs/videosbatch-workflow-canonical.md`。

## 角色

### 总控 Planner

总控 Planner 负责用户目标、当前运行目录、阶段顺序、执行计划、Worker 调度、结果合并、全局复盘、失败重规划和最终汇报。Planner 可以反复思考和优化，但不能伪造本地或远程状态、跳过人工门禁或把模型文本当作事实。

### 阶段 Planner

阶段 Planner 只在一个机器阶段内拆分任务。例如：资产候选按 `assetKey` 拆分，最终分镜在全局结构确定后按 `sequence` 拆分，视频执行按十秒片段拆分。阶段 Planner 不得改变 canonical 阶段顺序或输入输出语义。

### Worker

Worker 只拥有一个明确单元：一个资产、一个分镜、一个音频事件或一个视频片段。Worker 必须使用 Planner 提供的输入快照和 prompt，返回结构化结果、工具证据、错误和实际状态。Worker 不得修改兄弟单元、扩大路径范围、生成服务端 ID 或自行进入下一阶段。

### Validator 与确定性工具

本地 Validator 或显式远程服务端是状态、Schema、版本血缘、权限、幂等、计费和门禁的最终裁决者。确定性编译器、合并器和 finalize 工具优先于让模型重复改写事实源；模型只负责需要创作或判断的部分。

## ExecutionPlan

Planner 在任何写操作前建立本轮计划。可以在对话或临时计划文件中保存，但每次执行都必须能还原以下字段：

```json
{
  "stageId": "ASSET_CANDIDATES",
  "sessionId": "<session>",
  "sourceRevision": 3,
  "sourceHash": "<sha256>",
  "allowedAction": "draft",
  "requiredInputs": ["ASSET_PLAN"],
  "expectedOutput": "IMAGE_CANDIDATES",
  "gate": "EVERY_REQUIRED_ASSET_HAS_VERIFIED_CANDIDATE",
  "requiresHumanConfirmation": false,
  "maxConcurrentWorkers": 4,
  "stageConcurrency": 4,
  "units": [
    {"unitId": "CHARACTER-HERO", "workerId": "pending"}
  ],
  "retryBudget": 1,
  "stopCondition": "所有必需资产都有可读取且已验证候选"
}
```

计划中的 `sourceRevision/sourceHash` 只是输入快照，不得替代服务端返回的真实血缘。任何上游编辑、确认撤销、Hash 变化或状态降级都会使计划失效，Planner 必须重新读取状态并重规划。

## 受控循环

```text
1. inspect：读取 Session 和 canonical 当前版本
2. plan：选定一个阶段，建立 ExecutionPlan 和并发预算
3. dispatch：只派发当前阶段允许的 Worker 单元
4. observe：读取 Worker/运行目录状态（远程适配时读取服务端），不重复提交 pending/running
5. review：按 gate、覆盖率、血缘和失败隔离做全局复盘
6. repair/retry：只修复受影响字段或失败单元，遵守预算
7. replan：来源过期、依赖变化或并发条件变化时重新规划
8. advance/pause：满足 gate 才进入下一阶段；人工或高风险门禁前暂停
```

“反复优化”只适用于草稿质量、局部合同修复和可重试失败。不得用无限循环替代用户确认、Provider 授权、余额检查或未知提交对账。

## 并发策略

| 阶段 | 默认并发 | 调度条件 |
| --- | ---: | --- |
| `LESSON_INPUT`、`COURSE_INTRO_CANDIDATES`、`STORY_SCRIPT`、`ASSET_PLAN`、`SCREENPLAY` | 1 | 需要完整上下文和全局事实 |
| `ASSET_CANDIDATES` | 4 | 每个 Worker 只处理一个 `assetKey`；完成后汇总校验 |
| `FINAL_STORYBOARD` 全局规划 | 1 | 先确定类型、时长、场次覆盖和序列 |
| `FINAL_STORYBOARD` 单条细化 | 2–4 | 仅在全局结构锁定后并行；合并后必须重新做全局校验 |
| `COPYABLE_PROMPT` | 1 | 优先使用确定性编译器，禁止并行改写事实源 |
| `EXECUTION` | 1（最多 2） | 受 Provider、费用、幂等和连续性限制；连续性敏感时保持串行 |
| TTS/音效事件 | 2–4 | 每个事件独立，混音前统一校验时间线 |
| `QUOTE`、混音、`STITCH` | 1 | 不允许并发生成多个报价或最终成片 |

如果运行环境、Provider 限流、用户授权或机器资源没有明确值，默认 `maxConcurrentWorkers=1`。并发上限由总控统一持有，Worker 不得自行递归派生。

内置 CLI 对应命令为：

```text
videosbatch worker plan
videosbatch worker next
videosbatch worker claim
videosbatch worker complete
videosbatch worker fail
videosbatch worker status
videosbatch worker reset --confirm-lost
```

本地 `run` 命令把计划、unit 状态、并发槽、lease 和 artifact 保存在运行目录的 `planner.json`、`worker_jobs.json`、`workers/` 和 `artifacts/`；旧的 `worker` 命令仍可用于远程 Session 调度元数据。默认本地运行不改变服务端阶段状态；Worker 完成后必须通过本地 Validator，远程适配才额外通过 VideosBatch API 的 Schema、lineage 和 gate 校验。

## Worker 完成协议

Worker 返回至少包含：

```text
stageId / unitId / workerId
status: pending | running | ready | failed | stale
sourceRevision / sourceHash
outputRevision / contentHash（如有）
tool / attempt / retryable
artifact 或脱敏错误
nextAction: merge | retry | replan | wait
```

总控只有在所有必需单元达到当前 gate、来源仍匹配且本地或远程 Validator 确认后，才能把阶段视为可继续。部分成功必须保留成功单元和失败证据，不得用合并后的空值掩盖失败。

## 强制暂停

Planner 必须在以下情况暂停并向用户说明具体动作：人工选择/确认、报价授权、真实 Provider/额度、音频混音、最终拼接、来源过期且需要重新选择、未知提交、不可重试错误或缺少必要工具/凭据。Planner 可以继续做只读检查和离线整理，但不能代替用户授权。
