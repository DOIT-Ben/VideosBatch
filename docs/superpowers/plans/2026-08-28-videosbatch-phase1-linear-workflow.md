# VideosBatch Phase 1 Linear Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the complete VideosBatch lesson-to-video chain to SeeReel so every stage advances in a fixed order, produces a visible/editable artifact, passes only structural contract validation, and reuses native SeeReel Asset/Shot/ShotRender/Stitch capabilities.

**Architecture:** VideosBatch remains a thin overlay on a pinned SeeReel source snapshot. A single `VideosBatchWorkflowState` is attached optionally to native `Session`; one generic runner executes an ordered stage registry. Early text/JSON artifacts are shown in a lightweight Workflow Rail + Artifact Panel, while media stages project into native SeeReel `Asset`, `Shot`, `ShotRender`, and `StitchJob` entities already rendered by the Canvas.

**Tech Stack:** SeeReel React 19 + Vite + Express 5 + PostgreSQL + TypeScript + existing SeeReel generation/Canvas/CLI/Agent runtime. No new workflow framework and no new schema dependency in Phase 1.

**Spec:** `docs/seereel-injection-map.md`

## Global Constraints

- Preserve the existing SeeReel Agent / Skills / CLI / Handoff behavior.
- Preserve the original SeeReel short-drama workflow.
- Implement one ordered VideosBatch workflow; do not add a second hidden agent graph.
- Assume model outputs are ideal except for structural contract validation.
- Every stage must leave a persisted, inspectable output.
- Use native SeeReel `Asset`, `Shot`, `ShotRender`, `WorkflowExecutionPlan`, and `StitchJob` instead of parallel lesson-specific media models.
- VLM review, semantic quality scoring, automatic repair, complex retry policy and general DAG execution are out of scope.
- Upstream manual edits never delete old downstream artifacts automatically; downstream completed stages become `stale`.
- Phase 1 story continuation uses one selected story. Multi-story branching is deferred.

---

## File Structure

Create the VideosBatch overlay as focused files:

```text
src/shared/videosBatchWorkflow.ts

src/server/videosBatchWorkflow/
  stageContracts.ts
  validators.ts
  runner.ts
  stages.ts
  prompts.ts
  api.ts

src/client/videosBatchWorkflow/
  WorkflowRail.tsx
  WorkflowArtifactPanel.tsx
  workflowLabels.ts

scripts/
  smoke-videosbatch-workflow-state.ts
  smoke-videosbatch-runner.ts
  smoke-videosbatch-api.ts
  smoke-videosbatch-ui.ts
  smoke-videosbatch-native-projection.ts
  smoke-videosbatch-e2e.ts
```

Modify only for wiring:

```text
src/shared/types.ts
src/server/index.ts
src/server/store.ts        # only if Session persistence requires explicit field handling
src/client/App.tsx         # or the narrowest existing root that owns the session/canvas layout
```

Reuse without copying:

```text
src/server/generators.ts
src/server/promptCompose.ts
src/server/tos.ts
src/server/visionReview.ts
src/client/flow/*
```

---

### Task 1: Import and pin the SeeReel baseline

**Files:**
- Create: `UPSTREAM_SEEREEL.md`
- Import unchanged: SeeReel source snapshot at commit `5521c90f267341f87f841411a58998c7a83b0504`
- Preserve: `docs/seereel-injection-map.md`, this plan, `.agents/skills/videosbatch-lesson-workflow/SKILL.md`

**Interfaces:**
- Consumes: upstream repository `feifeibear/SeeReel` at the pinned commit.
- Produces: a runnable SeeReel baseline inside `DOIT-Ben/VideosBatch` before workflow injection.

- [ ] **Step 1: Write provenance file**

Create `UPSTREAM_SEEREEL.md`:

```markdown
# Upstream SeeReel

- Repository: https://github.com/feifeibear/SeeReel
- Pinned commit: 5521c90f267341f87f841411a58998c7a83b0504
- License: MIT
- Import policy: upstream syncs are committed separately from VideosBatch overlay changes.
- Overlay rule: prefer new VideosBatch files and wiring-only edits to upstream core files.
```

- [ ] **Step 2: Import the pinned source tree without creative refactors**

