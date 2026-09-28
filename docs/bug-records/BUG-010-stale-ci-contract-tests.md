# BUG-010 CI 遗留断言未跟随阶段与折叠状态更新

- 类型：测试缺陷；优先级：P1；负责人：DOIT-Ben。
- 状态：已闭环；修复提交 `745c59f` 本地及远端验收通过，GitHub #7 已关闭。
- 发现：2026-09-29 收尾核验；影响：主线 CI 失败，无法形成可信基线。
- 关联：canonical spec、UI System；线上单号见本目录索引。

## 现象

基线 f856a95 的 Actions 35751532628 在阶段数量断言失败；继续本地执行 CI 独有测试，又复现分镜旁白断言失败。

## 复现

在 f856a95 安装锁文件依赖后运行 `node --import tsx scripts/smoke-videosbatch-workflow-state.ts` 和 `node --import tsx scripts/smoke-videosbatch-content-ux.tsx`。

## 代码/行号证据

- workflow-state.ts:43 仍期望 13 个可见阶段；shared/videosBatchWorkflow.ts:3 的机器阶段实际为 14 个，规范区分 9 个产品步骤。
- content-ux.tsx 原 263–267 行以默认折叠视图断言详情存在；StoryboardStage.tsx:46 的初始展开状态为 []。
- 阴性对照：本轮 runner、copyable-prompt-ui、lesson-document-parser、guided-studio-v2 原有定向测试通过。

## 根因

旧 CI 专用夹具未同步现行合同；这两个用例不在 verify:offline 中，历史离线通过不能证明它们通过。

## 修复方案

仅对齐测试：检查 14 个机器阶段及 EXECUTION → AUDIO_DELIVERY → STITCH 顺序；通过既有视图状态接口打开分镜，保留旁白断言，并检查默认折叠时不挂载详情。不改 UI 默认值和业务合同。

## 验收标准

两个定向测试退出 0，完整离线验证通过，当前提交远端 CI 通过。CI 与离线检查集合差异另见 BUG-011。

实际验收：完整 verify:offline 和 CI 额外定向测试退出 0；[远端 CI 36466770358](https://github.com/DOIT-Ben/VideosBatch/actions/runs/36466770358) 为 success，对应修复提交 745c59f。未覆盖范围由 BUG-011 继续跟踪。
