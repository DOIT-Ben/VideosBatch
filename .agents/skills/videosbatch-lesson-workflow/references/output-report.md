# 阶段结果报告

每次阶段动作完成后，用中文报告以下字段。默认报告来自本地运行目录状态；远程适配才来自服务端状态。不以模型回复是否完整作为成功依据。

## 最小字段

```text
阶段：<stageId>
状态：<pending|running|ready|failed|stale>
版本：<revision 或 ->
来源：<sourceStageId / sourceRevision>
内容哈希：<contentHash，必要时脱敏显示>
门禁：<当前 gate 或 needs_human_confirmation>
工具：<videosbatch-rest|seereel-cli|server-executor|other>
下一动作：<inspect|draft|save|confirm|retry|execute|wait>
```

Planner 总控或存在拆分 Worker 时追加：

```text
计划：<ExecutionPlan 摘要或 ->>
并发：<maxConcurrentWorkers / 实际运行数>
Worker：<unitId=workerId:status，或 ->>
复盘：<通过|局部修复|重新规划|等待>
```

Worker 报告必须额外包含 `unitId` 和 `workerId`。Worker 只报告自己的结果；阶段是否可继续由 Planner 在收齐结果后根据服务端 gate、覆盖率和 lineage 决定。

## 失败报告

失败时追加：

```text
错误码：<服务端 errorInfo.code>
错误摘要：<脱敏后的 message>
可重试：<是|否>
来源是否仍匹配：<是|否|未检查>
保留产物：<是|否>
需要用户动作：<没有|确认内容|授权媒体动作|补充配置|修复输入>
```

## 汇报规则

- `ready` 只能表示服务端校验通过且来源版本当前，不表示真实 Provider 或最终成片已经完成。
- `failed` 与 `stale` 不得被改写成“已完成”；保留错误和历史产物的事实。
- `running` 时先等待或读取状态，不重复提交。
- 人工确认和真实媒体授权必须写明“等待用户”，不能用 Agent 推断代替。
- `PARTIAL`、失败单元或未收齐的并发结果不得汇报为阶段 `ready`；必须报告保留的成功单元、失败证据和下一次 `retry/replan` 动作。
