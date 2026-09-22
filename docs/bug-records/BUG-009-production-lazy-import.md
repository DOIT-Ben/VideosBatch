# BUG-009 生产构建工作台懒加载白屏

- 状态：已闭环（本地）
- 发现：2026-09-22，ADR-0003 P3 真实浏览器验收。
- 严重度：P1；生产构建的本地隔离运行，不据此推断线上事故。
- 治理：ADR-0003 / P3 的必要验收阻塞修复。

## 复现与证据
执行 `npm run build`，生产模式服务打开 `/tasks` 后继续一个任务。Chrome 报 `Failed to fetch dynamically imported module`，请求 `/VideosBatchStudio-*.js` 得到 HTML，而真实文件在 `/assets/`。任务列表能显示，进入工作台白屏。

## 根因与修复
`scripts/inline-entry-assets.mjs` 将入口模块搬进 HTML，改变相对 import 与 import.meta.url 的基准。保留 Vite 输出的外部模块引用，CSS 内联不变；不使用正则改写压缩后的模块代码。

## 验收
- [x] 构建入口保持 /assets/index-*.js，动态 import 在资源目录解析。
- [x] 实际浏览器从任务列表和深链接进入工作台通过。
- [x] 独立审查与离线全量通过。

## 验收证据
2026-09-22：smoke:adr0003-workspace、API revision 冲突回归、构建与 verify:offline 通过；独立审查 R1 发现保存竞争，增加提交记录与持久化记录双重核对后 R2 PASS。真实 Chrome 在临时数据/fake 服务验证刷新与切步骤保留、项目隔离、延迟保存期间的新草稿保护及冲突提示。具体复现步骤和边界见 ADR-0003 最终本地验收。未执行生产或真实 Provider 验收。
