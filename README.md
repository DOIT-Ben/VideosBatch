# VideosBatch

VideosBatch is a **chain-style lesson-to-video workflow** built around the SeeReel production runtime.

The design deliberately avoids a multi-agent architecture. There is one visible workflow, one runner, and an ordered list of stages. Each stage receives the previous stage's structured output, calls an LLM/media provider or deterministic compiler, validates the result, persists it to the production canvas, and advances to the next stage.

## Core flow

```text
LESSON_INPUT
  -> LESSON_PLAN
  -> ASSET_PLAN
  -> ASSET_GENERATION
  -> STORYBOARD
  -> PROMPT_COMPILE
  -> VIDEO_GENERATION
  -> VIDEO_REVIEW
       -> PASS   -> STITCH -> DONE
       -> REPAIR -> PROMPT_COMPILE / VIDEO_GENERATION
```

## Relationship with SeeReel

SeeReel is the production base and remains responsible for the persistent session/canvas, assets, shots, review records, repair-friendly state and final stitch. VideosBatch injects a lesson-oriented stage definition and prompt/schema contracts into that runtime.

This repository starts by validating the workflow contract in isolation so the orchestration can be reviewed without dragging in unrelated FrameFlow infrastructure. The next integration step is to place the same runner/stage definitions inside a SeeReel source checkout and bind the `SeeReelRuntimePort` to its native session/store/API functions.

## Non-goals

- no planner agent / asset agent / review agent
- no hidden autonomous agent graph
- no FrameFlow artifact/lineage subsystem
- no provider-specific reference aliases in the canonical workflow state

The workflow state is the product state. Human edits may pause the chain at any stage, update the visible artifact, and resume from that point.
