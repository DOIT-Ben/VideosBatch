# ADR-0001：VideosBatch 对齐 FrameFlow 的提示词、产物规格与垫图合同

Status: Accepted
Date: 2026-09-15
Alignment source: FrameFlow（WSL `~/projects/frameflow`，分支 `main`，提交 `bbb17414f3e766890fad87fec667fe057e397980`）
Canonical spec: [`specs/videosbatch-workflow-canonical.md`](../../specs/videosbatch-workflow-canonical.md)
Delivery record: 本文件同时承担 ADR、Phase Plan 与 Evidence（本仓库此前无 ADR/phase 目录约定，故在此建立 `docs/adr/` 最小约定）

## 1. Original Requirement and Source

| 锚点 | 原始输入（逐字） | 日期 |
| --- | --- | --- |
| S1 | 「看看提示词要求和产物规格，和一些视频生成的垫图逻辑，对齐我们的wsl项目frameflow。」 | 2026-09-15 |
| S2 | 「你在改啥？回退。我让你我们的videobatch对齐frameflow。」 | 2026-09-15 |
| S3 | 「开始。写好ADR推进。」 | 2026-09-15 |

**方向裁决（S2）**：改造对象是 **VideosBatch**，FrameFlow 是**只读标准源**。本轮方向曾一度反转（改 FrameFlow 去贴合 VideosBatch），已按 S2 全量回退：

- 回退后对 `video-creation-contract.ts`、`providers/newapi-minimax-h3-contract.ts` 及其两个测试文件全库检索 `appendH3StrictReferenceBindings|assertH3PromptHasNoForbiddenIdentifiers|Reference image bindings (strict)`，**零残留**。
- 自本 ADR 起，FrameFlow 侧只读，不再写入。

**上游边界（已知事实）**：`specs/videosbatch-workflow-canonical.md` 的 `Source Provenance` 一节记录上游仓库为 `https://github.com/DOIT-Ben/FrameFlow.git`；其引用的本机路径 `E:/desktop/AI/11_Products/lab/FrameFlow` 在本机已不存在（`docs/`、`src/lib/providers/` 均无文件），当前唯一可读副本是 WSL 克隆。故本 ADR 以 WSL 提交 `bbb17414` 为对齐基准。

## 2. Context：两侧事实对照

两边打同一个 H3 专营站（`minimax_h3`、multi-reference、2–9 张图、4–15s、同一张 768p 尺寸表），**底层参数已天然一致**；要搬的是 FrameFlow 的**合同纪律**。

| # | 维度 | FrameFlow（标准） | VideosBatch（现状） | 差距 |
| --- | --- | --- | --- | --- |
| G1 | 错误合同 | `ProviderApiError(message, status, code, retryable, billingResult, responseMetadata?)`（`src/lib/providers/contracts.ts:371`），计费结论 `NOT_CHARGED/CHARGED/UNKNOWN` 是一等字段 | `NewApiH3ProviderError` 有 `code/retryable/status/taskId`，**无 `billingResult`/`responseMetadata`**；另有约 15 处校验与抓图失败抛裸 `Error` | 错误形状不统一，付费失败无法自证是否扣费 |
| G2 | 垫图抓取纪律 | 单次抓取 `AbortSignal.timeout(30_000)` 与调用方信号合并；`REFERENCE_FETCH_CONCURRENCY = 2`；`cache: 'no-store'`；`readBoundedResponseBytes` 按**实际解码字节**计数（先查 content-length，每个错误分支都取消 body）；URL 必须 https 且禁止内嵌凭据 | 串行抓取，只有整作业 45 分钟计时器（单图挂死会吃掉整个镜头预算）；`response.arrayBuffer()` **无界**读完再判 20MB；本地 `/media/` 读取同样无界 | 抓图既可被拖死，也可被大响应打爆内存 |
| G3 | 参考图快照 | `storageKey / mimeType / byteSize / sha256`（内容寻址，`src/lib/generations/video/execution-payload.ts:16`） | `VideosBatchReferenceBinding` 只有 `imageUrlHash`（URL 寻址，`src/shared/videosBatchNativeProjection.ts:14`） | URL 不变而内容变时无法发现 |
| G4 | 提示词骨架治理 | 版本化不可变资产：`v1.0.0` / `v1.1.0` + 每资产 sha256 钉（`src/lib/video-creation-prompts/registry.ts:59`，`as const satisfies`），历史版本仍可读 | `loadPromptTemplate(name)` 只做注册表↔目录一致性，**无版本、无哈希钉** | 骨架被误改会静默改变模型输入 |
| G5 | 血缘证据 | `ProviderExecutionEvidence`：`executionPayloadSha256 / referenceOrdinals / referenceRoles / referenceSha256` | 已有 `videosBatchPackageContentHash / videosBatchPromptHash / videosBatchPromptCompilerVersion` | 已达标，本轮不动 |

## 3. Decision

在**不改 9 步流程、不改提示词正文、不改 H3 提交参数**的前提下，把 FrameFlow 的四条合同纪律移植进 VideosBatch：

1. **单一结构化错误合同**：新增 `src/server/videosBatchWorkflow/h3ProviderErrors.ts` 承载 `NewApiH3ProviderError`（补 `billingResult`，可选 `responseMetadata`）与 `NewApiH3SubmissionStateUnknownError`；`newApiH3Video.ts` 内所有校验/抓图/配置失败一律改为该形状，不再有裸 `Error` 流出付费路径。原导入点通过再导出保持兼容。
2. **抓图纪律收敛**：新增 `src/server/videosBatchWorkflow/h3ReferenceMedia.ts`（镜像 FrameFlow 的 `reference-media.ts` 职责）导出 `imageFile`；新增 `src/server/videosBatchWorkflow/boundedResponse.ts` 提供 `readBoundedResponseBytes` / `ResponseBodyLimitError`。纪律：单次抓取 30s 超时（与作业信号 `AbortSignal.any` 合并）、并发 2、`cache: 'no-store'`、有界读取、https-only 且拒绝内嵌凭据、mime 白名单。
3. **绑定快照内容寻址**：`VideosBatchReferenceBinding` 增加可选 `bytesSha256 / byteSize / mimeType`，由实际字节计算；重试一致性比较**以 `bytesSha256` 优先**，缺失时回退 `imageUrlHash`。`shotExecutionPackage` 校验与 `store` 序列化同步。
4. **提示词骨架版本化 + 哈希钉**：`promptTemplates.ts` 补 `PROMPT_TEMPLATE_VERSIONS` 与 `PROMPT_TEMPLATE_HASHES`（当前版本统一 `v1.0.0`），加载时校验漂移即抛错；`smoke:videosbatch-prompt-templates` 覆盖。

