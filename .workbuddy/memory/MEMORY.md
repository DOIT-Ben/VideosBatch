# VideosBatch 项目长期记忆

## 一、结构与契约（改前端前必读）

- **每个步骤必须用 `components/StagePage.tsx`**（渲染统一的「stage slate」头部：mono 序号 +
  步骤名 + 标题 + lead）。步骤序号/名称**唯一来源**是 `stageModel.ts` 的
  `VIDEOS_BATCH_PRODUCT_STEPS`，用 `productStepIndexLabel(id)` / `productStepName(id)` 取；
  不要手写 `.vbs-stage-page` / kicker / `vbs-document-header`。头部右侧用 `facts`/`actions`，
  要放别的东西用 `aside` 整体替换。
- **运行控件只在 `WorkflowFooter`**（自动运行 + 步骤操作菜单），进度展示只在
  `WorkflowProgressRail`。不要再新增重复的状态条/工具栏。`WorkflowFooter` 在 `completed` 时
  按设计隐藏自动运行按钮（快捷菜单保留）；无 workflow 的会话不渲染运行区。
- **导航入口只放工作台头部**：`VideosBatchHeader` 左上「任务列表」回 `/gallery`；项目 chip
  即会话切换下拉；右侧 `⋯` 溢出菜单承载查看用量/下载/语言。SeeReel 侧栏+顶栏在 VideosBatch
  模式下被**有意隐藏**（smoke `guided-studio-v2.tsx:171-176` 断言了这条契约）。**凡「开关在
  topbar、内容渲染在别处」的组合，都要检查内容自身能否关闭**（TokenUsagePanel 踩过）。
- **模型输出容错**：凡拿模型输出的分类名/枚举做分组，**一律不要精确相等**——要在字符串任意
  位置匹配规范名，匹配不到退化为取首段，保证任何输入都有归处（`IntroCandidatesStage` 教训：
  精确匹配导致 9 张候选卡全消失、步骤显示完成但正文空白）。

## 二、设计 token 与样式分层

- **色板/圆角唯一定义点 = `videosBatchStudio/tokens.css`**，同一个选择器组
  `:root, .videosbatch-studio-v2, .app-shell.videosbatch-canvas-mode`（一份声明三个作用域）。
  **其他任何样式表都不要再定义 `--vbs-*` / `--vbs-v2-*`**（smoke 三条守卫断言盯着）。
  `--vbs-v2-*` 是新尺度命名，`--vbs-*` 是旧语义别名（指向同一尺度，勿删）。
- **⚠️ Portal 陷阱**：Radix Portal/Dialog/Drawer 渲染到 `<body>`，不在 studio 子树内——
  token 若只挂 studio 容器，portal 内全 unset（菜单透明 + 浅色字浮在米白页面上）。所以
  **必须同时挂 `:root`**，且 portal 内容自己写 `color`。判断：
  `getComputedStyle(el).getPropertyValue("--vbs-v2-surface")` 返回空串就是没继承到。
- **CSS 变量只向下继承**：studio 容器上的 token，`.app-shell:has(...)` 这类祖先选择器读不到；
  要跨层就得提到 `:root`（现已提，代价是 SeeReel 全站也能读到，名字带前缀无副作用）。
- 样式分 6 个文件、**加载入口不同**：`main.tsx` → `styles.css`（全局，兼服务 flow/canvas）+
  `storyboardPrompt.css` + `guidedStudioV2.css`（V2 主体）+ `guidedStudioV2Focus.css`（**纯覆盖层**，
  对叠加顺序敏感）；`App.tsx` → `videosBatchStudio.css` + `contentUx.css`。**先确认改的是哪一层**。
- **判死 CSS 四重法**：① `src/client/**/*.tsx` 拼串 `includes()` 类名（前缀类有传递性）；
  ② 全仓扫描（排 node_modules/.git/dist/output/.workbuddy）确认只有目标文件引用；
  ③ 前缀拼接兜底；④ `git log --all -S <name> -- '*.tsx' '*.ts'`。**保留例外**：React Flow 运行时
  注入的 `.react-flow__*` / `.connectingto` / `.connectionindicator`。**名字会骗人**：判死必读
  对应组件（`.vbs-debug-backdrop`/`.vbs-asset-preview` 是死的，不带前缀的 `.asset-preview` 活的）。
- 删**共享选择器只摘死的一半**（卡片表面的 `.vbs-form-card`、`
  .vbs-inline-facts span, .vbs-document-facts span` 这类成对规则、`.vbs-screenplay-list, .vbs-shot-list`）。
  批量删用 postcss（`output/prune-styles.mjs`，先 `--dry` 验 parse→stringify 与原文件 0 行差异），
  删完做结构性证明（`output/check-live-kept.mjs`：新增 0 / 活规则被删 0 / 死规则残留 0）。
