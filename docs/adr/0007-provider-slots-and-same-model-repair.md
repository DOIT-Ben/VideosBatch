# ADR-0007：三槽文本路由与同模型修复

Decision: ACCEPTED
Date: 2026-09-22
Phase: PASSED (P0/P1/P2 code/configuration); real-course acceptance blocked by provider failures; full-video acceptance remains incomplete

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

### P1：主槽 max 思考（2026-09-22）

原始用户补充：“如果deepseek-v4.1-flash 还不行，那就尝试切换思考模式，设置max思考模式。”

FR-0007-003：增加主槽 `VIDEOSBATCH_LLM_REASONING=max`，映射 Responses API 的 `reasoning.effort`。显式槽位设置优先于阶段默认；同模型 repair 继承原槽位，其他槽位推理设置独立。参考 [DeepSeek 官方思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)，第三方兼容性以实际请求验证。P1: PASSED（配置与代码）；真实课程验收受外部服务失败阻塞。验收包括 max 请求体、有效参数日志、备用 low 隔离和同课程真实重跑；不得把请求参数当作推理质量提升的证明。

P1 验收记录（2026-09-22，原基线 73d9acc）：

- IN_PROGRESS → REVIEW_1 → ACCEPTANCE → PASSED（代码/配置）：独立只读审查无阻断问题；新增 smoke 覆盖主槽 max 覆盖阶段默认、两次同模型 repair 保持 max、第二槽 low 隔离和有效参数日志。TypeScript、完整 `npm run verify:offline`、`smoke:env-hygiene` 均退出 0。
- 本地忽略配置启用 `VIDEOSBATCH_LLM_REASONING=max`；普通启动的执行/媒体/语音开关仍为 fake，真实验收仅由隔离进程启用。
- 同课程真实运行 `run_d3cd9311-d665-451e-9ceb-717c7298f081`：primary / deepseek-v4.1-flash / max 在 79388 ms 后 NETWORK_ERROR；fallback-1 / gpt-5.6-terra / low 在 120016 ms 后 TIMEOUT；third / deepseek-v4-flash / none 在 495 ms 返回 HTTP 402 Insufficient Balance。
- 三槽均未取得可校验的课程输出，本轮未进入合同 repair，未生成视频。实际请求日志证实发送 max，不能证明供应商内部执行 max，也不能判断它是否改善结构遵循。没有降低校验规则或修改报价行为。
- 外部阻塞影响：真实课程和视频验收仍未通过；保留当前 max 配置及历史证据，不自动充值或无限重试。隔离验收进程在失败后停止。
- 本机忽略证据：`data/real-acceptance/20260922-live/verify-adr0007-max.log`、`workflow-before-max.json`、`workflow-max-result.json`、`runs-max-result.json`。P1 回滚只需移除本地主槽 reasoning 设置并撤回对应代码，不覆盖三槽凭据或 P0 成果。

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

## P2：所有供应商失败均顺序回退（2026-09-22）

原始用户补充：“给我修改逻辑，只要是上个供应商不行，不管是什么问题，都要路由到下一个供应商重试，知道连续三个供应商失败才算失败。”

FR-0007-004：文本阶段按三个供应商槽依次执行；每槽首次请求一次，内容不合格时同槽 repair 最多两次。网络、HTTP（含认证/余额）、空输出、非法 JSON、业务校验和 repair 失败都转下一槽从原始输入重新生成；仅全部配置槽失败才判阶段失败，最多三槽、九次提交。通过即停止，保留跨槽诊断与请求记录。局部存盘失败、用户取消或源材料错误不是供应商故障，不能靠外发重试解决，保持停止。

P2: PASSED（逻辑与路由验收；真实课程内容仍未通过）。替代 P0 的“不可重试 HTTP 立即停止”和“合同修复耗尽即阶段失败”规则；报价行为不改。验证：主槽三次内容失败后第二槽成功、401/402 继续、三槽九次上限、第三槽成功、同名模型不同端点、诊断持久化失败停止；独立审查及完整 offline gate。


P2 验收记录（基线 9bee4d4）：

- IN_PROGRESS → REVIEW_1 → REWORK_1：独立审查发现第二槽旧多模型列表会挤占第三槽，改为按供应商分组（第二槽默认首模型，显式覆盖可选其他模型）。补充回归并消除旧规范的余额错误回退冲突。
- REVIEW_2 → REWORK_2 → REVIEW_3：完整离线测试发现主槽缺密钥提示兼容回归，恢复 missingKeyError 原错误提示同时允许下一槽；最终独立复审无阻断问题。
- ACCEPTANCE → PASSED：TypeScript、provider-slots-repair、executor smoke 及最终完整 `npm run verify:offline` 退出 0。新增回归覆盖首槽三次业务不合格后第二槽成功、第三槽成功、九次上限、400/401/402/403/429/503、网络/超时、非法 JSON、旧多模型槽位、诊断累积与存盘失败停止。
- 同课程真实重跑：主槽 deepseek-v4.1-flash/max 首次返回 101178 ms（业务校验失败）；repair 第一次 70906 ms NETWORK_ERROR，第二次 96177 ms 返回但仍不合格；随后 JingAI gpt-5.6-terra/low 实际调用 89825 ms NETWORK_ERROR；第三槽官方 deepseek-v4-flash/none 调用 475 ms 返回 HTTP_402 余额不足。五次请求记录均保留，全部三个供应商失败后阶段才失败，未生成视频。
- 本地忽略证据：`verify-adr0007-failover-final.log`、`workflow-failover-result.json`、`runs-failover-result.json`，均位于 `data/real-acceptance/20260922-live/`。真实运行在多模型兼容补丁之前启动，当前实际配置每槽单模型，其路由分支与最终代码相同；补丁边界由离线回归验证。失败后停止隔离服务，普通运行模式保持原配置。
- 回滚：撤回 P2 提交可恢复 P1 原回退语义；不修改凭据、不删除历史验收文件。业务校验未放宽，真实课程成功仍受供应商响应与内容质量约束。

本次真实运行 ID：`run_b62836b2-919d-4a3b-8456-0d0f340e67ba`。
