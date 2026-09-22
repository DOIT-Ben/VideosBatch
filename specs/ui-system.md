# UI System

Status: active
Owner: SeeReel
Last Reviewed: 2026-08-30

## Purpose

Define the durable visual and interaction rules for the SeeReel workstation so the canvas stays readable, premium, and useful across desktop, narrow desktop, and mobile screens.

## Scope

- Canvas background, node contrast, panels, toolbars, inspector surfaces, and responsive behavior.
- Local development, production local runs, and the deployed site.
- Visual rules that affect the main SeeReel session workspace.
- VideosBatch Guided Studio visual hierarchy when the product owns the focused workflow surface.

VideosBatch 的阶段语义、提示词和产物合同不在本 UI 规格中定义，统一见
[`videosbatch-workflow-canonical.md`](videosbatch-workflow-canonical.md)。

## Non-Goals

- This spec does not define marketing landing pages.
- This spec does not choose exact copy for every button.
- This spec does not replace component-level implementation details.

## User Stories

- As a creator, I can read node labels and status information at a glance.
- As a mobile user, I can inspect a session without text overlapping or controls disappearing.
- As an operator, I can visually distinguish canvas, nodes, active selections, and side panels.
- As a VideosBatch user, I can move through all nine production steps without the product appearing to switch visual systems between stages.

## Product Rules

- The canvas and nodes must not use the same effective darkness level; node boundaries must remain visible without hover.
- Primary actions must remain reachable on desktop and mobile, but dense toolbars should collapse or wrap instead of clipping text.
- Button text must fit its container at supported viewport widths.
- UI hierarchy should be calm and product-focused; avoid decorative effects that reduce readability.
- SeeReel is an operational creative workstation, so the first screen should be usable product UI rather than a marketing splash.
- The top action strip should not expose unlabeled utility controls whose behavior is already covered by automatic refresh, node-level controls, or keyboard-driven canvas recovery.
- Public entry into SeeReel defaults to Chinese unless the user has explicitly chosen a language in the current language-preference version.
- UI must preserve spatial continuity: content or controls already shown to the user must not disappear and reappear somewhere else unless the movement is caused by an explicit user action such as navigation, tab switching, filtering, expanding, collapsing, or responsive layout transition.

## VideosBatch Guided Studio Rules

- Guided Studio is a warm-white Editorial AI Studio, not a dark developer tool, admin dashboard, or high-saturation Canva-like creation surface.
- `.videosbatch-studio-v2` is the canonical visual scope. Legacy `--vbs-*` semantic component tokens must resolve to the V2 token family while inside that scope rather than defining a second near-duplicate palette.
- The product header remains one quiet product navigation layer. Project metadata must not read as a separate heavy card competing with brand and mode navigation.
- The nine-step `WorkflowProgressRail` remains the product workflow navigator and must preserve status semantics, click targets, accessibility labels, and horizontal scrolling. Visual polish may make it read as a connected production timeline but must not simplify away running, confirm, stale, failed, or ready states.
- Shared content surfaces use three roles: normal Surface Card, interactive Selectable Card, and primary Focus Card. Dense long-form editors should remain flatter rather than turning every section into a raised card.
- Warm amber is an accent, not a page fill. Completed workflow state uses low-saturation green; failure uses explicit red; pending remains neutral.
- Card hover lift is limited to 1px and all nonessential motion must respect `prefers-reduced-motion`.
- The lesson upload visual may change, but `react-dropzone`, supported formats, parsing, text confirmation, and start-workflow behavior remain unchanged.
- Before workflow start, edits to parsed lesson text expose an explicit save action and persist as a session-scoped local draft so stage/mode remounts do not discard unconfirmed work; the server workflow remains the source of truth after confirmation.
- Step 09 may have stronger delivery-page emphasis, but final playback, download, StitchJob state, and Canvas switching behavior remain unchanged.
- Status language must stay consistent inside one step surface: the stage toolbar status badge must not contradict the stage body (for example "已完成" alongside "正在生成视频 0/12"); when the workflow stage is ready but downstream media is not generated yet, the body must say what is actually pending.
- When the workflow is completed, the stage toolbar must not keep showing a disabled run control; workflow-complete state is communicated through the rail, header count, and footer instead.
- All nine steps must be able to reach `ready` so the header count can reach 9 / 9; no product step may be structurally unable to leave `pending`.
- Canvas mode shares the workflow studio's warm-white Editorial color temperature: the `--vbs-canvas-*` token family resolves to the same warm canvas, border, and text values as `--vbs-v2-*`, node type identity strips and handles use the warm accent family, and per-type tag chips keep their distinct semantic hues for classification.

