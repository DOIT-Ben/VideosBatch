# VideosBatch 音频就绪门禁与 PARTIAL 重试落地方案

Status: implemented (scope #5/#13/#14)
Date: 2026-09-03
Canonical spec: `specs/videosbatch-workflow-canonical.md`
Scope: 只处理问题 #5、#13、#14；不顺带实现 TTS、音效生成或新的 Provider。

## 1. 目标

修复三类状态错误：

1. `COPYABLE_PROMPT` artifact 为 `PARTIAL` 时，阶段仍显示 `ready`。
2. `STITCH` 在 `audioTimeline.streams.tts=[]` 或 `mix.status=pending` 时仍可能进入完成路径。
3. 已有的 `PARTIAL` 产物无法通过显式重试接口恢复。

完成后必须满足：

- 任何 `PARTIAL`/`FAILED` 的派生或媒体 artifact 都不能让所属阶段进入 `ready`。
- `STITCH` 只有在视频、来源血缘和独立音频时间线全部就绪时才能执行并变为 `ready`。
- 可修复失败保留原 artifact、错误证据和来源快照，并可用当前 lineage 显式重试。
- 旧会话无需手改 `data/cinema-store.json`，首次读取或运行时自动收敛到正确状态。

## 2. 边界与不做事项

本次只修状态合同和重试入口，不实现：

- TTS Provider 调用、音效文件生成、音频混音算法（问题 #2、#3、#4）。
- H3 Prompt 内容编译、镜头风格或运镜修复（问题 #1、#7、#8、#9）。
- 角色/道具创作质量修复（问题 #15--#19）。

`EXECUTION` 表示视频片段执行完成，`STITCH` 表示最终可交付完成。这样在 TTS/混音能力尚未接入时，视频片段可以被审阅，但最终成片必须被门禁拦截，不得显示完成。

## 3. 当前证据与根因

- `src/server/videosBatchWorkflow/runner.ts` 的 `runNext()` 只把 `ASSET_CANDIDATES` 和 `EXECUTION` 的媒体 `PARTIAL` 转成失败；`COPYABLE_PROMPT` 的 `PARTIAL` 会走普通成功分支。
- `src/server/videosBatchWorkflow/nativeMediaStages.ts` 的 `validateAudioTimeline()` 目前只检查数组结构，并接受 `tts=[]` 与 `mix.status=pending`。
- `src/server/videosBatchWorkflow/api.ts` 的 retry 路由要求 `stage.status === "failed"`；旧会话的 `COPYABLE_PROMPT` 仍是 `ready + artifact.status=PARTIAL`，因此不可重试。
- 已验证旧会话 `ses_5e3ff36a` 当前为 `COPYABLE_PROMPT stage=ready`、`artifact.status=PARTIAL`、11 个失败分镜。

## 4. 目标状态合同

### 4.1 派生 artifact 与阶段状态

`COPYABLE_PROMPT` 的 artifact 状态和 workflow stage 状态必须按下表收敛：

| artifact.status | stage.status | errorInfo.retryable | 说明 |
|---|---|---:|---|
| `READY` | `ready` | 不适用 | 所有分镜引用完整且可验证 |
| `PARTIAL` | `failed` | `true` | 保留可查看产物，允许带 lineage 重试 |
| `FAILED` | `failed` | 由失败原因决定 | 不得进入下游 |

`PARTIAL` 不等于丢弃。阶段失败时保留 `artifact`、`contentHash`、`sourceHashes`、`sourceRevisions` 和 `failedSegments`。

### 4.2 音频就绪判定

增加一个可复用的 `audioTimelineReadiness` 判定，分为结构校验和交付校验：

**结构校验**（`EXECUTION` 使用）：

- schema、duration、`FINAL_STORYBOARD` revision/hash 当前。
- `narration`、`dialogue`、`soundEffects`、`tts` 均为数组。
- 每个事件有合法时间区间、唯一 `id`，并至少有 `text` 或 `audioUrl`。
- `mix.status` 只能是 `pending` 或 `ready`。

**交付校验**（`STITCH` 使用）：

- 若存在 narration/dialogue 事件，`tts` 必须非空，并为每个语音事件提供对应的 `audioUrl`。
- 若存在 soundEffects 事件，每个事件必须有可读取的 `audioUrl`；纯文字描述不能冒充音效文件。
- `mix.status` 必须为 `ready`，且 `mix.audioUrl` 必须存在并通过媒体 URL 校验。
- 任何一项不满足都返回稳定错误码 `AUDIO_TIMELINE_NOT_READY`，禁止创建成功的 StitchJob。

没有语音或音效事件时，`tts=[]` 本身可以合法；但只要存在待播事件，就不能以空 TTS 通过。

### 4.3 STITCH 阶段

- `stitchGateErrors()` 和 `STITCH.validate()` 都调用交付校验，避免仅绕过执行入口就伪造 ready artifact。
- 音频未就绪时，阶段状态为 `failed`，artifact 不生成或保留上次 artifact，`errorInfo.retryable=true`，提示先补齐 audio timeline 再重试。
- 已有 ready final video 不得被新一轮失败覆盖；其旧 StitchJob 保留为历史记录，但当前 workflow 不得标记 `completed=true`。

## 5. 旧状态兼容与重试

新增 `reconcileVideosBatchReadiness(workflow)`（名称可按现有约定调整），在以下入口调用：

- `runNext()` / `runAll()` 开始时；
- `GET /api/sessions/:sessionId/videosbatch` 返回前；
- `POST .../retry/:stageId` 校验前；
- `replaceStageArtifact()` 写回前后。

规则：

1. 发现 `COPYABLE_PROMPT` artifact 为 `PARTIAL`/`FAILED` 且 stage 仍为 `ready`，就地改为 `failed`，保留所有 artifact 和 lineage 字段。
2. 若当前 stage 已越过该失败阶段，把 `currentStage` 回拨到最早失败阶段，后继阶段标记 `stale`，`completed=false`。
3. 生成稳定的 `errorInfo.code`（建议 `COPYABLE_PROMPT_PARTIAL` / `COPYABLE_PROMPT_FAILED`），不得依赖自由文本判断。
4. `retryLineageIssues()` 仍强制检查当前依赖的 revision/hash；不允许用重试绕过上游变更或资产确认。
5. retry 成功后，新的 artifact 必须为 `READY`；若仍为 `PARTIAL`，阶段继续 `failed` 并更新 attempt/error 证据。

`PUT .../stages/COPYABLE_PROMPT/artifact` 若保存合法 `PARTIAL`，返回 200 但 stage 必须是 `failed`，不能推进 `currentStage`。

## 6. 具体改动文件

必改：

- `src/server/videosBatchWorkflow/runner.ts`
  - 抽取统一 artifact failure/reconciliation helper。
  - 将 `COPYABLE_PROMPT` 的 `PARTIAL`/`FAILED` 收敛为 failed stage。
  - 保留 artifact、lineage 和可重试错误信息。
- `src/server/videosBatchWorkflow/nativeMediaStages.ts`
  - 将音频校验拆成 structural/delivery 两种模式。
  - 在 STITCH gate 和 validator 双重调用 delivery 模式。
  - 使用 `AUDIO_TIMELINE_NOT_READY`，不创建 StitchJob。
- `src/server/videosBatchWorkflow/api.ts`
  - 在 workflow GET、retry、artifact PUT 前调用 readiness reconciliation。
  - 保证 legacy `ready + PARTIAL` 先被收敛再进入 retry lineage 校验。
- `src/shared/videosBatchWorkflow.ts`
  - 如需新增稳定错误码或 audio readiness 字段，在此定义，不在 API/客户端各自发明类型。

建议改：

- `src/client/videosBatchStudio/stageModel.ts` / `StudioStageToolbar.tsx`
  - 对 `failed + retryable` 显示“重试本阶段”，提交当前 source revision/hash；不要把 `PARTIAL` 伪装成完成。
- `scripts/smoke-videosbatch-api-retry.ts`
- `scripts/smoke-videosbatch-llm-text-stages.ts`
- `scripts/smoke-videosbatch-native-media-stages.ts`
- `specs/videosbatch-workflow-canonical.md`

## 7. 测试与验收

### 7.1 COPYABLE_PROMPT

- 构造合法 `PARTIAL` artifact，调用 `runNext()`：断言 stage=`failed`、artifact 原样保留、`errorInfo.code` 稳定、`retryable=true`。
- 构造 legacy `stage=ready + artifact.status=PARTIAL`：调用 workflow GET/`runNext()` 后断言自动收敛为 failed，并回拨 currentStage。
- 用当前 lineage 调用 retry：断言执行一次，成功 artifact 为 `READY` 时 stage 才变为 ready；仍 partial 时不能推进。
- 错误或过期 source hash 必须返回 `RETRY_LINEAGE_CONFLICT`，不能绕过门禁。

### 7.2 音频与 STITCH

- `tts=[]` 且存在 narration/dialogue：STITCH gate 失败，错误码为 `AUDIO_TIMELINE_NOT_READY`。
- `mix.status=pending`：STITCH gate 失败，且没有创建 StitchJob。
- `tts`、音效 URL 和 `mix.audioUrl` 全部有效：gate 通过，现有 stitch mock 被调用。
- 只有空 narration/dialogue/soundEffects 时，空 `tts` 不因数量本身失败；仍必须有 ready mix 才能 STITCH。
- 手工伪造 `STITCH` READY artifact 但 audio timeline 不 ready：validator 返回失败。

### 7.3 命令

```text
npm run smoke:videosbatch-llm-text-stages
npm run smoke:videosbatch-api-retry
npm run smoke:videosbatch-native-media-stages
npm run smoke:specs
npm run smoke:secrets
npm run build
```

本阶段不调用真实 TTS、音效或视频 Provider，不修改 `.env`，不修改 `data/` 中的旧会话文件。

## 8. 迁移、发布与回滚

- 采用懒迁移，不直接编辑 `data/cinema-store.json`；首次 API 读写即可修复旧 stage 状态。
- 旧的 ready final video 不删除；只把 workflow/当前 StitchJob 的可交付状态纠正为未完成。
- 回滚代码时不回滚数据；旧 artifact 仍可被新代码识别并再次收敛。
- 真实验收只验证一个已有会话的状态收敛和一个 mock stitch gate；不付费生成新视频。

## 9. 完成定义

- [x] `COPYABLE_PROMPT PARTIAL` 不再显示 ready，且可以按 lineage 重试。
- [x] legacy `ready + PARTIAL` 自动收敛并阻止越过失败阶段。
- [x] `tts=[]`（存在待播语音时）或 `mix=pending` 不再通过 STITCH 交付门禁。
- [x] 音频不完整时不创建成功 StitchJob、不标记 workflow completed。
- [x] 定向 smoke、规范、秘密扫描和构建通过。

## 10. 实施证据

- 分支：`feature/videosbatch-audio-readiness-gate`
- runner：统一 artifact failure/reconciliation，保留 partial artifact 和 lineage。
- API：workflow GET、run、artifact PUT、retry 前执行 legacy readiness 收敛。
- native media：STITCH 使用 delivery audio gate，错误码为 `AUDIO_TIMELINE_NOT_READY`。
- 客户端：可重试失败阶段显示“修复后重试本阶段”，携带当前 source revision/hash。
- 本轮验证：`npm run smoke:videosbatch-llm-text-stages`、`npm run smoke:videosbatch-api-retry`、`npm run smoke:videosbatch-native-media-stages`、`npm run smoke:videosbatch-native-media-resilience`、`npm run smoke:specs`、`npm run smoke:secrets`、`npm run build` 均通过。
- 明确未覆盖：TTS/音效 Provider 和实际音频生成仍属于问题 #2--#4 的后续任务。
