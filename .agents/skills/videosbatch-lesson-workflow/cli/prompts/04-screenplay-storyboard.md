# 阶段提示词组：剧本、分镜与可复制提示词

当前阶段只允许处理 `SCREENPLAY`、`FINAL_STORYBOARD` 或 `COPYABLE_PROMPT`。执行前读取 canonical spec 的对应提示词材料、故事类型、十秒分镜规则、资产语义标签和当前上游版本。

执行要求：

- `SCREENPLAY` 只使用当前故事和已确认资产；`FINAL_STORYBOARD` 只使用当前正式剧本和已确认资产语义清单；`COPYABLE_PROMPT` 只使用当前正式分镜和已确认资产稳定 ID。任何阶段都不得创造清单外的事实或对象。
- `FINAL_STORYBOARD` 是正式事实源；`COPYABLE_PROMPT` 只能逐字段派生，不得重新创作。
- 语义资产标签和稳定公开 ID 的注入边界按 canonical spec 执行。
- 分镜投影或提示词编译失败时保留正式分镜，不用不完整副本冒充可发送结果。

允许工具：结构化文本执行器、VideosBatch `run-next`、阶段 artifact API、服务端分镜投影和提示词编译器。

返回：按 `references/output-report.md` 报告阶段、状态、版本、哈希、门禁、投影结果和下一动作。