Preserve upstream paths so future comparisons remain possible.

- [ ] **Step 3: Run the upstream baseline checks**

Run:

```bash
npm ci
npm run build
npm run smoke:canvas-crud
npm run smoke:shot-generation-state
npm run smoke:seereel-skill-boundaries
npm run smoke:libtv-style-stitch
```

Expected: all commands exit 0 before any VideosBatch workflow code is added.

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "chore: import pinned SeeReel runtime"
```

---

### Task 2: Add the minimal workflow state to native Session

**Files:**
- Create: `src/shared/videosBatchWorkflow.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/server/store.ts` only if persistence needs explicit handling
- Test: `scripts/smoke-videosbatch-workflow-state.ts`

**Interfaces:**
- Produces:

```ts
export type VideosBatchStageId =
  | "LESSON_INPUT"
  | "INTRO_GENERATION"
  | "STORY_EXPANSION"
  | "STORY_SELECTION"
  | "ASSET_PROMPT_GENERATION"
  | "ASSET_GENERATION"
  | "SCREENPLAY_GENERATION"
  | "STORYBOARD_GENERATION"
  | "REFERENCE_BINDING"
  | "VIDEO_GENERATION"
  | "STITCH";

export type VideosBatchStageStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed"
  | "stale";

export interface VideosBatchStageState<T = unknown> {
  status: VideosBatchStageStatus;
  revision: number;
  artifact?: T;
  error?: string;
  updatedAt?: string;
}

export interface VideosBatchWorkflowState {
  version: 1;
  currentStage: VideosBatchStageId;
  selectedStoryId?: string;
  stages: Partial<Record<VideosBatchStageId, VideosBatchStageState>>;
  updatedAt: string;
}
```

Add only this field to native `Session`:

```ts
videosBatchWorkflow?: VideosBatchWorkflowState;
```

- [ ] **Step 1: Write failing round-trip smoke test**

The test must prove:

```ts
assert.equal(normalSession.videosBatchWorkflow, undefined);
assert.equal(reloadedWorkflow.version, 1);
assert.equal(reloadedWorkflow.currentStage, "INTRO_GENERATION");
assert.equal(reloadedWorkflow.stages.LESSON_INPUT?.status, "ready");
```

Also prove an old SeeReel session without the field still round-trips unchanged.

- [ ] **Step 2: Run the test and confirm failure**

```bash
npx tsx scripts/smoke-videosbatch-workflow-state.ts
```

- [ ] **Step 3: Implement the minimal shared types and persistence wiring**

Do not add an Artifact table or a new database schema unless the imported SeeReel store makes the optional Session field impossible to persist.

- [ ] **Step 4: Verify state + existing session behavior**

```bash
npx tsx scripts/smoke-videosbatch-workflow-state.ts
npm run smoke:session-portability
npm run smoke:session-delete-cleanup
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/videosBatchWorkflow.ts src/shared/types.ts src/server/store.ts scripts/smoke-videosbatch-workflow-state.ts
git commit -m "feat: persist VideosBatch workflow on session"
```

---

### Task 3: Build one generic linear runner and contract validator layer

**Files:**
- Create: `src/server/videosBatchWorkflow/stageContracts.ts`
- Create: `src/server/videosBatchWorkflow/validators.ts`
- Create: `src/server/videosBatchWorkflow/runner.ts`
- Create: `src/server/videosBatchWorkflow/stages.ts`
- Test: `scripts/smoke-videosbatch-runner.ts`

**Interfaces:**

```ts
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface StageExecutionContext {
  session: Session;
  workflow: VideosBatchWorkflowState;
  assets: Asset[];
  shots: Shot[];
}

export interface StageResult<T = unknown> {
  artifact: T;
}

