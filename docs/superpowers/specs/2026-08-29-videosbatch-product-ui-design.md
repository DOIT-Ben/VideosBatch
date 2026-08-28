# VideosBatch Product UI V1 Design

## Status

Canonical product UI specification for VideosBatch on top of SeeReel.

This document defines the user-facing product experience only. Workflow semantics remain owned by the current VideosBatch canonical workflow contract and FrameFlow source-of-truth. SeeReel remains the native media production surface and data model.

## Product goal

Turn the existing engineering-facing `WorkflowRail + raw JSON ArtifactPanel + SeeReel Canvas` into a guided course-video production experience that a non-technical creator can operate end-to-end without understanding workflow IDs, JSON artifacts, Asset IDs, Shot IDs, provider dialects, or SeeReel internals.

The product must preserve every existing production capability while reducing the amount of system vocabulary exposed to ordinary users.

## Core product principle

VideosBatch owns **workflow guidance and decision UX**.

SeeReel owns **media objects, fine editing, rendering, playback, review, and stitching**.

Both views operate on the same persisted Session and native objects:

```text
VideosBatch Guided Studio
        │
        │ same Session / Assets / Shots / Renders / StitchJobs
        ▼
SeeReel native state
        ▲
        │
SeeReel Canvas
```

No duplicated Asset model, Shot model, Canvas model, media cache, renderer, or stitch system may be introduced.

## Primary navigation

For a selected project/session, the workspace has two first-class modes:

1. **流程制作** — default mode. Guided, content-first, stage-aware experience.
2. **制作画布** — advanced mode. Existing SeeReel Canvas with full native editing capabilities.

Default behavior:

- Opening a VideosBatch project defaults to `流程制作`.
- `制作画布` is always available from the project header.
- Switching modes never copies data and never creates a new Session.
- The active mode is local UI state in V1 and does not modify workflow state.

## User-facing workflow

The machine workflow remains 13 canonical stages:

```text
LESSON_INPUT
COURSE_INTRO_CANDIDATES
COURSE_INTRO_SELECTION
STORY_SCRIPT
ASSET_PLAN
ASSET_CANDIDATES
ASSET_CONFIRMATION
SCREENPLAY
FINAL_STORYBOARD
COPYABLE_PROMPT
QUOTE
EXECUTION
STITCH
```

The product UI groups them into 9 human-facing steps:

| Product step | Machine stages |
| --- | --- |
| 01 教案 | `LESSON_INPUT` |
| 02 课程导入 | `COURSE_INTRO_CANDIDATES` + `COURSE_INTRO_SELECTION` |
| 03 故事文稿 | `STORY_SCRIPT` |
| 04 资产计划 | `ASSET_PLAN` |
| 05 资产图片 | `ASSET_CANDIDATES` + `ASSET_CONFIRMATION` |
| 06 视频剧本 | `SCREENPLAY` |
| 07 视频分镜 | `FINAL_STORYBOARD` + `COPYABLE_PROMPT` |
| 08 视频生成 | `QUOTE` + `EXECUTION` |
| 09 最终成片 | `STITCH` |

The grouping is presentation only. Server stage IDs and ordering are unchanged.

## Desktop information architecture