**P3（结构化提示词文档 `promptDocument`）本轮不授权**：它改变提示词的表示与投影契约，属架构级变更，留待单独 ADR 与用户裁定。

## 4. Requirement Traceability

| ID | 来源 | 期望结果 | 阶段 | 验证谓词 |
| --- | --- | --- | --- | --- |
| FR-0001-001 | S1（产物规格） | 任何付费提交失败都能区分「是否已扣费」，据此决定能否自动重试 | P0 | 抓图/校验失败 → `billingResult === 'NOT_CHARGED'`；提交被拒且 5xx → 可重试且不宣称未扣费 |
| FR-0001-002 | S1（垫图逻辑） | 单张参考图挂死不再吃掉整个镜头的生成预算 | P0 | 抓图超时上限 30s 常量存在且被 `AbortSignal` 合并；超时抛结构化错误而非挂到作业超时 |
| FR-0001-003 | S1（垫图逻辑） | 同一 URL 内容已变时必须拦截，不静默用新图生成 | P1 | 快照含 `bytesSha256`；内容变化时提交前失败 |
| FR-0001-004 | S1（提示词要求） | 提示词骨架被误改立刻可见 | P2 | 骨架字节与钉住的 sha256 不一致时加载/校验失败 |
| TR-0001-001 | S2（对齐 FrameFlow） | provider 路径失败收敛为单一结构化形状 | P0 | `newApiH3Video.ts` 付费路径无裸 `Error` 抛出；错误含 `status/code/retryable/billingResult` |
| TR-0001-002 | S2 | 参考图字节读取有界，按实际解码字节计数 | P0 | 超过上限的响应在读完前失败；每个错误分支取消 body |
| TR-0001-003 | S2 | 参考图 URL 只接受 https 且无内嵌凭据 | P0 | `http:` 或 `https://user:pass@` 被拒绝 |
| TR-0001-004 | S2 | 抓图并发 2、单次 30s、`no-store` | P0 | 常量被导出且被消费；请求携带 `cache: 'no-store'` |
| TR-0001-005 | S1（产物规格） | 绑定快照可内容寻址 | P1 | `imageUrlHash` 与 `bytesSha256` 同时存在；重试比较优先 `bytesSha256` |
| TR-0001-006 | S1（提示词要求） | 骨架注册表带版本与哈希钉 | P2 | 版本与哈希表对全部 8 个模板齐全；导出的哈希等于磁盘实际字节哈希 |

## 5. Phase Plan

| 阶段 | 范围 | 依赖 | 文件边界 | 验收门 |
| --- | --- | --- | --- | --- |
| P0 结构化错误 + 抓图纪律 | 新建 `h3ProviderErrors.ts`、`h3ReferenceMedia.ts`、`boundedResponse.ts`；改造 `newApiH3Video.ts` | 无 | 上述 4 文件 + `scripts/smoke-videosbatch-newapi-h3.ts` + canonical spec 对应小节 | `smoke:videosbatch-newapi-h3`、`smoke:videosbatch-native-media-stages`、`tsc --noEmit`、`verify:offline` |
| P1 快照内容寻址 | 扩展 `VideosBatchReferenceBinding` 与写入/校验/序列化链路 | P0 | `src/shared/videosBatchNativeProjection.ts`、`newApiH3Video.ts`、`shotExecutionPackage.ts`、`nativeProjection.ts`、`store.ts`、相关 smoke、canonical spec | `smoke:videosbatch-shot-execution-package`、`smoke:videosbatch-native-projection`、`smoke:videosbatch-native-media-stages`、`verify:offline` |
| P2 骨架版本化 + 哈希钉 | 注册表补版本与哈希，加载校验漂移 | P0 | `src/server/prompts/promptTemplates.ts`、`scripts/smoke-videosbatch-prompt-templates.ts`、canonical spec §7 | `smoke:videosbatch-prompt-templates`、`smoke:videosbatch-llm-text-stages`、`smoke:videosbatch-frameflow-canonical`、`verify:offline` |
| P3 结构化提示词文档 | 提示词表示与投影契约 | — | `docs/adr/0002-videosbatch-structured-prompt-document.md` | **已出 ADR（0002）并给出分阶段；决策待产品确认，尚未实现** |

## 6. Boundaries / Non-goals

- 不改 9 步流程、阶段 id、UI、`.env` 变量名与语义、H3 提交参数（`model/workflow_id/size/prompt_enhance`）。
- 不改提示词正文（骨架内容逐字节不变；P2 只加版本与哈希，不重写文案）。
- 不改 FrameFlow 任何文件。
- 不运行付费路径，不做真实 Provider 提交（本轮全部离线）。
- 不新增数据库、不改凭据来源。

## 7. Compatibility

- `NewApiH3ProviderError` / `NewApiH3SubmissionStateUnknownError` 由 `newApiH3Video.ts` 继续再导出，既有导入点零改动。
- 新增错误字段与快照字段**均为可选**，历史 `Shot`/`ShotRender` 快照不带新字段仍可读、可轮询；缺失时回退 `imageUrlHash` 比较。
- 模板哈希钉会使命中漂移的加载直接失败（fail-fast），这是有意为之；改骨架必须同时升级版本与哈希。

## 8. Verification

每阶段：`tsc --noEmit` → 定向 smoke → 阶段末 `npm run verify:offline`（跑前必须腾空 5173）。全部阶段完成后核对本文件证据表与 canonical spec 是否一致。

## 9. Phase Log

