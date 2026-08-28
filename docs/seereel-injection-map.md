# VideosBatch / SeeReel Canonical Injection Map

## 0. Authority and synchronization

VideosBatch does **not** define a competing course-video workflow.

The unique upstream business truth is:

- Repository: `DOIT-Ben/FrameFlow`
- Canonical file: `docs/视频制作工作流完整步骤.md`
- Canonical id: `COURSE_VIDEO_WORKFLOW_CANONICAL`
- Synced FrameFlow commit: `f5a1c78bd14bd2889c1eb7949e9a5983ea4b48e0`

This document is only the SeeReel/VideosBatch integration projection of that canonical workflow. If this document, code, prompts, tests, UI labels, or any implementation detail conflicts with the FrameFlow canonical file, FrameFlow wins and the derived VideosBatch material must be updated before new generation or real-provider execution.

Git history is the archive for superseded designs. Historical workflow vocabulary is not a compatibility surface and must not be used by current code, prompts, tests, UI, or product documentation.

---

## 1. Product boundary

VideosBatch is a thin educational workflow overlay on the pinned SeeReel runtime.

Reuse SeeReel's native:

- `Session` persistence;
- Agent / Skills / CLI / Handoff;
- Canvas / Inspector;
- `Asset` and image generation/import;
- `Shot` and storyboard surface;
- `ShotRender` / generation task lifecycle;
- `WorkflowExecutionPlan`;
- provider reference compilation;
- Stitch and delivery;
- optional VLM review / repair capabilities.

Do not create a second agent graph, generic DAG engine, canvas, asset database, shot model, render model, review model, or stitch system.

VideosBatch adds only the canonical lesson-specific stage state, stage contracts, manual gates, prompt contracts, and projection adapters required to drive those existing SeeReel objects.

---

## 2. Canonical visible stage order

```text
LESSON_INPUT
  -> COURSE_INTRO_CANDIDATES
  -> COURSE_INTRO_SELECTION
  -> STORY_SCRIPT
  -> ASSET_PLAN
  -> ASSET_CANDIDATES
  -> ASSET_CONFIRMATION
  -> SCREENPLAY
  -> FINAL_STORYBOARD
  -> COPYABLE_PROMPT
  -> QUOTE
  -> EXECUTION
  -> STITCH
  -> DONE
```

FrameFlow machine-readable creative/run stages are `COURSE_INTRO_CANDIDATES`, `STORY_SCRIPT`, `ASSET_PLAN`, `ASSET_CANDIDATES`, `ASSET_CONFIRMATION`, `SCREENPLAY`, `FINAL_STORYBOARD`, `COPYABLE_PROMPT`, `QUOTE`, and `EXECUTION`.

VideosBatch adds:

- `LESSON_INPUT` as the local persisted lesson root;
- `COURSE_INTRO_SELECTION` as the explicit visible UI/control representation of FrameFlow's `ONE_COURSE_INTRO_LOCKED` gate;
- `STITCH` as the final projection into native SeeReel assembly/delivery.

`COURSE_INTRO_SELECTION` is a manual/control gate, not a second LLM generation step.

---

## 3. Canonical stage contracts

### 3.1 LESSON_INPUT

Input:

- project id;
- current lesson/teaching material.

Output:

- visible lesson-root artifact for the current workflow revision.

The lesson material is untrusted model input. Downstream prompt builders must delimit it as data and must never execute instructions embedded in that material.

### 3.2 COURSE_INTRO_CANDIDATES

Input: current lesson input.

Output: exactly three categories / nine candidates:

- `A-01`, `A-02`, `A-03` — 数学史与知识由来;
- `B-01`, `B-02`, `B-03` — 历史需求与古今应用;
- `C-01`, `C-02`, `C-03` — 创意故事与现代情境.

Each candidate must preserve the complete FrameFlow prompt contract, including:

- 200–300 Chinese-character body;
- clear situation, actor need, conflict escalation, mathematical value, and stopping point;
- opening with a need, anomaly, dispute, or unresolved problem rather than a conventional lesson announcement;
- ending question without giving away the lesson's core answer;
- no premature explanation of the target concept, method, property, formula, or rule;
- one of the three truthfulness categories;
- reliable handling of real history and explicit labeling of fictional material;
- genuine differentiation in opening, conflict source, progression, setting, and ending;
- video-friendly cast and scene complexity;
- no storyboard, narration list, subtitles, or image-asset advice in this stage.

