# 参考图绑定修复计划

规范依据：`specs/videosbatch-workflow-canonical.md`
落地文档：`docs/videosbatch-reference-binding-repair.md`

## 目标

修复 VideosBatch H3 多参考图的声明顺序、`Image N` 提示词映射、multipart 上传顺序和执行快照一致性，并修复 `COPYABLE_PROMPT` 的语义位置回退。

## 顺序

1. 更新 canonical 规范和落地文档，冻结字段、失败策略和 3 镜头验收边界。
2. 让资产读取和 native projection 产生稳定有序 binding。
3. 让 H3 适配器用同一个列表编译 prompt、文件和脱敏审计记录。
4. 在执行提交前持久化 Shot/Render 快照。
5. 修复 copyable 派生回退，运行定向 smoke、规范、秘密扫描和构建。
6. 只用已有提示词串行实跑 3 个真实镜头，核对绑定后停止。

## 风险与控制

- 付费重复提交：快照先写入，已知 taskId 只轮询，不盲目重 POST。
- 资产越权：沿用现有 session/shot 可见性和确认校验。
- 签名 URL 泄露：日志只记录 URL 哈希，真实配置不进仓库。
- 旧 Provider 回归：绑定回调是可选项，非 H3 路径保持原行为。
- 真实费用扩张：硬性限制 3 个 10 秒镜头，不执行 stitch。

## 检查点

- C1：规范文档更新完成后才改代码。
- C2：纯函数/本地 mock 证明顺序和映射一致。
- C3：离线门禁全部通过后才启动真实 Provider。
- C4：真实镜头逐条核对并记录脱敏证据。