| 阶段 | 状态 | 提交 | 证据 |
| --- | --- | --- | --- |
| 回退 FrameFlow | DONE | —（FrameFlow 不在本仓库） | 全库检索零残留 |
| P0 | DONE | `27edd90` | `tsc --noEmit` 通过；`smoke:videosbatch-newapi-h3` / `native-media-stages` / `native-media-resilience` / `shot-execution-package` / `specs` / `doc-consistency` / `secrets` 全绿 |
| P1 | DONE | `6655455` | `tsc --noEmit` 通过；`smoke:videosbatch-newapi-h3` / `shot-execution-package` / `native-projection` / `native-media-stages` 全绿 |
| P2 | DONE | `e8bf2de` | `tsc --noEmit` 通过；`smoke:videosbatch-prompt-templates` / `text-stage-specs` / `frameflow-canonical` / `llm-text-stages` 全绿 |
| P0-R / P2-R / P4 | DONE | `a7f6d49` | 复审 D1/D2/D5 修复（见 §11 执行记录）；`tsc --noEmit` 通过；`smoke:videosbatch-newapi-h3` / `prompt-templates` / `doc-consistency` / `specs` 全绿；`npm run verify:offline` RC=0 |
| 第二轮复审 | DONE | `da17298` | 扩大审查面后修 D7/D8、记录 D9（见 §12）；`tsc --noEmit` 通过；`smoke:videosbatch-native-media-resilience` / `newapi-h3` / `native-projection` / `store-save` / `secrets` 等全绿；`npm run verify:offline` RC=0 |
| D3 内联参考图 | DONE | `3a5441b` | 参考图来源扩展为 HTTPS / `/media/` / 内联 `data:` 三选一（见 §13）；spec 升 1.4.7；`smoke:videosbatch-newapi-h3` + 6 个相邻 smoke 全绿 |
| D9 执行快照完整性层 | DONE | `5ca2235` | 严格规范化 JSON + 载荷哈希自校验 + 适配器能力矩阵闸（见 §13）；spec 升 1.4.8；`tsc --noEmit` 通过；`npm run verify:offline` RC=0（4m08s） |
| 全量门禁 | 见下 | — | `npm run verify:offline`（跑前已腾空 5173） |

**证据口径说明（有意偏离）**：P0–P2 各自用 `tsc --noEmit` + 该阶段的定向 smoke 收口，全量 `verify:offline` 在三个阶段代码齐备后跑一次。理由：同一轮内三阶段改动文件基本不相交（仅 `newApiH3Video.ts` 被 P0/P1 先后触碰），一次全量门禁即覆盖三者的合计影响面，避免三次构建与约 90 个 smoke 的重复成本。若全量门禁出现失败，按失败项归属到对应阶段修复。

### 分支记录（偏离默认串行 main 约定）

本仓库当前规范工作树停在本地分支 `feature/videosbatch-audio-readiness-gate`（无上游，领先 `master` 28 个提交），仓库内既无 `main` 也无 `docs/adr` 先例；本 ADR 之前的四次提交（`2ae3e47`、`cc18dfc`、`bddb79e`、`ce75991`）同样落在该分支上。

- **决定**：P0–P2 继续在该分支上串行提交，不新建阶段分支或工作树，也不切到 `master`——切换会丢掉 28 个提交的在途上下文，且在共用仓库上单方面换分支风险高于收益。
- **边界**：本地提交＝本地交付。推送到远端或并入 `master` 需要用户单独授权，不在本 ADR 范围内。阶段提交保持精确文件范围，不用 `git add -A`。
- **后续**：如需并入 `master`，按仓库既有的分支流程另开一次显式操作。

## 10. Open Questions

- ~~FrameFlow 的 `referenceId` 查重合同（`REFERENCE_ID_DUPLICATE`）是否需要同步进 VideosBatch 的绑定校验？~~ **已结**：VideosBatch 已在 `shotExecutionPackage.ts` 校验包内 `references` 的 `referenceId` 与 `assetId` 去重（"references contains duplicate referenceId"），并在构建期校验绑定与 `FINAL_STORYBOARD.references` 的 `referenceId`/`assetKey`/`semanticLabel` 一致，覆盖率不低于 FrameFlow 的对应合同。**无需新增工作**，故不纳入 P1 范围。
- P3（结构化提示词文档 `promptDocument`）**已授权并已出 ADR**：[`0002-videosbatch-structured-prompt-document.md`](./0002-videosbatch-structured-prompt-document.md)。结论是这项**不是照搬**——VideosBatch 的提示词正文按 §7.7 只带语义标签、不带可标记的引用锚点，机械构造只会得到单 text 节点的退化解。ADR-0002 给出方案对比与 P3-1～P3-4 分阶段，并列出三个**待产品确认**的前提问题；答案到位前维持扁平字符串（方案 D，有意为之）。
- ~~见 §11：复审发现三条未修的偏差（D1 待授权修复、D2 待授权修复、D3 待裁定）。~~ **已全部结项**：D1/D2/D5 修复于 `a7f6d49`，D3 修复于 `3a5441b`（见 §13）。
- ~~**待裁定**：D3——参考图是否需支持内联 `data:image/...;base64,`。~~ **已结**（`3a5441b`）：用户授权后按「三来源等价」实施，内联载荷复用同一套 MIME/20MB/空内容校验与内容寻址，且原始载荷一律不落库。
- ~~**待授权**：D9——生成执行快照的「规范化 JSON + 载荷哈希 + 适配器版本闸」自校验层。~~ **已结**（`5ca2235`）：见 §13。

## 11. 复审发现（2026-09-15 深度审查）

Phase Log 标 DONE 后，按要求做了一次不依赖本文档、直接对照两侧源码的复审。方法：读 FrameFlow（`bbb17414`）的 `providers/contracts.ts`、`http/bounded-response.ts`、`providers/newapi-h3-dedicated/{reference-media,response,request,adapter}.ts`、`generations/video/{execution-payload,reference-plan}.ts`、`video-creation-prompts/{registry,loader}.ts`，逐行对照本仓对应实现。