## Acceptance Criteria

### 2026-09-22 Task discovery and guided-workflow usability

- Task discovery shares the studio's paper/ink tokens, with one page title and one primary creation action. Search, status filters and sort work locally on existing sessions; no mutation or hidden deletion is implied by filtering.
- Task rows show a readable title, current step/status, last update and one continue action. Progress reflects the nine existing product-step states, never invented percentages. Empty search results offer a clear reset.
- Workflow action labels identify the result to be generated. Manual confirmation and completed states use explanatory text instead of inert primary buttons. Browsing another step exposes a return-to-current action.
- Long operations remain explicitly visible without claiming an ETA. Re-running a step and continuous generation explain their scope before dispatch; non-destructive step navigation does not prompt.
- All rail statuses have Chinese accessible labels. The selected step remains in view on narrow screens, and left/right/Home/End keyboard navigation moves focus without starting a generation.
- At 390, 768 and 1440px, task controls, document headings, editors and the footer fit without page-level horizontal overflow. Touch targets are at least 40px, keyboard focus is visible, and reduced motion is honored.
- These are presentation and interaction contracts only; stage order, manual gates, provider selection and draft persistence remain governed by the canonical workflow spec.

- [ ] Node title, status, and primary action controls are readable on a 390px-wide viewport.
- [ ] Canvas background, node body, node border, selected node, and inspector panel have visible contrast.
- [ ] Toolbars wrap, collapse, or scroll intentionally instead of hiding button labels.
- [ ] No visible text overlaps adjacent controls in the main session workspace.
- [ ] The top action strip does not show the global VLM checkbox or a standalone manual refresh icon.
- [ ] A fresh visit with only the legacy `uiLanguage=en` preference still starts in Chinese.
- [ ] Previously visible content or controls do not unexpectedly vanish and reappear in another area during normal loading, refresh, polling, or background state updates.
- [ ] Production and local UI use the same committed styles, with no server-only manual patch.
- [ ] VideosBatch shell and stage components resolve to one coherent V2 palette and typography hierarchy.
- [ ] VideosBatch progress navigation still exposes all nine steps and every existing workflow state after visual polish.
- [ ] VideosBatch workflow mode keeps natural document scrolling and does not introduce an inner clipped viewport.
- [ ] VideosBatch lesson upload and final delivery retain their existing functional contracts after visual polish.
- [ ] A completed fake-mode workflow shows 9 / 9 in the header, no disabled auto-run control in the stage toolbar, and no "已完成" badge contradicting a "生成中/等待" stage body.
- [ ] The asset confirmation step never reaches a state where the confirmation bar is hidden while the workflow gate still waits for confirmation.
- [ ] Canvas mode nodes, edges, handles, inspector, and toolbar read as the same warm-white Editorial system as the workflow steps, with no cold-blue surfaces or teal chrome left over.

## Verification

- [ ] `npm run smoke:specs`
- [ ] `npx tsx scripts/smoke-videosbatch-guided-studio-v2.tsx`
- [ ] `npm run verify:offline`
- [ ] Open `http://localhost:5173/canvas/ses_demo_agent_plan` or the current demo session.
- [ ] Check desktop, narrow desktop, and mobile widths.
- [ ] For release changes, verify `https://seereel.studio` after deployment.

