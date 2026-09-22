# 自动化工作台本地验收证据

2026-09-22；对应 ADR-0004/0005/0006、specs/ui-system.md 与 specs/videosbatch-workflow-canonical.md。阶段状态只由 automation-workspace-plan.md 维护。

## 环境与边界

- Windows、Intel Core i9-14900HX（32逻辑CPU）、物理内存34,070,192,128字节、Node22.22.0；IAB Chromium153.0.0.0，1280×720。默认刷新率，未做CPU/网络节流；暖缓存测量。
- scripts/fixtures/production-performance.tsx 使用实际 TaskList、VideosBatchStudio、useStageDraft、useRunEvents、RunStore及App共享的mergeProductionView/mergeStateById；传输是浏览器内合成 SSE ReadableStream，草稿API为替身。完整view回执包含workflow/shots/assets，经实际合并路径更新组件。双requestAnimationFrame记录下一次绘制机会，属于前端接收到可见反馈的近似上界，不含真实网络/Provider时间。
- 完整应用交互运行于随机临时data的localhost:5188，fake/fake；真实SSE鉴权/重连和持久化另由真实HTTP/SQLite集成测试覆盖。没有真实Provider/生产容量或代理验收结论。

## 固定浏览器负载

1000项目摘要，5活跃项目、合计60镜头，当前页20000字；实际CUA点击切换和输入。10事件/秒持续60秒，在第30秒加入100事件/秒持续1秒，共700事件。

| 指标 | 样本数 | p95 | 最大值 | 目标 |
|---|---:|---:|---:|---:|
| 本地输入反馈 | 30 | 17.7ms | 17.7ms | ≤100ms |
| 缓存项目切换到绘制 | 31 | 13.5ms | 15.5ms | ≤300ms |
| SSE数据到绘制 | 700 | 20.8ms | 27.3ms | ≤250ms |
| PerformanceObserver长任务 | 0 | — | — | 无>200ms |

输入后的正文20060字（保留首轮30字草稿，再输入30字）、selectionStart/End=30、焦点仍在编辑器；标题确实显示“性能验收正文 · 更新700”，证明内容props经过完整更新。报告sequence=700、revision=704。未缓存项目网络耗时未纳入上述缓存指标；应用已有可访问加载态，真实Provider首次生成延时不在此处推断。

首轮漏接productionView时测得输入24.3ms/切换13.4ms/事件20.9ms；因R1审查发现覆盖缺口，该轮仅作为局部状态证据，上表是补齐链路后的重测。

## 五项目故事、后继入队与回退

`npm run smoke:production-acceptance` 退出0；合成证据目录videosbatch-acceptance-0OCz0F。

- A执行、B待确认、C可重试失败、D服务端草稿、E排队同时存在。真实HTTP批量暂停A/E，A在途完成后暂停，E未提交。
- 打开真实鉴权SSE后断开，关闭并重新创建服务/控制库；暂停意图和D草稿保留。这里是服务对象重启；真实子进程退出故障由已有P0/P1/P4测试单独证明。
- 重试C、保存D并继续、确认B、恢复A/E，五项目到达资产确认。A已成功步骤执行1次、C仅失败步骤2次、E执行1次；D正文和revision+1保留。
- 32个无关卡阻塞的步骤结果返回到持久后继入队：p95=29.70ms，目标≤1秒。该指标包含结果校验/保存，不包含执行器计算时间。
- 待所有工作停稳后关闭控制库，共同复制整个data树；独立子进程恢复备份，逐项比较五项目workflow、revision、run身份，待投影数0。
- 明确停止旧all运行后调用原run-next等待接口，人工关卡仍保留。这验证同步入口降级；直接把数据库退回不认识新格式的历史二进制没有被执行，也不建议在存在活跃意图时这样做。
- 选中镜头与未选依赖/缺顶层URL的成功render复用，由native-media-resilience实适配器合成测试覆盖；没有付费生成。

测试开发期间修正了合成projectId不满足Pnnn合同、样本数不足、子进程tsx解析路径、降级入口owner身份和旧all计划未停止等夹具问题；未放宽产品合同来通过测试。

## 浏览器布局与键盘

- 完整应用在390/768/1440px实际视口验证：任务列表scrollWidth分别390/768/1440，无整页横向溢出；正文编辑器宽度344/721.15/1080，主体scrollWidth380/758/1430。手机步骤栏保留有意的内部横向滚动。
- 手机新增后台暂停/停止按钮实际高度44px；任务管理控件44px。未改变既有QUOTE呈现。
- 实际Enter打开“更多功能”，Escape关闭后activeElement的aria-label恢复“更多功能”。P4真实Ctrl+S保存与P5列表/编辑器往返光标、草稿保持证据继续有效。
- prefers-reduced-motion模拟已实际匹配，所测页面无运行CSS动画。测试后清除媒体/视口覆盖。
- 测试服务从5188移动到5190以让离线测试独占固定端口，仍使用同一个隔离临时data。

## 离线回归与关闭条件

- 最终隔离副本：`C:/Users/HB/AppData/Local/Temp/videosbatch-p6-final-o1arhblu`。按Git零分隔文件清单复制源码、无.env/用户data；依赖使用本机既有node_modules Junction，fake/fake。完整verify:offline成功前缀见verify-p6.log，旧资产确认文案断言修正后从该项起连续37项全部退出0，见verify-p6-remaining.log。没有删减任何必需测试。最终CSS优先级微调另经完整build/tsc和手机DOM回归通过。
- 包含旧CLI/画布/媒体/Quote工作流校验、全部P0—P5恢复与编辑回归，以及新增五项目acceptance；测试开发环境问题和修复保留在日志/阶段台账。
- 独立审查review_storage_p0：R1 REQUEST_CHANGES（性能路径缺口）；REWORK_1后R2 PASS。浏览器与离线通过后才关闭P6。
- 最终范围差异审查：包含QUOTE生成和校验的stages.ts相对09fdde9无差异；无新增价格/付费确认界面或支付接口。测试与实现均未调用真实Provider，未部署生产。
- 发布边界：本次为本地代码及模拟验收交付。真实适配器目前没有经过验证的正文逐块流能力，界面仅在适配器支持并通过块校验时显示临时预览；现有实际适配器主要显示真实阶段状态和已保存成果，未伪造流式文字。
