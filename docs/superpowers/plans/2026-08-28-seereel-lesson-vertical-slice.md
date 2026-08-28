# Superseded: SeeReel Lesson Vertical Slice Implementation Plan

This plan is intentionally superseded because it simplified the real VideosBatch production workflow too aggressively (`LESSON_PLAN -> ASSET_PLAN -> STORYBOARD`).

Use these documents instead:

- Design/spec: `docs/seereel-injection-map.md`
- Current implementation plan: `docs/superpowers/plans/2026-08-28-videosbatch-phase1-linear-workflow.md`

The current Phase 1 preserves the actual chain:

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

Phase 1 assumes ideal model outputs and validates only structural contracts. Every stage must persist a visible artifact. SeeReel native Agent/Skill/Canvas/Asset/Shot/ShotRender/Stitch capabilities remain available and are reused rather than replaced.
