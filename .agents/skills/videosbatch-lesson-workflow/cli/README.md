# VideosBatch CLI

这是 `videosbatch-lesson-workflow` Skill 自带的命令行工具。默认使用本地运行目录和文件状态，不需要 VideosBatch Web 服务；旧的 `/api/sessions/:sessionId/videosbatch/*` 命令作为可选远程适配保留。

## 安装

需要 Node.js 18.17 或更高版本：

```powershell
npm install -g <skill-root>\cli
videosbatch --help
```

也可以不安装到 PATH，直接运行：

```powershell
node <skill-root>\cli\videosbatch.mjs --help
```

## 配置

可选远程适配地址为 `http://localhost:5173`。本地运行目录不使用该地址；只有旧远程命令才读取环境变量：

```powershell
$env:VIDEOSBATCH_BASE_URL = "http://localhost:5173"
$env:VIDEOSBATCH_ACCESS_TOKEN = "<access-token>"
```

也可以保存到用户级配置 `~\.videosbatch\config.json`：

```powershell
videosbatch configure --base-url http://localhost:5173
videosbatch doctor --json
videosbatch prepare .\lesson.docx --out .\runs\lesson-001
videosbatch status .\runs\lesson-001 --json
videosbatch run next .\runs\lesson-001 --json
videosbatch run save .\runs\lesson-001 --stage COURSE_INTRO_SELECTION --artifact-file .\selection.json
videosbatch run dispatch .\runs\lesson-001 --unit CHARACTER-HERO --worker-id worker-01
videosbatch run record .\runs\lesson-001 --unit CHARACTER-HERO --worker-id worker-01 --lease-id <lease-id> --result-file .\worker-result.json
videosbatch run all .\runs\lesson-001 --auto-fake --json
videosbatch run finalize .\runs\lesson-001 --json
```

令牌不会出现在正常输出中。远程部署若启用了访问令牌，使用环境变量比命令行参数更安全。

## 远程适配命令

```powershell
videosbatch doctor --json
videosbatch session create --title "分数的意义"
videosbatch start --session <session-id> --project-id P001 --lesson-text "教案正文"
videosbatch status --session <session-id> --json
videosbatch run-next --session <session-id> --json
videosbatch artifact save --session <session-id> --stage SCREENPLAY --file .\screenplay.json
videosbatch retry --session <session-id> --stage STORY_SCRIPT --json
videosbatch prompt build --stage FINAL_STORYBOARD --session <session-id> --mode draft --unit 3 --max-concurrent 3 --out .\stage-prompt.md
videosbatch worker plan --session <session-id> --stage ASSET_CANDIDATES --units-json '["CHARACTER-HERO","SCENE-CLASSROOM"]' --max-concurrent 2
videosbatch worker next --session <session-id> --stage ASSET_CANDIDATES --json
videosbatch worker claim --session <session-id> --stage ASSET_CANDIDATES --unit CHARACTER-HERO --worker-id worker-01
videosbatch worker complete --session <session-id> --stage ASSET_CANDIDATES --unit CHARACTER-HERO --worker-id worker-01 --lease-id <lease-id> --result-file .\worker-result.json
videosbatch worker status --session <session-id> --stage ASSET_CANDIDATES --json
```

本地 `run all` 必须显式添加 `--auto-fake`，只用于离线结构验证。远程旧命令 `run-all --confirm-run-all` 仍需显式确认。涉及真实 Provider、额度、音频或拼接时，仍需按 Skill 的人工授权规则逐阶段操作。

`prompt build` 会在当前仓库根目录或 `VIDEOSBATCH_CANONICAL_SPEC` 指定的位置核验 canonical spec；找不到规范或 Spec ID 不匹配时 fail-closed。`--unit` 和 `--max-concurrent` 只把 Planner 的调度上下文写入提示词，不会授予 Worker 额外权限，也不会改变服务端并发限制。

Worker plan 状态默认保存在 `~\.videosbatch\workers`，可用 `VIDEOSBATCH_WORKER_HOME` 指定专用目录。计划状态只记录 Planner 调度元数据和脱敏结果，不保存令牌或凭据。`claim` 会占用一个 lease 和并发槽；`complete/fail` 必须提供匹配的 `worker-id + lease-id`；running Worker 不会因超时自动重置，必须先确认丢失再执行 `reset --confirm-lost`。

上面的 `worker plan/claim/...` 是远程 Session 兼容命令；本地运行目录必须使用 `run dispatch/record/reset`，其状态保存在 `<run-dir>` 内。

所有命令都支持 `--json`；错误形状为：

```json
{
  "error": {
    "code": "...",
    "message": "...",
    "retryable": false,
    "status": 409
  }
}
```