**结论：P0/P1/P2 的实现与门禁证据全部复核通过，但有 3 条偏差是本轮未覆盖的，其中 D1 方向危险。**

### 复核通过项（无可执行动作）

| 项 | 证据 |
| --- | --- |
| `boundedResponse.ts` 与 FrameFlow **逐行等价**（content-length 预检、按解码字节计数、每个错误分支 cancel body、abort 监听与 `releaseLock`） | 两文件 71 行全文比对，仅引号风格不同 |
| 抓图纪律五条全部落地：30s 单次超时（`AbortSignal.any` 合并作业信号）、并发 2、`no-store`、HTTPS-only 且拒内嵌凭据、mime 白名单 | `h3ReferenceMedia.ts`；FrameFlow 的 `REFERENCE_FETCH_TIMEOUT_MS` 实为模块私有常量，本仓导出更利于验证 |
| 内容寻址贯通 binding → package → 重投影，且抓取失败不擦掉既有好指纹 | `nativeProjection.ts:917-920` 显式保留三字段；`newApiH3Video.ts:213-222` `contentAddressFor` 回退 |
| ADR 硬断言「付费路径无裸 `Error`」 | `newApiH3Video.ts` 23 处 throw 全为 `unchargedError` / `NewApiH3ProviderError` / `NewApiH3SubmissionStateUnknownError`，无一处 `throw new Error` |
| `referenceId` 去重断言 | `shotExecutionPackage.ts:644-645` |
| non-goal「不改 `.env` 变量名与语义」未被破坏 | `VIDEOSBATCH_H3_ALLOW_HTTP` 由 `ca6be03`/`d2f61ed`（2026-09-01）引入，非本轮新增 |
| 20MB 上限数值与 FrameFlow 一致 | 两边均 `20 * 1024 * 1024` |
| 计费分层的其余各格 | 提交 4xx→`NOT_CHARGED`、5xx→`UNKNOWN`+可重试、POST 网络中断→提交状态未知且不重试、存 taskId 失败→带 taskId 的未知、轮询超时/失败→`UNKNOWN`+可重试+taskId、空视频→`UNKNOWN`、**成片已返回但写盘失败→`CHARGED` 且不重试**（与 FrameFlow `response.ts:306` 的 UNKNOWN→CHARGED 升格语义一致） |

### D1【高·方向危险】轮询阶段「任务失败」被判 `NOT_CHARGED`，比标准源乐观一格

- **本仓**：`newApiH3Video.ts:446-451` —— 轮询 `/videos/{id}/content` 返回 400/409 且消息非「处理中」时，抛 `H3_TASK_FAILED`，`billingResult: "NOT_CHARGED"`。
- **FrameFlow**：`response.ts:247` `billingResult: explicitBillingResult ?? (status === 'completed' ? 'CHARGED' : 'UNKNOWN')`。它**从不**在任务受理后推断未计费；`NOT_CHARGED` 只出现在**提交阶段**的本地校验与 4xx（`request.ts:9,20`）。任务已被受理意味着大概率已计费，只可能是 `CHARGED` 或 `UNKNOWN`。
- **危害**：`NOT_CHARGED` 的语义是「可安全重试」。此处 `taskId` 已存在、任务已被上游受理，判成未计费会诱导重提 → 重复计费。当前由 `retryable: false` 兜住自动重试，但任何依据 `billingResult` 做对账、退费、告警的下游都会判错。
- **两个次级缺陷**：
  1. **不读 Provider 的权威结论**。FrameFlow 的 `response.ts:64-65` 把 `billing_result`/`billingResult` 纳入响应 schema，并在 `:235/:247` 以「Provider 显式值优先、本地推断兜底」取值。本仓完全没有读取该字段的能力，计费结论纯属本地推断。
  2. **成功路径不产生「已计费」证据**。FrameFlow 的 `billingResult` 贯穿到 `ProviderTask`，成片拿到时 UNKNOWN 升格为 `CHARGED`。本仓 `generateShotVideoViaNewApiH3` 成功只返回 `mediaUrl: string`，费用事实没有出口。
- **文档连带问题**：`specs/videosbatch-workflow-canonical.md` §8.5 正文（`2508`）已把这条错规则固化为「任务被 Provider 明确判失败为 `NOT_CHARGED` 且不重试」；而同文件 Acceptance Criteria（`2559`）只列了四类分层，**未包含这一格**——spec 正文与自身验收标准不一致，且这一格与标准源相反。§8.5 内部亦自相矛盾：同一条里「轮询失败/超时/空视频→`UNKNOWN`」与「任务失败→`NOT_CHARGED`」出自同一个轮询循环、同一份响应证据。
- **建议修复（P0-R，待授权）**：轮询阶段任务失败改判 `UNKNOWN`（保留不重试）；`H3ResponseMetadata` 增加读取 Provider 显式 `billing_result` 并以之覆盖推断；成功路径把「已计费」结论回传给调用方。同步修 spec §8.5 正文 + 验收标准 + `smoke:videosbatch-newapi-h3`。

### D2【中·只做了一半】P2 的「版本化」缺少可回读维度，未达 G4 声明的标准

- **FrameFlow**：`registry.ts:46-57` `..._FILES_BY_VERSION` 与 `:73-84` `..._HASHES_BY_VERSION` 是**按版本索引**的两张表；历史资产（`final-storyboard/v1.0.0` 与 `v1.1.0` 并存）**留在磁盘**；`loader.ts:71-99` `loadVideoCreationPromptAsset(id, version)` 接受版本参数。`registry.ts:1-5` 注释明说其目的是让调用方「load the historical assets to read or recover old runs without silently substituting new instructions」。
- **本仓**：`promptTemplates.ts` 的 `PROMPT_TEMPLATE_VERSIONS` 是**一张平表**，版本值只被 `assertPromptTemplateIntegrity` 的错误消息引用；`loadPromptTemplate(name)` **没有版本参数**，磁盘上每个模板只有一份 `name.md`。改骨架只能就地覆盖，旧版本字节永久丢失，历史 run 无法按当时的骨架复现。
- **ADR 自身不一致**：§2 的 G4 标准列了「版本化不可变资产 / 每资产 sha256 钉 / **历史版本仍可读**」三条，§3 Decision 第 4 条只要求「补版本与哈希、加载校验漂移」，**悄悄缩掉了第三条且未给理由**。
- **建议修复（P2-R，待授权）**：补 `..._FILES_BY_VERSION` / `..._HASHES_BY_VERSION` 与 `loadPromptTemplate(name, version = current)`，当前 8 个模板全部落在 `v1.0.0`，先只建机制不改内容——回读能力立即可用，此后改骨架时旧版自然留存。