Exactly three recommendation entries are produced. Each recommendation explains classroom attraction, connection to the core knowledge point, and video-production feasibility. Recommendations do not themselves authorize downstream use.

### 3.3 COURSE_INTRO_SELECTION

Manual/control gate.

Persist exactly one current selection:

```ts
selectedIntroId: "A-01" | ... | "C-03" | "CUSTOM";
selectionMode: "user_selected" | "system_recommended" | "custom";
selectionReason: string;
introLocked: true;
```

A custom selection must persist its confirmed body. No downstream stage may infer another candidate or expand multiple candidates in parallel.

### 3.4 STORY_SCRIPT

Input: only the locked intro current version.

Output: one 600–800-character story document.

Requirements:

- preserve the selected topic, knowledge point, story direction, and truthfulness level;
- start from a real need or suspense;
- include conflict escalation;
- make the mathematical knowledge the key clue rather than an appended moral;
- stop on an unresolved question and do not give the answer;
- stay inside the lesson's knowledge boundary;
- use language suitable for the target grade and oral classroom narration;
- do not produce storyboard, subtitle, shot-table, or image-asset suggestions.

### 3.5 ASSET_PLAN

Input: current story document.

Output: structured `VIDEO_ASSET_PLAN` using the four canonical asset categories:

- `CHARACTER`
- `SCENE`
- `PROP`
- `CREATURE`

Required process:

1. scan the story paragraph by paragraph and sentence by sentence for all potentially necessary visual objects;
2. retain uncertain items as candidate considerations rather than silently omitting them;
3. group by the four canonical categories;
4. deduplicate the same underlying object while recording meaningful age/outfit/identity/form variants;
5. perform an omission check against the story;
6. create one independent image prompt per confirmed plan item.

The full FrameFlow image-prompt rules remain part of the contract:

- project-wide 影视级 3D 国漫 CG style;
- no mixing of style vocabularies;
- character/anthropomorphic template with front full body, side full body, back full body, and facial close-up, four-panel horizontal arrangement, pure white background, 16:9, static neutral pose, no action/prop/effect, with detailed face, hair, clothing, material, pattern, accessory, lower-body and footwear description;
- cross-version character identity continuity for face shape, facial features, eyes, hair, body type, and basic temperament;
- pure-environment scene template with foreground / midground / background structure, strong spatial depth, no people/animals/story action, natural unified lighting;
- centered single-prop template on pure white background, complete object, no hands/actions/effects, with geometry/material/colors/surface/edge details;
- centered non-anthropomorphic creature template with complete body/species/limb/wing/tail/eye/horn/claw/scale/feather/fur/shell details; anthropomorphic or upright human-like creatures route to the character template;
- unified negative prompt covering text, watermark, logo, gibberish, crop, missing subject, extra people, complex background where forbidden, proportion/structure errors, malformed limbs, extra hands/fingers, broken faces, style inconsistency, and low-resolution blur.

The model owns semantic `assetKey` values only, e.g. `CHARACTER-HERO`.

The model must not generate:

- stable public asset IDs;
- native SeeReel `Asset.id` values;
- selected candidate IDs;
- provider aliases.

### 3.6 ASSET_CANDIDATES

Input: persisted asset plan.

Output: image candidate state for every required asset.

Use SeeReel's native image/asset path. The server assigns stable public asset IDs after the plan is persisted, in deterministic plan order:

```text
assetKey        -> publicAssetId
CHARACTER-HERO  -> P001-A001
SCENE-ROOM      -> P001-A002
...
```

Every required item must have at least one verified candidate before the workflow can advance to asset confirmation.

### 3.7 ASSET_CONFIRMATION

Manual/control gate.

Output: every required plan item is bound to exactly one current confirmed image/native asset.

The workflow must stop here while any required asset is missing, unverified, stale, or unselected. Changing an upstream asset plan or regenerating candidates invalidates dependent confirmation state as appropriate.

### 3.8 SCREENPLAY

Input:

- current story document;
- current confirmed asset facts.

Output: structured `VIDEO_SCREENPLAY`.

The formal screenplay locks `targetDurationSeconds` to exactly one of:

```text
90, 100, 110, 120, 130, 140, 150
```

No other duration set is valid for new generation.

Required scene semantics follow FrameFlow's current contract:

