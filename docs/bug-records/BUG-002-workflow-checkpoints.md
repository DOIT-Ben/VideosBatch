# BUG-002 长任务无阶段持久化检查点

- 状态：已闭环（本地）
- 发现时间与方式：2026-09-22，代码审查与本地隔离复现
- 严重度：P1
- 影响面：长任务无阶段持久化检查点；不据此推断线上已发生事故。
- 证据边界：基线 a762bb5；合成测试数据、fake 执行器；未访问生产或付费 Provider。
- 治理：ADR-0003 / P2

## 现象
长任务无阶段持久化检查点。

## 复现
隔离 fake 执行器阻塞时 API 与磁盘均为 pending；正常请求结束可保存为阴性对照。

## 代码/行号证据
基线位置：`src/server/videosBatchWorkflow/runner.ts:448; src/server/videosBatchWorkflow/api.ts:303`。原本地临时探针不作为长期回归入口；修复阶段补仓库测试。

## 根因
runner 只返回最终对象，API 在长请求返回后保存。

## 修复方案
执行前保存 running、每阶段结束保存结果；启动时把遗留 running 标为中断且不自动重试。

## 验收标准
- [x] 阻塞期间可读取 running；前一阶段成果落盘；重启不重新调用 Provider。
- [x] 定向测试、独立审查及阶段证据完成。

## 验收证据
2026-09-22：smoke:adr0003-recovery、smoke:adr0003-api、既有 retry/store-save/product-ui-foundation、content-ux 和 tsc 通过。独立审查 R1 要求修复保存失败的假 running；R2 PASS。完成保存失败只保留内存结果并阻止自动重发，磁盘故障未恢复前不保证新结果持久性。不宣称真实 Provider 或生产验收。
