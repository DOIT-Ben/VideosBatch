# VideosBatch Product UI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the engineering-facing horizontal WorkflowRail as the primary VideosBatch UI with a guided 9-step product studio that defaults to workflow mode and preserves the existing SeeReel Canvas as an advanced second mode.

**Architecture:** Add a focused `src/client/videosBatchStudio/` product boundary. The studio derives 9 product steps from the canonical 13-stage workflow, renders a light Guided Studio shell, and uses existing VideosBatch API calls. `App.tsx` only chooses between `workflow` and `canvas` modes and forwards workflow state updates; existing `FlowView` remains unchanged.

**Tech Stack:** React 19, TypeScript, existing SeeReel client API, existing CSS pipeline, Node/tsx smoke tests, React server rendering for component contract tests.

**Spec:** `docs/superpowers/specs/2026-08-29-videosbatch-product-ui-design.md`

## Global Constraints

- `流程制作` is the default mode for a selected VideosBatch Session.
- `制作画布` renders the existing `FlowView` without changing native SeeReel Asset/Shot/Stitch models.
- Product UI exposes 9 human-facing steps while machine workflow remains the canonical 13 stages.
- No new server API is introduced in Foundation.
- Raw JSON is not the primary stage surface; it is available only through an explicit advanced/debug drawer.
- Guided mode uses light editorial styling; Canvas mode retains existing SeeReel styling.
- `App.tsx` must not absorb stage rendering logic.
- Existing VideosBatch and SeeReel regression tests must remain green.

---

### Task 1: Product step model and status mapping

**Files:**
- Create: `src/client/videosBatchStudio/stageModel.ts`
- Test: `scripts/smoke-videosbatch-product-ui-foundation.tsx`

**Interfaces:**
- Consumes: `VideosBatchStageId`, `VideosBatchWorkflowState`, `VideosBatchStageStatus` from `src/shared/videosBatchWorkflow.ts`.
- Produces:
  - `type VideosBatchProductStepId = "lesson" | "intro" | "story" | "asset-plan" | "assets" | "screenplay" | "storyboard" | "execution" | "final"`
  - `type VideosBatchProductStatus = "pending" | "running" | "ready" | "confirm" | "stale" | "failed"`
  - `VIDEOS_BATCH_PRODUCT_STEPS`
  - `productStepForStage(stageId)`
  - `deriveProductStepStatus(workflow, step)`
  - `deriveCurrentProductStep(workflow)`

- [ ] **Step 1: Write the failing foundation smoke test**

Create `scripts/smoke-videosbatch-product-ui-foundation.tsx` with assertions that:

```tsx
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { VIDEOS_BATCH_PRODUCT_STEPS, productStepForStage } from "../src/client/videosBatchStudio/stageModel";

assert.equal(VIDEOS_BATCH_PRODUCT_STEPS.length, 9);
assert.equal(productStepForStage("COURSE_INTRO_CANDIDATES"), "intro");
assert.equal(productStepForStage("COURSE_INTRO_SELECTION"), "intro");
assert.equal(productStepForStage("ASSET_CANDIDATES"), "assets");
assert.equal(productStepForStage("ASSET_CONFIRMATION"), "assets");
assert.equal(productStepForStage("FINAL_STORYBOARD"), "storyboard");
assert.equal(productStepForStage("COPYABLE_PROMPT"), "storyboard");
assert.equal(productStepForStage("QUOTE"), "execution");
assert.equal(productStepForStage("EXECUTION"), "execution");
```