- continuous scene `sequence` starting at 1;
- scene title;
- knowledge focus / theme;
- emotional purpose;
- primary visual presentation mode;
- ambient sound;
- effect / transition sound;
- action / interaction sound;
- voice guidance;
- visual/action description;
- dialogue/narration;
- evidence array for server-supported teaching evidence.

The screenplay covers the complete story from beginning to end but does not generate final storyboard units yet. Confirmed asset facts may be used; invented asset IDs are forbidden.

### 3.9 FINAL_STORYBOARD

Input:

- current formal screenplay;
- current confirmed assets.

Output: structured `VIDEO_STORYBOARD` with `format = FINAL_10_SECOND`.

Hard invariants:

- storyboard `targetDuration` equals screenplay `targetDurationSeconds`;
- segment count equals `targetDuration / 10` (9–15 segments);
- every segment is exactly 10 seconds;
- every segment has 3–5 continuous subshots;
- subshot durations sum to exactly 10 seconds;
- segment sequence starts at 1 and is continuous;
- subshot sequence starts at 1 and is continuous;
- the full screenplay is covered from start to finish;
- references use only current confirmed stable public asset IDs;
- no provider-local positional aliases are used as canonical references;
- visual continuity records character, scene, prop, and creature continuity requirements.

The structured final storyboard is the production truth and must not be rewritten merely to create a convenient copy/paste prompt.

### 3.10 COPYABLE_PROMPT

Input:

- current final storyboard;
- current confirmed assets.

Output: derived `copyableStoryboardPrompt` only.

Stable public markers such as `【P001-A001】` may appear only inside visual-effect text. Per segment:

- maximum 7 stable IDs;
- no duplicate marker;
- no invented or stale ID;
- every declared reference must appear in the text and vice versa;
- no position-based image naming in the visual-effect copy;
- dialogue, narration, subtitle, sound, timing, camera, and action structure stay unchanged;
- `fullText` must contain every derived segment text.

This stage does not mutate `FINAL_STORYBOARD`.

`COPYABLE_PROMPT` is a display/transfer derivative, not quote or execution truth. If upstream storyboard or asset-plan state changes, the derived copy must be regenerated.

### 3.11 QUOTE

Input: current structured final storyboard and current confirmed asset/version lineage.

Output: `QUOTE_SNAPSHOT`.

The quote must bind the current version/hash and asset order. If a relevant ancestor version, storyboard content, or confirmed asset order changes, the quote becomes stale/invalid.

Phase 1 may use a deterministic fake quote implementation while preserving this boundary. Real billing is not required to prove the workflow chain.

### 3.12 EXECUTION

Input: current valid quote snapshot.

Output: native SeeReel execution/render state.

Real execution must validate authorization, balance, idempotency, and current-source requirements according to the canonical FrameFlow boundary before provider submission. Phase 1 may use deterministic fake execution while keeping this stage and contract visible.

Provider-specific reference aliases are compiled only here, from canonical stable public IDs resolved to current confirmed native assets. Provider aliases must never become canonical workflow state.

### 3.13 STITCH

Input: successful native execution results.

Output: native SeeReel `StitchJob` / final video.

Reuse SeeReel's existing stitch and delivery path.

---

## 4. Stable identity ownership

Canonical identity layering is one-way:

```text
model semantic identity
assetKey = CHARACTER-HERO
        ↓ server after persisted plan
stable public identity
P001-A001
        ↓ SeeReel resolution
native Asset.id
asset_xxx
        ↓ provider compiler at execution boundary
provider-local alias
@图片1
```

Rules:

1. Model output never owns `P001-A001`.
2. Stable public IDs survive image regeneration/candidate changes for the same plan item.
3. Native `Asset.id` is an implementation identity, not user-facing semantic identity.
4. Provider aliases never enter canonical workflow state.
5. Asset order used by quote/execution is derived from the current confirmed plan snapshot, not incidental Canvas ordering.

---

## 5. Workflow state and manual gates

VideosBatch keeps one optional workflow object on native SeeReel `Session`:

```ts
export interface VideosBatchStageState<T = unknown> {
  status: "pending" | "running" | "ready" | "failed" | "stale";
  revision: number;
  artifact?: T;
  error?: string;
  updatedAt?: string;
}

export interface VideosBatchWorkflowState {
  version: 1;
  currentStage: VideosBatchStageId;
  completed: boolean;
  selectedIntroId?: string;
  selectionMode?: "user_selected" | "system_recommended" | "custom";
  selectionReason?: string;
  introLocked: boolean;
  stages: Partial<Record<VideosBatchStageId, VideosBatchStageState>>;
  updatedAt: string;
}
```