### D3【中·能力不对齐】不支持内联 `data:image/...;base64,` 参考图

- **FrameFlow**：`reference-media.ts:5,13-25,104-107` 的 `imageFile` 第一步就试 `inlineImageFile()`，命中 data URL 直接 `Buffer.from(base64)` 成 `File`，**不发网络请求**；另有 `MAX_GENERATION_REFERENCE_DATA_URL_CHARS` 上限常量（`reference-limits.ts:3-4`）与 `reference-bounds.test.ts` 覆盖。
- **本仓**：`newApiH3Video.ts:66-72` 的 `referenceCandidates` 在候选过滤阶段只保留 `https://` 与 `/media/`，data URL 被**静默丢弃**；若某资产只有 data URL，最终以 `H3_REFERENCE_PLAN_INVALID`（「没有可用的 HTTPS 或本地图片 URL」）失败。
- **判定：非缺陷，是两种自洽策略**。本仓用「上游落盘」替代「inline 直传」——`generators.ts:1682-1688` 的 `cacheGeneratedImage` 会把 data URL 解 base64 写成 `/media/...`。**但要注意它的三个原样返回分支**（`:1678` 非匹配 scheme、`:1684` 正则不匹配的 data URL、`:1691` 非 http 值），这些值一旦进入绑定就是死路。
- **建议**：列为待裁定项。若产品会出现 inline 参考图（例如前端直接粘贴 base64），按 FrameFlow 补 `inlineImageFile` 分支，成本约 20 行；若确认参考图只来自落盘资产，则维持现状并在 spec 里写明「只接受 HTTPS 与 `/media/`」以固化意图。

### D4/D5/D6【低】治理型观察，不构成对齐偏差

- **D4**：20MB 上限在 FrameFlow 是跨上传/存储/抓取**共用**的 `MAX_GENERATION_REFERENCE_BYTES`（`generations/contracts/reference-limits.ts`，有单测钉值），本仓是 `h3ReferenceMedia.ts` 内的本地常量。数值一致，但口径变更要改多处才能同步。
- **D5**：`boundedResponse.ts` 建成后，成片下载路径 `newApiH3Video.ts:421` 仍是 `await contentResponse.arrayBuffer()` 无界读取。当时范围限定在参考图，不算偏差；但工具已在手，顺手收口成本极低。同类还有两处 FrameFlow 已做而本仓未做：**错误响应体**的有界读取——FrameFlow `transport.ts:7,23-42` 的 `boundedResponseText` 用 `MAX_ERROR_BODY_BYTES = 64 * 1024` 卡住错误体，本仓 `newApiH3Video.ts:225-232` 的 `responseMessage` 是裸 `await response.text()`；以及 FrameFlow 对 content 端点路径做了 `CONTENT_PATH_PATTERN` 白名单校验（本仓用 `encodeURIComponent(taskId)` 达成等效防护，无需改）。
- **D6**：本仓在抓图纪律上**强于**标准源三处——超时归因（区分 `TimeoutError`）、HTTP 非 2xx 带 `responseMetadata`、本地 `/media/` 的 path-traversal 守卫 + `stat` 预检大小。FrameFlow 均无。建议保持，并在 spec 里登记为有意增强，避免后续被误当偏差回退。

### 复审后的阶段追加建议（均待用户授权）

| 阶段 | 范围 | 依赖 | 验收门 |
| --- | --- | --- | --- |
| P0-R | D1：轮询阶段计费结论改 `UNKNOWN`；读取 Provider 显式 `billing_result`；成功路径回传计费结论；同步 spec §8.5 正文与验收标准、`smoke:videosbatch-newapi-h3` | 无 | 定向 smoke + `tsc --noEmit` + `verify:offline` |
| P2-R | D2：骨架按版本索引的 FILES/HASHES 表 + `loadPromptTemplate(name, version?)` | 无 | `smoke:videosbatch-prompt-templates` + `verify:offline` |
| P4 | D3：裁定后决定是否补 inline data URL 参考图；D4/D5 顺带收口 | 需先裁定 | 视裁定范围 |

**未授权前不动**：D1/D2 都是合同级变更（D1 改计费语义、D2 改加载签名），按 §7 Change Policy 必须先改 spec 再改代码；本 ADR 已按 §6 的边界要求停在「记录 + 建议」。

### 执行记录（P0-R / P2-R / P4 · 2026-09-15 · 提交 `a7f6d49`）

用户下达「优化」后按 §7 Change Policy 执行：先改 spec（`1.4.4 → 1.4.5`）再改代码，改完跑定向 smoke + 全量 `verify:offline`（RC=0）。

