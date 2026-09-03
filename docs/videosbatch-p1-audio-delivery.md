# VideosBatch P1-B：可控音频交付实施规范

状态：IMPLEMENTATION PLAN（实现计划，不是新的业务规范）
范围：问题 #2、#3、#4：TTS 旁白、真实音效、按 `audioTimeline` 混音并生成最终成片

## 0. 规范边界

阶段字段、时长、人工确认和交付定义仍以 `specs/videosbatch-workflow-canonical.md` 为唯一真源。本文件只定义媒体实现方式。`docs/videosbatch-audio-readiness-gate-repair.md` 已完成 #5、#13、#14 的就绪门禁；本阶段要把门禁要求的空位真正填成可读取的音频产物。

本阶段不能把“有文字描述”当成“有音频文件”，不能把 H3 自带音轨当成受控旁白，也不能在失败时用静音伪装成可交付成片。

## 1. 目标与交付边界

### 1.1 目标

从当前确认的 `FINAL_STORYBOARD` 生成一条可审计的独立音频链：

```text
分镜 voice/sound 意图
  -> audioTimeline（时间与血缘）
  -> TTS 旁白/对白音频
  -> 真实音效音频
  -> 按时间线混音
  -> STITCH 输出含受控音轨的最终 MP4
```

每个音频事件都必须能追溯到分镜子镜头、源版本、Provider、模型、尝试次数和本地/远程媒体哈希。

### 1.2 非目标

- 不修改已验收的 Guided Studio UI；
- 不改变正式分镜的字段语义或参考图绑定；
- 不让 H3 负责生成可控旁白；
- 不在离线验证通过前调用真实 TTS、音效或视频 Provider；
- 不把现有通用“拼接后再添加音轨”流程直接冒充 VideosBatch 音频交付；
- 不修改旧会话数据库文件，不删除已有视频。

## 2. 当前代码事实与可复用部分

1. `nativeMediaStages.ts` 已从最终分镜构造 `audioTimeline`，但当前 `streams.tts` 为空、`streams.mix.status` 为 `pending`（`buildAudioTimeline()` 附近）。这解释了为什么 STITCH 门禁会阻塞。
2. `nativeMediaStages.ts` 已有结构校验与交付校验，要求语音事件对应 TTS URL、音效事件有 URL、mix 为 ready；实现阶段必须满足这些既有门禁，不得降低校验。
3. `narration.ts` 已实现火山 OpenSpeech TTS、缓存、时长探测、FFmpeg 旁白混音和重试，可提取为适配器复用；但 `runNarrationPipeline()` 的入口要求已有 `finalVideoUrl`，不能原样用于 VideosBatch 的逐镜头时间线。
4. `generators.ts` 的 `stitchShotVideos()` 当前以 FFmpeg concat 合并镜头原生音轨；虽然接收 `audioTimeline` 参与签名，但尚未把 timeline 事件作为输入混音。
5. 当前没有可直接确认的独立 SFX Provider 入口。实现前必须先盘点已有项目/FrameFlow 适配；不得凭空猜测 endpoint 或把文本写入 `audioUrl`。

## 3. 音频执行包与状态合同

音频实现应消费 Prompt 阶段冻结的 `ShotExecutionPackage`，并扩展当前 `VideosBatchAudioTimeline`（优先新增可选字段，保持旧客户端兼容）：

```ts
type AudioEvent = {
  id: string;                 // 稳定：shot-{sequence}-{kind}-{ordinal}
  sourceEventId: string;      // FINAL_STORYBOARD 子镜头事件 ID
  startSec: number;
  endSec: number;
  text?: string;              // narration/dialogue 的原文
  audioUrl?: string;          // TTS/SFX 产物，必须可读取
  status: "planned" | "ready" | "failed";
  provider?: string | null;
  model?: string | null;
  attempt: number;
  contentHash?: string;
  error?: { code: string; message: string; retryable: boolean };
};
```

流的职责固定：

- `narration` / `dialogue`：只保存分镜中的文字意图和时间窗；
- `tts`：与每一个 voice 事件一对一，保存真实 TTS 文件 URL；
- `soundEffects`：与每一个 sound 事件一对一，保存真实音效文件 URL；
- `mix`：保存最终混音文件 URL、时长、哈希和生成时间；
- `sourceRevision/sourceHash`：必须与当前 `FINAL_STORYBOARD` 一致。

事件去重只能使用稳定 `sourceEventId`，不能只按相同文本去重，否则同一句台词在不同镜头会被错误吞掉。

## 4. 音频来源和 Provider 规则

### 4.1 TTS

- 优先复用 `synthesizeViaDoubao()` 的火山 OpenSpeech v3 适配器；将网络调用包在 VideosBatch 专用接口中，输入为单一事件和声线配置。
- 真实模式从受保护环境变量读取凭证；文档、日志和响应绝不打印密钥。
- fake 模式生成确定性的本地短音频，并通过同一时长探测和 URL 校验，不能直接填占位字符串。
- 每个事件按 `contentHash + voice + provider` 缓存；已 ready 的事件重试时不得重复计费。
- TTS 失败不能插入静音后继续标记 READY；应保存结构化错误并让该事件/阶段可重试。

### 4.2 真实音效

实现前先完成 Provider/资产来源盘点，优先级如下：

1. 已确认且可读取的音频资产（`ASSET_CONFIRMATION`）；
2. 项目或 FrameFlow 已有的音效生成/检索适配器；
3. 经确认的生产音效 Provider 新适配器。

如果没有可用来源，返回 `SFX_AUDIO_UNAVAILABLE`，保持 PARTIAL/FAILED，不得把 `sound` 文本当作 `audioUrl`，也不得静默改成 H3 原生音效。

### 4.3 H3 原生音频

