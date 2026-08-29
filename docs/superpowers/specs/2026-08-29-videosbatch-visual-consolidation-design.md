# VideosBatch Visual Consolidation Design

## Status

Approved follow-up to `2026-08-29-videosbatch-guided-studio-v2-design.md` for `feat/videosbatch-product-ui`.

## Goal

Raise the existing Guided Studio V2 from a functionally complete product shell to one coherent Editorial AI Studio visual system across all nine product steps, without changing the workflow, upload, scrolling, media-runtime, or interaction contracts that already passed acceptance.

## Scope boundary

This is a visual consolidation pass, not another information-architecture redesign.

Keep unchanged:

- `VideosBatchHeader + WorkflowProgressRail + StudioStageToolbar + StageWorkspace + WorkflowFooter` composition;
- nine product-step mapping and canonical 13-stage workflow;
- file upload parsing, accepted formats, 25 MB limit, and confirmation sequence;
- natural document scrolling and focus-mode shell behavior;
- Radix semantics, react-dropzone interaction, Canvas switch, native SeeReel assets/shots/stitch;
- API and persistence contracts.

## Visual direction

The product is a warm-white Editorial AI Studio: restrained, modern, readable for education content, and visually closer to a production/editorial workspace than an admin console, dark developer tool, or high-saturation Canva-like creation surface.

### Canonical palette

```text
canvas          #F6F4EF
canvas-warm     #FAF8F3
surface         #FFFFFF
surface-muted   #F8F6F1
text            #191C20
text-soft       #74716A
border          #E8E4DA
border-strong   #D9D3C7
accent          #D8A640
accent-soft     #FBF4DF
success         #557761
danger          #AD5A50
```

Legacy semantic components that still consume `--vbs-*` must inherit aliases from the V2 token family so the shell and stage components no longer render with two near-duplicate palettes.

### Shape, depth, and motion

```text
control radius  10px
card radius     18px
focus radius    22px
transition      150–200ms, target 170ms
hover lift      1px maximum
```

Use shadow only for raised, selected, or focus content. Do not add decorative shadows to every container. Decorative gradients are limited to subtle upload/final-delivery emphasis.

### Typography

Use the existing system stack. Do not add font binaries or webfont dependencies.

```text
Stage title     30–36px / 650
Section title   18–22px / 650
Body            14–15px / 400
Metadata        11–12px / 400–650
Step number     10px / 700
```

Avoid poster-like extra-bold Chinese headings.

## Product header

The header becomes a single quiet 68–72px product navigation layer.

Left:

```text
✦ VideosBatch
  AI 课程视频工作室
```

Center/right metadata:

```text
观察物体（1） · 0/9
```

Right:

```text
流程制作   制作画布
```

The long explanatory sentence is removed from the header. Project metadata remains but loses the heavy boxed-card treatment.

## Production timeline

Keep `WorkflowProgressRail`; do not replace it with a weaker purely decorative stepper.

Restyle it as a state-aware production timeline:

- one node per step with connector line;
- current/confirm uses warm amber;
- completed uses low-saturation green;
- pending uses neutral border/text;
- failed remains explicit red;
- selected state is restrained rather than a large black pill;
- status icon remains so meaning does not depend on color alone;
- horizontal scrolling remains at narrower widths.

## Surface roles

Existing semantic components are visually normalized into three primary roles instead of forcing every region to look identical.

### Surface Card

Normal content/document container. White surface, subtle border, no or minimal shadow.

### Selectable Card

Intro candidate, asset candidate, or another explicit choice. Gains a small hover lift; selected state uses amber border/ring and a restrained raised shadow.

### Focus Card

Current primary task, parsed-document confirmation, or final delivery. May use the larger focus radius and restrained raised shadow.

Dense authoring surfaces such as screenplay/storyboard editors remain flatter so long-form work does not become a stack of oversized floating cards.

## Step 01 lesson upload

Keep the existing react-dropzone and two-tab interaction.

Visual changes only:

- replace the ordinary dashed border with a 1px solid warm border;
- use a very light warm surface/gradient;
- 20–22px radius;
- upload icon retains a dark brand base with amber icon;
- hover changes border/background and lifts at most 1px;
- parse success/warning/error states use the shared state palette.

## Steps 02–08

Do not rewrite stage components. Normalize:

- page title position and vertical rhythm;
- card radius, border, padding, and selection state;
- button hierarchy and focus rings;
- form/editor typography;
- success, warning, error, loading, and empty-state language;
- media card spacing and dense editor surfaces.

The user should not feel that each step came from a different product.

## Step 09 final delivery

The final page becomes a calm delivery/handoff surface rather than another ordinary stage card.

Keep the existing status derivation, native StitchJob playback, download URL, and Canvas action.

Presentation:

- completion/status copy grouped as one delivery header;
- final player is the dominant visual object;
- primary action is download when available;
- secondary action is return to Canvas;
- no confetti, illustration, or high-saturation celebration effect.

## Accessibility and responsive rules

- Existing aria labels and Radix semantics remain.
- Status continues to use icon/text in addition to color.
- `prefers-reduced-motion` remains authoritative.
- Timeline remains horizontally scrollable instead of wrapping into an unstable multi-row layout.
- Guided flow remains a natural page scroll; no nested clipped workspace viewport may be introduced.

## Acceptance criteria

1. Shell and legacy stage components resolve to one canonical V2 palette inside `.videosbatch-studio-v2`.
2. Header reads as one product navigation layer and no longer presents project metadata as a heavy independent card.
3. Progress rail reads as a connected production timeline while preserving every existing workflow status and click target.
4. Step 01 upload interaction is unchanged but uses the new solid-border warm focus surface.
5. Intro/asset selected states share one visual language.
6. Story, screenplay, storyboard, execution, and media surfaces share typography, border, focus, and spacing rules without becoming visually over-carded.
7. Step 09 clearly reads as final delivery while preserving existing playback/download/Canvas behavior.
8. No workflow/API/upload/scrolling contract changes are introduced.
9. Existing VideosBatch smoke tests and build remain green after implementation.
