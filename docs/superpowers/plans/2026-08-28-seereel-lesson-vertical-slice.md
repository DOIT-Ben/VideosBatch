# SeeReel Lesson Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a complete lesson plan can enter VideosBatch and become editable native SeeReel `Shot[]` on the existing Canvas without replacing SeeReel's Agent/Skill/Session/Asset/Review/Stitch runtime.

**Architecture:** Pin VideosBatch to upstream SeeReel commit `5521c90f267341f87f841411a58998c7a83b0504`. Preserve SeeReel core behavior and add one optional lesson-workflow overlay on `Session`; each lesson stage either calls an existing SeeReel capability or a single LLM completion and persists its output into existing SeeReel state. The first vertical slice stops after native `Shot[]` are visible and editable on Canvas; paid video generation is intentionally out of scope for this milestone.

**Tech Stack:** SeeReel React 19 + Vite + Express + PostgreSQL + existing SeeReel Agent Skills / Canvas / Session / Asset / Shot APIs; Node 22 tests.

**Spec:** `docs/seereel-injection-map.md`

## Global Constraints

- Preserve SeeReel Agent/Skill/CLI/Handoff behavior; do not introduce a second hidden agent graph.
- Session/Canvas remains the human + agent shared source of truth.
- Reuse native `Asset`, `Shot`, `ShotRender`, `VideoReviewVerdict`, `WorkflowExecutionPlan`, and `StitchJob` types.
- Lesson workflow state is optional and additive; existing short-drama workflow must continue to work.
- Stable asset identity remains canonical; provider aliases are not persisted in lesson workflow state.
- First milestone ends when lesson-derived native shots are visible and editable on SeeReel Canvas.

---

### Task 1: Import and pin the SeeReel runtime

**Files:**
- Create: `UPSTREAM_SEEREEL.md`
- Import unchanged from SeeReel: `src/client/**`, `src/server/**`, `src/shared/**`, `packages/seereel-cli/**`, `.agents/skills/seereel-*`, `package.json`, `package-lock.json`, `vite.config.ts`, `Dockerfile`, `LICENSE`
- Preserve VideosBatch additions: `.agents/skills/videosbatch-lesson-workflow/SKILL.md`, `docs/seereel-injection-map.md`, `src/workflow/**`

**Interfaces:**
- Consumes: upstream SeeReel commit `5521c90f267341f87f841411a58998c7a83b0504`
- Produces: a runnable SeeReel baseline inside VideosBatch with provenance documented in `UPSTREAM_SEEREEL.md`

- [ ] **Step 1: Add provenance metadata**

Create `UPSTREAM_SEEREEL.md` with upstream repository URL, pinned commit, import date, MIT license note, and an explicit rule that future upstream syncs happen as dedicated commits before VideosBatch overlay changes.

- [ ] **Step 2: Import the pinned SeeReel source snapshot unchanged**

Copy the pinned source tree while preserving upstream paths so future diffs remain reviewable.

- [ ] **Step 3: Restore VideosBatch overlay files after the import**

Keep the existing lesson workflow skill, injection map, and workflow prototype files.

- [ ] **Step 4: Run upstream verification before any lesson integration changes**

Run:

```bash
npm ci
npm run build
npm run smoke:canvas-crud
npm run smoke:shot-generation-state
npm run smoke:seereel-skill-boundaries
```

Expected: all commands exit 0 on the unmodified imported baseline.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: import pinned SeeReel runtime"
```

---

### Task 2: Add optional lesson workflow state to native Session

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/store.ts`
- Test: `scripts/smoke-lesson-workflow-session.ts`

**Interfaces:**
- Consumes: native SeeReel `Session`
- Produces: optional `Session.lessonWorkflow` with no behavior change for sessions that omit it

Define:

```ts
export type LessonWorkflowStage =
  | "LESSON_PLAN"
  | "ASSET_PLAN"
  | "ASSET_GENERATION"
  | "STORYBOARD"
  | "CANVAS_REVIEW"
  | "VIDEO_GENERATION"
  | "VIDEO_REVIEW"
  | "STITCH";

export interface LessonWorkflowState {
  sourceLesson: string;
  stage: LessonWorkflowStage;
  status: "ready" | "running" | "paused" | "error" | "done";
  lessonPlan?: unknown;
  assetPlan?: unknown;
  error?: string;
  updatedAt: string;
}
```

Add only:

```ts
lessonWorkflow?: LessonWorkflowState;
```

to `Session`.

- [ ] **Step 1: Write failing smoke test**

The test creates a normal SeeReel session without `lessonWorkflow`, persists it, reloads it, then patches `lessonWorkflow` and verifies both old and new session shapes round-trip.

- [ ] **Step 2: Run test and confirm it fails before implementation**

```bash
npx tsx scripts/smoke-lesson-workflow-session.ts
```

- [ ] **Step 3: Add the optional type and store round-trip support**

