# VideosBatch Visual Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the existing Guided Studio V2 into one coherent warm-white Editorial AI Studio visual language across all nine product stages without changing workflow semantics, upload behavior, scrolling, API contracts, or the canonical 13-stage state machine.

**Architecture:** Keep the current `VideosBatchHeader + WorkflowProgressRail + StudioStageToolbar + StageWorkspace + WorkflowFooter` information architecture. Use the existing `guidedStudioV2.css` as the canonical V2 visual layer, map legacy `--vbs-*` tokens onto the V2 token family, and only make targeted markup changes where CSS alone cannot express the desired hierarchy. Existing stage components remain semantically intact.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Radix UI 1.6.7, Lucide React, plain scoped CSS.

**Spec:** `docs/superpowers/specs/2026-08-29-videosbatch-guided-studio-v2-design.md`

## Global Constraints

- Do not change the canonical 13-stage VideosBatch workflow semantics.
- Do not change upload parsing, file limits, accepted formats, scroll behavior, Canvas switching, or API contracts.
- Preserve the nine product steps and their existing status derivation.
- Preserve Radix accessibility primitives and `react-dropzone` upload interaction.
- Do not add font binaries, webfonts, shadcn source, a new CSS framework, or a new design-system dependency.
- Keep `prefers-reduced-motion` support.
- Guided flow must continue to use natural document scrolling, not a nested clipped viewport.
- Verification must include the existing Guided Studio smoke test, `npm run smoke:specs`, `npm run build`, and `npm run verify:offline` when CI/runtime execution is available.

---

### Task 1: Lock the Visual Consolidation Contract

**Files:**
- Modify: `docs/superpowers/specs/2026-08-29-videosbatch-guided-studio-v2-design.md`
- Modify: `scripts/smoke-videosbatch-guided-studio-v2.tsx`

**Interfaces:**
- Consumes: existing Guided Studio V2 component hierarchy and status model.
- Produces: source-level regression assertions for the canonical V2 token set, timeline-style progress rail structure, and delivery-page classes.

- [ ] **Step 1: Add the approved Visual Consolidation section to the design spec**

Document that the pass is a visual-system consolidation rather than another workflow redesign. Define canonical tokens, surface roles, typography, state language, and the requirement that all nine steps feel like one studio.

- [ ] **Step 2: Add failing source-contract smoke assertions**

Extend `scripts/smoke-videosbatch-guided-studio-v2.tsx` with assertions that:

```ts
const headerSource = readFileSync(new URL("../src/client/videosBatchStudio/VideosBatchHeader.tsx", import.meta.url), "utf8");
const railSource = readFileSync(new URL("../src/client/videosBatchStudio/components/WorkflowProgressRail.tsx", import.meta.url), "utf8");
const v2CssSource = readFileSync(new URL("../src/client/videosBatchStudio/guidedStudioV2.css", import.meta.url), "utf8");
const finalStageSource = readFileSync(new URL("../src/client/videosBatchStudio/stages/FinalVideoStage.tsx", import.meta.url), "utf8");

assert.ok(headerSource.includes("AI 课程视频工作室"));
assert.ok(railSource.includes("vbs-v2-progress-node"));
assert.ok(v2CssSource.includes("--vbs-v2-radius-card"));
assert.ok(v2CssSource.includes("--vbs-v2-shadow-raised"));
assert.ok(v2CssSource.includes("--vbs-bg: var(--vbs-v2-canvas)"));
assert.ok(finalStageSource.includes("vbs-final-delivery"));
```

- [ ] **Step 3: Run the focused smoke test and confirm it fails before implementation**

Run:

```bash
npx tsx scripts/smoke-videosbatch-guided-studio-v2.tsx
```

Expected: FAIL on one or more newly introduced visual-contract assertions.

- [ ] **Step 4: Commit the contract changes**

```bash
git add docs/superpowers/specs/2026-08-29-videosbatch-guided-studio-v2-design.md scripts/smoke-videosbatch-guided-studio-v2.tsx
git commit -m "test: define VideosBatch visual consolidation contract"
```

### Task 2: Consolidate Tokens and Shared Surface Language

**Files:**
- Modify: `src/client/videosBatchStudio/guidedStudioV2.css`
- Modify: `src/client/videosBatchStudio/contentUx.css` only if a selector cannot be safely overridden in the V2 layer.

**Interfaces:**
- Consumes: legacy stage classes and existing `--vbs-*` variables from `videosBatchStudio.css`.
- Produces: canonical V2 tokens plus backwards-compatible aliases used by every existing stage component.

- [ ] **Step 1: Add canonical tokens to `.videosbatch-studio-v2`**

Use this exact token family:

