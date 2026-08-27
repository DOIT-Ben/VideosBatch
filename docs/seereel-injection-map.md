# SeeReel Injection Map

## Principle

VideosBatch is an **overlay on SeeReel**, not a replacement runtime.

Keep the existing SeeReel code and behavior wherever possible. Add only the lesson-specific workflow state, prompts and orchestration entrypoint.

## Reuse without redesign

SeeReel already has the core objects VideosBatch needs:

- `Session`: persistent production container and human/agent handoff target.
- `StoryPlan`: existing story planning payload for short-drama mode. Keep it unchanged so original SeeReel workflows still work.
- `Asset`: already supports character/scene/prop/style, session/shot scope, reference metadata, generation and review.
- `Shot`: already contains title/script/camera/duration/assetIds/rawPrompt/prompt, continuity inputs, multiple renders, generation state and VLM review.
- `ShotRender`: already acts as a take/version record.
- `VideoReviewVerdict` / repair plan: reuse for review and repair.
- `WorkflowExecutionPlan`: reuse for dependency-aware batch shot rendering.
- `StitchJob`: reuse for final assembly.

Therefore VideosBatch should **not** introduce parallel `LessonAsset`, `LessonShot`, `LessonRender`, `LessonReview` or `LessonStitch` models.

## Minimal persistent extension

Add one optional lesson workflow object to `Session` (exact naming can be adjusted when SeeReel source is imported):

```ts
export type LessonWorkflowStage =
  | 'LESSON_PLAN'
  | 'ASSET_PLAN'
  | 'ASSET_GENERATION'
  | 'STORYBOARD'
  | 'CANVAS_REVIEW'
  | 'VIDEO_GENERATION'
  | 'VIDEO_REVIEW'
  | 'STITCH'
  | 'DONE'

export interface LessonWorkflowState {
  version: 1
  cursor: LessonWorkflowStage
  status: 'ready' | 'running' | 'paused' | 'done' | 'error'
  sourceLessonText: string
  lessonPlan?: unknown
  assetPlan?: unknown
  canvasReview?: unknown
  videoReview?: unknown
  updatedAt: string
}

export interface Session {
  // existing SeeReel fields stay unchanged
  lessonWorkflow?: LessonWorkflowState
}
```

Shots and assets remain native SeeReel rows.

## Files to preserve

When importing SeeReel into VideosBatch, preserve these systems rather than rewriting them:

- `src/server/generators.ts` — image/video provider execution
- `src/server/promptCompose.ts` — existing provider prompt composition behavior
- `src/server/visionReview.ts` — VLM review
- `src/server/store.ts` — persistence
- `src/server/tos.ts` — media publish path
- `src/shared/shotGenerationState.ts` — shot generation state
- `src/client/flow/*` — canvas, nodes, inspector, mentions and wiring
- existing stitch logic and `StitchJob`
- `.agents/skills/seereel-cli`
- `.agents/skills/seereel-agent-session`
- `.agents/skills/seereel-casting-assets`
- `.agents/skills/seereel-cinematography`
- `.agents/skills/seereel-canvas-review`
- `.agents/skills/seereel-shortdrama` (original short-drama mode remains available)

## Files/features to add or minimally extend

### 1. Add lesson workflow skill

Add:

```text
.agents/skills/videosbatch-lesson-workflow/SKILL.md
```

This is an additional orchestrator entrypoint for lesson input. It does not delete or replace `seereel-shortdrama`.

### 2. Extend `Session` with optional lesson workflow state

Target:

```text
src/shared/types.ts
src/server/store.ts
```

Only add the optional state required to resume the chain after refresh/human edit.

### 3. Add lesson workflow API/control surface

Prefer a small set of endpoints inside the existing SeeReel server, for example:

```text
POST /api/sessions/:id/lesson-workflow/start
POST /api/sessions/:id/lesson-workflow/next
POST /api/sessions/:id/lesson-workflow/pause
POST /api/sessions/:id/lesson-workflow/resume
POST /api/sessions/:id/lesson-workflow/restart-from/:stage
```

These endpoints should call existing asset/shot/review/stitch operations internally instead of duplicating them.

### 4. Add lesson stage prompts

The prompt contracts live in the VideosBatch overlay and are the primary product-specific injection.

- lesson -> production plan
- production plan -> asset plan
- assets + plan -> native SeeReel shots
- canvas review -> pass/fallback stage
- video review -> pass/fallback stage

### 5. Add minimal canvas visibility

Do not create a second workflow editor. Reuse the existing SeeReel canvas and Inspector.

Possible minimal UI additions:

- session header: current lesson workflow stage
- one plan node/card for `LESSON_PLAN`
- one asset-plan node/card for `ASSET_PLAN`
- stage progress strip
- pause/resume/continue controls

Assets, shots, renders, review and stitch nodes remain the existing SeeReel nodes.

## Mapping

```text
LESSON_PLAN
  -> Session.lessonWorkflow.lessonPlan

ASSET_PLAN
  -> Session.lessonWorkflow.assetPlan

ASSET_GENERATION
  -> native Asset[]

STORYBOARD
  -> native Shot[]

CANVAS_REVIEW
  -> existing canvas review / repair records

VIDEO_GENERATION
  -> existing WorkflowExecutionPlan + ShotRender[]

VIDEO_REVIEW
  -> native VideoReviewVerdict / VideoReviewRepairPlan

STITCH
  -> native StitchJob
```

## Agent behavior

Existing SeeReel agents remain useful. They may start, inspect, advance, repair and stitch the lesson workflow through the same CLI/API and handoff mechanisms.

The only invariant is that agent work must write to the same persistent SeeReel state shown to the human. No lesson-specific state should exist only inside an agent scratchpad.

## Why this is intentionally small

The goal is not to build another orchestration framework. The product value is the **ordered lesson-to-video prompt chain** and its ability to use SeeReel's existing production capabilities.

The first real integration should therefore be measured by how few SeeReel files need invasive modification.