- **零回归验证**：`output/shots/cmp.mjs` 全 DOM 每元素 17 项 computed 属性哈希 + 整页截图，
  「改后」「改前」各跑一次。**⚠️「零变化」必须先有阳性对照能变才算数**（曾出现改 token 指纹
  纹丝不动，实为该 token 无可见消费者；换 `--vbs-v2-canvas`/`--vbs-v2-text` 立刻变）。换文件
  比对时顺手 HTTP 验 dev server 真吐的是新文件（`/src/client/styles.css?direct`）。截图字节
  （±2%）只作旁证。排查「某条 computed 值是谁给的」用 CDP `CSS.getMatchedStylesForNode`。
- **⚠️ 行内 style 打赢一切 CSS**：`flow/buildGraph.ts` 与 `flow/pendingConnection.ts`
  **禁止**在 edge 上写 `style.stroke`——它落到 `<path>` 的行内样式，任何选择器都盖不住
  （曾经 56 条边全是写死的 `#fbbf24`，Focus 层的边色规则是死的）。**边色只在 CSS 给**（读
  `--vbs-v2-edge*`），builder 只写 `strokeWidth / strokeDasharray / opacity`。
  xyflow v12 的基础边色走 CSS 变量：`--xy-edge-stroke` / `--xy-edge-stroke-selected` /
  `--xy-edge-stroke-width`，画布块里覆盖它们即可。**背景点阵是 `<circle>` 用 `fill` 不是 `stroke`**，
  老规则 `.react-flow__background-pattern line, path{stroke}` 从来没匹配上。
- **暖色审计脚本** `output/canvas-brass-visible.mjs`（改任何颜色后跑一遍）：遍历 shell 内元素读
  `color/background/border/fill/stroke` + `::before/::after`，判暖 = `r-b>45 && g-b>20 && r>130`。
  两条必须：① 加 `getClientRects().length>0` **可见性过滤**——画布模式下 SeeReel 的
  topbar/sidebar 仍在 DOM 里（`display:none`），`getComputedStyle` 照样返回颜色，会造假阳性；
  ② 用 `g-b` 区分，否则 danger 红 `rgb(242,162,162)` 会被当成黄铜。

## 三、设计主题（2026-09-14 那轮，已提交 `2ae3e47`）

- **一个度量 / 一块板 / 黄铜稀缺**：所有 surface 对齐 `--vbs-v2-measure:1080px`
  （`--vbs-v2-gutter: max(28px, calc((100% - 1080px)/2))`）；每步同一块 slate 头；
  **amber 只作「有人工闸门待确认」的信号**（`confirm` 轨道点 + 模式提示），其余全是墨色在纸上。
- **画布有意不共用 1080 measure**——图要宽度，用 `--vbs-v2-canvas-inset`。纪律是
  **一个面一条内缩，绝不两条**。
- **画布上的黄铜 = 「手握着的线」**：拖动中的连接线、optimistic 边（`.edge-pending`）、被点中的边。
  handle / 节点色条 / 按钮 / 选中边框 / 参考图条全是墨。节点色条是**无黄铜的哑光 family**。
- **画布可读性靠聚焦不靠颜色**：`FlowView.tsx` 的 `displayEdges` 按 `selectedNodeId` 给相连边加
  `edge-linked`、其余加 `edge-dimmed`。56 条边同色不丢信息——原先 5 种色相没图例，本来就是噪声。
- 不引 webfont（CJK 字体兆级、大陆不稳）——靠字号/字重/字距/tabular-figures + sans/mono 配对。
- canvas 模式 accent 有意更深（`#9c6f10` / `#fbf3e0`），写在 tokens.css 覆盖块里；
  `--vbs-canvas-*` 平行命名已废除。
- 节点状态点暖色只有一个来源 `var(--vbs-v2-accent)`；蓝/绿/红三个点仍是**状态**，不动。
- 操作细节（审计脚本、四条铁律、收尾清单）见技能 **`videosbatch-ui-retheme`**。

## 四、运行模式与入口

- **文本/媒体两个独立开关，缺省即 fake**（`server/videosBatchWorkflow/runtimeProvider.ts`）：
  `VIDEOSBATCH_EXECUTOR_MODE` ∈ `fake|llm`，`VIDEOSBATCH_MEDIA_MODE` ∈ `fake|native`。
  `MEDIA_MODE=fake` → 图片/视频永远不产出（「有的能生成有的不能」不是 bug 是模式）。真出片需
  `MEDIA_MODE=native` + `EXECUTOR_MODE=llm`；**native 复用 SeeReel 的付费凭据，切换前必须用户点头**。
- 「自动运行到确认点」= `POST /api/sessions/<id>/videosbatch/run-all`，按设计停在第一个需人工
  确认的步骤（footer 变灰显示「请完成当前确认」），不是卡死。
- `/gallery` 是「Gallery 创作广场」分享页，**不是任务中心**；任务列表只是外壳左栏
  `aside.sidebar`（这正是「进门找不到新建/切换」的根因）。`/canvas/<id>` 是 9 步工作台，
  `/canvas` 不带 id 会落回最后一个 session（不是新建页）。