| 条目 | 修复 | 落点 |
| --- | --- | --- |
| D1 计费判错 | 轮询阶段 `H3_TASK_FAILED` 的 `billingResult` 由 `NOT_CHARGED` 改为 `evidence.declared ?? "UNKNOWN"`，`retryable` 仍为 `false` | `newApiH3Video.ts` 轮询分支 |
| D1 不读 Provider 结论 | 新增 `h3DeclaredBillingResult(payload)`（读裸体或 `data` 包装的 `billing_result`/`billingResult`，越界值忽略）；提交与轮询两处均以「Provider 显式值优先、本地推断兜底」取值 | `h3ProviderErrors.ts`、`newApiH3Video.ts` 提交/轮询分支 |
| D1 成功路径无证据 | 新增 `H3ChargedEvidence` 与 `onCharged` 回调；`generators → nativeMediaStages` 全链透传，落库到 `ShotRender.videosBatchBillingResult`；回调自身异常抛 `H3_BILLING_RECORD_FAILED`（`CHARGED`、不可重试、保留 taskId 与 mediaUrl） | `newApiH3Video.ts`、`generators.ts`、`nativeMediaStages.ts`、`videosBatchNativeProjection.ts` |
| D2 版本不可回读 | 新增 `PROMPT_TEMPLATE_VERSION_ORDER` 与 `PROMPT_TEMPLATE_HASHES_BY_VERSION`；`loadPromptTemplate(name, version?)` 支持按版本回读，当前版本读 `<name>.md`、历史版本读 `history/<name>/<version>.md`，未登记版本 fail-fast；导出 `promptTemplateRelativePath()` 供断言 | `promptTemplates.ts` |
| D4 20MB 上限 | 复核为**已满足**（单消费者、已导出、被 smoke 钉值），**无代码改动** | `h3ReferenceMedia.ts`（未改） |
| D5 错误体无界 | 新增 `readBoundedResponseText()`（`MAX_BOUNDED_RESPONSE_TEXT_BYTES = 64 KiB`，对齐 FrameFlow `MAX_ERROR_BODY_BYTES`）；`responseEvidence`/`responsePayload` 改用有界读取，超限按状态码降级、不当作可用载荷 | `boundedResponse.ts`、`newApiH3Video.ts` |

**执行中新发现并一并修掉的一个隐患**：`onCharged` 记录失败若以普通错误逃逸，会清掉尝试标记、诱导第二次付费提交——正是 D1 要消除的失败类。已按上表第三行兜住，并新增 `H3_BILLING_RECORD_FAILED` 码（spec §8.5 允许追加码清单已同步）。

**门禁证据**：`smoke:videosbatch-newapi-h3` 新增 `taskFailed` / `taskFailedDeclared` / `hugeError` 三种服务端模式与 `onCharged` 断言（成功报 `CHARGED`、轮询失败报 `UNKNOWN`、Provider 结论覆盖且仍不可重试、超大错误体降级、计费记录失败报 `H3_BILLING_RECORD_FAILED`）；`smoke:videosbatch-prompt-templates` 新增第 9 节（按版本回读、版本哈希表完整性、未知版本 fail-fast、历史路径解析）。`tsc --noEmit` 通过，`npm run verify:offline` RC=0。

**仍未做（有意留出）**：
- **D3**：内联 `data:image/...;base64,` 参考图——属产品策略选择（见 §10 待裁定），未授权前不动。
- **P3**（结构化提示词文档 `promptDocument`）：需单独 ADR。
- **推送远端 / 并入 `master`**：见 §9 分支记录，需用户单独授权。

## 12. 第二轮复审（2026-09-15，扩大审查面 · 提交 `da17298`）

第一轮只审了 H3 适配器、参考图与骨架版本三个面。第二轮按原始对齐清单把**尚未覆盖的面**逐块对照 FrameFlow `bbb17414`：执行快照（`generation-execution-snapshot.ts`、`generations/runtime/*`）、计费证据累积（`response-metadata.ts`）、幂等（`client-idempotency.ts`）、诊断脱敏（`safeProviderDiagnosticMessage`）。

### 复核通过项（无可执行动作）

| 项 | 证据 |
| --- | --- |
| **提交幂等设计成立** | `newApiH3Video.ts:386` 的 `Idempotency-Key` = `videosbatch-<shotId>-<sha256(shotId + generationStartedAt)[:24]>`，键在付费 POST **之前**持久化（`nativeMediaStages.ts:1307`），恢复同一任务复用原键（`taskId` 存在时不清 `generationStartedAt`），只有**显式重试**才清 `generationStartedAt` 从而换新键。同内容重复提交会在 Provider 侧去重。**不加改动** |
| 409 幂等冲突且未回原任务号 | 已由 `isUnknownSubmission` 的「幂等冲突且响应未返回原任务号」分支兜住，落到不可重试的未知态 |
| 成功路径的计费证据 | 第一轮 P0-R 已把 `H3ChargedEvidence` 落到 `ShotRender.videosBatchBillingResult`，本轮确认每份 render 各带自己的结论、历史 render 不被覆盖 |
| 失败分层与 `retryable` 解耦 | 计费结论只作记账；能否自动重试始终只由 `retryable` 决定 |

### D7【高·D1 的镜像】失败路径丢弃计费结论，D1 的判定到不了持久化

- **本仓**：`nativeMediaStages.ts` 的 `mediaError()` 只产出 `{code, message, retryable, attempt, provider, model?, taskId?}`，**没有 `billingResult`**；catch 块用 `patch.videosBatchError = info` 落库。于是适配器在错误对象上给出的 `billingResult`（第一轮 D1 的核心产出）在**持久化边界被丢掉**。
- **FrameFlow**：`failGeneration(id, error, lease, billingResult: Exclude<ProviderBillingResult,'UNKNOWN'>, …)` —— 计费结论是**必填参数**且由 `mergeProviderBillingResult(generation.providerBillingResult, …)` **单调累积**到 `generation.providerBillingResult`；`UNKNOWN` 甚至被类型排除在 `failGeneration` 之外，必须走 `requireGenerationReconciliation` 的对账态。
- **危害**：一次「可能已计费」的失败与一次「证明未计费」的失败在持久化状态里**完全同形**。D1 修好的结论只活在瞬时异常里——这与 D1 本身是同一类错误，只是发生在下一层。
- **建议修复（已执行）**：`VideosBatchMediaError` 与 `Shot.videosBatchError` 增加 `billingResult`；`mediaError` 从错误对象读取并落库；落库前按 `CHARGED > NOT_CHARGED > UNKNOWN` **单调合并**（等价 `mergeProviderBillingResult`），已判 `CHARGED` 不被后续 `UNKNOWN` 抹掉。

### D8【中·凭据卫生】Provider 诊断文本未脱敏 URL 与内联 data URL

