---
name: videosbatch-lesson-workflow
description: Use when the user asks SeeReel/VideosBatch to turn a lesson plan into a visible, editable, reviewable video workflow.
---

# VideosBatch Lesson Workflow

## Boundary

This skill **extends the existing SeeReel production system**. Do not create a second agent graph, canvas, session store, asset system, render system or stitch system.

Keep SeeReel's existing skills and control surfaces available. In particular, continue to use existing SeeReel CLI/session/handoff mechanics, casting/assets capability, cinematography capability, canvas review, render polling, repair and stitch behavior whenever they already solve the operation.

This skill owns only the lesson-specific chain and the lesson-specific prompt contracts.

## Ordered workflow

```text
lesson input
  -> LESSON_PLAN
  -> ASSET_PLAN
  -> ASSET_GENERATION
  -> STORYBOARD
  -> CANVAS_REVIEW
  -> VIDEO_GENERATION
  -> VIDEO_REVIEW
  -> STITCH
```

Every stage must write its result back to visible SeeReel session/canvas state before the workflow advances.

A human edit in the web canvas becomes the source of truth. Refresh state before continuing after a human edit.

## Stage rules

### LESSON_PLAN

Input: raw lesson plan / teaching material.

Call the configured LLM once and produce a concise structured video plan containing:
- video goal
- target duration/aspect ratio/style
- ordered teaching/story flow
- required on-screen information
- narration/dialogue intent
- asset needs at semantic level

Do not produce final provider prompts here.

### ASSET_PLAN

Input: LESSON_PLAN.

Call the configured LLM once and produce the assets required by the video:
- characters
- scenes
- props
- visual/style anchors

Each reusable asset receives a stable business reference id. Stable references survive all later edits and regenerations.

Reuse SeeReel casting/assets conventions and asset publishing flow rather than inventing another asset store.

### ASSET_GENERATION

Use SeeReel's existing image/import/publish pipeline to create or attach the planned assets.

Keep all generated/imported assets visible in the session canvas.

### STORYBOARD

Input: approved/generated assets plus LESSON_PLAN.

Use the lesson storyboard prompt contract and reuse SeeReel cinematography/shot-node conventions.

Every shot must contain:
- purpose
- duration
- visual/action/camera description
- narration/dialogue when needed
- stable references to required assets
- enough information for the existing video provider layer to compile the final request

Do not persist provider-local aliases such as `@图片1` as canonical asset identity.

### CANVAS_REVIEW

Reuse the existing SeeReel canvas-review capability.

Review for:
- missing required lesson content
- missing or stale assets
- unfilmable shots
- reference mistakes
- continuity problems
- shot duration/coverage problems

On failure, route back to the earliest owning stage (`LESSON_PLAN`, `ASSET_PLAN`, or `STORYBOARD`). Do not create a new repair workflow.

### VIDEO_GENERATION

Reuse SeeReel's current render/generation pipeline and provider adapters.

Provider-specific reference aliases are compiled only at execution time.

### VIDEO_REVIEW

Reuse SeeReel/VLM review. If a render fails because the plan or prompt is wrong, route back to `STORYBOARD`. If only the render is bad, regenerate only the affected shot using the existing shot repair/regeneration path.

### STITCH

Reuse SeeReel stitch/delivery. Do not rebuild final editing in the workflow layer.

## Agent behavior

Existing SeeReel/Codex/Claude-style agents may automatically operate this workflow, but they must operate the same visible state that the human sees.

Agent capability is preserved; **workflow state remains authoritative**.

Do not hide intermediate deliverables in agent scratch state. The lesson plan, asset plan, assets, storyboard, reviews, renders and final stitch must all remain inspectable in SeeReel state.