Do not alter existing `story`, asset, shot, stitch, or agent fields.

- [ ] **Step 4: Run test and upstream session smoke tests**

```bash
npx tsx scripts/smoke-lesson-workflow-session.ts
npm run smoke:session-portability
npm run smoke:session-delete-cleanup
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/server/store.ts scripts/smoke-lesson-workflow-session.ts
git commit -m "feat: add optional lesson workflow state"
```

---

### Task 3: Add minimal lesson workflow control API

**Files:**
- Modify: `src/server/index.ts`
- Create: `src/server/lessonWorkflow.ts`
- Test: `scripts/smoke-lesson-workflow-api.ts`

**Interfaces:**
- Consumes: `Session.lessonWorkflow`
- Produces: start / next / pause / resume / restart-stage operations against the same persisted session

Expose:

```text
POST /api/sessions/:id/lesson-workflow/start
POST /api/sessions/:id/lesson-workflow/next
POST /api/sessions/:id/lesson-workflow/pause
POST /api/sessions/:id/lesson-workflow/resume
POST /api/sessions/:id/lesson-workflow/restart-stage
```

`start` body:

```json
{
  "lessonText": "完整教案文本"
}
```

- [ ] **Step 1: Write failing API smoke test**

Verify start initializes stage `LESSON_PLAN`, pause blocks `next`, resume re-enables `next`, and restart-stage resets only the requested stage output.

- [ ] **Step 2: Run and confirm failure**

```bash
npx tsx scripts/smoke-lesson-workflow-api.ts
```

- [ ] **Step 3: Implement control API with no creative logic**

The API only coordinates stage state; it does not contain lesson prompts or provider code.

- [ ] **Step 4: Run API test and existing client-route smoke test**

