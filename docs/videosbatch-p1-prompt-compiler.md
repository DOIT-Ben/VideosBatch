# VideosBatch P1-A：Provider Prompt 编译器实施规范

状态：IMPLEMENTATION PLAN（实现计划，不是新的业务规范）
范围：问题 #1、#7、#8、#9  责任域：正式分镜 -> Provider 视频请求

## 0. 规范边界

`specs/videosbatch-workflow-canonical.md` 是阶段、字段语义和产物门禁的唯一真源。本文件只规定如何实现和验证，不得重新定义故事类型、分镜字段、时长或人工确认规则。若本文件与唯一规范冲突，以唯一规范为准，并先记录冲突再编码。

相关现状记录：

- `docs/videosbatch-audio-readiness-gate-repair.md` 只覆盖音频就绪门禁（#5、#13、#14），不在本文件中重复修改。
- 参考图绑定已由 `feature/videosbatch-reference-binding` 的实现提供有序快照；本阶段只能复用其结果，不能重新发明一套绑定顺序。

## 1. 目标与非目标

### 1.1 目标

让每个 VideosBatch 镜头在发送给 H3 前，都由同一个、可审计、可重放的 `Shot Execution Package` 编译得到。编译结果必须完整表达正式分镜中的：

- 教学语义：主题、知识点、镜头目的、教材证据；
- 视觉语义：章节、场景、主体/人物/核心意象、辅助元素/道具；
- 画面执行：每个子镜头的时间、画面、动作、运镜、连续性；
- 声音意图：旁白/对白文本、说话者和音效意图（只作为执行约束，不要求 H3 生成受控音频）；
- 有序参考图：`referenceId`、`ordinal`、`assetKey`、语义标签和已验证图片快照；
- 版本血缘：`sourceStageId`、`sourceRevision`、`sourceHash`、`assetPlanRevision`、`assetPlanHash`、`contentHash`。

### 1.2 非目标

- 不修改 Guided Studio 的已验收界面；
- 不改变三种 canonical `storyType` 的字段定义；
- 不让 `COPYABLE_PROMPT` 反向成为执行事实源；
- 不在 Prompt 中暴露稳定公开资产 ID、密钥、签名 URL 或内部路径；
- 不把旁白交给 H3 生成，不把 H3 原生音轨当作受控 TTS；
- 不在离线合同通过前调用真实 Provider。

## 2. 当前代码事实（作为实现起点）

1. `canonicalStoryboard.ts` 已保存三种互斥字段布局以及每条 10 秒、3--5 个子镜头的结构。
2. `nativeProjection.ts` 的 `canonicalPromptParts()` 目前只拼接场景、类型主体、辅助字段和画面/动作（约第 173 行），没有完整带入镜头、声音、教学语义和跨镜头连续性。
3. `nativeProjection.ts` 另外保存了 `script` 与 `camera`，但它们没有进入 `rawPrompt`；`newApiH3Video.ts` 最终只把 `shot.rawPrompt` 交给 `compileNewApiH3Prompt()`。
4. `newApiH3Video.ts` 已有稳定的参考图排序、文件上传和 `Image N` 映射，新的编译器必须把这条有序列表作为唯一输入。

## 3. 统一执行包契约

实现时可按现有命名调整文件名，但必须有等价的共享类型，不能在投影层和 Provider 层各自拼接字段。

```ts
type ShotExecutionPackage = {
  schemaVersion: "1";
  sourceStageId: "FINAL_STORYBOARD";
  sourceRevision: number;
  sourceHash: string;
  assetPlanRevision: number;
  assetPlanHash: string;
  contentHash: string;
  shot: {
    sequence: number;
    chapter: string | null;
    screenplaySceneSequence: number;
    durationSec: 10;
    storyType: "STORY" | "SCIENCE" | "KNOWLEDGE";
  };
  teaching: {
    goal: string;
    knowledgeFocus: string;
    evidence: Array<{ source: string; quote: string }>;
  };
  visual: {
    scene: string;
    roleLabel: "人物" | "主体" | "核心意象";
    role: string;
    supportLabel: "道具" | "辅助元素";
    support: string;
    effects: Array<{
      sequence: number;
      timeRange: string;
      duration: number;
      visual: string;
      action: string;
      camera: string;
    }>;
    styleSpec: string;
    negativePrompt: string;
    globalContinuity: string;
  };
  audioIntent: {
    voices: Array<{ id: string; text: string; startSec: number; endSec: number }>;
    sounds: Array<{ id: string; text: string; startSec: number; endSec: number }>;
  };
  references: Array<{
    referenceId: string;
    ordinal: number;
    assetKey: string;
    semanticLabel: string;
    assetId: string;
    imageUrlHash?: string;
  }>;
};
```

