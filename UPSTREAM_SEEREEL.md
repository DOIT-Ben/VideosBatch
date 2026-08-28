# Upstream SeeReel

VideosBatch uses SeeReel as its production runtime baseline.

- Upstream repository: https://github.com/feifeibear/SeeReel
- Pinned commit: `5521c90f267341f87f841411a58998c7a83b0504`
- Upstream license: MIT
- Import strategy: exact pinned checkout copied into VideosBatch, with VideosBatch-only overlay files preserved.
- Sync rule: future upstream syncs must be isolated in dedicated commits before VideosBatch workflow changes.

The VideosBatch Phase 1 workflow specification remains in:

- `docs/seereel-injection-map.md`
- `docs/superpowers/plans/2026-08-28-videosbatch-phase1-linear-workflow.md`
- `.agents/skills/videosbatch-lesson-workflow/SKILL.md`
