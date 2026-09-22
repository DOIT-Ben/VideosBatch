# BUG-005 新拼接运行中误显示旧成片完成

- 状态：已闭环（本地）
- 发现时间与方式：2026-09-22，代码审查与本地隔离复现
- 严重度：P2
- 影响面：新拼接运行中误显示旧成片完成；不据此推断线上已发生事故。
- 证据边界：基线 a762bb5；合成测试数据、fake 执行器；未访问生产或付费 Provider。
- 治理：ADR-0003 / P2

## 现象
新拼接运行中误显示旧成片完成。

## 复现
组件静态渲染：旧 ready 视频+新 running 任务时仍显示完成和旧链接；单个 ready 任务为对照。

## 代码/行号证据
基线位置：`src/client/videosBatchStudio/contentModel.ts:233; src/client/videosBatchStudio/stages/FinalVideoStage.tsx:6`。原本地临时探针不作为长期回归入口；修复阶段补仓库测试。

## 根因
按视频 URL 而非最新任务选取状态。

## 修复方案
最新任务决定状态；历史成片单独标注，工作流 stale/未完成不能宣称当前已完成。

## 验收标准
- [x] 新任务 running/failed 不显示当前完成；上一版明确标识；当前 ready 正常交付。
- [x] 定向测试、独立审查及阶段证据完成。

## 验收证据
2026-09-22：smoke:adr0003-recovery、smoke:adr0003-api、既有 retry/store-save/product-ui-foundation、content-ux 和 tsc 通过。独立审查 R1 要求修复保存失败的假 running；R2 PASS。完成保存失败只保留内存结果并阻止自动重发，磁盘故障未恢复前不保证新结果持久性。不宣称真实 Provider 或生产验收。