`assetId` 和 `imageUrlHash` 只能留在服务端审计视图；Provider 文本只允许语义标签和 `Image N`。构造器只接受 `status=ready` 的 `ASSET_PLAN` stage wrapper（含 `revision`、`contentHash` 和 `artifact`），拒绝裸 artifact。`styleSpec` 与 `negativePrompt` 从已确认的 `ASSET_PLAN` 继承，并在 Prompt 的“连续性”章节作为全局画面约束输出。执行包必须在发送前冻结，重试时按相同 `contentHash` 重放，不能重新从全局资产表排序。

编译结果另返回 `compilerVersion` 和独立的 `promptHash`；`promptHash` 覆盖实际 Prompt 文本、编译器版本和 full/compact 渲染模式。`Image N` 映射保留完整的类型化语义标签，例如 `Image 1 = 【人物：小宇】`，不得退化为只有名称的绑定。

## 4. 编译器行为合同

### 4.1 输入来源和优先级

编译器只读取当前确认版本的 `FINAL_STORYBOARD`、`ASSET_PLAN`、`ASSET_CONFIRMATION` 和必要的 `SCREENPLAY` 血缘。执行包必须保存 `assetPlanRevision` 与 `assetPlanHash`；输入版本或哈希过期、风格/负面约束不匹配、场次不存在、参考图无法解析时，直接返回结构化错误，不生成部分 Prompt。风格和负面约束只能从已确认 `ASSET_PLAN` artifact 复制，不能由调用方另行覆盖。

`compileShotProviderPrompt()` 与直接的 `renderShotProviderPromptSections()` 都必须接收当前 `FINAL_STORYBOARD` 和 `ASSET_PLAN` 的 revision/hash；当前 `ASSET_PLAN` 还必须提供 style/negative 原文用于逐项比对。缺少当前上下文视为血缘不完整并阻断，不能仅凭执行包自身 hash 渲染。

### 4.2 固定渲染顺序

Provider Prompt 的章节顺序固定如下，顺序变化视为合同变化：

1. `教学目标与知识点`
2. `章节与场景`
3. 当前 `storyType` 的主体字段（STORY=人物，SCIENCE=主体，KNOWLEDGE=核心意象）
4. 当前类型的辅助字段（STORY=道具，其他类型=辅助元素）
5. `画面效果`：按子镜头序号逐条输出时间、画面、动作、运镜
6. `连续性`：全片风格、上一镜尾部状态、当前镜头必须保持的身份/空间/方向（有值才输出）
7. `声音表演约束`：原始旁白/对白和音效意图，仅用于嘴型、反应和节奏；明确“音频由独立 TTS/混音链路提供”
8. `Reference image bindings (strict)`：按 `ordinal` 输出 `Image N = 语义标签`

每个章节都必须来自结构化字段，禁止只把整个 JSON `JSON.stringify()` 后塞进用户 Prompt。字段值中的换行、控制字符、ASCII 章节标记和 compact 分隔符必须被规整或阻断；输出还要验证固定章节标题唯一且顺序不变。合同修复只发送受影响字段和校验错误。

### 4.3 Provider 安全规则

