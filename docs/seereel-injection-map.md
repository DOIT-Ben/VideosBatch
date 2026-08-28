# SeeReel Injection Map v2

## 0. Scope

VideosBatch is an **overlay on SeeReel**. The Phase 1 goal is not to redesign SeeReel and not to optimize model quality. The goal is to prove one fixed, visible, resumable lesson-to-video production chain.

Phase 1 assumes every LLM / image / video call can produce the desired content. The system only needs to:

1. execute stages in order;
2. persist the output of every stage;
3. make every output visible and editable;
4. run a thin contract validator before advancing;
5. reuse SeeReel native media production objects wherever they already exist.

No semantic quality review, no review agent, no repair agent, no hidden agent graph, no general DAG engine.

---

## 1. Source workflow preserved

The business workflow comes from the existing VideosBatch production prompts and is intentionally kept recognizable:

```text
LESSON_INPUT
  -> INTRO_GENERATION
  -> STORY_EXPANSION
  -> STORY_SELECTION
  -> ASSET_PROMPT_GENERATION
  -> ASSET_GENERATION
  -> SCREENPLAY_GENERATION
  -> STORYBOARD_GENERATION
  -> REFERENCE_BINDING
  -> VIDEO_GENERATION
  -> STITCH
  -> DONE
```

Meaning:

- `LESSON_INPUT`: complete lesson plan input.
- `INTRO_GENERATION`: lesson -> three categories / nine course-intro candidates + recommended three.
- `STORY_EXPANSION`: selected three intros -> three complete stories.
- `STORY_SELECTION`: human chooses the story that continues downstream. This stage is a control/artifact stage, not an LLM stage.
- `ASSET_PROMPT_GENERATION`: story -> candidate assets, final asset list, stable asset ids, per-asset image prompts.
- `ASSET_GENERATION`: batch-generate the actual reusable character / scene / prop / creature images.
- `SCREENPLAY_GENERATION`: story -> video screenplay with scenes, visuals, audio and dialogue/narration.
- `STORYBOARD_GENERATION`: screenplay -> ordered 10-second storyboards with 3-5 subshots each.
- `REFERENCE_BINDING`: storyboard + asset list -> insert canonical asset ids such as `P001-A001` into the storyboard without changing its content.
- `VIDEO_GENERATION`: batch-generate native SeeReel shot renders.
- `STITCH`: use native SeeReel stitch to assemble the final video.

`VIDEO_GENERATION` and `STITCH` are product runtime stages added after the existing prompt workflow. They are not new creative-planning stages.

---

## 2. Core rule: one visible chain

The product state is the workflow state.

There is one ordered list of stages. Every stage has one visible artifact and one status.

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
```

`stale` means an upstream artifact was manually edited after this stage completed. Old outputs are preserved; they are not silently deleted.

The runner needs only two execution modes:

- `runNext`: execute exactly the current stage.
- `runAll`: keep calling `runNext` until the chain completes or a stage fails / requires a manual selection.

No separate pause/resume state machine is required in Phase 1 because stage boundaries are already natural pause points.

---

## 3. Every stage produces an artifact

Phase 1 does not create a generic artifact database/table. The early text/JSON outputs are persisted inside an optional VideosBatch workflow object attached to the native SeeReel `Session`.

```ts
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

export interface Session {
  // native SeeReel fields remain unchanged
  videosBatchWorkflow?: VideosBatchWorkflowState;
}
```

This is the only new persistent workflow model required for Phase 1.

Native media entities remain native SeeReel entities:

- generated asset images -> `Asset[]`
- generated storyboards/shots -> `Shot[]`
- video attempts -> `ShotRender[]`
- final assembly -> `StitchJob`

Do not add `LessonAsset`, `LessonShot`, `LessonRender`, `LessonReview` or `LessonStitch`.

---

## 4. Stage runner

The entire orchestration core can be one generic runner and one stage registry.

```ts
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

Execution order:

```text
load Session
  -> resolve current StageDefinition
  -> execute
  -> validate contract
  -> persist artifact
  -> project into native SeeReel entities when needed
  -> mark stage ready
  -> advance currentStage
```

`project` is only needed when a stage must create/update native SeeReel state:

- `ASSET_GENERATION` -> native `Asset[]`
- `STORYBOARD_GENERATION` -> native `Shot[]`
- `REFERENCE_BINDING` -> update native `Shot.assetIds` / prompt draft fields
- `VIDEO_GENERATION` -> native `ShotRender[]`
- `STITCH` -> native `StitchJob`

All creative text stages remain ordinary structured artifacts.

---

## 5. Contract validation only

Phase 1 does **not** decide whether content is good, creative, pedagogically perfect, cinematic or aesthetically strong.

Validation answers only: "Can this output legally enter the next stage?"

Examples:

### INTRO_GENERATION

- exactly 9 intro candidates;
- three major categories are represented;
- each candidate contains id/name/type/content/question/truthfulness;
- exactly 3 recommended candidate ids;
- recommended ids exist in the 9 candidates.

### STORY_EXPANSION

- exactly 3 stories;
- every story has id/title/type/truthfulness/content;
- source intro id exists.

### STORY_SELECTION

- one valid story id selected in Phase 1.

### ASSET_PROMPT_GENERATION

- stable asset ids match project id convention;
- ids are unique;
- type is character/scene/prop/creature;
- every final asset has name/source/usage/prompt;
- final asset list can be resolved by id.

### STORYBOARD_GENERATION

- every storyboard segment is 10 seconds;
- every segment contains 3-5 subshots;
- subshot durations sum to 10 seconds;
- sequence ids are unique and ordered;
- required visual/audio/dialogue fields exist.

### REFERENCE_BINDING

