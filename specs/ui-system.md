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

## Acceptance Criteria

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

## Verification

- [ ] `npm run smoke:specs`
- [ ] `npx tsx scripts/smoke-videosbatch-guided-studio-v2.tsx`
- [ ] `npm run verify:offline`
- [ ] Open `http://localhost:5173/canvas/ses_demo_agent_plan` or the current demo session.
- [ ] Check desktop, narrow desktop, and mobile widths.
- [ ] For release changes, verify `https://seereel.studio` after deployment.

## Change Policy

Update this spec before broad UI redesigns and with any fix that changes responsive behavior, canvas layering, or core visual hierarchy.