export interface StageDefinition<T = unknown> {
  id: VideosBatchStageId;
  execute(ctx: StageExecutionContext): Promise<StageResult<T>>;
  validate(artifact: T, ctx: StageExecutionContext): ValidationResult;
  project?(artifact: T, ctx: StageExecutionContext): Promise<void>;
}
```

The ordered registry is exactly:

```ts
export const STAGE_ORDER: VideosBatchStageId[] = [
  "LESSON_INPUT",
  "INTRO_GENERATION",
  "STORY_EXPANSION",
  "STORY_SELECTION",
  "ASSET_PROMPT_GENERATION",
  "ASSET_GENERATION",
  "SCREENPLAY_GENERATION",
  "STORYBOARD_GENERATION",
  "REFERENCE_BINDING",
  "VIDEO_GENERATION",
  "STITCH",
];
```

- [ ] **Step 1: Write failing runner tests with fake executors**

Test these exact behaviors:

```text
runNext executes one stage only
runAll stops at STORY_SELECTION when no selectedStoryId exists
runAll resumes after selectedStoryId is set
validator failure marks only current stage failed
successful stage persists artifact then advances currentStage
editing an upstream artifact marks all downstream ready stages stale
old downstream artifacts remain present
```

- [ ] **Step 2: Run and verify failure**

```bash
npx tsx scripts/smoke-videosbatch-runner.ts
```

- [ ] **Step 3: Implement minimal runner**

Required exported operations:

```ts
startWorkflow(session: Session, lessonText: string): VideosBatchWorkflowState
runNext(ctx: StageExecutionContext): Promise<VideosBatchWorkflowState>
runAll(ctx: StageExecutionContext): Promise<VideosBatchWorkflowState>
replaceStageArtifact(
  workflow: VideosBatchWorkflowState,
  stageId: VideosBatchStageId,
  artifact: unknown,
): VideosBatchWorkflowState
restartFrom(
  workflow: VideosBatchWorkflowState,
  stageId: VideosBatchStageId,
): VideosBatchWorkflowState
```

Do not implement semantic review, repair prompts or retry loops.

- [ ] **Step 4: Add only structural validators**

Implement functions:

```ts
validateIntroGeneration
validateStoryExpansion
validateStorySelection
validateAssetPromptGeneration
validateScreenplayGeneration
validateStoryboardGeneration
validateReferenceBinding
```

Media-generation stages may initially validate only that expected native ids/results exist.

- [ ] **Step 5: Run runner tests**

```bash
npx tsx scripts/smoke-videosbatch-runner.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/server/videosBatchWorkflow scripts/smoke-videosbatch-runner.ts
git commit -m "feat: add linear VideosBatch workflow runner"
```

---

### Task 4: Add the minimal workflow control API

**Files:**
- Create: `src/server/videosBatchWorkflow/api.ts`
- Modify: `src/server/index.ts`
- Test: `scripts/smoke-videosbatch-api.ts`

**Interfaces:**

Expose:

```text
POST /api/sessions/:id/videosbatch/start
POST /api/sessions/:id/videosbatch/run-next
POST /api/sessions/:id/videosbatch/run-all
PUT  /api/sessions/:id/videosbatch/stages/:stageId/artifact
POST /api/sessions/:id/videosbatch/restart-from/:stageId
GET  /api/sessions/:id/videosbatch
```

`start` request:

```json
{
  "projectId": "P001",
  "lessonText": "完整教案文本"
}
```

- [ ] **Step 1: Write failing API smoke test**

Verify:

```text
start -> LESSON_INPUT ready, INTRO_GENERATION current
run-next -> exactly one transition
run-all -> stops on STORY_SELECTION when no story selected
PUT STORY_SELECTION artifact -> selectedStoryId persisted and downstream can continue
PUT upstream artifact -> downstream ready stages become stale
restart-from -> current stage moves back without deleting old artifacts
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx tsx scripts/smoke-videosbatch-api.ts
```

- [ ] **Step 3: Implement routes as thin runner wrappers**

No prompts, provider logic or media-generation implementation belongs in `api.ts`.

- [ ] **Step 4: Verify API + existing routes**

```bash
npx tsx scripts/smoke-videosbatch-api.ts
npm run smoke:client-routes
```

- [ ] **Step 5: Commit**

```bash
git add src/server/videosBatchWorkflow/api.ts src/server/index.ts scripts/smoke-videosbatch-api.ts
git commit -m "feat: expose VideosBatch workflow controls"
```

---

### Task 5: Make every early-stage artifact visible and editable

**Files:**
- Create: `src/client/videosBatchWorkflow/workflowLabels.ts`
- Create: `src/client/videosBatchWorkflow/WorkflowRail.tsx`
- Create: `src/client/videosBatchWorkflow/WorkflowArtifactPanel.tsx`
- Modify: the narrowest existing session/canvas root (`src/client/App.tsx` or equivalent after import)
- Test: `scripts/smoke-videosbatch-ui.ts`

**Interfaces:**
- Consumes: `Session.videosBatchWorkflow`.
- Produces: fixed stage rail plus artifact inspection/edit controls.

Stage labels:

```ts
export const WORKFLOW_LABELS = {
  LESSON_INPUT: "教案",
  INTRO_GENERATION: "三类九套课程导入",
  STORY_EXPANSION: "三个完整故事",
  STORY_SELECTION: "选定故事",
  ASSET_PROMPT_GENERATION: "资产拆解与提示词",
  ASSET_GENERATION: "资产图片",
  SCREENPLAY_GENERATION: "视频剧本",
  STORYBOARD_GENERATION: "10秒分镜",
  REFERENCE_BINDING: "资产引用",
  VIDEO_GENERATION: "视频生成",
  STITCH: "最终拼接",
} as const;
```

- [ ] **Step 1: Write failing UI smoke test**

Verify the UI can render all 11 stages in order and expose these actions where applicable:

```text
查看
编辑
重新生成
从这里继续
```

Do not assert new Canvas node types for text stages.

- [ ] **Step 2: Run and confirm failure**

```bash
npx tsx scripts/smoke-videosbatch-ui.ts
```

- [ ] **Step 3: Implement WorkflowRail**

Requirements:

```text
current stage visually identifiable
ready/failed/stale/running visible
clicking a stage opens its artifact
native media stages can focus corresponding Canvas entities
```

- [ ] **Step 4: Implement WorkflowArtifactPanel**

For Phase 1 use straightforward structured renderers/textareas; do not build a rich document editor.

Save edits through:

```text
PUT /api/sessions/:id/videosbatch/stages/:stageId/artifact
```

- [ ] **Step 5: Verify UI + upstream Canvas tests**

```bash
npx tsx scripts/smoke-videosbatch-ui.ts
npm run smoke:canvas-node-layout
npm run smoke:inspector-selected-data
```

- [ ] **Step 6: Commit**

```bash
git add src/client/videosBatchWorkflow src/client/App.tsx scripts/smoke-videosbatch-ui.ts
git commit -m "feat: add visible VideosBatch workflow rail"
```

---

### Task 6: Implement the text-generation stages using the existing production prompts

**Files:**
- Create: `src/server/videosBatchWorkflow/prompts.ts`
- Modify: `src/server/videosBatchWorkflow/stages.ts`
- Modify: `src/server/videosBatchWorkflow/stageContracts.ts`
- Test: extend `scripts/smoke-videosbatch-runner.ts`

**Interfaces:**

Implement these model-backed stages:

```text
INTRO_GENERATION
STORY_EXPANSION
ASSET_PROMPT_GENERATION
SCREENPLAY_GENERATION
STORYBOARD_GENERATION
REFERENCE_BINDING
```

Implement this non-model stage:

```text
STORY_SELECTION
```

`LESSON_INPUT` is created by `startWorkflow`.

- [ ] **Step 1: Define structured output contracts that preserve the current prompt semantics**

Example intro contract:

```ts
export interface IntroCandidate {
  id: string;
  category: "A" | "B" | "C";
  direction: string;
  name: string;
  type: string;
  content: string;
  endingQuestion: string;
  truthfulness: {
    type: "真实史实" | "真实背景下的合理改编" | "完全虚构的故事化情境";
    note: string;
  };
}

