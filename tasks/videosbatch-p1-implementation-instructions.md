# VideosBatch P1 两条交付线：分阶段执行指令

状态：READY_FOR_IMPLEMENTATION
适用任务：`codex://threads/01a062fe-1292-7e40-9ebb-e07d0bbdeaeb`
工作目录：`E:\desktop\AI\11_Products\lab\VideosBatch`

## 一、执行前提

先完整阅读以下文件，再开始任何代码修改：

1. `AGENTS.md`
2. `specs/videosbatch-workflow-canonical.md`
3. `docs/videosbatch-p1-prompt-compiler.md`
4. `docs/videosbatch-p1-audio-delivery.md`
5. `docs/videosbatch-audio-readiness-gate-repair.md`

当前工作树存在既有未提交改动，必须逐文件保留。开始和每个小阶段结束时运行：

```powershell
git -c core.fsmonitor=false --no-optional-locks status --porcelain=v2 --branch --ahead-behind --untracked-files=all --ignore-submodules=none
```

不得使用 `git reset`、`git checkout --`、`git clean`、`git add .` 或覆盖既有脏文件。不得提交、推送、合并或删除分支。

## 二、硬性执行协议

- 一次只实现一个小阶段，不得把 Prompt 和音频两个总阶段一次性完成。
- 每个小阶段只改该阶段列出的文件；发现需要扩大范围时先停下报告。
- 每个小阶段完成后，先运行该阶段验证命令，再报告：改动文件、测试退出码、产物/快照、未解决问题和下一阶段依赖；报告后停止，等待继续指令。
- 先离线、后真实；在所有离线合同和构建通过前，禁止真实 TTS、音效、H3 或视频 Provider 调用。
- 不修改 `.env`、`data/` 旧会话、前端视觉和参考图绑定逻辑。
- 失败必须保留结构化错误和可重试状态；不得用静音、空 URL、`json_object` 降级或假 READY 绕过门禁。

## 三、执行顺序与小阶段

### A0：现场与契约确认（只读）

动作：确认分支、HEAD、脏文件清单，定位现有 `Shot`、`FINAL_STORYBOARD`、`audioTimeline`、H3 和 TTS 入口；不要修改文件。
验收：能明确指出现有缺口和将复用的函数；没有真实网络请求。
命令：

```powershell
npm run smoke:specs
npm run smoke:secrets
```

完成后停止并汇报现场。

### A1：`ShotExecutionPackage` 契约与 fixture

参考：`docs/videosbatch-p1-prompt-compiler.md` 第 3 节、`docs/videosbatch-p1-audio-delivery.md` 第 3 节。
动作：新增共享类型、构造器、稳定哈希和 STORY/SCIENCE/KNOWLEDGE fixture；不接 Provider。
验收：同一输入生成相同 `contentHash`；字段缺失、错类型、过期 revision/hash、重复 voice 事件均被拒绝。
验证：

```powershell
npm run smoke:videosbatch-llm-text-stages
npm run smoke:videosbatch-native-media-stages
npm run smoke:videosbatch-native-media-resilience
npm run build
```

完成后停止并等待审查。

### A2：确定性 Provider Prompt 编译器

动作：实现纯函数 Prompt 编译器，按固定章节输出教学语义、场景、类型主体、辅助元素、画面效果、连续性、声音表演约束和 `Image N` 映射。
硬门禁：不得 `JSON.stringify` 整体分镜；不得出现稳定资产 ID、URL 或内部路径；不得让 H3 生成受控旁白。
验收：三种 storyType 的字段互斥且完整；所有 camera/action/voice/sound/teaching/evidence 可追溯。
验证：

```powershell
npm run smoke:videosbatch-native-projection
npm run smoke:videosbatch-newapi-h3
npm run smoke:secrets
npm run build
```

完成后停止，附三种类型的脱敏 Prompt 快照。

### A3：原生投影和 H3 适配

动作：让 `nativeProjection.ts` 从执行包写入 Shot；让 `newApiH3Video.ts` 使用执行包编译结果，同时保留已有 reference ordinal、上传顺序、URL 哈希、幂等键和回调。
验收：相同 canonical 输入重投影 hash 不变；请求 Prompt 与快照逐字一致；请求中没有稳定 ID；重复提交不会改变参考图顺序。
验证：

```powershell
npm run smoke:videosbatch-native-projection
npm run smoke:videosbatch-newapi-h3
npm run smoke:videosbatch-api-retry
npm run build
```

完成后停止，先做代码审查，不得真实提交 H3。

### A4：Prompt 负向合同收口

动作：补齐错章节、漏场次、缺镜头/旁白、跨类型字段、过期 lineage、稳定 ID 泄漏、位置型图片标签、超长 Prompt 和重复旁白测试。
验收：每个错误有稳定 code/message/retryable/attempt/provider；修复请求只包含受影响字段和错误。
验证：

