# ADR-0002：VideosBatch 结构化提示词文档（`VideoPromptDocument`）

- 状态：**Proposed（待产品确认提示词编写模型后转 Accepted）**
- 日期：2026-09-16
- 前置：[`0001-videosbatch-align-frameflow-contracts.md`](./0001-videosbatch-align-frameflow-contracts.md) 的 **P3**（`promptDocument`）；依据 `specs/videosbatch-workflow-canonical.md` §7 Change Policy「合同级变更先改 spec 再改代码」
- 参照实现：FrameFlow `bbb17414` 的 `src/lib/video-creation-contract.ts`、`prototypes/lesson-video-factory/src/{contracts,prompt-document}.ts`

## 1. 背景

FrameFlow 把视频提示词建模为**结构化文档**，而不是一段字符串：

```ts
type VideoPromptDocument = {
  version: 1
  nodes: Array<{ type: 'text'; text: string } | { type: 'reference'; referenceId: string }>
}
```

配套三条合同：

1. **投影一致性**：`projectVideoPromptDocument(doc)` = 依序拼接全部 `text` 节点再 `trim()`，**必须与同一请求里的 `prompt` 完全一致**，否则报 `PROMPT_DOCUMENT_PROJECTION_MISMATCH`。即「结构化视图」与「扁平字符串」是同一事实的两种表示，不允许漂移。
2. **按方言编译**：`compileVideoPromptDocument(doc, bindingByReferenceId, dialect)` 把 `reference` 节点替换成方言 token —— `seedance` 用 `@图片N` / `@视频N`，`minimax-h3` 用 `Image N` / `Video N`，`generic` 用 `参考图片N` / `参考视频N`。参考素材的序号、别名绑定集中在文档层，不再散落在字符串拼接里。
3. **语义别名提示**：`appendVideoReferenceNameHints` 追加 `参考素材对应关系：Image 1=乐乐；…`。

VideosBatch 目前是**扁平字符串**：`compileNewApiH3Prompt()` 把 `Image N = 语义名称` 的映射行拼到基础提示词之后，映射与正文混在一个字符串里。

## 2. 关键约束（决定了这项不能照搬）

- spec §7.7 明文规定：**稳定公开资产 ID 不得进入 H3 prompt**，正文只用语义标签（`【人物：乐乐】`），token 绑定由适配器按 ordinal 生成。
- 因此**当前提示词里没有任何可标记的引用锚点**。FrameFlow 的教学原型 `buildShotPromptDocument` 之所以能工作，是因为它的正文里带 `【P###-A###】` 标记，把标记换成 `reference` 节点即可。
- 结论：在 VideosBatch 现有数据上机械地构造文档，只会得到 **单一 text 节点的退化解**（`nodes: [{type:'text', text: prompt}]`），投影一致性恒真、零信息增益 —— 这是**改了个寂寞**，不是对齐。

## 3. 备选方案

| 方案 | 做法 | 代价 | 判断 |
|---|---|---|---|
| **A. 退化解** | 直接把当前 prompt 包成单 text 节点文档 | 极小 | **拒绝**：纯装饰，消费方行为一字不变，等于给系统加一层空壳 |
| **B. 正文携带语义锚点** | 最终分镜正文允许写 `【人物：乐乐】` 这类**语义锚点**，文档把它编译成 `reference` 节点；稳定 ID 仍不进正文 | 中 | **倾向**：与 §7.7「正文只用语义标签」一致，锚点本就是现有词汇；改动集中在提示词编译器与 H3 适配器 |
| **C. 正文携带稳定 ID 锚点** | 学 FrameFlow 原型用 `【P###-A###】` | 中 | **拒绝**：直接违反 §7.7，且会把稳定 ID 泄漏到 Provider 请求 |
| **D. 不做** | 维持扁平字符串 | 零 | **保留为默认**：现状已可用，P3 的收益是**可审计性**而非功能 |

## 4. 建议决定（方案 B）

若产品确认「最终分镜正文可以写语义锚点」，则：

1. 新增 `src/shared/videosBatchPromptDocument.ts`（叶子模块，前后端共用）：文档类型、`projectVideosBatchPromptDocument()`、`compileVideosBatchPromptDocument(doc, bindings, dialect)`、`VIDEOSBATCH_PROMPT_DOCUMENT_DIALECTS`。
2. 新增失败码 `PROMPT_DOCUMENT_PROJECTION_MISMATCH`（只允许追加）。
3. `ShotExecutionPackage` 与最终分镜 artifact **同时**携带 `prompt`（字符串，权威）与 `promptDocument`（结构化视图）；两者由同一处生成，并在构建期断言投影一致。
4. H3 适配器改为**从文档编译**提示词（方言 `minimax-h3`），替换现有 `Image N = …` 手工拼接；**必须产出与今天逐字相同的 prompt**，否则视为回归。
5. 持久化：`videosBatchPromptHash` 继续钉住**编译后的扁平字符串**；`promptDocument` 按其规范化 JSON 的哈希另存，便于比对「结构化视图是否被静默改写」。

## 5. 分阶段

| 阶段 | 内容 | 出口判据 |
|---|---|---|
| **P3-1** | 合同模块 + 投影一致性断言 + smoke；**不改任何消费方** | 投影不一致必 fail；模块被真实消费（避免新增死代码） |
| **P3-2** | 最终分镜与执行包同时携带文档；构建期断言一致 | 全量门禁绿；H3 prompt 逐字不变 |
| **P3-3** | H3 适配器改从文档编译；copyable prompt 复用同一次编译 | prompt 哈希与 P3-2 前一致（零回归证明） |
| **P3-4** | spec 升版 + ADR 转 Accepted | — |

## 6. 非目标

- 不引入 `first_frame_to_video` / `first_last_frame_to_video` / `continue_from_video` 等创作模式（FrameFlow 有，VideosBatch 的九步流程只产出多参考图镜头）。
- 不引入 `seedance` 方言（VideosBatch 的原生视频路径只有 `minimax-h3` 与兼容自定义端点）。
- 不改动 §7.7 的「稳定 ID 不进 prompt」。

## 7. 待产品确认

1. 最终分镜正文是否允许写**语义锚点**（如 `【人物：乐乐】`）来标记引用位置？（方案 B 的前提）
2. 若允许，锚点缺失时是**回退为纯文本**，还是**判 PARTIAL**？（建议回退为纯文本，与 §7 现有「不得仅因位置未命中把整条镜头标为 PARTIAL」保持一致）
3. 是否需要结构化的 `promptDocument` 进入**用户可见**的审计视图，还是仅作为内部一致性凭据？

## 8. 未落地声明

本 ADR 交付的是**决策与分阶段计划**，**不含实现**。P3-1 起需在获得上面三个问题的答案后单独执行；在答案到位之前，VideosBatch 维持扁平字符串提示词（方案 D），该现状是**有意的**而非遗漏。