export interface IntroGenerationArtifact {
  candidates: IntroCandidate[];
  recommendedIds: string[];
}
```

Example story artifact:

```ts
export interface StoryExpansionArtifact {
  stories: Array<{
    id: string;
    sourceIntroId: string;
    title: string;
    type: string;
    truthfulness: string;
    content: string;
  }>;
}
```

Example asset-plan final item:

```ts
export interface PlannedAsset {
  stableId: string;
  type: "character" | "scene" | "prop" | "creature";
  name: string;
  source: string;
  usage: string;
  prompt: string;
}
```

Example storyboard segment:

```ts
export interface StoryboardSegment {
  id: string;
  chapter: string;
  sequence: string;
  type: "story" | "science" | "knowledge";
  scene: string;
  subjects: string[];
  props: string[];
  durationSec: 10;
  subshots: Array<{
    startSec: number;
    endSec: number;
    visual: string;
    camera?: string;
    audio?: string;
    dialogue?: string;
  }>;
}
```

- [ ] **Step 2: Port the existing prompt content, do not rewrite its business intent**

Only change the requested output from free-form text to the corresponding structured contract where practical. Preserve the existing constraints and terminology.

- [ ] **Step 3: Use one LLM execution helper for all text stages**

The stage registry supplies prompt + context + expected contract. Do not create separate agents.

- [ ] **Step 4: Run with deterministic fake responses first**

```bash
npx tsx scripts/smoke-videosbatch-runner.ts
```

Expected: the full text chain advances through `REFERENCE_BINDING` without any paid provider call.

- [ ] **Step 5: Commit**

```bash
git add src/server/videosBatchWorkflow/prompts.ts src/server/videosBatchWorkflow/stages.ts src/server/videosBatchWorkflow/stageContracts.ts scripts/smoke-videosbatch-runner.ts
git commit -m "feat: add VideosBatch text workflow stages"
```

---

### Task 7: Project asset and storyboard stages into native SeeReel entities

**Files:**
- Modify: `src/server/videosBatchWorkflow/stages.ts`
- Test: `scripts/smoke-videosbatch-native-projection.ts`
- Reuse unchanged: native SeeReel asset/image/shot/store logic

**Interfaces:**

`ASSET_GENERATION`:

```text
PlannedAsset[]
  -> native SeeReel Asset[]
  -> existing image generation capability
