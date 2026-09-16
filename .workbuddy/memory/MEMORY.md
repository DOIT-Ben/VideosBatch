# VideosBatch 项目长期记忆

> 细则在技能里：`videosbatch-stage-development`（阶段/闸门/smoke 链）、`videosbatch-ui-retheme`
> （外观/token/审计）、`ts-deadcode-cleanout`、`videosbatch-frameflow-alignment`。真源
> `specs/videosbatch-workflow-canonical.md`，决策史 `docs/adr/0001-*.md`。**本文件只留动手前必知的约束。**

## 一、前端结构与契约

- 每步用 `components/StagePage.tsx`；步骤序号/名称唯一来源是 `stageModel.ts` 的
  `VIDEOS_BATCH_PRODUCT_STEPS`（用 `productStepIndexLabel`/`productStepName` 取），不要手写头部。
- 运行控件只在 `WorkflowFooter`，进度只在 `WorkflowProgressRail`，不要再加状态条/工具栏。
- 导航入口只在 `VideosBatchHeader`（「任务列表」→ `/gallery`、项目 chip = 会话下拉、`⋯` 菜单）；
  该模式下 SeeReel 侧栏+顶栏**有意隐藏**。凡「开关在 topbar、内容在别处」的组合，都要检查内容自身
  能否关闭（TokenUsagePanel 踩过）。
- **模型输出做分组一律不要精确相等**：在任意位置匹配规范名，匹配不到退化为原值。多命中取**出现
  位置最早者**（规范输出是 `<规范名>：<子方向>`），同位置取更长词，再同按声明顺序，最后用
  `assetKey` 前缀兜底；判据是「任何输入都有归处且不丢项」。
- **⚠️ 渲染期顶层抛 = 整页白屏**：`VideosBatchStudio` 同步调会 `throw` 的 `productStepForStage`，
  映射集合必须用**集合相等**断言守。外层 `StudioErrorBoundary` 兜底，且**兜底面板必须自带出口**——
  `VideosBatchHeader` 在边界内部会一起消失，只给「刷新页面」对确定性错误等于死循环。兜底复用真实
  头部 class（`vbs-v2-header`/`vbs-v2-back`），不新增 CSS。

## 二、闸门与状态机

- **两个人工闸门的「已答复」来源不同，回退必须按来源清**：`COURSE_INTRO_SELECTION` 来自工作流级
  字段（`clearIntroSelection`）；`ASSET_CONFIRMATION` 来自阶段产物 `confirmed:true`
  （`clearAssetConfirmation`，须连 `contentHash` 一起删）。契约 spec §7.13。
- **闸门就绪判定必须与客户端判定同源**：两个 `*Ready` 都必须校验**闸门自身阶段的 status**；只查
  产物会出现「界面要求重新确认、自动运行却判定通过冲过去」。
- **收紧判定后必须同时证明「能恢复」**，否则等于把 bug 换成死锁（spec 1.4.9 教训）。
- **产物保存失败必须上抛**：成功后会退出编辑态/关面板的走 `performOrThrow`；只推进游标、成功不关
  编辑面的动作（选择课程导入、确认资产）保留吞异常的 `perform`，由统一错误条展示。

## 三、运行模式与环境

- **文本/媒体/TTS 三个独立开关，缺省即 fake**（`runtimeProvider.ts`）：`VIDEOSBATCH_EXECUTOR_MODE`
  ∈ fake|llm、`VIDEOSBATCH_MEDIA_MODE` ∈ fake|native、`VIDEOSBATCH_TTS_PROVIDER`。`MEDIA_MODE=fake`
  → 图片/视频永远不产出（**不是 bug 是模式**）。**native 复用 SeeReel 付费凭据，切换前要用户点头**。
- 「自动运行到确认点」= `POST /api/sessions/<id>/videosbatch/run-all`，按设计停在第一个需人工确认的
  步骤（footer 显示「请完成当前确认」），不是卡死。
- `/gallery` 是分享广场**不是任务中心**（任务列表只是外壳左栏 `aside.sidebar`）；`/canvas/<id>` 是
  9 步工作台，`/canvas` 不带 id 落回最后一个 session。
- 会话标题唯一来源 `src/shared/sessionTitle.ts`（前后端共用）：空标题或
  `/^un(?:n)?amed session\s+\d+$/i` → `课程视频 · MM-DD HH:mm`；**用户自起标题永不覆盖**。
- 存储文件**存在但读不出**时必须先隔离字节（`rename`，失败退化 `copyFile`），都失败则**拒绝启动**，
  否则空库起来后下一次保存会原子覆盖用户数据。只有 `ENOENT` 是正常空态。
- dev = `node node_modules/tsx/dist/cli.mjs src/server/index.ts`（5173，**别用 npx**，沙箱会劫持到
  wsl.exe）。类型检查 `node node_modules/typescript/bin/tsc --noEmit [--noUnusedLocals]`。释放端口用
  PowerShell `Get-NetTCPConnection -LocalPort 5173 -State Listen` + `Stop-Process -Force`（bash 的
  `taskkill //PID` 参数会被吃掉）。浏览器探针用仓库内 `playwright-core` + chromium
  `C:/Users/HB/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe`。

## 四、验证纪律

- **「写了 smoke」≠「有回归网」**：改/加任何 smoke 后必须确认它在 `verify:offline` 链里。
- **「加了断言」≠「断言能失败」**：每条新断言都要**重新注入缺陷、实测变红**（注入 → 跑 smoke →
  要求非零退出且命中期望文案 → 按内存副本**逐字节还原**，**别用 `git restore`**，会毁掉未提交的
  修复）。⚠️ `includes("文案")` 极易空转——面板说明文字常含同一句，要按**元素**断言。
- **SSR 测不了错误边界**：`renderToStaticMarkup` 下 React 不捕获（直接抛）。边界行为只能真实浏览器
  验；兜底 UI 可直接单元断言（实例化边界 → 置 `state` → 渲染 `render()`）。
- 跑 `verify:offline` 前先腾空 5173（内含自起服务器的用例，否则 EADDRINUSE 假失败）；`&&` 链会在
  第一个红的 smoke 处断掉，**必须看日志确认每条都执行过**。

## 五、操作失误备忘

- **同一文件不要并行编辑**：两个 `Edit` 同发，其中一次会被覆盖丢失，而回执仍是「成功」。改完必须
  用**行为证据**（渲染结果/探针输出）确认。
- **破坏性探针在失败路径上也必须只读**：`page.click("button.vbs-primary")` 会点到**步骤自身的**主
  按钮并真实改数据（曾误确认某会话的课程导入）。要按可访问名定位
  （`getByRole("button", { name: "…" })`），并在 `finally` 还原 + 校验 sha。
