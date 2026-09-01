# Upstream SeeReel

VideosBatch uses SeeReel as its production runtime baseline.

- Upstream repository: https://github.com/feifeibear/SeeReel
- Pinned commit: `5521c90f267341f87f841411a58998c7a83b0504`
- Upstream license: MIT
- Import strategy: exact pinned checkout copied into VideosBatch, with VideosBatch-only overlay files preserved.
- Sync rule: future upstream syncs must be isolated in dedicated commits before VideosBatch workflow changes.

The active VideosBatch workflow specification is:

- `specs/videosbatch-workflow-canonical.md`

The SeeReel projection and routing entry are derived references only:

- `docs/seereel-injection-map.md`
- `.agents/skills/videosbatch-lesson-workflow/SKILL.md`

Historical VideosBatch design material is archived under
`docs/archive/videosbatch-design/`; see its `manifest.json` for hashes and restore paths.