- 工作台用 `components/ModeBanner.tsx` 明说「模拟模式：图片与视频不会真实生成」，可关闭并用
  sessionStorage 记住。
- 会话命名在 `src/shared/sessionTitle.ts`（前后端共用，保证乐观行与持久化行一致）：空标题或
  `/^un(?:n)?amed session\s+\d+$/i` → `课程视频 · MM-DD HH:mm`；**用户自起标题永不覆盖**；
  `store.load()` 做内存迁移不写盘。列表/菜单显示步骤进度而不是镜头数。`/api/state` 的
  `runtime.videosBatch` 暴露模式与 ready 状态（服务端 try/catch 包住，环境非法降级成 `error` 字段）。

## 五、清理死代码（2026-09-14 第二轮）

通用方法论见技能 **`ts-deadcode-cleanout`**。本项目专属的几条：

- **四层 + 各层判据**：不可达文件（TS 编译器 API 建 `src+scripts` 模块图，**必须识别
  `import()`/`require()`**，否则 `lazy(() => import(...))` 会被误判成死）；未被导入的导出
  （分 `[D]` 真死 / `[e]` 只摘 `export`）；模块内私有死代码（`tsc --noUnusedLocals`，**会级联，
  迭代到收敛**）；死 CSS（postcss + 全仓 code 语料）。本仓库结果：**0 孤儿文件**。
- **⚠️ 共享选择器**：`.a, .b { font-weight:600 }` 只 `.b` 被覆盖时，删声明连 `.a` 的一起删了
  → 1075 处 computed 差异。条件是**每个选择器都被同上下文同属性覆盖**才可删。
- **⚠️ 删语句吞前导换行**：`getFullStart()` 会粘出 `import A;import B;`（tsc 不报错）。
- **⚠️ 按源码文本断言的 smoke 有两类，都要扫**：
  (a) 正则要求 `export type X` 存在（`smoke-audio-separation.ts:9`）——摘 `export` 会红；
  扫 `assert.*export (const|function|type|interface|class)`。
  (b) **更阴**：私有函数名被用作**正则锚点/终止符**。`smoke-canvas-video-node-playback.ts:6`
  曾用 `/function RobustVideoThumb[\s\S]*?\n}\n\nfunction statusBadge/` 抽函数体，
  `statusBadge` 只是"紧随其后的那个函数"；`--noUnusedLocals` 正确删掉它 → smoke 红，
  而 tsc 绿、全 DOM 零差异、其余 smoke 全绿。修法是改锚点为
  `\n}\n\n(?=(?:export )?(?:async )?function |(?:export )?const |// )`，**不是把死代码加回来**。
  扫法：抽脚本里所有 `function NAME`，逐个确认 `src/` 里还有。
- **共享词汇表不要收紧**：`src/shared/types.ts` 是项目共享域词汇，导出就是这文件的产品
  （且已有 smoke 把它写成契约）。这类文件保留全部导出；收紧实现模块即可。
- **验证顺序**：① `tsc --noEmit` → ② `tsc --noEmit --noUnusedLocals`（迭代到空）→
  ③ 全 DOM 逐元素 computed 差异（必须先有**阳性对照**证明这测法能测出变化）→
  ④ 结构性证明（每个 (上下文,选择器,属性) 的最终生效值一致）→ ⑤ `npm run verify:offline`。
  **⑤ 是唯一能抓到"文本锚点"那类断裂的**（`&&` 链会在第一个红的 smoke 处断掉，
  后面几十个根本没跑）。
- **工具落点（`output/` 被 gitignore，删了就没了）**：`deadcode.mjs`、`deexport.mjs`、
  `prune-css.mjs`、`check-css-prune.mjs`、`elem-dump.mjs`、`prune-unused.mjs`、`css-dup.mjs`。
- **`verify:offline` 里会自己起服务器的用例**（`smoke:canvas-crud` 等）——跑之前先腾空 5173，
  否则报 EADDRINUSE 假失败。

## 六、环境备忘

- 启动 dev：`node node_modules/tsx/dist/cli.mjs src/server/index.ts`（默认 5173）。**别用 npx**
  （沙箱会劫持到 wsl.exe 并拦掉）。类型检查 `node node_modules/typescript/bin/tsc --noEmit`；
  构建 `node node_modules/vite/bin/vite.js build`。释放端口：
  `Get-NetTCPConnection -LocalPort 5173 -State Listen` + `Stop-Process -Force`
  （bash 里 `taskkill //PID` 会被 Git Bash 吃掉参数，别用）。
- 截图/DOM：chromium 在 `C:/Users/HB/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe`，
  用仓库内 playwright-core 驱动；入口 `http://127.0.0.1:5173/canvas/<sessionId>`。
- git 用系统版 `C:/Program Files/Git/mingw64/bin/git.exe`；**提交前 `git status` 逐行确认**
  （仓库多会话共用，不要 `git add -A`）。