- every referenced asset id exists;
- no invented asset id;
- max 7 unique asset ids per storyboard segment.

No LLM semantic-review loop in Phase 1.

If validation fails, the stage becomes `failed` and displays the validation error. Automatic "repair prompt" can be added later.

No new schema dependency is required; use focused TypeScript validators.

---

## 6. Visibility: Workflow Rail + native Canvas

Do not turn SeeReel Canvas into a generic workflow editor.

Add one lightweight left/top `WorkflowRail` that renders the fixed ordered stages:

```text
教案
  ↓
九套课程导入
  ↓
三个完整故事
  ↓
选定故事
  ↓
资产拆解/提示词
  ↓
资产图片
  ↓
视频剧本
  ↓
10秒分镜
  ↓
资产引用
  ↓
视频生成
  ↓
最终拼接
```

Each stage card shows:

- status;
- short summary;
- `查看`;
- `编辑` when the artifact is editable;
- `重新生成`;
- `从这里继续`.

Clicking a text stage opens a `WorkflowArtifactPanel` / Inspector view.

Native stages remain visible through existing SeeReel Canvas nodes:

- asset images -> native Asset nodes;
- storyboards/shots -> native Shot / storyboard nodes;
- videos -> native Shot Video nodes;
- stitch -> native Stitch node.

The Workflow Rail may link/focus the corresponding native Canvas nodes instead of duplicating them.

This preserves SeeReel's own design principle that Canvas is the inspectable production surface rather than a free-form general graph.

---

## 7. Manual edits and stale propagation

Every visible artifact can be edited.

When an artifact is edited:

1. increment that stage revision;
2. keep the edited stage `ready`;
3. mark all downstream completed stages as `stale`;
4. keep old downstream artifacts visible;
5. user may choose `从这里重新生成后续`.

No automatic destructive deletion.

Example:

```text
STORY_EXPANSION  ready (manual edit)
STORY_SELECTION  stale
ASSET_PROMPT_GENERATION stale
ASSET_GENERATION stale
SCREENPLAY_GENERATION stale
...
```

This is sufficient lineage for Phase 1. No separate lineage database is required.

---

## 8. Reuse SeeReel without redesign

Keep these SeeReel systems and code paths:

- `Session` and persistence;
- Agent / Skills / CLI / Handoff;
- `Asset` creation and image generation;
- `Shot` and storyboard state;
- `ShotRender` / generation task lifecycle;
- prompt composition / Seedance reference logic;
- `WorkflowExecutionPlan` for native shot generation dependencies;
- Stitch and final video output;
- existing Canvas / Inspector / node graph;
- VLM review / repair capabilities remain available but are not a required Phase 1 stage.

Particularly avoid rewriting:

```text
src/server/generators.ts
src/server/promptCompose.ts
src/server/visionReview.ts
src/server/tos.ts
src/shared/shotGenerationState.ts
src/client/flow/* existing node semantics
```

VideosBatch adds a thin workflow layer around them.

---

## 9. Minimal new files

Preferred overlay:

```text
src/shared/videosBatchWorkflow.ts

src/server/videosBatchWorkflow/
  stages.ts
  runner.ts
  validators.ts
  prompts.ts
  api.ts

src/client/videosBatchWorkflow/
  WorkflowRail.tsx
  WorkflowArtifactPanel.tsx
```

Existing SeeReel files should receive only wiring-level changes:

```text
src/shared/types.ts
  -> optional Session.videosBatchWorkflow

src/server/index.ts
  -> mount VideosBatch workflow API

src/server/store.ts
  -> persist the optional workflow object if existing Session serialization requires it

src/client/App.tsx or FlowView.tsx
  -> mount WorkflowRail / artifact panel
```

Do not modify core generator/review/stitch implementations unless an actual adapter gap is discovered during integration.

---

## 10. Minimal API

Phase 1 needs only:

```text
POST /api/sessions/:id/videosbatch/start
POST /api/sessions/:id/videosbatch/run-next
POST /api/sessions/:id/videosbatch/run-all
PUT  /api/sessions/:id/videosbatch/stages/:stageId/artifact
POST /api/sessions/:id/videosbatch/restart-from/:stageId
GET  /api/sessions/:id/videosbatch
```

`start` receives the lesson text and project id.

`run-next` executes one stage.

`run-all` executes until `DONE`, `FAILED`, or the manual `STORY_SELECTION` gate.

Editing an artifact through `PUT` automatically marks downstream stages stale.

---

## 11. Phase 1 acceptance

Phase 1 is complete when one real SeeReel session can do this:

```text
paste lesson plan
  -> run chain
  -> see 9 intro candidates
  -> see 3 expanded stories
  -> select 1 story
  -> see asset prompts/list
  -> see generated native asset nodes
  -> see video screenplay
  -> see full 10-second storyboard set
  -> see canonical asset references bound into the storyboard
  -> generate native SeeReel shot videos
  -> stitch final video
```

At every stage the user can inspect the current output. Text artifacts are editable. Native media objects use the existing SeeReel Inspector.

Contract failure stops the chain and shows the error.

That is the entire Phase 1 product requirement.

---

## 12. Explicitly deferred

Do not implement in the Phase 1 workflow core:

- semantic quality scoring;
- teaching-objective coverage engine;
- VLM as a mandatory gate;
- automatic repair agent;
- multi-agent orchestration;
- general DAG editor;
- multi-story branching after story selection;
- cost/billing optimization;
- model routing optimization;
- complex retry policies;
- automatic prompt optimization;
- new timeline editor.

SeeReel's existing optional review/repair/agent capabilities stay intact and can be used manually, but VideosBatch Phase 1 does not depend on them.