```css
--vbs-v2-canvas: #f6f4ef;
--vbs-v2-canvas-warm: #faf8f3;
--vbs-v2-surface: #ffffff;
--vbs-v2-surface-muted: #f8f6f1;
--vbs-v2-text: #191c20;
--vbs-v2-text-soft: #74716a;
--vbs-v2-border: #e8e4da;
--vbs-v2-border-strong: #d9d3c7;
--vbs-v2-accent: #d8a640;
--vbs-v2-accent-deep: #866315;
--vbs-v2-accent-soft: #fbf4df;
--vbs-v2-success: #557761;
--vbs-v2-danger: #ad5a50;
--vbs-v2-radius-control: 10px;
--vbs-v2-radius-card: 18px;
--vbs-v2-radius-focus: 22px;
--vbs-v2-shadow-raised: 0 12px 34px rgba(25, 28, 32, 0.055);
--vbs-v2-shadow-selected: 0 10px 28px rgba(25, 28, 32, 0.08);
--vbs-v2-transition: 170ms ease;
```

- [ ] **Step 2: Alias the legacy component tokens inside V2**

```css
--vbs-bg: var(--vbs-v2-canvas);
--vbs-surface: var(--vbs-v2-surface);
--vbs-surface-subtle: var(--vbs-v2-surface-muted);
--vbs-text: var(--vbs-v2-text);
--vbs-muted: var(--vbs-v2-text-soft);
--vbs-border: var(--vbs-v2-border);
--vbs-accent: var(--vbs-v2-accent);
--vbs-accent-soft: var(--vbs-v2-accent-soft);
--vbs-success: var(--vbs-v2-success);
--vbs-danger: var(--vbs-v2-danger);
```

This removes the current split where V1 semantic stage components and V2 shell render with similar but different palettes.

- [ ] **Step 3: Normalize shared surfaces**

Apply one consistent border/radius/shadow language to:

```css
.vbs-form-card,
.vbs-note-card,
.vbs-empty-card,
.vbs-intro-card,
.vbs-asset-plan-card,
.vbs-asset-card,
.vbs-screenplay-scene,
.vbs-shot-card,
.vbs-video-shot-card,
.vbs-storyboard-item,
.vbs-progress-card
```

Use borders for structure, shadow only for raised/selectable/focus content, and avoid decorative gradients outside upload/final-delivery emphasis.

- [ ] **Step 4: Normalize form focus and button motion**

Use the same amber focus ring and `170ms` transition across tabs, buttons, text areas, selectable cards, and icon controls. Keep disabled states unchanged semantically.

- [ ] **Step 5: Re-run the focused smoke test**

```bash
npx tsx scripts/smoke-videosbatch-guided-studio-v2.tsx
```

Expected: token-related assertions PASS; header/rail/final-delivery assertions may still fail until later tasks.

- [ ] **Step 6: Commit**

```bash
git add src/client/videosBatchStudio/guidedStudioV2.css src/client/videosBatchStudio/contentUx.css
git commit -m "style: consolidate VideosBatch visual tokens"
```

### Task 3: Refine Product Header and Production Timeline

**Files:**
- Modify: `src/client/videosBatchStudio/VideosBatchHeader.tsx`
- Modify: `src/client/videosBatchStudio/components/WorkflowProgressRail.tsx`
- Modify: `src/client/videosBatchStudio/guidedStudioV2.css`
- Modify: `src/client/videosBatchStudio/guidedStudioV2Focus.css` only to keep the focus-mode size overrides aligned.

**Interfaces:**
- Consumes: `sessionTitle`, `completedCount`, `totalSteps`, `VideosBatchProductStatus`, and `onSelectStep` exactly as today.
- Produces: unchanged behavior with a quieter 72px product header and a status-aware timeline presentation.

- [ ] **Step 1: Simplify the header hierarchy**

Render brand copy as:

```tsx
<div className="vbs-v2-brand-title">
  <strong>VideosBatch</strong>
  <span>AI 课程视频工作室</span>
</div>
```

Remove the long explanatory sentence from the header. Keep the project title and completion count but visually flatten the project meta from a boxed card into compact inline metadata. Keep `流程制作 / 制作画布` behavior unchanged.

- [ ] **Step 2: Convert the progress rail markup to node + copy**

Inside each existing button, render:

```tsx
<span className="vbs-v2-progress-node" aria-hidden="true"><StatusIcon status={status} /></span>
<span className="vbs-v2-progress-copy">
  <span className="vbs-v2-progress-index">{String(index + 1).padStart(2, "0")}</span>
  <span className="vbs-v2-progress-label">{step.label}</span>
</span>
```

Do not change click handlers, accessibility labels, status derivation, or horizontal scrolling.

- [ ] **Step 3: Style the rail as a production timeline rather than nine pills**

Use connector lines between nodes, neutral pending nodes, green ready nodes, amber current/confirm nodes, danger failed nodes, and a restrained selected background. State remains visible through icon + color, not color alone.

- [ ] **Step 4: Align focus-mode overrides**

Ensure `guidedStudioV2Focus.css` does not force the old pill heights/radii and keeps natural document scrolling unchanged.