VideosBatch 的旁白和音效必须由独立流控制。若 Provider 支持 `generate_audio`，请求中显式关闭；若无法关闭，混音前必须明确选择并实现“保留环境声、去除/压低原生语音”的策略，并在审计记录中标明。禁止独立 TTS 与 H3 语音双播。

## 5. 混音和最终成片合同

新增可测试的 FFmpeg 混音函数（名称可按项目约定调整），输入为已物化的镜头视频和音频事件，输出必须满足：

- 所有事件按 `startSec/endSec` 对齐，超出视频时长的事件明确失败或按规范截断并记录；
- TTS、对白、音效各自保留独立输入，再按固定增益/ducking 规则混合；
- 镜头原生音轨只作为环境底噪来源，不得重复叠加同一旁白/对白；
- 输出时长与 `audioTimeline.durationSec` 相等，误差不超过既有容差；
- 输出包含可探测的 AAC 音频流，`mix.audioUrl` 指向本地或 HTTPS 可读取媒体；
- 混音签名包含镜头版本、音频事件哈希、声线/Provider 配置，内容不变时可复用缓存；
- FFmpeg 中间文件失败时清理半成品，保留错误日志尾部和结构化状态。

STITCH 只有在视频、资产血缘、TTS、音效和 mix 全部 ready 时才可创建成功 Job。音频未就绪时沿用 `AUDIO_TIMELINE_NOT_READY`，不创建假的最终视频。

## 6. 重试、隔离与可恢复性

- 网络错误、5xx、超时只对当前音频事件做有限重试，默认最多 3 次；每次记录 provider/model/attempt/error。
- 显式 retry 只重跑 failed 事件，已 ready 的 TTS/SFX/mix 复用内容哈希；不能把整部视频重新提交。
- Provider 切换只在当前 Provider 的预算耗尽后发生，不能与内部重试相乘成无界请求。
- 进程重启后，`generating/running` 事件要收敛为可重试的 failed/blocked 状态；已被 Provider 接受的任务必须保留 task ID。
- 源分镜 revision/hash 变化时，旧音频全部 stale；旧最终视频保留为历史，不得冒充当前交付。

统一错误至少包括：`code`、`message`、`retryable`、`attempt`、`provider`、`model`、`sourceRevision`、`sourceHash`、`eventId`。

## 7. 小阶段实施顺序

### B0：音频契约与 fixture

只新增/扩展类型、事件 ID 规则、fixture 和 readiness helper；不调用网络。
验收：从一条最终分镜生成稳定 timeline；重复旁白不会被错误合并；血缘变化可识别。
验证：`npm run smoke:videosbatch-native-media-stages`、`npm run smoke:videosbatch-native-media-resilience`、`npm run build`。
停止：报告事件表、哈希和负向样例，等待审查。

### B1：TTS 事件适配器（fake 优先）

输入：B0 timeline。
改动：接入现有 TTS 核心，先实现 fake 本地音频，再接真实配置；每个事件独立缓存和重试。
验收：`tts` 与 voice 事件一对一、URL 可读、时长可探测；失败不会伪装 ready。
验证：新增定向 smoke，另跑 `npm run smoke:secrets` 和 `npm run build`。
停止：先只交 fake 结果，不进行真实 Provider 验收。

### B2：音效来源适配

输入：B0 sound 事件和已确认资产。
改动：接入已盘点的资产/Provider；没有来源时返回明确错误。
验收：每个 sound 事件要么有可读取音频，要么被单独标记 failed；不能以文字通过交付门禁。
验证：音效 URL/媒体探测 smoke、`npm run smoke:videosbatch-native-media-stages`。
停止：报告 Provider 证据、费用边界和失败隔离。

### B3：Timeline 混音器

输入：ready 的 TTS/SFX 事件和镜头视频。
改动：实现按时间线物化、延迟、增益和 FFmpeg 混音，写回 `mix` 产物及哈希。
验收：输出时长、音频流、事件顺序和缓存签名正确；原生音轨不造成旁白重复。
验证：使用本地 fixture 做音频流/时长检查、`npm run smoke:videosbatch-native-media-resilience`、`npm run build`。
停止：展示一个 10 秒 fake 混音产物及探测结果。

### B4：STITCH 接入与状态门禁

输入：B3 mix。
改动：让 `stitchShotVideos()` 真正消费 timeline；保留现有 `AUDIO_TIMELINE_NOT_READY`、stale 和幂等逻辑。
验收：缺任一音频事件时不创建成功 Job；完整 timeline 才能得到含音轨 MP4。
验证：`npm run smoke:videosbatch-native-media-stages`、`npm run smoke:videosbatch-native-media-resilience`、`npm run smoke:videosbatch-api-retry`、`npm run smoke:specs`、`npm run build`。
停止：完成离线审查后再申请真实链路。

### B5：一次真实单镜头验收

前置：B0--B4 全部离线通过、秘密扫描通过、临时 Provider 配置经确认。
范围：只生成一个 10 秒镜头和一条 TTS/音效混音；不批量、不覆盖旧产物。
验收：记录实际 Provider、任务号、音频 URL、时长、最终 MP4 音频流和费用；失败可按事件重试。
停止：只汇报证据，不自动扩大到全片。

## 8. 完成定义

- `audioTimeline` 中每个 voice/sound 事件都有可追溯的真实音频或明确失败；
- `tts`、`soundEffects`、`mix` 不再以空数组/pending 冒充完成；
- 最终 MP4 的受控旁白、对白和音效按时间线混入，且不重复；
- 每个事件可单独重试，源版本变化会使旧音频 stale；
- fake 与真实模式共用同一合同和探测器；
- 定向 smoke、构建、秘密扫描通过后，才允许一次真实单镜头验收；
- 不提交、推送、合并、清理工作树或修改无关问题。
