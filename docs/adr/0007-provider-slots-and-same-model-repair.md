# ADR-0007：三槽文本路由与同模型修复

Decision: ACCEPTED
Date: 2026-09-22
Phase: PASSED (P0 code/configuration); full-video acceptance remains incomplete

## Original Requirement and Source

来源：2026-09-22 当前用户会话，原文摘录（不包含凭据）：
> 你去用这个PPTbuilder项目里面的这个供应上：jingai-gpt-5.6-terra。把他的配置拿过嘞，复制一份作为我们的第二备用槽deepseek官方顺延到第三。好吗？然后同模型，repair放到最多2次

用户明确确定了槽位顺序和修复次数，授权直接实施。这里“第二”按总槽位解释：现有主槽、JingAI、官方 DeepSeek。PPT-Builder 只读。

| Requirement | Decision / P0 | Acceptance |
| --- | --- | --- |
| FR-0007-001 | 保留主槽；复制 Builder 的 JingAI 配置到第二槽；官方移到第三槽 | 三个独立端点/凭据按顺序选择；凭据不入 Git |
| FR-0007-002 | 合同 repair 固定原生成槽及请求模型，最多两次 | 首槽及备用槽生成后的两次 repair 均不跨槽，仍 strict json_schema |
| TR-0007-001 | 首轮三次请求预算，向剩余槽预留请求；repair 独立两次预算，无备用预留 | 有界三槽错误回退、同名模型不同端点测试 |
| TR-0007-002 | 补齐失败证据（由前次诊断缺陷引出） | 每次返回后 checkpoint 脱敏原文、解析产物、校验错误；修复请求报错不丢前轮证据 |

## 实施与兼容

沿用现有主槽和 FALLBACK_*（第二槽），增加 FALLBACK_2_*（第三槽）；未配置第三槽时保持旧接口可用。routeId 只标识槽位，不含密钥。正常业务结果由原 validator 决定，不降低规则，不改报价。首轮权限、余额等不可重试错误仍立即停止。

分镜默认使用主槽模型；显式模型覆盖必须解析到已配置的同模型槽，不把其他槽模型发送到错误端点。保留旧主模型覆盖的兼容路径，但拒绝 repair 路由丢失。

P0：实现、相关离线 smoke、独立审查、真实单阶段验收、文档与提交。真实视频仍受后续人工创作门禁及媒体服务状态约束，不作为本 ADR 全部代码验收的替代。

## Evidence

P0 验收记录（2026-09-22，原基线 f0c6e83）：

- IN_PROGRESS → REVIEW_1：独立审查发现覆盖模型路由绑定、JSON 凭据脱敏、非法 JSON 原文留存三个缺陷。
- REVIEW_1 → REWORK_1 → REVIEW_2：修复并加入 `scripts/smoke-provider-slots-repair.ts`；第二轮独立只读审查无阻断问题。
- REVIEW_2 → ACCEPTANCE → PASSED：`npm run verify:offline` 完整退出 0（包括新回归、构建、spec、secret、恢复与调度测试），`smoke:env-hygiene` 通过。测试中的合成凭据改用明确 fixture 变量后通过密钥扫描，没有降低扫描规则。
- 新回归覆盖三槽独立凭据/端点、相同模型不同端点、备用槽生成后的两次同模型 repair、显式模型覆盖、字段验证失败原文保存、repair 遇 402 后证据保全、非法 JSON 重试前 checkpoint、存盘失败停止请求和凭据脱敏。
- 本地槽位：主槽 `deepseek-v4.1-flash`；第二槽从 PPT-Builder `PLANNING_PROVIDER_3`（alias `jingai-terra`）复制 `gpt-5.6-terra` 的 URL、密钥和 low 推理配置；原官方 `deepseek-v4-flash` 顺延第三槽。未修改 PPT-Builder，未提交 `.env`。
- JingAI 第二槽真实 strict JSON canary 成功，耗时 12739 ms，实际返回模型 `gpt-5.6-terra`，凭据与来源一致（仅记录布尔验证）。第三槽本轮未付费验证，前轮余额不足仍是已知限制。
- 真实课程任务 `ses_f8d7a385` / `run_4bc8fe05-79b7-4dd6-8ea4-f5c035a41d66` 验证了 1 次生成 + 2 次同主槽 repair：耗时分别为 20131 / 16900 / 16448 ms。三次请求均使用 strict JSON Schema，repair 均为 `same-model`，未切换备用。
- **真实课程业务验收未通过**：原文首轮使用 A-01 等顶层中文条目，修复后使用 `course_intro_candidates` 而非合同的 `candidates`，导致标准候选数组缺失及推荐引用失败。已保存三轮脱敏原文、解析快照和具体规则错误。未生成视频，不把路由/repair 机制通过等同于完整视频通过。
- 本地详细证据保留在 Git 忽略目录 `data/real-acceptance/20260922-live/`：`verify-adr0007.log`、`jingai-canary.json`、`workflow-latest.json`。这些是本机证据，不是随仓库分发的产物；上面的脱敏结论随本 ADR 留存。
- 诊断边界：保留模型文本响应（含非法 JSON／未完成输出），每条最多 200000 字符并显式标记截断；非成功 HTTP 响应只保留既有脱敏摘要，不保存所有原始 HTTP body。新运行清空旧诊断，旧运行快照由持久化结果保留。

回滚：撤回代码提交并恢复本地第二槽为官方、删除第三槽配置；不删除测试成果。报价行为未改。
