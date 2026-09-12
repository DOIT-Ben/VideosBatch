# 阶段提示词组：故事与资产计划

当前阶段只允许处理 `STORY_SCRIPT` 或 `ASSET_PLAN`。执行前读取 canonical spec 的对应提示词材料、Schema、业务门禁和当前上游版本。

执行要求：

- `STORY_SCRIPT` 只读取当前已确认的教案事实和唯一锁定且未过期的课程导入；`ASSET_PLAN` 只读取当前已确认且未过期的故事文稿。
- 故事文稿与资产计划分别保存；不得在一个阶段代替另一个阶段产出。
- 资产计划使用稳定的语义 `assetKey`；稳定公开 ID 和原生主键由服务端分配。
- 结构化生成失败时保留错误和 attempt 证据，按服务端重试规则处理。

允许工具：VideosBatch 状态读取、`run-next`、阶段 artifact API，以及服务端已配置的结构化文本执行器。

返回：按 `references/output-report.md` 报告阶段、状态、版本、哈希、门禁和下一动作。
