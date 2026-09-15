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
| P3 结构化提示词文档 | 提示词表示与投影契约 | — | — | **未授权**，需单独 ADR |

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
| 全量门禁 | 见下 | — | `npm run verify:offline`（跑前已腾空 5173） |

**证据口径说明（有意偏离）**：P0–P2 各自用 `tsc --noEmit` + 该阶段的定向 smoke 收口，全量 `verify:offline` 在三个阶段代码齐备后跑一次。理由：同一轮内三阶段改动文件基本不相交（仅 `newApiH3Video.ts` 被 P0/P1 先后触碰），一次全量门禁即覆盖三者的合计影响面，避免三次构建与约 90 个 smoke 的重复成本。若全量门禁出现失败，按失败项归属到对应阶段修复。

### 分支记录（偏离默认串行 main 约定）

本仓库当前规范工作树停在本地分支 `feature/videosbatch-audio-readiness-gate`（无上游，领先 `master` 28 个提交），仓库内既无 `main` 也无 `docs/adr` 先例；本 ADR 之前的四次提交（`2ae3e47`、`cc18dfc`、`bddb79e`、`ce75991`）同样落在该分支上。

- **决定**：P0–P2 继续在该分支上串行提交，不新建阶段分支或工作树，也不切到 `master`——切换会丢掉 28 个提交的在途上下文，且在共用仓库上单方面换分支风险高于收益。
- **边界**：本地提交＝本地交付。推送到远端或并入 `master` 需要用户单独授权，不在本 ADR 范围内。阶段提交保持精确文件范围，不用 `git add -A`。
- **后续**：如需并入 `master`，按仓库既有的分支流程另开一次显式操作。

## 10. Open Questions

- ~~FrameFlow 的 `referenceId` 查重合同（`REFERENCE_ID_DUPLICATE`）是否需要同步进 VideosBatch 的绑定校验？~~ **已结**：VideosBatch 已在 `shotExecutionPackage.ts` 校验包内 `references` 的 `referenceId` 与 `assetId` 去重（"references contains duplicate referenceId"），并在构建期校验绑定与 `FINAL_STORYBOARD.references` 的 `referenceId`/`assetKey`/`semanticLabel` 一致，覆盖率不低于 FrameFlow 的对应合同。**无需新增工作**，故不纳入 P1 范围。
- P3（结构化提示词文档 `promptDocument`）仍未授权，需要单独 ADR。
- 见 §11：复审发现三条未修的偏差（D1 待授权修复、D2 待授权修复、D3 待裁定）。

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
