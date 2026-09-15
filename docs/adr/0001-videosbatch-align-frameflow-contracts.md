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