Required manual stops:

- `COURSE_INTRO_SELECTION` until one intro is explicitly locked;
- `ASSET_CONFIRMATION` until every required asset is selected/confirmed.

`runAll` must stop at these gates rather than silently inventing a selection.

---

## 6. Edits, versions, and stale propagation

Every user-visible artifact may be edited within its legal outer contract.

When an upstream stage changes:

1. increment its revision;
2. keep the edited stage visible/ready;
3. mark completed downstream stages `stale`;
4. preserve prior outputs for inspection;
5. invalidate downstream manual confirmations and quote/execution bindings that depended on the old revision;
6. require regeneration/reconfirmation from the earliest affected stage;
7. set the workflow back to an unfinished state when previously completed downstream output is no longer current.

Do not silently delete old outputs and do not treat stale quote, selected asset, storyboard, or execution state as current.

---

## 7. Runner architecture

Use one linear runner and one stage registry.

```ts
export interface StageDefinition<T = unknown> {
  id: VideosBatchStageId;
  execute(ctx: StageExecutionContext): Promise<{ artifact: T }>;
  validate(artifact: T, ctx: StageExecutionContext): ValidationResult;
  project?(artifact: T, ctx: StageExecutionContext): Promise<void>;
}
```

The runner performs only:

```text
load current Session/workflow/native state
  -> enforce manual/current-source gate
  -> execute current stage
  -> validate structural/business contract
  -> persist stage artifact
  -> project to native SeeReel state when applicable
  -> mark ready
  -> advance
```

It is not a hidden Agent loop and does not perform semantic quality review in Phase 1.

Dedicated text-model stages use strict structured output. Do not add a hidden finalizer or a generic Chat Agent round after the stage output.

---

## 8. Native SeeReel projection

Projection ownership:

- `ASSET_CANDIDATES` -> native `Asset[]` candidate/generated image state;
- `ASSET_CONFIRMATION` -> current stable-public-ID to confirmed native `Asset.id` mapping;
- `FINAL_STORYBOARD` -> native `Shot[]` inspection/execution units;
- `COPYABLE_PROMPT` -> derived text only and never authoritative execution state;
- `EXECUTION` -> native render / `ShotRender[]` / `WorkflowExecutionPlan` behavior;
- `STITCH` -> native `StitchJob`.

Keep existing SeeReel generator, prompt composition, TOS, Canvas, review, and stitch implementations unless a concrete adapter gap requires a narrow change.

---

## 9. UI

Use a lightweight fixed Workflow Rail plus the native SeeReel Canvas.

Labels:

```text
教案
三类九套课程导入
锁定课程导入
故事文稿
资产计划与提示词
资产候选图
确认资产
正式视频剧本
最终10秒分镜
垫图副本
报价
视频执行
最终拼接
```

Every stage shows status and current artifact. Long editing, selection, and candidate confirmation may open in the current artifact panel/inspector/drawer. Do not turn Canvas into a second generic workflow editor.

Media remains inspectable as native SeeReel nodes.

---

## 10. Phase 1 fake-first acceptance

Before real providers, a deterministic fake E2E must prove:

```text
lesson
 -> 9 intro candidates
 -> lock exactly 1 intro
 -> 1 story document
 -> asset plan with semantic assetKeys
 -> candidate native assets with server-owned Pxxx-Axxx ids
 -> confirm all required assets
 -> formal screenplay with allowed locked duration
 -> exact N x 10-second final storyboard segments
 -> derived copyable prompts
 -> quote snapshot
 -> execution/render state
 -> native stitch
 -> DONE
```

At every step the artifact is inspectable and structural/business-contract violations stop advancement.

Only after this E2E and SeeReel regressions are green should fake executors be replaced by real LLM/image/video/quote/provider integrations.

---

## 11. Current authoritative local files

Current VideosBatch implementation sources are:

```text
src/shared/videosBatchWorkflow.ts
src/server/videosBatchWorkflow/*
src/client/videosBatchWorkflow/*
scripts/smoke-videosbatch-*
.agents/skills/videosbatch-lesson-workflow/SKILL.md
docs/seereel-injection-map.md
```

Only the canonical stage vocabulary and contracts in this document are valid for current VideosBatch development. Superseded source trees and implementation plans are removed from the working tree; Git history is the only archive for them.