The same smoke file will grow in later tasks.

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npx tsx scripts/smoke-videosbatch-product-ui-foundation.tsx
```

Expected: `ERR_MODULE_NOT_FOUND` for `videosBatchStudio/stageModel`.

- [ ] **Step 3: Implement `stageModel.ts`**

Define the exact 9-step configuration:

```ts
export const VIDEOS_BATCH_PRODUCT_STEPS = [
  { id: "lesson", label: "教案", stages: ["LESSON_INPUT"] },
  { id: "intro", label: "课程导入", stages: ["COURSE_INTRO_CANDIDATES", "COURSE_INTRO_SELECTION"] },
  { id: "story", label: "故事文稿", stages: ["STORY_SCRIPT"] },
  { id: "asset-plan", label: "资产计划", stages: ["ASSET_PLAN"] },
  { id: "assets", label: "资产图片", stages: ["ASSET_CANDIDATES", "ASSET_CONFIRMATION"] },
  { id: "screenplay", label: "视频剧本", stages: ["SCREENPLAY"] },
  { id: "storyboard", label: "视频分镜", stages: ["FINAL_STORYBOARD", "COPYABLE_PROMPT"] },
  { id: "execution", label: "视频生成", stages: ["QUOTE", "EXECUTION"] },
  { id: "final", label: "最终成片", stages: ["STITCH"] }
] as const;
```

Status mapping rules:

- any failed stage → `failed`
- any running stage → `running`
- any stale stage → `stale`
- `intro` while workflow cursor is `COURSE_INTRO_SELECTION` and intro not locked → `confirm`
- `assets` while workflow cursor is `ASSET_CONFIRMATION` and asset confirmation is not complete → `confirm`
- all stages in the product step are ready → `ready`
- otherwise → `pending`

`deriveCurrentProductStep` maps `workflow.currentStage` to its product step and returns `final` when `workflow.completed` is true.

- [ ] **Step 4: Run test to verify GREEN**

Run the smoke command and expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/videosBatchStudio/stageModel.ts scripts/smoke-videosbatch-product-ui-foundation.tsx
git commit -m "feat: add VideosBatch product step model"
```

---

### Task 2: Guided Studio shell, header, sidebar, and footer

**Files:**
- Create: `src/client/videosBatchStudio/VideosBatchHeader.tsx`
- Create: `src/client/videosBatchStudio/WorkflowSidebar.tsx`
- Create: `src/client/videosBatchStudio/WorkflowFooter.tsx`
- Create: `src/client/videosBatchStudio/VideosBatchStudio.tsx`
- Modify: `scripts/smoke-videosbatch-product-ui-foundation.tsx`

**Interfaces:**
- `VideosBatchStudio` consumes:

```ts
{
  sessionId: string;
  sessionTitle: string;
  workflow?: VideosBatchWorkflowState;
  onWorkflowChange(workflow: VideosBatchWorkflowState): void;
  onOpenCanvas(): void;
}
```

- `WorkflowSidebar` consumes `workflow`, `selectedStepId`, `onSelectStep`.
- `VideosBatchHeader` consumes project title, current product step/status, and `onOpenCanvas`.
- `WorkflowFooter` consumes `workflow`, selected step, and callbacks for previous/continue actions.

- [ ] **Step 1: Extend the smoke test with shell expectations**

Render `VideosBatchStudio` with a canonical test workflow and assert markup contains:

```text
流程制作
制作画布
01
教案
02
课程导入
09
最终成片
```

Assert it does **not** contain all 13 raw stage labels in the sidebar and does not render the old `videosbatch-stage-rail` class.

- [ ] **Step 2: Run to verify RED**

Expected: module not found for `VideosBatchStudio`.

- [ ] **Step 3: Implement header/sidebar/footer**

`WorkflowSidebar` renders one button per `VIDEOS_BATCH_PRODUCT_STEPS`, with:

```tsx
<button data-step-id={step.id} data-status={status} aria-current={isCurrent ? "step" : undefined}>
  <span className="vbs-step-number">{String(index + 1).padStart(2, "0")}</span>
  <span>{step.label}</span>
  <StageStatus status={status} />
</button>
```

Foundation may inline a minimal status label helper or create it in Task 3.

`VideosBatchHeader` renders:

- `VideosBatch`
- session title
- current step summary
- segmented controls with `流程制作` selected and `制作画布` calling `onOpenCanvas`

`WorkflowFooter` renders non-destructive navigation:

- `上一步` changes selected product step only
- current primary action is delegated to `VideosBatchStudio` and uses existing run/save APIs

- [ ] **Step 4: Implement `VideosBatchStudio` composition**

State:

