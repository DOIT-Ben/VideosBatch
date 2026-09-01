# VideosBatch 运行事实

更新时间：2026-08-31
适用范围：本机 `E:\desktop\AI\05-Third-party-repos\VideosBatch` 的 Guided Studio 验收配置。

## 当前 Git 现场

- 分支：`feature/videosbatch-newapi-h3`
- HEAD：`134719527bfd63788b040530e8cdc4bd9ab4db67`
- 该工作区存在既有未提交改动；本记录不代表这些改动已经提交或推送。

## 本机配置事实

配置文件位于仓库根目录 `.env`，该文件已被 `.gitignore` 忽略，不应提交。

| 项目 | 当前值 | 说明 |
| --- | --- | --- |
| `VIDEOSBATCH_EXECUTOR_MODE` | `fake` | 本地 UI/Workflow 验收，不调用真实文本接口 |
| `VIDEOSBATCH_MEDIA_MODE` | `fake` | 本地 UI/Workflow 验收，不调用真实图片/视频接口 |
| 文本主模型 | `gpt-5.6-terra` | OpenAI Responses 兼容路由 |
| 最终分镜推理 | `medium` | 仅适用于最终分镜主模型 |
| 最终分镜输出 | `json_schema` | 每个阶段使用专用 Schema；不静默降级为 `json_object` |
| 最终分镜请求 | 两段 | `CHUNKED=1`、`CHUNK_COUNT=2`，按范围生成后合并校验 |
| 文本备用模型 | `deepseek-v4-flash` | 主模型有限重试耗尽后才切换 |
| 备用输出/推理 | `json_schema` / `none` | 避免 reasoning 混入结构化结果 |
| 文本重试 | `3` 次 | 等待 `2000,5000,10000 ms` |
| 图片路由 | `lyaiapp` | 当前因 `MEDIA_MODE=fake` 不会调用 |
| 视频路由 | `newapi-h3` | 当前因 `MEDIA_MODE=fake` 不会调用 |

真实 API Key、Token 和完整生产配置只保存在本机受保护环境中；本文不记录任何密钥值。

## 已验证事实

- DeepSeek 备用文本路由已通过最小结构化 JSON 请求。
- 120 秒最终分镜已通过两段请求、合并和完整服务端校验，得到 12 条分镜。
- `npm run build`、VideosBatch LLM executor/text stages/runtime provider Smoke 及 `npm run smoke:secrets` 曾通过。

## 2026-08-31 FrameFlow 手册适配

- 当前阶段规范唯一入口为 `specs/videosbatch-workflow-canonical.md`（`VIDEOSBATCH_WORKFLOW_CANONICAL`）。
- FrameFlow 手册副本已移入 `docs/archive/videosbatch-design/upstream/视频制作工作流完整步骤.md`，仅作为可追溯证据保存。
- 最终分镜模型只接收已确认资产的语义清单，输出 `【人物：...】`、`【场景：...】` 等标签；稳定公开编号仅在 `COPYABLE_PROMPT` 派生阶段由服务端映射。
- ASSET_PLAN 现在要求候选资产总清单、四类覆盖、遗漏二次核对、统一 3D 国漫风格和负面约束；最终分镜校验增加类型一致性、字段非空、音效长度、钩子/悬念和稳定编号禁用检查。

本文件只记录本机运行证据和历史验证结果，不定义阶段、提示词或产物合同。

## 2026-08-31 真实授权链路复验（手册适配后）

- 使用本机受保护中转配置，临时执行 `COURSE_INTRO_CANDIDATES -> STORY_SCRIPT -> ASSET_PLAN -> SCREENPLAY -> FINAL_STORYBOARD`；媒体模式保持 `fake`，未调用图片/视频生成。
- `gpt-5.6-terra` 在资产计划和最终分镜出现网络超时时，按现有有限重试策略切换 `deepseek-v4-flash`，修复请求继续携带上一版上下文和合同错误。
- 最终分镜两段请求合并通过：`storyType=KNOWLEDGE`、`targetDuration=120` 秒、`segmentCount=12`；结果摘要保存在本机临时验证目录，不写入仓库 `data/`。
- 真实输出验证了最终分镜使用语义资产标签，未输出 `Pxxx-Axxx` 稳定编号；稳定编号映射仍由 `COPYABLE_PROMPT`/执行投影负责。

以上三项为此前真实链路验证结果；上一轮文档更新时仅复核了当前分支、HEAD 和本机配置键值，未重新发起真实供应商请求。

## 2026-08-31 真实全链路复验

本轮在隔离目录 `E:\Codex-worksapce\codex\20260831-VideosBatch真实全链路-20260831` 执行，未写入仓库 `data/`。

- 文本阶段：课程导入、故事文稿、资产计划、资产候选、正式剧本均通过；主模型在最终分镜返回格式不符合合同，切换到 DeepSeek 后长上下文请求出现超时/连接挂起。
- 图片阶段：LyAIApp 实际生成并缓存 9 张图片，通过非占位 URL 校验。
- 视频阶段：NewAPI H3 实际生成并缓存 2 个 10 秒 MP4；第 3 个镜头重试时返回 `idempotency_key 与其他请求冲突`，剩余镜头未继续提交，以避免重复计费。
- 拼接阶段：使用这 2 个真实 MP4 独立执行归一化和 ffmpeg 拼接，生成约 20.3 秒的可读 MP4；这证明拼接实现可用，但不等于 12 镜头最终成片已完成。

因此，上一轮结论是**部分真实链路通过**：文本（除最终分镜长请求稳定性）、图片、部分视频和局部拼接已有证据；12 镜头视频批量与最终成片仍被 H3 长任务/幂等冲突阻塞。

## 2026-08-31 修复后真实复验

- 合同修复现在分为两层：主文本供应商最多 3 次（首请求 + 2 次精准修复）；每次修复都带上一版 JSON 与逐条校验错误。主供应商耗尽后通过 `providerRoute=fallback-only` 直达 `deepseek-v4-flash`，不会再次调用主供应商。
- H3 提交成功后先将 `taskId` 写回 native Shot；恢复执行优先轮询该 taskId，成功后将 taskId 与开始时间保留在 ShotRender 审计字段。无任务号的 409 幂等冲突会进入 `H3_SUBMISSION_STATE_UNKNOWN`，停止盲目重提。
- H3 参考图按 `sourceImageUrl -> referenceImageUrl -> imageUrl -> mediaUrl` 依次尝试；远程 404 时可回退到受限的 `data/media` 本地缓存，仍执行 PNG/JPEG/WebP 与 20MB 限制。
- 真实授权续跑复用了前 2 个已有视频，并新生成第 3–9 个视频。第 9 个在停止竞态中已先提交，随后只恢复轮询原 taskId 并收尾；第 10–12 个镜头未调用。最终使用 9 个 ready 镜头独立拼接成功：`data/media/final-videosbatch-nine-shot-stitch-0596ddcf59b5-1788129874052.mp4`。
- 本次真实复验中错误数为 0；此前第 8 镜头的远程参考图 404 已由本地缓存回退解决，未再次触发幂等冲突。

## 使用边界

保持 `fake/fake` 才是本机浏览器验收默认状态。只有明确进入真实链路验收时，才在本机临时环境中切换执行器，并继续遵守密钥不入 Git、不入日志、不入截图的约束。