- [ ] **Step 5: Run smoke**

```bash
npx tsx scripts/smoke-videosbatch-guided-studio-v2.tsx
```

Expected: header and rail assertions PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/videosBatchStudio/VideosBatchHeader.tsx src/client/videosBatchStudio/components/WorkflowProgressRail.tsx src/client/videosBatchStudio/guidedStudioV2.css src/client/videosBatchStudio/guidedStudioV2Focus.css
git commit -m "style: refine VideosBatch header and timeline"
```

### Task 4: Normalize Stage Typography, Cards, Upload, and States

**Files:**
- Modify: `src/client/videosBatchStudio/guidedStudioV2.css`
- Modify: `src/client/videosBatchStudio/contentUx.css` only when necessary.

**Interfaces:**
- Consumes: all existing stage markup without behavioral changes.
- Produces: consistent title rhythm, card depth, selection, focus, loading, empty, and upload presentation across steps 01–08.

- [ ] **Step 1: Normalize typography**

Set product/stage hierarchy to:

```text
Stage title: 30–36px / 650
Section title: 18–22px / 650
Body: 14–15px / 400
Metadata: 11–12px / 400–650
Step number: 10px / 700
```

Use the existing system stack; do not add fonts.

- [ ] **Step 2: Refine lesson upload without changing `react-dropzone` behavior**

Replace the dashed-border visual with a 1px solid warm border, very light warm gradient, 20–22px radius, and restrained hover lift. Keep the icon, keyboard/file-picker interaction, errors, parse preview, and both tabs unchanged.

- [ ] **Step 3: Normalize selectable cards**

Intro candidates and asset candidates use the same selected treatment: amber border/ring, raised shadow, and semantic selected badge. Hover lift is limited to 1px.

- [ ] **Step 4: Normalize dense authoring surfaces**

Story, screenplay, storyboard, and video-generation cards use consistent inner padding and borders, but do not force every dense editor into a large raised card. Preserve readable long-form surfaces and native media previews.

- [ ] **Step 5: Normalize state surfaces**

Map success/confirm/error/loading/empty surfaces onto the same green/amber/red/neutral token language. Do not replace text feedback with color-only indicators.

- [ ] **Step 6: Run existing content UX and Guided Studio smoke tests**

```bash
npx tsx scripts/smoke-videosbatch-content-ux.tsx
npx tsx scripts/smoke-videosbatch-guided-studio-v2.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/client/videosBatchStudio/guidedStudioV2.css src/client/videosBatchStudio/contentUx.css
git commit -m "style: unify VideosBatch stage surfaces"
```

### Task 5: Turn Step 09 into a Delivery Surface and Verify the Full Pass

**Files:**
- Modify: `src/client/videosBatchStudio/stages/FinalVideoStage.tsx`
- Modify: `src/client/videosBatchStudio/guidedStudioV2.css`
- Modify: `scripts/smoke-videosbatch-guided-studio-v2.tsx`

**Interfaces:**
- Consumes: `preferredFinalVideo(session)`, `artifact.finalVideoUrl`, existing download URL, and `onOpenCanvas`.
- Produces: the same playback/download/canvas actions inside a stronger final-delivery composition.

- [ ] **Step 1: Introduce semantic delivery markup**

Wrap the existing final-stage content in:

```tsx
<div className="vbs-final-delivery">
  <div className="vbs-final-delivery-copy">...</div>
  <div className="vbs-final-delivery-media">...</div>
</div>
```

Keep the existing status logic, video element, download anchor, and Canvas button unchanged.

- [ ] **Step 2: Style Step 09 as a calm handoff page**

Use a larger focus surface, restrained accent, prominent final player, completion badge when ready, and clearly separated primary download vs secondary Canvas action. Avoid confetti, illustrations, and high-saturation celebration effects.

- [ ] **Step 3: Run focused tests**

```bash
npx tsx scripts/smoke-videosbatch-guided-studio-v2.tsx
npx tsx scripts/smoke-videosbatch-content-ux.tsx
npm run smoke:specs
npm run build
```

Expected: PASS.

- [ ] **Step 4: Run the project-required offline verification**

```bash
npm run verify:offline
```

Expected: PASS. If the current execution environment cannot run repository commands, record that limitation and rely on GitHub CI/status rather than claiming local verification.

- [ ] **Step 5: Review the diff specifically for scope leakage**

Confirm there are no changes to:

- `src/shared/videosBatchWorkflow.ts` state-machine semantics;
- server workflow runner/API behavior;
- lesson document parsing;
- upload accepted types/size;
- Canvas mode contract;
- natural page scrolling contract.

- [ ] **Step 6: Commit**

```bash
git add src/client/videosBatchStudio/stages/FinalVideoStage.tsx src/client/videosBatchStudio/guidedStudioV2.css scripts/smoke-videosbatch-guided-studio-v2.tsx
git commit -m "style: finish VideosBatch editorial delivery polish"
```