```ts
const [selectedStepId, setSelectedStepId] = useState<VideosBatchProductStepId>(() =>
  workflow ? deriveCurrentProductStep(workflow) : "lesson"
);
const [showDebug, setShowDebug] = useState(false);
```

When workflow current stage advances, keep the user's selected completed step stable unless the workflow is actively running; when a new workflow is created, select the derived current step.

- [ ] **Step 5: Run test to verify GREEN**

Run the smoke script and expect PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/videosBatchStudio scripts/smoke-videosbatch-product-ui-foundation.tsx
git commit -m "feat: add VideosBatch guided studio shell"
```

---

### Task 3: Stage workspace boundary and advanced artifact drawer

**Files:**
- Create: `src/client/videosBatchStudio/components/StageStatus.tsx`
- Create: `src/client/videosBatchStudio/components/ArtifactDebugDrawer.tsx`
- Create: `src/client/videosBatchStudio/stages/StageWorkspace.tsx`
- Create: `src/client/videosBatchStudio/stages/LessonStage.tsx`
- Create: `src/client/videosBatchStudio/stages/IntroCandidatesStage.tsx`
- Create: `src/client/videosBatchStudio/stages/StoryStage.tsx`
- Create: `src/client/videosBatchStudio/stages/AssetPlanStage.tsx`
- Create: `src/client/videosBatchStudio/stages/AssetGalleryStage.tsx`
- Create: `src/client/videosBatchStudio/stages/ScreenplayStage.tsx`
- Create: `src/client/videosBatchStudio/stages/StoryboardStage.tsx`
- Create: `src/client/videosBatchStudio/stages/ExecutionStage.tsx`
- Create: `src/client/videosBatchStudio/stages/FinalVideoStage.tsx`
- Modify: `src/client/videosBatchStudio/VideosBatchStudio.tsx`
- Modify: `scripts/smoke-videosbatch-product-ui-foundation.tsx`

**Interfaces:**

`StageWorkspace` consumes:

```ts
{
  sessionId: string;
  workflow?: VideosBatchWorkflowState;
  stepId: VideosBatchProductStepId;
  onWorkflowChange(workflow: VideosBatchWorkflowState): void;
}
```

Each stage component receives the machine-stage artifacts it needs and renders semantic headings/cards. Foundation specialized renderers may be intentionally minimal but must not render the raw artifact object as the primary content.

- [ ] **Step 1: Add smoke assertions for semantic workspace and debug isolation**

For an intro artifact, assert default markup contains `三类九套课程导入` and `选择课程导入方案` but does not expose `<pre>{JSON.stringify(...)}</pre>`.

Triggering/opening debug state is tested by rendering `ArtifactDebugDrawer open` directly and asserting it contains `原始数据` and JSON text.

- [ ] **Step 2: Run to verify RED**

Expected missing stage components.

- [ ] **Step 3: Implement `ArtifactDebugDrawer`**

Reuse the useful behavior from the old `WorkflowArtifactPanel`:

- format artifact with `JSON.stringify(artifact, null, 2)`
- optional advanced JSON edit/save when `onSave` is supplied
- explicit `高级 · 原始数据` title
- close button

Do not show this component unless the user clicks `查看原始数据`.

- [ ] **Step 4: Implement semantic Foundation stage components**

Foundation content contracts:

- `LessonStage`: project/lesson starter with a large lesson textarea and existing `api.startVideosBatch` action when workflow is absent.
- `IntroCandidatesStage`: groups/list summary from candidate artifact and presents a clear `选择课程导入方案` heading; Phase 2 will add full 3×3 card polish.
- `StoryStage`: readable story document surface.
- `AssetPlanStage`: grouped asset plan surface.
- `AssetGalleryStage`: semantic asset-image/confirmation surface; Phase 2 will add native image gallery polish.
- `ScreenplayStage`: readable screenplay surface.
- `StoryboardStage`: vertical storyboard/shot summary surface.
- `ExecutionStage`: batch video execution summary.
- `FinalVideoStage`: final completion/stitch summary.

No stage component should render the whole artifact as a raw JSON blob by default.

- [ ] **Step 5: Wire `StageWorkspace` registry**

Use an explicit switch/map from product step ID to the 9 stage components. Do not create a generic DAG renderer.

- [ ] **Step 6: Run smoke test to verify GREEN**

- [ ] **Step 7: Commit**

```bash
git add src/client/videosBatchStudio scripts/smoke-videosbatch-product-ui-foundation.tsx
git commit -m "feat: add semantic VideosBatch stage workspaces"
```

---

### Task 4: Light product visual system

**Files:**
- Create: `src/client/videosBatchStudio/videosBatchStudio.css`
- Modify: `src/client/videosBatchStudio/VideosBatchStudio.tsx`
- Modify: `src/client/App.tsx`
- Modify: `scripts/smoke-videosbatch-product-ui-foundation.tsx`

**Interfaces:**
- CSS classes are scoped under `.videosbatch-studio` / `.vbs-*`.
- Existing `src/client/styles.css` and `FlowView` classes are not restyled globally.

- [ ] **Step 1: Add smoke assertions for scoped product shell classes**

Assert Guided Studio markup contains:

```text
videosbatch-studio
vbs-sidebar
vbs-workspace
vbs-context
```

- [ ] **Step 2: Run to verify RED if classes are missing**

- [ ] **Step 3: Implement scoped CSS tokens and responsive layout**

Use CSS custom properties scoped to `.videosbatch-studio`:

```css
.videosbatch-studio {
  --vbs-bg: #f7f4ec;
  --vbs-surface: #ffffff;
  --vbs-surface-subtle: #fbf9f4;
  --vbs-text: #25231f;
  --vbs-muted: #77736a;
  --vbs-border: #e8e3d8;
  --vbs-accent: #e5b84b;
  --vbs-accent-soft: #f7e8b9;
}
```

Desktop layout:

```css
.videosbatch-studio-body {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr) 260px;
}
```

At <= 1279px hide/collapse the right context rail. At <= 899px change sidebar to a compact horizontal/scrollable step selector while keeping main content readable.

- [ ] **Step 4: Import the new CSS only from the product boundary/App entry**

Do not mutate SeeReel Canvas styles.

- [ ] **Step 5: Run smoke test and `npm run build`**

Expected PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/videosBatchStudio src/client/App.tsx scripts/smoke-videosbatch-product-ui-foundation.tsx
git commit -m "style: add VideosBatch guided studio visual system"
```

