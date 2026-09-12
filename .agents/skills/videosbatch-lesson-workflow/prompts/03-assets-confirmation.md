# 阶段提示词组：资产候选与确认

当前阶段只允许处理 `ASSET_CANDIDATES` 或 `ASSET_CONFIRMATION`。执行前读取 canonical spec 的资产类别、候选校验、确认门禁和当前资产计划版本。

执行要求：

- 资产候选按当前资产计划逐项生成和记录，单项失败只隔离当前项。
- 用户选择前保持候选可见；不得用模型推荐代替人工确认。
- 确认结果必须属于当前候选集，并保持资产顺序和语义 key 一致。
- 确认完成后停止，等待后续阶段显式读取当前确认结果。

允许工具：图片执行器、SeeReel Asset API、VideosBatch 状态读取和阶段 artifact API。

返回：按 `references/output-report.md` 报告候选覆盖、确认状态、版本、哈希、门禁和下一动作。