- **FrameFlow**：`safeProviderDiagnosticMessage` 依次剥掉 `Bearer`、`api_key|token|secret|password`、内联 `data:image/...;base64,…`、**全部 `http(s)://` URL**，再折叠空白并截断 500。
- **本仓**：`nativeMediaStages.ts`、`api.ts`、`llmExecutor.ts` **三处各自**内联了同一对正则，且**只**处理 `Bearer` 与 `api_key|token|secret`——**不处理 URL，也不处理内联 data URL**。
- **危害**：参考图是**签名 URL**，H3 的错误体常回显请求内容；`mediaError.message` 会进入 `Shot.error` 与 `videosBatchError.message` 长期存储。spec §7.7 已明文要求「请求日志…不记录签名 URL」，而错误消息这条通道没有同等约束——**同一份 spec 内部不自洽**，且三份实现会各自漂移。
- **建议修复（已执行）**：抽出 `providerDiagnostics.ts` 的 `sanitizeProviderDiagnosticText()`（令牌 / 密钥 / 内联 data URL / URL，幂等），三处调用点统一改用它。

### D9【中·能力缺口，未授权，仅记录】生成执行快照 schema

- **FrameFlow**：`generation-execution-snapshot.ts` 用 zod 定义 `generationExecutionPayloadSchema`（`schemaVersion` / `publicModelId` / `runtimeModelId` / `creationMode` / `compiledPrompt` / `duration` / `aspectRatio` / `references[]`（`ordinal`+`role`+`storageKey`+`mimeType`+`byteSize`+`sha256`）/ 续写来源证据 / `segmentPlan`），配 `canonicalExecutionJson()`（键排序、禁 `undefined`）与 `executionPayloadSha256()`；`parseGenerationExecutionSnapshot()` 在读取时**重算哈希并逐字段校验**，再断言 `adapterKey:adapterVersion` 仍在能力矩阵内。
- **本仓**：`shotExecutionPackage.ts` 有 schema 版本、有引用内容寻址（`bytesSha256`/`byteSize`/`mimeType`），但**没有**「规范化 JSON → 载荷哈希」这一自校验层，也没有 `adapterKey`/`adapterVersion` 版本闸。
- **判定**：这是**规模较大的能力缺口**（涉及新契约 + 迁移 + 全链读写），不是一行修复。按 §6 边界**本轮只记录不动**，需要时另开阶段（建议命名 P5）并单独授权。

### 结论

第二轮确认 D7/D8 两条**真偏差**（均已按 §7 Change Policy 先改 spec 再改代码修掉），D9 一条能力缺口记录待授权，幂等一项复核通过、**刻意不加改动**——避免为「对齐」制造无意义的 diff。

## 13. 第三轮执行（2026-09-16 · D3 + D9 落地 · 用户全量授权）

用户对 ADR-0001 三条未结项（D3、D9、P3）与推送一并授权。D3、D9 已实现并合入；P3 转为独立 ADR（见 0002），**未实现**。

### D3 参考图来源扩展（提交 `3a5441b`，spec 升 1.4.7）

- **原状**：`newApiH3Video.ts` 的 `referenceCandidates()` 只放行 `^https://` 与 `/media/`，内联 `data:image/...;base64,...` 被**静默过滤**——FrameFlow 的资产库明确支持内联预览图（`store/use-app-store.ts` 的正则白名单），本仓不支持。
- **修复**：`h3ReferenceMedia.ts` 新增 `inlineDataUrlFile()`，以锚定正则校验 MIME 白名单与 base64 形状，**按 base64 长度预判 20MB 上限**（在分配解码缓冲之前就拒绝），复用同一 `referenceBytes()` 得到 `byteSize`/`bytesSha256`/`mimeType`，与 URL 来源内容寻址口径完全一致。
- **不落库**：`resolveReferenceFiles` 对内联来源改用 `inline:sha256:<bytesSha256>` 作为提交地址——既避免在内存中保留并哈希 20MB 级 data URL，也确保审计快照与请求日志只出现哈希（与 §7.7 签名 URL 纪律同源）。
- **证据**：`smoke:videosbatch-newapi-h3` 增内联解码字节口径、四种非法载荷（非图片 MIME／空载荷／缺 base64 头／超限）均判未计费、内联候选经过滤存活；6 个相邻 smoke 全绿。

### D9 付费执行快照完整性层（提交 `5ca2235`，spec 升 1.4.8）

- **原状**：本仓 `shotExecutionPackage.ts` 已有 `contentHash` 自校验（重算并比对），但 (a) 其规范化走 `canonicalStoryboard.stableJson`／`JSON.stringify`，**会静默丢弃 `undefined`、把 `NaN` 降级为 `null`**——哈希无法证明覆盖了每个字段；(b) 完全没有适配器版本闸。
- **修复**：新增 `executionSnapshotIntegrity.ts`，逐条对齐 FrameFlow：严格规范化 JSON（键递归排序、数组保序、遇 `undefined`／非有限数字／非 JSON 值**硬失败**）、`executionPayloadSha256()`、`parseVideosBatchExecutionSnapshot()`（重算哈希 + 要求再规范化后与持久化字节**逐字相等** + 适配器版本闸）、`VIDEOSBATCH_ADAPTER_CAPABILITY_MATRIX` 与 `(adapterKey, adapterVersion, runtimeModelId, creationMode, 参考图数量)` 能力判定。
- **接线**：付费 POST 前把「即将提交的内容」规范化并算哈希，经 `onExecutionSnapshotPrepared` 落库到 `Shot.videosBatchExecutionSnapshot`；恢复任务时先校验，**适配器版本已下架或载荷被改动一律拒绝**，不对本构建无法解释的任务继续轮询。适配器闸在**取参考图之前**执行。
- **并存而非替换**：`stableJson` 继续服务血缘内容哈希（改动它会重写全部已钉历史哈希），新模块只约束付费快照——ADR 与 spec §7.12 都写明了这条边界。
- **证据**：`smoke:videosbatch-newapi-h3` 增 11 项断言（键序/数组保序、`undefined` 与 `NaN` 硬失败、快照往返、篡改哈希拒绝、非规范形式拒绝且即便哈希匹配、下架适配器拒绝恢复、能力矩阵边界、真实提交路径「快照在绑定之后、POST 之前产生」、快照覆盖精确提示词与有序引用）；6 个相邻 smoke 全绿；`npm run verify:offline` RC=0（4m08s）。