```

`STORYBOARD_GENERATION`:

```text
StoryboardSegment[]
  -> native SeeReel Shot[]
```

`REFERENCE_BINDING`:

```text
bound canonical P001-Axxx ids
  -> resolve native Asset ids
  -> update Shot.assetIds
  -> persist the visible bound prompt/draft
```

- [ ] **Step 1: Write failing projection smoke test**

Given a deterministic workflow fixture, verify:

```text
planned assets create native Asset rows
stable P001-Axxx identity can resolve back to the native Asset row
storyboard segments create native Shot rows in order
shot.assetIds all resolve to native Assets
existing Canvas graph sees the Assets and Shots without new media node types
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx tsx scripts/smoke-videosbatch-native-projection.ts
```

- [ ] **Step 3: Implement adapters by calling existing SeeReel functions/code paths**

Do not duplicate generator, upload, reference or shot persistence logic in the VideosBatch workflow folder.

- [ ] **Step 4: Verify projection + upstream regressions**

```bash
npx tsx scripts/smoke-videosbatch-native-projection.ts
npm run smoke:asset-prompt
npm run smoke:image-reference-binding
npm run smoke:canvas-crud
npm run smoke:shot-inspector-autosave
```

- [ ] **Step 5: Commit**

```bash
git add src/server/videosBatchWorkflow/stages.ts scripts/smoke-videosbatch-native-projection.ts
git commit -m "feat: project workflow artifacts into SeeReel assets and shots"
```

---

### Task 8: Reuse native SeeReel video generation and stitch as the last two stages

**Files:**
- Modify: `src/server/videosBatchWorkflow/stages.ts`
- Test: extend `scripts/smoke-videosbatch-native-projection.ts`
- Reuse unchanged: `WorkflowExecutionPlan`, shot generation/polling and StitchJob code paths

**Interfaces:**

`VIDEO_GENERATION`:

```text
native ready Shot[]
  -> existing SeeReel workflow execution plan
  -> existing generation calls/polling
  -> native ShotRender[] / ready Shot videos
```

`STITCH`:

```text
ready native shot videos
  -> existing SeeReel StitchJob
  -> final video
```

- [ ] **Step 1: Add fake native media executors to prove the chain**

Before any paid API acceptance, fake the native generation adapter so the runner can prove:

```text
REFERENCE_BINDING ready
  -> VIDEO_GENERATION ready
  -> STITCH ready
  -> workflow complete
