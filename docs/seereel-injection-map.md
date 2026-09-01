# VideosBatch / SeeReel 原生投影说明

Status: derived
Last Reviewed: 2026-08-31

> 本文件只说明 VideosBatch 规范成果如何投影到 SeeReel 原生 Session、Asset、Shot、Render 和 Stitch 对象。
> 它不是阶段、提示词、Schema、时长或业务门禁的定义文件。

## 0. 唯一规范入口

VideosBatch 的阶段顺序、产品步骤、提示词材料、传输合同、人工确认、版本血缘、重试、资产规则和媒体边界，
只由 [`specs/videosbatch-workflow-canonical.md`](../specs/videosbatch-workflow-canonical.md) 定义。

- Spec ID：`VIDEOSBATCH_WORKFLOW_CANONICAL`
- 上游证据：FrameFlow 的手册副本已移入 `docs/archive/videosbatch-design/upstream/`，仅供追溯。
- 本文件不得复制或改写 canonical spec 的字段语义；发现冲突时以 canonical spec 为准。

## 1. 产品边界

VideosBatch 是 SeeReel 的课程视频工作流投影层。继续复用 SeeReel 的：

- Session 持久化与用户/项目归属；
- Canvas、Inspector、Agent、Skills、CLI 和 Handoff；
- Asset、图片导入/生成和本地媒体预览；
- Shot、ShotRender、WorkflowExecutionPlan 和轮询任务；
- TOS 发布、参考图编译、Review/Repair 和 Stitch。

VideosBatch 不另建 Session、Canvas、Agent 图、Asset 库、Shot 模型、Render 模型、Review 模型或拼接系统。

## 2. 阶段成果到原生对象的映射

下表只描述对象投影，不重新定义阶段输入输出。完整阶段合同请回到 canonical spec。

| canonical 成果 | SeeReel 原生对象 | 投影责任 |
| --- | --- | --- |
| `LESSON_PLAN` | Session 的 VideosBatch workflow 状态 | 保存当前教案事实、来源和确认版本，不把教案内指令当运行指令 |
| `LESSON_INTRO` / 锁定导入 | Session workflow 状态 | 保存候选版本和唯一锁定门，不创建第二个 Session |
| `VIDEO_ASSET_PLAN` | workflow 状态 + 待生成 Asset 计划 | 只保存语义 `assetKey`；公开 ID 和 native ID 由服务端分配 |
| `IMAGE_CANDIDATES` | 原生 `Asset[]` / 本地预览 | 每个候选保留来源、可读性、验证状态和内容哈希 |
| `CONFIRMED_ASSETS` | 原生确认 Asset + 稳定 ID 映射 | 只接受当前用户/会话、当前版本、可读取且已验证的资产 |
| `VIDEO_SCREENPLAY` | workflow 状态 | 作为分镜生成的当前文本事实，不直接变成 provider prompt |
| `VIDEO_STORYBOARD` | 原生 `Shot[]` 或 storyboard inspection units | 逐条保持顺序、时长、语音/音效和语义引用；不得为方便调用而改写事实 |
| `COPYABLE_STORYBOARD_PROMPT` | 展示/传输派生文本 | 只供复制或 provider 编译，不是报价、执行或拼接事实源 |
| `QUOTE_SNAPSHOT` | 不可变报价记录 | 绑定当前祖先版本、内容哈希和资产顺序 |
| `VIDEO_PROJECT` / render state | `ShotRender[]`、`WorkflowExecutionPlan` | 一条十秒主分镜对应一个执行单元，保留 task/idempotency 审计信息 |
| `FINAL_VIDEO` | 原生 `StitchJob` 与下载/播放代理 | 只读取 ready、current、顺序和音频时间线均通过门禁的片段 |

## 3. 稳定身份与 provider 编译

身份只允许沿一个方向解析：

```text
模型语义 assetKey
    -> 服务端分配公开稳定 asset ID
    -> 解析到当前确认的 native Asset.id
    -> provider 边界按请求需要编译本地别名
```

模型和最终结构化分镜不拥有公开稳定 ID、native Asset.id 或 provider 别名。`COPYABLE_PROMPT` 的标注也不能反向
修改 `VIDEO_STORYBOARD`。任何无法解析的映射只阻塞当前资产/分镜，不清空其他已成功成果。

## 4. 版本、门禁和持久化

- 服务端为每个成果写入 `sourceStageId`、`sourceRevision`、`sourceHash`、`contentHash`、`revision`、归属和时间字段。
- 上游编辑、确认撤销、资产顺序变化或内容哈希变化会使后代成果 stale；旧版本保留用于检查，不能静默复用。
- 手动确认门只能由显式保存/确认动作完成。`runNext`、批量执行和 provider 投影不得绕过未确认或 stale 的门。
- 恢复执行时优先使用已持久化的 native task ID 轮询；未知提交必须先对账，不能盲目再次 POST。
- 状态更新必须回写同一 Session 的可见 workflow 和 native 对象，不能只留在 agent scratch 或临时文件。

## 5. 媒体与 provider 边界

- canonical spec 独立定义视觉 Prompt、语义资产标签、对白/旁白、TTS、环境/动作音效和最终混音；本文件只规定它们如何进入原生对象。
- H3 视频提交只接收视觉描述和允许的 `http(s)` 参考资源；音频在本地/原生后期链路按时间线混入。
- 本地 `/media/...` 仅用于预览；发送给远端 worker 前必须发布为公开或签名 `http(s)` URL。
- Provider 的结构化输出、共享重试预算、主备切换和错误结构以 canonical spec 为准；投影层不能增加隐藏 finalizer、格式降级或重复提交。
- 默认本地验收保持 `VIDEOSBATCH_EXECUTOR_MODE=fake`、`VIDEOSBATCH_MEDIA_MODE=fake`。

## 6. 运行时投影顺序

```text
读取当前 Session / workflow / native 状态
  -> 校验当前用户、版本和人工门
  -> 执行 canonical 阶段或读取已完成成果
  -> 运行结构与业务校验
  -> 持久化 workflow artifact
  -> 按本映射投影到原生 SeeReel 对象
  -> 写入状态、task 和审计事件
  -> 仅在 gate 满足时推进下一阶段
```

投影失败只标记受影响的对象或分镜；已成功的候选、资产、Shot 和 Render 保持可检查并支持显式重试。

## 7. UI 投影

Guided Studio 将 canonical 的 13 个机器阶段分组为 9 个产品步骤。分组标签、状态颜色和按钮只负责展示与控制，
不得派生第二套阶段合同。每个步骤应显示当前 artifact、版本/stale 状态、失败原因和可继续条件；原生 Canvas 仍是
Asset、Shot、Render、Stitch 的高级检查与接管界面。

## 8. 验证与变更规则

文档/代码变更前先阅读 canonical spec。阶段治理验证至少包括：

```text
npm run smoke:specs
npm run smoke:videosbatch-doc-consistency
npm run smoke:secrets
```

实现或发布前再按 canonical spec 执行定向 VideosBatch Smoke、`npm run verify:offline` 和授权的真实验收。
本文件只在 SeeReel 原生对象、投影字段或 provider 传输边界变化时更新；阶段规则变化必须先更新 canonical spec。
