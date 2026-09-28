# BUG-011 CI 与离线验收集合不一致及外部验收缺口

- 类型：验证技术债 / 待确认；优先级：P2；负责人：DOIT-Ben。
- 状态：未修复，作为后续独立任务跟踪；不阻止本地 fake 功能开发，不代表可发布。
- 发现：2026-09-29 仓库收尾。
- 影响：远端绿灯不能代表完整离线门禁或真实 Provider / 生产验收。
- 关联：BUG-010、release-process、canonical spec、ADR-0007；线上单号见索引。

## 现象

phase1-verify.yml 执行一组独立 smoke 和 build，没有调用 package.json 的完整 verify:offline；后者也没有包含全部 CI 独有项。当前仓库没有 GitHub Release，继承的 SeeReel 发布文档含上游 main、公共站点和云环境，不能据此认定本 fork 的部署身份。

## 复现

比较 `.github/workflows/phase1-verify.yml` 的 run 字段与 package.json 的 verify:offline；执行 `gh run list` 和 `gh api repos/DOIT-Ben/VideosBatch/releases`。本轮 Release 返回 []，没有查询或操作其他仓库、站点或生产环境。

## 代码/行号证据

- `.github/workflows/phase1-verify.yml`：baseline job 的独立检查清单。
- `package.json`：verify:offline 含 production-*、Responses stream、provider slots 等额外门禁。
- `docs/adr/0007-provider-slots-and-same-model-repair.md`：真实验证仅课程导入候选单阶段，未生成完整视频。
- 阴性对照：CI 已包含 build、运行时 Provider 与 native media 检查；不是没有测试。

## 根因

验证入口分开演进，发布说明继承上游。实际部署状态未核验是证据缺口，不是已证实的生产故障。

## 下一步

由负责人确认统一门禁方案及运行预算，独立变更验证工作流；不在本次收尾擅改发布策略。需要真实 Provider、浏览器全矩阵、生产或 npm 验收时明确环境、范围和费用，再执行并回填。规范中的未勾选验收项保留为待核验清单，不批量改成已完成。

## 验收标准

CI 与本地门禁具有明确且受维护的覆盖关系；干净安装、完整离线与 CI 均通过。若要求发布，补足该 fork 部署目标、服务 SHA 和真实端到端验收；此前明确只支持本地 fake 基线结论。
