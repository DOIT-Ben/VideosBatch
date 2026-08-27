# VideosBatch

VideosBatch is a **lesson-to-video workflow injected into the SeeReel production base**.

The key rule is simple: **preserve SeeReel, inject the lesson workflow.** We do not build a second agent platform, a second canvas, or a second video runtime. SeeReel keeps its existing agent/skill/CLI/handoff capabilities, persistent session/canvas, assets, shots, review/repair state, generation pipelines and stitch flow. VideosBatch adds lesson-oriented stage definitions, prompts, schemas and routing.

## Core flow

```text
LESSON_INPUT
  -> LESSON_PLAN
  -> ASSET_PLAN
  -> ASSET_GENERATION
  -> STORYBOARD
  -> CANVAS_REVIEW
  -> VIDEO_GENERATION
  -> VIDEO_REVIEW
       -> PASS   -> STITCH -> DONE
       -> REPAIR -> rewind to the owning stage
```

Each stage is still one step in one visible chain. A stage may call an LLM, image model, video model, VLM review, or deterministic SeeReel operation. The workflow state remains visible in the SeeReel canvas so a human can pause, edit and resume at any point.

## Preserve SeeReel agent-native capability

SeeReel already supports agent-driven operation through its orchestrator skill, stage skills, CLI, session handoff and web canvas. VideosBatch keeps those capabilities. The injected lesson workflow can be:

- advanced automatically by an existing SeeReel/Codex/Claude-style agent;
- advanced directly by the workflow runner;
- paused and edited by a human in the canvas;
- resumed from the same persisted stage.

The agent is an **operator of the visible workflow**, not a replacement for the workflow state.

## What VideosBatch injects

- lesson-plan -> video-plan prompt contract
- lesson asset planning rules
- lesson-oriented storyboard prompt contract
- stable asset/reference conventions
- review routing rules for lesson videos
- one ordered stage definition
- a small adapter that maps those stages onto existing SeeReel capabilities

## What VideosBatch does not replace

- SeeReel session/store/canvas
- SeeReel asset and shot nodes
- SeeReel generation providers
- SeeReel `seereel-cli` / session handoff
- SeeReel canvas review and VLM review
- SeeReel stitch/delivery
- SeeReel's existing agent/skill mechanism

The current branch validates this injection contract in isolation before importing the full SeeReel source tree into this repository.
