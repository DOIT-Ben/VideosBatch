# 执行任务指令：VideosBatch 音频就绪门禁与 PARTIAL 重试

执行状态：已完成（2026-09-03，范围为问题 #5、#13、#14）

## 任务

在 VideosBatch 中修复问题 #5、#13、#14：

- `COPYABLE_PROMPT` artifact 为 `PARTIAL`/`FAILED` 时，所属 stage 必须为 `failed`，不能为 `ready`。
- `STITCH` 不得接受存在待播语音但 `tts=[]`，也不得接受 `mix.status=pending`。
- 旧会话的 `stage=ready + artifact.status=PARTIAL` 必须自动收敛，并能通过显式 retry API 修复。

## 工作目录与基线

- 工作目录：`E:\desktop\AI\11_Products\lab\VideosBatch`
- 基线分支：从 `feature/videosbatch-reference-binding` 创建独立功能分支。
- 规范：`specs/videosbatch-workflow-canonical.md`
- 方案：`docs/videosbatch-audio-readiness-gate-repair.md`
- 当前运行事实：`.env` 保持 fake/fake；禁止把任何密钥、签名 URL 或 `data/` 文件加入提交。

## 实现要求

1. 先更新 canonical 规范版本和本任务方案，再改代码。
2. 在 `runner.ts` 增加统一的 artifact readiness reconciliation：
   - 保留 partial artifact、contentHash、source lineage 和 failedSegments；
   - 将 `COPYABLE_PROMPT` 的 partial/failed 映射为 failed stage；
   - legacy ready+partial 读取时自动回拨 currentStage 并标记后继 stale；
   - 使用稳定错误码 `COPYABLE_PROMPT_PARTIAL` / `COPYABLE_PROMPT_FAILED`。
3. 在 `nativeMediaStages.ts` 把音频检查分成 structural 与 delivery 两种模式：
   - EXECUTION 只做 structural 检查；
   - STITCH gate 和 STITCH validator 必须做 delivery 检查；
   - 有 narration/dialogue 时要求对应 TTS audioUrl；有 soundEffects 时要求音效 audioUrl；mix 必须 ready 且有 audioUrl；
   - 失败使用 `AUDIO_TIMELINE_NOT_READY`，禁止创建 StitchJob。
4. 在 `api.ts` 的 workflow GET、retry 和 artifact PUT 入口调用 reconciliation；retry 继续强制校验 source revision/hash。
5. 若客户端已有阶段操作入口，增加 retryable failed stage 的“重试本阶段”动作；不要把 retry 替换成无 lineage 的 restart。
6. 不实现 TTS/音效 Provider，不改 H3 Prompt，不修创作内容，不运行真实 Provider。

## 必须测试

- `COPYABLE_PROMPT PARTIAL` -> stage failed，artifact 保留，retryable=true。
- legacy ready+partial -> GET/run/retry 前自动收敛，currentStage 不得越过 COPYABLE_PROMPT。
- retry lineage 缺失/过期 -> 409 `RETRY_LINEAGE_CONFLICT`。
- `tts=[]` 且有 voice event -> STITCH 失败。
- `mix.status=pending` -> STITCH 失败且没有 StitchJob。
- 完整有效 audio timeline -> STITCH mock 可以继续。
- 手工伪造 STITCH READY artifact 不能绕过 delivery validator。

## 验证命令

```powershell
npm run smoke:videosbatch-llm-text-stages
npm run smoke:videosbatch-api-retry
npm run smoke:videosbatch-native-media-stages
npm run smoke:specs
npm run smoke:secrets
npm run build
```

## 停止条件

- 发现需要新增 TTS/音效 Provider 或修改 `.env`：停止并报告，不自行扩展范围。
- 发现旧会话必须直接改写 `data/cinema-store.json`：停止，改用懒迁移方案。
- 任一测试出现真实网络提交、密钥回显、孤儿 StitchJob 或 stage 状态不一致：停止并保留失败证据。

## 交付物

- 代码、定向 smoke 和 canonical 规范变更。
- `docs/videosbatch-audio-readiness-gate-repair.md` 中的验收项逐项勾选。
- 变更摘要：哪些状态被纠正、旧会话如何收敛、哪些音频能力仍未实现。

## 本轮结果

- `COPYABLE_PROMPT` 的 `PARTIAL/FAILED` 已统一进入 failed stage，原 artifact 和来源血缘保留。
- legacy `ready + PARTIAL` 在 workflow API 入口自动回拨并标记后继 stale；retry API 已验证 lineage 约束。
- `STITCH` 已拒绝待播语音缺少 TTS、音效缺少 URL、`mix.status=pending` 或 mix URL 缺失的输入，且不会创建 StitchJob。
- 定向 smoke、规范、秘密扫描和构建均通过；未调用真实 TTS/音效/视频 Provider。