---

### Task 5: App dual-mode integration and old Rail retirement

**Files:**
- Modify: `src/client/App.tsx`
- Remove primary usage of: `src/client/videosBatchWorkflow/WorkflowRail.tsx`
- Keep temporarily for compatibility/debug unless no longer imported.
- Modify: `scripts/smoke-videosbatch-product-ui-foundation.tsx`
- Modify: `.github/workflows/phase1-verify.yml`

**Interfaces:**

`App.tsx` adds local mode state:

```ts
type VideosBatchWorkspaceMode = "workflow" | "canvas";
const [videosBatchMode, setVideosBatchMode] = useState<VideosBatchWorkspaceMode>("workflow");
```

When selected Session changes, reset mode to `workflow` for Sessions participating in VideosBatch V1.

- [ ] **Step 1: Add source-level smoke assertions**

The smoke script reads `src/client/App.tsx` and asserts:

- imports `VideosBatchStudio`
- does not render `<WorkflowRail`
- renders `<VideosBatchStudio`
- preserves `<FlowView`
- contains a `workflow` / `canvas` mode branch

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Replace the current WorkflowRail insertion in `App.tsx`**

Remove the current topbar-embedded `WorkflowRail` block.

Render mode selection at workspace level:

```tsx
{activeView === "studio" && selectedSession ? (
  videosBatchMode === "workflow" ? (
    <VideosBatchStudio
      sessionId={selectedSession.id}
      sessionTitle={selectedSession.title}
      workflow={selectedSession.videosBatchWorkflow}
      onWorkflowChange={updateWorkflowInSessionState}
      onOpenCanvas={() => setVideosBatchMode("canvas")}
    />
  ) : (
    <FlowView ...existingProps />
  )
) : ...}
```