- 不出现 `Pxxx-Axxx`、数据库 ID、URL、文件路径或内部任务号；
- 不出现位置型“第几张图”替代 `Image N` 语义映射；
- 不让模型改写、补写或回答教学结论；
- 不把台词/旁白重复拼到多个章节；
- 不把服务端音频事件 ID写入 Provider Prompt；
- H3 若支持 `generate_audio`，VideosBatch 请求必须显式关闭，或在进入混音前明确丢弃其语音轨；不能让 H3 原生音轨与 TTS 双播；
- Prompt 编译必须是确定性的纯函数，不能在编译器内隐式调用 LLM。

### 4.4 长度与失败

编译后先做本地长度和字段完整性检查。超出 Provider 限制时，先按章节边界做不丢字段的压缩；仍超限则返回 `PROMPT_CONTEXT_TOO_LARGE`，不得静默截断或隐藏分段请求。

统一错误至少包含：`code`、`message`、`retryable`、`attempt`、`provider`、`model`、`sourceRevision`、`sourceHash`。

## 5. 小阶段实施顺序

### A0：契约冻结（只做共享类型和 fixture）

输入：一条 STORY、一条 SCIENCE、一条 KNOWLEDGE 的已确认最终分镜。
改动：建立执行包类型、构造器、稳定哈希和三类 fixture；不改 Provider 请求。
验收：fixture 能逐字段还原原分镜，缺字段/过期血缘会失败。
验证：`npm run smoke:videosbatch-llm-text-stages`、`npm run smoke:specs`、`npm run build`。
停止：报告类型、fixture、哈希和失败样例，等待下一阶段指令。

### A1：确定性 Prompt 编译器

输入：A0 执行包。
改动：新增纯函数编译器和章节渲染器；不接网络、不改 UI。
验收：三种类型使用正确主体字段；所有画面/运镜/教学/声音意图均可在编译文本中定位；稳定 ID 不泄漏。
验证：新增编译器单测或 smoke，并运行 `npm run smoke:videosbatch-native-projection`。
停止：输出三种类型的脱敏 Prompt 快照和差异。

### A2：原生投影改为执行包驱动

输入：A1 编译器。
改动：`nativeProjection.ts` 只负责构造执行包并把编译结果写入 Shot；保留现有 `assetIds` 和 binding 快照。
验收：同一 canonical 输入重复投影得到相同 `contentHash`；重新投影不会丢失旁白、镜头、音效或连续性。
验证：`npm run smoke:videosbatch-native-projection`、`npm run smoke:videosbatch-store-save`、`npm run build`。
停止：检查工作树和投影 JSON，等待审查。

### A3：H3 请求接入

输入：A2 的执行包和现有有序参考图计划。
改动：`newApiH3Video.ts` 仅接收执行包编译结果；保留 `Image N` 映射、上传顺序、幂等键和审计回调。
验收：请求 Prompt 与本地快照逐字一致；请求体不含稳定 ID；引用顺序、数量和 URL 哈希一致。
验证：`npm run smoke:videosbatch-newapi-h3`、`npm run smoke:videosbatch-native-projection`、`npm run smoke:secrets`。
停止：先用 fake/拦截请求验证，不调用真实 H3。

### A4：负向合同与回归

覆盖：漏场次、错 storyType、缺 camera、缺 voice、重复旁白、过期 hash、稳定 ID 泄漏、引用顺序变化、超长 Prompt。
验证：`npm run smoke:videosbatch-llm-text-stages`、`npm run smoke:videosbatch-native-projection`、`npm run smoke:videosbatch-newapi-h3`、`npm run smoke:specs`、`npm run build`。
停止：只有 A4 全部通过，才允许进入音频阶段。

## 6. 完成定义

- H3 的唯一 Prompt 来源是当前 `ShotExecutionPackage`，不再是精简 `rawPrompt`；编译结果另有包含编译器版本和渲染模式的 `promptHash`，不能只用执行包 `contentHash` 区分 Prompt 变体；
- 三种类型字段都能无损追溯；
- 旁白/音效进入独立音频意图流，既不会丢失，也不会要求 H3 生成受控音频；
- 参考图顺序、语义映射和审计快照保持现有实现；
- 所有离线合同、构建和秘密扫描通过；
- 未提交的用户改动未被覆盖，未执行提交、推送、合并或真实 Provider 调用。