Target layout for >= 1024px:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ VideosBatch   项目标题                         状态      流程制作 | 制作画布 │
├───────────────┬────────────────────────────────────┬─────────────────────┤
│               │                                    │                     │
│ ✓ 01 教案     │                                    │ 当前步骤            │
│ ✓ 02 课程导入 │                                    │ 状态                │
│ ● 03 故事文稿 │          主工作区                  │ 版本                │
│ ○ 04 资产计划 │                                    │ 上游依赖            │
│ ○ 05 资产图片 │                                    │                     │
│ ○ 06 视频剧本 │                                    │ 重新生成            │
│ ○ 07 视频分镜 │                                    │ 查看原始数据        │
│ ○ 08 视频生成 │                                    │                     │
│ ○ 09 最终成片 │                                    │                     │
├───────────────┴────────────────────────────────────┴─────────────────────┤
│ 上一步                                      保存并继续 / 生成下一步 →     │
└──────────────────────────────────────────────────────────────────────────┘
```

Column behavior:

- Left sidebar: 220–248px fixed width.
- Main stage workspace: flexible, minimum 560px.
- Right context rail: 240–280px when viewport >= 1280px; collapses into a drawer below that.
- SeeReel Canvas replaces the Guided Studio content entirely when `制作画布` is selected.

## Global header

The product header displays:

- `VideosBatch`
- current session/project title
- autosave/current workflow status
- provider readiness summary without exposing secrets
- segmented mode switch: `流程制作` / `制作画布`
- primary action for the current step

Provider details are not a blocking part of V1 UI. A compact readiness indicator is enough:

```text
文本：模拟 / 已连接
媒体：模拟 / 已连接
```

Secret entry continues to use the existing credential/configuration mechanisms until a dedicated VideosBatch settings experience is designed.

## Workflow sidebar

The sidebar shows 9 product steps, not 13 machine stages.

Each step displays one user-facing state:

- `未开始`
- `生成中`
- `已完成`
- `需要确认`
- `需要更新`
- `失败`

Mapping rules:

- machine `pending` → `未开始`
- machine `running` → `生成中`
- machine `failed` → `失败`
- machine `stale` → `需要更新`
- machine `ready` → `已完成`
- manual-gate stage ready but not yet confirmed/locked → `需要确认`

Manual gate product steps:

- 课程导入: `COURSE_INTRO_SELECTION`
- 资产图片: `ASSET_CONFIRMATION`

The sidebar may expose completion progress but must not expose raw revision numbers by default.

## Step 01 — 教案

Purpose: create the workflow from a complete lesson plan.

Primary fields:

- 项目名称 — prefilled from Session title, editable using existing session title behavior.
- 完整教案 — large content textarea/editor.
- 视频比例 — V1 read-only/default `16:9` unless the workflow contract later exposes a canonical value.
- 目标风格 — summarized from current project/style configuration when available.
- 生成方式 — `分步确认` in V1.

Do not expose `projectId` as a required user field. The client may continue passing a generated/default project identifier internally.

Primary action: `开始生成课程导入`.

## Step 02 — 课程导入

Render `COURSE_INTRO_CANDIDATES` as three semantic groups with three cards each:

- A 数学史与知识由来
- B 历史需求与古今应用
- C 创意故事与现代情境

Each candidate card shows:

- code/title
- candidate text
- type/category
- recommendation indicators when present in the artifact
- authenticity/background information when present
- selected state

Primary action per card: `选择此方案`.

Once selected, show a persistent locked-selection banner and the action `继续生成故事`.

The product UI must never require editing candidate JSON.

## Step 03 — 故事文稿

Render the single canonical `STORY_SCRIPT` as a readable long-form document.

Visible metadata when present:

- title
- story type
- authenticity/background note
- word count
- core knowledge point

Actions:

- 编辑正文
- 重新生成
- 确认故事 / 继续生成资产计划

Editing is field-aware text editing, not raw JSON editing.

## Step 04 — 资产计划

Render `ASSET_PLAN` as semantic groups:

- 人物/拟人动物
- 场景/空间环境
- 兵器/法宝/道具
- 神兽/灵宠/非拟人生物

Each asset plan row/card displays:

- user-facing stable ID when assigned (`P001-A001` style)
- asset name
- category
- source evidence/source scene
- description/continuity notes
- generation prompt
- aspect ratio

Primary interaction: inspect and edit prompt/content before candidate generation.

`assetKey` and native SeeReel `Asset.id` remain advanced/debug information.

## Step 05 — 资产图片

Render native SeeReel Assets and `ASSET_CANDIDATES` as a gallery, grouped by asset category.

Asset card states:

- 待生成
- 生成中
- 待确认
- 已确认
- 失败

Each card shows:

- image thumbnail
- asset name
- stable user-facing ID
- candidate count/selection state if relevant
- confirmation status

Actions:

- 生成
- 换一张 / 重新生成
- 选择图片
- 确认当前图片
- 查看详情

Asset detail opens in a side drawer and can show the full prompt and advanced metadata.

The gallery uses the existing native Asset data; no duplicate image store is introduced.

## Step 06 — 视频剧本

Render `SCREENPLAY` as a structured document editor.

Header shows:

- target duration
- expected storyboard segment count = `targetDurationSeconds / 10`

Each segment/scene renders readable fields such as:

- sequence/title
- visual
- narration/dialogue
- sound/music guidance
- teaching purpose

Actions:

- edit
- save
- regenerate stage
- generate storyboard

## Step 07 — 视频分镜

Render `FINAL_STORYBOARD` as vertically stacked 10-second shot cards.

Each card displays:

- sequence and time range
- teaching purpose
- visual prompt
- narration/subtitles when present
- 3–5 subshots with timing, visual/action, camera, sound/voice
- resolved asset chips/thumbnails

`COPYABLE_PROMPT` is treated as derived execution data, not a second primary document. It can be viewed under advanced details.

Actions:

- edit storyboard content
- regenerate from this point
- open matching native Shot in Canvas

## Step 08 — 视频生成

Render `EXECUTION` and native Shot/ShotRender state as a batch execution dashboard.

Header:

- total shots
- completed shots
- progress percentage

Each task row shows:

- shot sequence
- state
- progress when available
- duration
- video thumbnail/player when ready

Actions:

- play
- regenerate a failed/completed shot
- open in Canvas

`QUOTE` is subordinate product information in V1 and must not become a standalone user step.

## Step 09 — 最终成片

Render current canonical/native Stitch result as a completion page.

Visible content:

- final video player
- final duration when known
- number of shots
- completion time when available
- final status/error

Actions:

- 下载 MP4
- 重新拼接
- 进入制作画布

Users do not need to understand `StitchJob` IDs.

## Advanced/raw data access

Raw JSON remains available for developers and advanced operators but is removed from the primary content surface.

Every stage page can expose an overflow action:

```text
⋯
├─ 查看原始数据
├─ 复制 JSON
└─ 查看版本信息
```

The existing `WorkflowArtifactPanel` logic is repurposed into an `ArtifactDebugDrawer`.

Raw JSON editing is not the default editing UX. If retained, it must be clearly labeled advanced/debug.

## Foundation component architecture

Create a new product boundary instead of expanding `App.tsx` or continuing to grow `WorkflowRail.tsx`.

```text
src/client/videosBatchStudio/
  VideosBatchStudio.tsx
  VideosBatchHeader.tsx
  WorkflowSidebar.tsx
  WorkflowFooter.tsx
  stageModel.ts

  stages/
    LessonStage.tsx
    IntroCandidatesStage.tsx
    StoryStage.tsx
    AssetPlanStage.tsx
    AssetGalleryStage.tsx
    ScreenplayStage.tsx
    StoryboardStage.tsx
    ExecutionStage.tsx
    FinalVideoStage.tsx

  components/
    StageStatus.tsx
    ArtifactDebugDrawer.tsx

  videosBatchStudio.css