### P3（未实现，转 ADR-0002）

调研结论：FrameFlow 的 `VideoPromptDocument` 依赖正文里**可标记的引用锚点**（其教学原型用 `【P###-A###】`）。本仓 §7.7 明文禁止稳定 ID 进入 H3 prompt、正文只用语义标签，因此机械构造只会得到单 text 节点的**退化解**（零信息增益）。故 P3 **不是照搬**，已出 [`0002`](./0002-videosbatch-structured-prompt-document.md) 记录方案对比、分阶段与三个待产品确认的前提问题；答案到位前维持扁平字符串。

## 14. 第四轮：主动 bug 扫查（2026-09-16）

方法：**不再重读既有结论，改用真实浏览器跑一遍 9 步流程**（仓库内 `playwright-core` + 本机 chromium，headless）交叉验证代码。扫描面覆盖：新建会话从 `LESSON_INPUT` 跑到 `STITCH`、全部 12 个已存在会话的每个步骤、非画布路由（`/`、`/gallery`、`/canvas`）、头部 ⋯ 菜单、流程制作／制作画布切换、上一步、语言切换、`restart-from` 与 `retry`。

### F1【高·功能死锁】`stale` 被当成阻断条件：回退过任何一步，流程再也跑不完

- **现象**：对任一上游阶段执行 `restart-from`（UI 上是「重新生成本步骤」，也等价于编辑上游产物／撤销确认）后，下游被正确标记 `stale`，但 `run-all` **永久停在原地**。实测：`restart-from SCREENPLAY` 后连打 4 次 `run-all` 均返回 200 且 `currentStage` 不变，`FINAL_STORYBOARD` 始终 `stale`、`completed` 永远为 `false`。
- **无解**：`retry` 只对 `failed` 生效（返回 409 `STAGE_NOT_FAILED`）；连在卡住的那一步再点一次「重新生成本步骤」也无效——`restart-from` 会把该步置 `pending`，但 lineage 不匹配的判定不受 `requiresLineage` 门控，仍判 `stale`。**该状态无任何 API 或 UI 出口**。
- **根因**：`runner.ts` 的 `dependencyIssues()` 把两类性质完全不同的问题合并成一个阻断清单：依赖未就绪（真的不能跑）与**本步产物的来源版本过期**（恰恰是「需要重跑」的定义）。`restart-from` 为保留可检视的历史产物而**不删除下游 artifact**，于是下游记录的 `sourceHashes`/`sourceRevisions` 永远落后于刚重跑的上游，`runNext` 每次都用不匹配把自己重新判成 `stale` 并 `return`，游标不动。
- **修复**（spec 升 **1.4.9**）：从 `dependencyIssues()` 移除两处 **mismatch** 判定，只保留真正的阻断项——依赖未 `ready`、依赖 `contentHash` 与产物不自洽、以及**本步 lineage 完全缺失**（伪造/遗留的 `ready` 态不得被静默接受，这条仍阻断并保留原有用例守它）。于是 lineage 过期不再是阻断条件，`runNext` 正常执行并以 `dependencySnapshot` 落**全新血缘**；`stale` 回到「重跑信号」的语义，与 spec §0.2「保留旧成果只作历史读取，不得静默复用」一致。
- **真实复验**：同一个此前彻底死锁的会话，修复后 `restart-from SCREENPLAY` → `run-all` 直接 `completed=true`，下游 7 个阶段全部 `ready`，且 `FINAL_STORYBOARD.sourceRevisions.SCREENPLAY` 等于 SCREENPLAY 当前 `revision`。
- **证据**：`smoke:videosbatch-runner` 增两组回归断言（回退后 `run-all` 必须能重跑到完成 + 新血缘一致；对已 stale 的阶段再次 `restart-from` 必须能恢复）——原用例**只断言了下游被标 `stale`，从未断言过之后能否恢复**，这正是缺口。相邻 7 个 smoke（`native-media-resilience`／`llm-text-stages`／`e2e`／`api`／`native-media-stages`／`api-retry`／`newapi-h3`）全绿。

### F2【低】缺 favicon：每次加载都报 404

- `index.html` 未声明图标，浏览器默认请求 `/favicon.ico` → 每次页面加载都在 console 留一条 404。仓库已有 `public/seereel-mark.png` 可直接用。
- 修复：`index.html` 增 `<link rel="icon" type="image/png" href="/seereel-mark.png" />`。复验：整页加载 console 错误数 **0**。

### G1【能力缺口·未修·需产品裁定】VideosBatch 工作台整块未接入 i18n

- 头部 ⋯ 菜单提供「Switch to English」，切换后 `document.documentElement.lang` 与 `localStorage["uiLanguage:v2"]` 都正确变化，**同一会话的「制作画布」也确实变成英文**（`图片→Image`、`未生成→Not generated`），但**「流程制作」9 步工作台一个字符串都不变**。
- 事实：`src/client/i18n.tsx` 的词典只覆盖 SeeReel 的 `app`/`flow`/`nodes`/`inspector` 等；`src/client/videosBatchStudio/` **零 `useI18n` 引用**，21 个文件共 1759 个中文字符。即工作台从未本地化，不是接线漏了。
- **未动**：整块本地化是产品级范围决策（要么给全部文案建词典条目，要么把该开关在工作台模式下收窄/隐藏），成本差异极大，留待裁定。

### 本轮复核通过、刻意未改

`/api/sessions/:id/videosbatch` 对未启动工作流的会话返回 409 `WORKFLOW_NOT_STARTED`——**设计内**，客户端有空态兜底。`projectId` 由服务端校验为 `^P\d{3,}-A\d{3,}$`，UI 固定发 `P001`——单项目产品下 `publicAssetId` 全局唯一，非缺陷。历史会话里 3 处 `failed` 步骤（LLM 超时、`omissionCheck` 校验、`COPYABLE_PROMPT PARTIAL`）均来自 2026-09-01 的真实模式运行，非当前代码的活缺陷。
