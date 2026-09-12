# VideosBatch 阶段路由清单

本文件只描述 Codex 的阶段路由和操作入口。默认入口是本地运行目录；远程 API 仅为可选适配。阶段字段、长提示词、时长、Schema 和业务校验必须回到 canonical 快照/`specs/videosbatch-workflow-canonical.md`，本文件不得重新定义。

## 阶段分组

| 分组 | 机器阶段 | 主要动作 | 典型工具 | 默认停止点 |
| --- | --- | --- | --- | --- |
| 教案与导入 | `LESSON_INPUT`、`COURSE_INTRO_CANDIDATES`、`COURSE_INTRO_SELECTION` | 解析、生成候选、保存用户选择 | `videosbatch lesson parse`、`start`、`run-next`、`artifact save` | 选定导入后停止 |
| 故事与资产计划 | `STORY_SCRIPT`、`ASSET_PLAN` | 生成或保存故事、资产计划 | `videosbatch run-next`、`artifact save`、服务端文本执行器 | 产物可审阅 |
| 资产候选与确认 | `ASSET_CANDIDATES`、`ASSET_CONFIRMATION` | 生成候选、保存选中的资产 | 内置 CLI、图片 Provider、SeeReel Asset API | 资产确认后停止 |
| 剧本与分镜 | `SCREENPLAY`、`FINAL_STORYBOARD`、`COPYABLE_PROMPT` | 生成、编辑、投影和派生可复制提示词 | `videosbatch run-next`、`artifact save`、提示词编译器 | 分镜可审阅 |
| 执行与交付 | `QUOTE`、`EXECUTION`、`STITCH` | 检查报价、生成片段、准备音频、拼接 | `videosbatch status`、`run-next`、`retry`、SeeReel 媒体 API | 真实媒体动作前暂停 |

## 本地运行目录入口

```text
videosbatch prepare <lesson-file> --out <run-dir>
videosbatch status <run-dir> --json
videosbatch run next <run-dir>
videosbatch run dispatch <run-dir> --unit <id> --worker-id <id>
videosbatch run record <run-dir> --unit <id> --worker-id <id> --lease-id <id>
videosbatch run reset <run-dir> --unit <id> --confirm-lost
videosbatch run finalize <run-dir>
```

本地入口不读取 `/api/state` 或 `/api/sessions`；所有状态来自运行目录文件。

## 统一路由

| 目的 | HTTP 入口 | 说明 |
| --- | --- | --- |
| 解析教案文件 | `POST /api/sessions/:sessionId/videosbatch/lesson/parse` | 只发送当前用户指定的教案字节和文件名 |
| 启动工作流 | `POST /api/sessions/:sessionId/videosbatch/start` | 保存项目和教案输入，创建阶段状态 |
| 读取状态 | `GET /api/sessions/:sessionId/videosbatch` | 每次动作前先读取 |
| 推进一个阶段 | `POST /api/sessions/:sessionId/videosbatch/run-next` | 默认推进入口 |
| 离线连续推进 | `POST /api/sessions/:sessionId/videosbatch/run-all` | 仅限明确授权的离线或受控场景 |
| 保存阶段产物 | `PUT /api/sessions/:sessionId/videosbatch/stages/:stageId/artifact` | 用户编辑或人工确认后使用 |
| 从阶段重新开始 | `POST /api/sessions/:sessionId/videosbatch/restart-from/:stageId` | 保留历史，后代重新变为待处理或过期 |
| 重试失败阶段 | `POST /api/sessions/:sessionId/videosbatch/retry/:stageId` | 必须携带当前来源 revision/hash |

## 结果判定

- `ready`：服务端校验通过，且当前来源仍匹配。
- `pending` / `running`：不得重复提交同一动作；先读取状态或等待。
- `failed`：读取 `errorInfo.retryable` 和来源血缘，决定显式重试或报告阻塞。
- `stale`：先回到当前来源阶段，不得直接复用旧产物。
- 人工阶段未完成时：返回 `needs_human_confirmation`，不代替用户确认。