```

V1 Foundation does not need every specialized renderer fully implemented. It must establish this boundary and route current artifacts into stage-specific placeholders/semantic renderers without falling back to the old horizontal Rail as the primary UI.

## App integration

`src/client/App.tsx` responsibilities after the refactor:

- own the selected SeeReel Session and global application state as it does today
- own or host the local `workflow | canvas` mode choice
- render `VideosBatchStudio` for workflow mode when a Session is selected
- render the existing `FlowView` unchanged for canvas mode
- pass a callback that updates `selectedSession.videosBatchWorkflow` in the existing state tree

`App.tsx` must not own stage rendering logic.

## API usage

Use existing VideosBatch client methods:

- start workflow
- get workflow
- run next
- run all
- save artifact
- restart from stage

V1 Product UI does not require a new server API unless a semantic action cannot be represented by the existing artifact-save and runner APIs.

Manual selection/confirmation actions should write the canonical artifact required by the existing server runner rather than introducing UI-only state.

## Visual system

Guided workflow mode uses a light, calm editorial workspace distinct from the dark SeeReel Canvas.

Suggested tokens:

```text
page background    #F7F4EC
surface            #FFFFFF
surface subtle     #FBF9F4
primary text       #25231F
secondary text     #77736A
border             #E8E3D8
brand accent       #E5B84B
brand accent soft  #F7E8B9
success            muted green
error              muted red
```

Visual rules:

- no large decorative gradients
- no glassmorphism-heavy panels
- high whitespace and reading comfort
- content cards use consistent radius and thin borders
- primary content typography is optimized for Chinese long-form reading
- status color is secondary to text/icon state
- brand yellow is used for focus, selection, progress, and primary action only

Canvas mode retains SeeReel's existing dark professional visual language.

## Responsive behavior

V1 targets desktop first:

- 1440px: optimal three-column Guided Studio
- 1280px: normal three-column Guided Studio
- 1024px: right context rail collapses to drawer
- < 900px: sidebar becomes compact step switcher; long-form editing may remain limited

Mobile is not required to support full storyboard/media fine editing in V1.

## Non-goals

V1 must not introduce:

- generic DAG workflow editor
- new Canvas implementation
- new Asset model/store
- new Shot model/store
- new media player subsystem
- multi-story parallel production
- multiplayer collaboration
- billing/commerce UI beyond passive quote visibility
- prompt IDE
- provider-specific `@图片N` editing UX

## Phase implementation

### Phase 1 — Foundation

- dual mode shell
- Guided Studio default
- vertical 9-step sidebar
- common stage layout/header/footer
- stage selection model
- status mapping
- generic semantic stage renderer boundary
- raw JSON moved to advanced drawer
- existing Canvas preserved unchanged

### Phase 2 — Content UX

- 3×3 intro candidate cards and selection
- story reader/editor
- asset plan grouped view
- asset gallery and confirmation
- screenplay document editor
- storyboard shot cards

### Phase 3 — Media polish

- native image loading/progress/error presentation
- video batch progress and preview
- final video page
- empty/loading/stale/failure recovery states
- responsive polish
- visual consistency and interaction animation

## Acceptance criteria for Phase 1

1. Opening a selected VideosBatch Session shows `流程制作` by default.
2. A visible mode switch changes between Guided Studio and existing SeeReel Canvas without changing Session identity.
3. Guided Studio shows 9 product steps rather than 13 machine cards.
4. Current workflow progress/status maps correctly to those 9 steps.
5. Selecting a product step renders a dedicated stage workspace region.
6. Raw JSON is hidden behind an explicit advanced/debug action.
7. Starting, running next, auto-running, restarting, and saving artifacts continue to use existing API behavior.
8. No change is made to native SeeReel Asset/Shot/Stitch data models.
9. Existing SeeReel Canvas renders unchanged in canvas mode.
10. TypeScript build and existing VideosBatch/SeeReel smoke tests remain green.