## Change Policy

Update this spec before broad UI redesigns and with any fix that changes responsive behavior, canvas layering, or core visual hierarchy.


## 2026-09-22 Automated workspace acceptance contract

Implementation status: `docs/adr/automation-workspace-plan.md`; these are accepted requirements, not a completion claim.

- One task center and the existing editor share run identity. Batch actions show eligible items and per-item outcomes; one failure does not lock other projects.
- Waiting, running, needs-attention, paused, stopping, failed and done use explicit Chinese labels. Request-in-flight is distinct from server-confirmed state.
- Realtime updates preserve focus, draft, selection, expansion and scroll anchors. Follow appended content only while already at the bottom and not editing. No fabricated stream, ETA or percentage.
- Draft/save/conflict/offline states distinguish local cache from durable server content. Save does not start generation; save-and-continue targets the saved revision. A failed continuation says saved-but-not-started.
- Task switching preserves navigation context. Ctrl/Cmd+S belongs to the editor only; dialogs restore focus, announcements do not flood and reduced motion is respected.
- Dense task management remains operable at 390/768/1440px. Performance fixtures and proposed thresholds are defined in ADR-0005 and must be measured rather than presumed.
- No quote, pricing, credit or payment UI is introduced or reworked.

### P3 事件与游标具体合同

一个页面一条fetch SSE（访问头不放URL），多owner可见范围用于本机共享和管理员模式。scope是授权session集合的摘要，offsets分别是每个owner的连续sequence；每包previous/cursor明确承认授权子集中过滤的事件，客户端只在previous等于当前cursor时应用，重复包忽略，缺口/乱序重新取快照。scope变化、超前或过期游标返回完整授权快照；cursor不是凭证。每owner保留最新10000条事件，心跳15秒，连接5分钟重建以重新认证；慢消费者断开重连。健康事件流时旧全局ETag轮询降至60秒；故障时运行快照和原状态轮询均5秒上限，页面隐藏不绘制内容，恢复可见后续接。

完整预览块须适配器显式提供validatePreview并通过校验，作为临时预览存储，与正式workflow分离；当前生产适配器没有该能力，诚实显示阶段/工作项反馈。正式内容局部按session读取，成功落盘后才成为saved；不改QUOTE。


### ADR-0006 P4 编辑发布合同（2026-09-22）

故事、视频剧本、分镜支持本机即时草稿、独立服务端草稿和显式发布。服务端确认草稿占用后暂缓相关后续派单；未发布草稿在租约过期后仍阻塞，另一页面不能释放该占用。在途工作完成其冻结版本后，发布在同一项目写屏障应用。其他项目及当前编辑输入不被锁定。

发布携带 expectedRevision、稳定 requestId、draftId 和页面实例；冲突保留双方内容，明确对照后才能重新基于新版编辑。保存期间新增文本不得被迟到响应清除；保存成功保留编辑器焦点。Ctrl/Cmd+S 仅编辑器内生效。

保存只发布新版本并保留失效下游成果。保存并继续持久化该精确版本的推进意图，投影完成后入队；重放与崩溃恢复不增重复版本、不重复生成，入队失败显示已保存尚未开始。人工关卡确认并继续复用相同合同。报价接口、内容及校验保持原样。

### ADR-0006 P5 任务管理合同（2026-09-22）

任务页共享后台Run状态，支持全部、执行中、等待、待处理、已完成筛选。多选开始/暂停/继续/停止后续/重试失败项先列出适用项与原因，服务端再次检查权限及版本，返回逐项回执；同请求重放不重复执行。排队优先级仅影响尚未开始的工作。列表分页保证大列表输入响应，保留筛选及位置；项目切换保留步骤、展开、草稿和编辑焦点位置。局部镜头操作固定选择范围，成功项复用、缺少范围外依赖时报待处理，不静默扩大执行范围。QUOTE合同不变。