Canvas mode must expose a visible way back to `流程制作`; this can be a small workspace-level segmented control or a product-mode control above `FlowView`.

- [ ] **Step 4: Keep Gallery behavior unchanged**

`activeView === "gallery"` continues to render the existing Gallery page and does not show Guided Studio.

- [ ] **Step 5: Add Foundation smoke to CI**

Add before build:

```yaml
- name: VideosBatch Product UI foundation smoke
  run: npx tsx scripts/smoke-videosbatch-product-ui-foundation.tsx
```

- [ ] **Step 6: Run targeted tests**

```bash
npx tsx scripts/smoke-videosbatch-product-ui-foundation.tsx
npx tsx scripts/smoke-videosbatch-ui.ts
npm run build
```

Expected PASS.

- [ ] **Step 7: Commit**

```bash
git add src/client/App.tsx src/client/videosBatchStudio scripts/smoke-videosbatch-product-ui-foundation.tsx .github/workflows/phase1-verify.yml
git commit -m "feat: make VideosBatch guided workflow the default studio"
```

---

### Task 6: Full regression verification and Foundation PR checkpoint

**Files:**
- No production files unless verification reveals a regression.

- [ ] **Step 1: Run VideosBatch targeted smoke suite**

```bash
npx tsx scripts/smoke-videosbatch-product-ui-foundation.tsx
npx tsx scripts/smoke-videosbatch-ui.ts
npx tsx scripts/smoke-videosbatch-e2e.ts
npx tsx scripts/smoke-videosbatch-native-projection.ts
npx tsx scripts/smoke-videosbatch-native-media-stages.ts
```

- [ ] **Step 2: Run build and SeeReel regressions**

```bash
npm run build
npx tsx scripts/smoke-canvas-crud.ts
npx tsx scripts/smoke-shot-generation-state.ts
node scripts/smoke-seereel-skill-boundaries.mjs
npx tsx scripts/smoke-libtv-style-stitch.ts
```

- [ ] **Step 3: Verify source boundary**

Check that:

- `App.tsx` contains no stage-specific artifact parsing logic.
- no new native Asset/Shot/Stitch model exists.
- old `WorkflowRail` is no longer the primary rendered UI.
- raw JSON is only reachable through `ArtifactDebugDrawer`.

- [ ] **Step 4: Push and wait for GitHub Actions `phase1-verify` to finish successfully**

Do not claim Foundation complete while Actions is queued/in-progress.

- [ ] **Step 5: Open a PR to `master`**

PR title:

```text
feat: add VideosBatch guided product studio foundation
```

PR description must state:

- Guided Studio becomes default VideosBatch mode
- SeeReel Canvas is preserved as advanced mode
- 9 product steps are presentation grouping over unchanged 13-stage workflow
- specialized Phase 2 content UX is intentionally not fully polished in this PR
- no server workflow contract or native media model changes

## Self-review

### Spec coverage

- Dual workflow/canvas modes: Tasks 2 and 5.
- Default Guided Studio: Task 5.
- 9-step user model: Task 1.
- Vertical sidebar/status system: Tasks 1, 2, and 4.
- Stage workspace boundary: Task 3.
- Raw JSON advanced-only: Task 3.
- Existing Canvas unchanged: Tasks 4 and 5.
- Light editorial visual system: Task 4.
- Desktop/responsive Foundation: Task 4.
- Existing API reuse: Tasks 2 and 3.
- App boundary: Task 5.
- Regression requirement: Task 6.

### Placeholder scan

No `TBD`, `TODO`, or unspecified implementation placeholders are permitted. Phase 2 polish is explicitly outside the Foundation acceptance scope rather than left as an implementation placeholder.

### Type consistency

The plan consistently uses `VideosBatchProductStepId`, `VideosBatchProductStatus`, `VIDEOS_BATCH_PRODUCT_STEPS`, `deriveProductStepStatus`, and `deriveCurrentProductStep` from Task 1. `VideosBatchStudio` owns selected product step; `App.tsx` owns only workflow/canvas mode and global Session state.
