# 阶段提示词组：报价、执行、音频与成片

当前阶段只允许处理 `QUOTE`、`EXECUTION` 或 `STITCH`。执行前读取 canonical spec 的执行、音频、媒体、重试和交付规则，并重新读取当前 `/videosbatch` 状态。

执行要求：

- 报价确认、真实 Provider、音频生成、混音和拼接都是需要授权或门禁的动作；没有本次用户明确授权就停止真实外部动作。QUOTE 可以先生成当前版本的不可变报价快照，不能把报价快照生成和付费执行混为一谈。
- QUOTE 只检查当前最终分镜、全祖先版本和资产顺序；EXECUTION 才额外需要当前可复制副本、视觉资产和报价。所有动作都禁止使用旧血缘。
- 单个镜头失败只隔离当前项；未知提交先对账，不重复扣费。
- `STITCH` 只有在必需片段和独立音频时间线满足 canonical 交付门禁时才允许继续：有语音事件时每个事件必须有 TTS URL，有音效事件时每个事件必须有音频 URL；没有待播语音事件时 `tts=[]` 合法，但 `mix.status=ready` 且 `mix.audioUrl` 仍是必需条件。

允许工具：VideosBatch 状态读取、报价/执行 API、SeeReel Shot/Render/Stitch API、音频时间线工具和显式重试 API。

返回：按 `references/output-report.md` 报告授权状态、阶段、片段/音频就绪状态、版本、哈希、错误和下一动作。