```

- [ ] **Step 2: Wire the production adapters to existing SeeReel paths**

VideosBatch must not reimplement Seedance polling, render storage or ffmpeg stitch logic.

- [ ] **Step 3: Run existing video/stitch regression tests**

```bash
npm run smoke:shot-generation-state
npm run smoke:shot-poll-errors
npm run smoke:video-delivery
npm run smoke:libtv-style-stitch
npm run smoke:stitch-normalizes-video-time
```

- [ ] **Step 4: Commit**

```bash
git add src/server/videosBatchWorkflow/stages.ts scripts/smoke-videosbatch-native-projection.ts
git commit -m "feat: finish VideosBatch chain with native render and stitch"
```

---

### Task 9: End-to-end Phase 1 acceptance

**Files:**
- Create: `scripts/smoke-videosbatch-e2e.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: one complete lesson-plan fixture.
- Produces: a fully completed VideosBatch workflow session with visible stage artifacts plus native SeeReel assets/shots/renders/stitch output.

- [ ] **Step 1: Create deterministic fixture executors**

Use fixed outputs for every creative/media stage so this acceptance tests orchestration rather than model quality.

- [ ] **Step 2: Run the complete chain**

Expected sequence:

```text
LESSON_INPUT ready
INTRO_GENERATION ready
STORY_EXPANSION ready
STORY_SELECTION waits
select story
ASSET_PROMPT_GENERATION ready
ASSET_GENERATION ready
SCREENPLAY_GENERATION ready
STORYBOARD_GENERATION ready
REFERENCE_BINDING ready
VIDEO_GENERATION ready
STITCH ready
DONE
```

Assertions:

```text
all 11 stage artifacts/statuses are inspectable
9 intro candidates exist
3 stories exist
one selectedStoryId exists
all planned stable asset ids are unique
native Asset rows exist
native Shot rows exist
all Shot.assetIds resolve
bound storyboard contains only existing stable asset ids
native video outputs exist in the fake adapter
native StitchJob/final output exists
editing STORY_EXPANSION marks all downstream completed stages stale but preserves their old artifacts
existing SeeReel skill/agent/session metadata remains intact
```

- [ ] **Step 3: Run focused regression suite**

```bash
npm run build
npm run smoke:seereel-skill-boundaries
npm run smoke:canvas-crud
npm run smoke:shot-inspector-autosave
npm run smoke:shot-generation-state
npm run smoke:libtv-style-stitch
npx tsx scripts/smoke-videosbatch-e2e.ts
```

- [ ] **Step 4: Add npm command**

```json
{
  "scripts": {
    "smoke:videosbatch-e2e": "tsx scripts/smoke-videosbatch-e2e.ts"
  }
}
```

- [ ] **Step 5: Update README with Phase 1 workflow and non-goals**

Document that content-quality optimization begins only after the deterministic chain passes.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-videosbatch-e2e.ts package.json README.md
git commit -m "test: verify complete VideosBatch linear workflow"
```

---

## Phase 1 Definition of Done

Phase 1 is done only when all of the following are true:

```text
1. A user can paste a lesson plan into a SeeReel session.
2. The fixed VideosBatch chain is visible in order.
3. runNext advances exactly one stage.
4. runAll advances the chain automatically and stops only on selection/failure/completion.
5. Every stage leaves a persisted inspectable artifact/status.
6. Text artifacts can be manually edited.
7. Editing an upstream artifact makes downstream outputs stale without deleting them.
8. Asset image generation uses native SeeReel Asset infrastructure.
9. Storyboard generation creates native SeeReel Shot rows.
10. Reference binding resolves canonical P001-Axxx ids to native assets.
11. Video generation uses native SeeReel shot-generation infrastructure.
12. Final assembly uses native SeeReel Stitch infrastructure.
13. Original SeeReel Agent/Skill/CLI/short-drama behavior still passes regression checks.
14. The deterministic fake-executor E2E passes without paid providers.
```

Only after this Definition of Done should the project optimize prompts, model quality, automatic repair, review scoring, parallelism, retries, provider routing or batch scale.