```bash
npx tsx scripts/smoke-lesson-workflow-api.ts
npm run smoke:client-routes
```

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/server/lessonWorkflow.ts scripts/smoke-lesson-workflow-api.ts
git commit -m "feat: add lesson workflow control api"
```

---

### Task 4: Implement LESSON_PLAN and ASSET_PLAN as two LLM stages

**Files:**
- Modify: `src/server/lessonWorkflow.ts`
- Create: `src/server/lessonPrompts.ts`
- Test: `scripts/smoke-lesson-stage-contracts.ts`

**Interfaces:**
- Consumes: `sourceLesson` and previous stage JSON
- Produces: structured `lessonPlan` and `assetPlan` persisted under `Session.lessonWorkflow`

`LESSON_PLAN` output contract:

```ts
interface LessonPlanOutput {
  title: string;
  videoGoal: string;
  targetDurationSec: number;
  style: string;
  teachingFlow: Array<{
    id: string;
    title: string;
    purpose: string;
    visualIdea: string;
  }>;
}
```

`ASSET_PLAN` output contract:

```ts
interface AssetPlanOutput {
  assets: Array<{
    stableId: string;
    name: string;
    type: "character" | "scene" | "prop" | "style";
    description: string;
    prompt: string;
  }>;
}
```

- [ ] **Step 1: Write contract tests using deterministic fake LLM responses**

Reject malformed JSON and keep the current stage unchanged on validation failure.

- [ ] **Step 2: Run and confirm failure**

```bash
npx tsx scripts/smoke-lesson-stage-contracts.ts
```

- [ ] **Step 3: Implement one generic structured LLM stage helper**

Use one helper for both stages; prompts differ, runner does not.

- [ ] **Step 4: Run tests**

```bash
npx tsx scripts/smoke-lesson-stage-contracts.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/server/lessonWorkflow.ts src/server/lessonPrompts.ts scripts/smoke-lesson-stage-contracts.ts
git commit -m "feat: add lesson and asset planning stages"
```

---

### Task 5: Map ASSET_GENERATION to native SeeReel Asset pipeline

**Files:**
- Modify: `src/server/lessonWorkflow.ts`
- Reuse unchanged: native SeeReel asset creation / image generation code paths
- Test: `scripts/smoke-lesson-asset-mapping.ts`

**Interfaces:**
- Consumes: `AssetPlanOutput`
- Produces: native SeeReel `Asset[]` with VideosBatch `stableId` retained in tags/metadata without replacing native `Asset.id`

- [ ] **Step 1: Write failing mapping test**

Given two planned assets, verify two native `Asset` records are created and repeated execution is idempotent for the same `stableId`.

- [ ] **Step 2: Confirm failure**

```bash
npx tsx scripts/smoke-lesson-asset-mapping.ts
```

- [ ] **Step 3: Implement adapter that calls existing SeeReel asset pipeline**

Do not copy generator code into `lessonWorkflow.ts`.

- [ ] **Step 4: Run mapping and existing asset tests**

```bash
npx tsx scripts/smoke-lesson-asset-mapping.ts
npm run smoke:asset-prompt
npm run smoke:image-reference-binding
```

- [ ] **Step 5: Commit**

```bash
git add src/server/lessonWorkflow.ts scripts/smoke-lesson-asset-mapping.ts
git commit -m "feat: map lesson assets to native SeeReel assets"
```

---

### Task 6: Make STORYBOARD produce native SeeReel Shot[]

**Files:**
- Modify: `src/server/lessonWorkflow.ts`
- Modify: `src/server/lessonPrompts.ts`
- Reuse unchanged: native SeeReel shot/store/canvas graph code
- Test: `scripts/smoke-lesson-storyboard-shots.ts`

**Interfaces:**
- Consumes: `LessonPlanOutput`, native lesson assets
- Produces: native SeeReel `Shot[]`

Storyboard output must map directly to existing fields:

```ts
{
  title,
  script,
  camera,
  durationSec,
  assetIds,
  rawPrompt,
  prompt
}
```

- [ ] **Step 1: Write failing test**

Verify storyboard creation writes native shots in order, every referenced asset id exists, and rerunning STORYBOARD replaces only lesson-generated draft shots while preserving manually edited non-lesson shots.

- [ ] **Step 2: Confirm failure**

```bash
npx tsx scripts/smoke-lesson-storyboard-shots.ts
```

- [ ] **Step 3: Implement STORYBOARD stage using the existing shot creation/store path**

No new LessonShot type.

- [ ] **Step 4: Run tests**

```bash
npx tsx scripts/smoke-lesson-storyboard-shots.ts
npm run smoke:canvas-crud
npm run smoke:shot-inspector-autosave
```

- [ ] **Step 5: Commit**

```bash
git add src/server/lessonWorkflow.ts src/server/lessonPrompts.ts scripts/smoke-lesson-storyboard-shots.ts
git commit -m "feat: generate native SeeReel shots from lesson"
```

---

### Task 7: Show the workflow and lesson artifacts on existing Canvas

**Files:**
- Modify: `src/client/flow/buildGraph.ts`
- Modify: `src/client/flow/nodes.tsx`
- Modify: `src/client/flow/Inspector.tsx`
- Test: `scripts/smoke-lesson-canvas.ts`

**Interfaces:**
- Consumes: `Session.lessonWorkflow`, native `Asset[]`, native `Shot[]`
- Produces: visible lesson-plan / asset-plan stage cards plus the existing native asset/shot nodes

- [ ] **Step 1: Write failing smoke test**

Verify graph contains stage nodes for LESSON_PLAN and ASSET_PLAN and native shot nodes for STORYBOARD; verify no separate hidden agent graph is created.

- [ ] **Step 2: Confirm failure**

```bash
npx tsx scripts/smoke-lesson-canvas.ts
```

- [ ] **Step 3: Add only lightweight stage nodes and reuse existing asset/shot rendering**

The Inspector must allow manual edit of lesson plan JSON/text and native shot fields.

- [ ] **Step 4: Run canvas smoke tests**

```bash
npx tsx scripts/smoke-lesson-canvas.ts
npm run smoke:canvas-node-layout
npm run smoke:inspector-selected-data
npm run smoke:shot-inspector-autosave
```

- [ ] **Step 5: Commit**

```bash
git add src/client/flow/buildGraph.ts src/client/flow/nodes.tsx src/client/flow/Inspector.tsx scripts/smoke-lesson-canvas.ts
git commit -m "feat: show lesson workflow on SeeReel canvas"
```

---

### Task 8: End-to-end vertical slice acceptance

**Files:**
- Create: `scripts/smoke-lesson-to-storyboard-e2e.ts`
- Update: `README.md`

**Interfaces:**
- Consumes: a complete lesson text
- Produces: a SeeReel session containing persisted lesson workflow state, native assets, and editable native shots visible in Canvas

- [ ] **Step 1: Build one deterministic fixture lesson**

Use a short elementary-school lesson fixture and fake LLM/media executors so acceptance does not require paid provider calls.

- [ ] **Step 2: Execute the complete chain through STORYBOARD**

```bash
npx tsx scripts/smoke-lesson-to-storyboard-e2e.ts
```

Expected assertions:

```text
session.lessonWorkflow.stage == CANVAS_REVIEW
native assets > 0
native shots > 0
all shot assetIds resolve
human patch to one shot persists after reload
existing SeeReel agent/skill metadata remains intact
```

- [ ] **Step 3: Run the focused regression suite**

```bash
npm run build
npm run smoke:canvas-crud
npm run smoke:shot-inspector-autosave
npm run smoke:seereel-skill-boundaries
npx tsx scripts/smoke-lesson-to-storyboard-e2e.ts
```

- [ ] **Step 4: Update README with the tested vertical slice and explicit next milestone**

Next milestone after this acceptance is provider-backed `VIDEO_GENERATION -> VIDEO_REVIEW -> STITCH`; do not begin it in this PR.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-lesson-to-storyboard-e2e.ts README.md
git commit -m "test: verify lesson to editable storyboard vertical slice"
```