```powershell
npm run smoke:videosbatch-llm-text-stages
npm run smoke:videosbatch-native-projection
npm run smoke:videosbatch-newapi-h3
npm run smoke:specs
npm run smoke:secrets
npm run build
```

完成后停止。A4 未通过不得进入音频 Provider。

### B0：音频时间线和事件 ID

动作：按执行包生成 narration/dialogue/soundEffects 事件；为每个事件保存 `sourceEventId`、时间窗、血缘和状态；只能按事件 ID 去重。
验收：相同台词出现在不同镜头时不被吞掉；源 revision/hash 变化会 stale；没有音频文件时只能是 planned/failed。
验证：

```powershell
npm run smoke:videosbatch-native-media-stages
npm run smoke:videosbatch-native-media-resilience
npm run build
```

完成后停止并提供事件表快照（不提交 Git）。

### B1：TTS 适配器（先 fake）

动作：复用现有 `synthesizeViaDoubao` 核心，包成按事件调用的 VideosBatch 适配器；先生成确定性本地音频，再接受保护配置。
硬门禁：每个 voice 事件一对一 TTS URL；失败不可写静音冒充 READY；ready 文件按内容 hash 复用。
验证：新增定向 TTS smoke，并运行：

```powershell
npm run smoke:videosbatch-native-media-stages
npm run smoke:videosbatch-native-media-resilience
npm run smoke:secrets
npm run build
```

完成后停止；未获本阶段验收前不得真实 TTS。

### B2：真实音效来源适配

动作：先盘点 ASSET_CONFIRMATION、项目和 FrameFlow 已有音效来源，再实现唯一适配器；没有来源时返回 `SFX_AUDIO_UNAVAILABLE`。
硬门禁：音效事件必须有可读取媒体 URL；文字描述不能通过交付校验；单个音效失败不影响其他已完成事件。
验证：音频 URL/媒体时长 smoke、`npm run smoke:videosbatch-native-media-stages`、`npm run build`。
完成后停止并报告实际来源、配置名、费用和失败隔离。

### B3：按时间线混音

动作：实现独立 FFmpeg 混音器，物化 TTS/SFX、按时间窗延迟和增益混合，输出 `mix.audioUrl`、时长、哈希和生成时间。
硬门禁：输出时长等于目标；含可探测 AAC；H3 原生旁白不得与 TTS 双播；半成品失败要清理。
验证：本地 fixture 生成 10 秒 fake 混音并探测音频流/时长；再运行：

```powershell
npm run smoke:videosbatch-native-media-resilience
npm run smoke:videosbatch-native-media-stages
npm run build
```

完成后停止并提供媒体探测结果。

### B4：STITCH 接入与门禁

动作：让 `stitchShotVideos()` 真正消费 ready 的 audioTimeline；保持 `AUDIO_TIMELINE_NOT_READY`、stale、幂等和单项重试规则。
验收：缺 TTS、缺音效或 mix pending 时不创建成功 StitchJob；完整 timeline 才能输出含音轨 MP4。
验证：

```powershell
npm run smoke:videosbatch-native-media-stages
npm run smoke:videosbatch-native-media-resilience
npm run smoke:videosbatch-api-retry
npm run smoke:specs
npm run smoke:secrets
npm run build
```

完成后停止并进行代码审查。

### B5：真实单镜头验收（最后）

前置：A0--A4、B0--B4 全部通过；临时 Provider 配置已在进程环境中准备；默认 `.env` 仍为 fake/fake。
范围：只执行一个 10 秒镜头、一条 TTS 和必要音效，不批量、不 stitch 全片。
必须记录：provider/model、task ID、attempt、音频文件 URL/哈希、最终 MP4 时长和音频流；失败保留证据并按事件重试。
完成后停止，不自动扩展到整片。

## 四、阻塞处理

遇到以下情况立即停止并报告，不得自行绕过：

- 需要修改既有脏文件或 `data/`；
- 需要新增未确认的 Provider、依赖或生产配置；
- Provider 返回结构无法验证；
- 真实请求可能重复计费或提交状态未知；
- 离线 smoke、秘密扫描或构建失败；
- 需要改变 canonical spec、前端界面或参考图绑定顺序。

报告格式固定：

```text
阶段：
状态：通过 / 失败 / 阻塞
改动文件：
验证命令与退出码：
证据：
剩余风险：
下一步（需等待指令）：
```

## 五、最终完成定义

只有满足以下全部条件，才可声称两条 P1 线完成：

- H3 请求由完整执行包编译，视觉、运镜、连续性和教学语义无损；
- TTS、真实音效和混音均为独立、可读取、可追溯产物；
- 旁白没有重复，H3 原生音频不会与受控音频双播；
- 事件级重试、stale、幂等和失败隔离均可验证；
- 定向 smoke、`npm run smoke:specs`、`npm run smoke:secrets` 和 `npm run build` 通过；
- 最后才完成一次受控真实单镜头验收；
- 未覆盖的问题（#15--#19）保持原状并单独列出。
