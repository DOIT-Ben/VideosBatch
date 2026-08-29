# VideosBatch Guided Studio V2 Design

## Status

Approved product redesign for the existing `feat/videosbatch-product-ui` branch.

## Goal

Turn VideosBatch from a workflow/debug UI embedded inside SeeReel into a focused, user-facing course-video production studio whose primary entry is uploading a lesson-plan document (`.doc`, `.docx`, `.pdf`). Preserve SeeReel as the native media runtime and advanced Canvas.

## Product principle

VideosBatch owns the guided experience. SeeReel owns sessions, assets, shots, renders, canvas and stitch.

No second media system, no second session store, no second workflow engine.

## Problems observed in local acceptance

The current browser acceptance screenshot exposed four product problems:

1. SeeReel's 320px session sidebar plus VideosBatch's own workflow sidebar creates duplicated navigation.
2. VideosBatch then adds a third permanent right-side status column, making the content area narrow while still visually sparse.
3. The top SeeReel toolbar and the VideosBatch header duplicate project/status information.
4. Step 01 assumes pasted text, while the real product input is normally a lesson-plan file.

The result reads like an admin/debug console instead of an AI course-video creator.

## V2 information architecture

### Focus mode

When `activeView === "studio"` and `videosBatchMode === "workflow"`, the outer SeeReel shell enters `vbs-flow-focus` mode.

In focus mode:

- hide the 320px SeeReel session sidebar;
- remove workspace outer padding;
- shrink the dark SeeReel top bar to a compact utility strip;
- hide nonessential developer/navigation actions (`AI use me`, GitHub, admin, export, usage) from the utility strip;
- keep credential access and language access available;
- keep the session title editable but visually secondary;
- the VideosBatch header becomes the product identity for the page.

Switching to `制作画布` removes focus mode and restores the original SeeReel shell unchanged.

### Guided Studio layout

The internal left `WorkflowSidebar` and permanent right context column are removed.

The workflow page becomes:

```text
┌───────────────────────────────────────────────────────────────────────┐
│  VideosBatch / 课程视频工作台        project      [流程制作][制作画布] │
│  从教案到课程导入视频                                             │
├───────────────────────────────────────────────────────────────────────┤
│  01教案 ─ 02课程导入 ─ 03故事 ─ 04资产 ─ 05图片 ─ 06剧本 ─ 07分镜 ... │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│                         CURRENT STAGE                                 │
│                                                                       │
│                  wide semantic work area                              │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│  上一步                                      保存/确认/生成下一步 →  │
└───────────────────────────────────────────────────────────────────────┘
```

The 9 user steps remain exactly the V1 product mapping:

1. 教案
2. 课程导入
3. 故事文稿
4. 资产计划
5. 资产图片
6. 视频剧本
7. 视频分镜
8. 视频生成
9. 最终成片

The canonical 13-stage machine workflow remains unchanged.

## Navigation

### Progress stepper

Use a single horizontal progress stepper beneath the VideosBatch header.

Each item shows:

- compact two-digit index;
- user-facing step label;
- state through color/icon rather than a second line of text.

States:

- pending: neutral outline;
- running: animated/accent indicator;
- ready: completed check;
- confirm: amber attention state;
- stale: refresh indicator;
- failed: red/error state;
- selected/current: dark high-contrast pill with subtle amber accent.

On narrower desktop widths the stepper scrolls horizontally instead of wrapping into multiple rows.

### Stage actions

Permanent right-side status UI is removed.

Actions move into a compact stage toolbar:

- `自动运行到确认点` as the useful primary secondary action;
- `重新生成本步骤`;
- Radix `DropdownMenu` for `查看原始数据` and stage diagnostics.

This keeps advanced/debug operations available without occupying 260px permanently.

## Visual direction

### Personality

Modern AI productivity studio, not educational cartoon UI and not admin dashboard.

Keywords:

- warm neutral;
- quiet;
- premium but restrained;
- high information hierarchy;
- large readable content canvas;
- almost no decorative gradients;
- accent color used sparingly.

### Color tokens

```text
canvas          #F4F3EF
canvas-warm     #F8F6F1
surface         #FFFFFF
surface-muted   #F7F5F0
text            #1F2328
text-soft       #6F716C
border          #E4E1D8
border-strong   #D7D2C6
accent          #D8A83E
accent-soft     #FAF0D2
success         #4F755B
danger          #B65A50
focus           rgba(216,168,62,.18)
```

### Shape and depth

- page cards: 18–22px radius;
- small controls: 10–12px radius;
- card shadow: very light, only for raised/selected content;
- avoid borders around every region;
- use whitespace and typography before separators.

### Typography

Use the existing system stack. No new font binary or webfont dependency.

Hierarchy:

- product title: 20–22px / 700;
- stage title: 30–36px / 700;
- body: 14–15px with 1.7–1.9 line-height;
- metadata: 11–12px.

## Step 01: lesson input redesign

### Default mode: upload lesson plan

File upload is the primary/default entry.

Supported formats:

- `.doc`
- `.docx`
- `.pdf`

Maximum file size: 25 MB.

Use `react-dropzone` for drag/drop, keyboard activation and accepted-file handling. Do not hand-roll a custom dropzone interaction layer.

Primary visual:

```text
上传你的课程教案
DOC · DOCX · PDF

[ large dropzone ]
拖入教案，或点击选择文件

             或

[粘贴教案文本]
```

Use Radix Tabs for:

- `上传文件` (default)
- `粘贴文本`

### Parse before workflow start

Uploading a document does not start the VideosBatch workflow.

Sequence:

```text
file selected
  ↓
server parse endpoint
  ↓
parsed text + metadata + warnings
  ↓
preview/edit confirmation
  ↓
user clicks “确认教案并开始制作”
  ↓
existing VideosBatch start endpoint
```

The user must see exactly what text will become `LESSON_INPUT.lessonText`.

### Parsed lesson preview

After parsing:

- file icon + filename;
- format;
- file size;
- character count;
- paragraph count;
- optional PDF page count;
- parsing warnings;
- editable extracted text preview;
- `重新上传`;
- `确认教案并开始制作`.

For an electronic PDF with little/no text, do not silently start. Return a warning/error that the PDF appears scanned and OCR is not part of this V2 scope.

### Text fallback

Pasting text remains supported, but is the secondary tab.

It uses the same confirmation/start path and the same canonical `lessonText` field.

## Lesson document parsing architecture

### Client

`LessonStage` uses `react-dropzone` and calls one new client API:

```ts
api.parseVideosBatchLesson(sessionId, file)
```

The upload uses the same raw-body pattern already used by SeeReel image/video uploads rather than inventing a multipart framework.

Request:

```text
POST /api/sessions/:sessionId/videosbatch/lesson/parse?filename=<name>
Content-Type: <browser file mime or application/octet-stream>
Body: raw file bytes
```

### Server

Add focused parser module:

`src/server/videosBatchWorkflow/lessonDocumentParser.ts`

OSS routing:

- `.doc` → `word-extractor@1.0.4`
- `.docx` → `mammoth@1.12.1` using `extractRawText({ buffer })`
- `.pdf` → `pdf-parse@2.4.5` using `PDFParse({ data })`

`pdf-parse` supports Node 22, matching repository CI.

No OCR is introduced in V2.

### File validation

Validation happens before parser dispatch:

1. file name extension must be `.doc`, `.docx`, or `.pdf`;
2. body must be non-empty and <= 25 MB;
3. magic bytes must match the requested format family:
   - PDF `%PDF-`;
   - DOC OLE compound-file signature `D0 CF 11 E0 A1 B1 1A E1`;
   - DOCX ZIP signature (`PK`) plus parser validation;
4. extracted text must exceed a minimum meaningful threshold;
5. normalize BOM, repeated blank lines and trailing whitespace.

### Response contract

```ts
interface ParsedLessonDocument {
  sourceKind: "file";
  fileName: string;
  fileType: "doc" | "docx" | "pdf";
  mimeType: string;
  sizeBytes: number;
  text: string;
  characterCount: number;
  paragraphCount: number;
  pageCount?: number;
  warnings: string[];
}
```

No uploaded lesson file is persisted as a new SeeReel Asset in V2. Only the extracted user-confirmed text enters the workflow.

This keeps the upload endpoint stateless and avoids creating another document-storage subsystem.

## LESSON_INPUT source metadata

Extend the existing lesson artifact only with optional source metadata:

```ts
interface VideosBatchLessonInputArtifact {
  projectId: string;
  lessonText: string;
  source?: {
    kind: "file" | "pasted_text";
    fileName?: string;
    fileType?: "doc" | "docx" | "pdf";
    sizeBytes?: number;
  };
}
```

All existing consumers continue to use `lessonText` as the fact source.

The optional source object is for UI/history only.

## Existing stages

The semantic V1 stage components remain. They are visually restyled to fit the new wider shell rather than rewritten.

Keep:

- intro candidate cards;
- story editor;
- asset plan;
- native asset candidate gallery;
- screenplay editor;
- Radix Accordion storyboard editor;
- Radix Tabs execution prompt;
- native Shot playback;
- native Stitch final video.

## OSS policy

Use external/general-purpose primitives before writing infrastructure UI:

- `radix-ui@1.6.7` remains the accessibility primitive layer;
- `react-dropzone@20.1.1` handles upload interaction;
- `mammoth@1.12.1` handles DOCX extraction;
- `pdf-parse@2.4.5` handles PDF extraction;
- `word-extractor@1.0.4` handles legacy DOC extraction;
- Lucide remains the icon set;
- SeeReel native models remain the media/runtime system.

Do not copy shadcn component source into this repository.

## Responsive behavior

Primary target: desktop 1280–1920.

- >= 1280: full 9-step horizontal rail;
- 960–1279: horizontally scrollable rail;
- < 960: upload/confirmation still usable, but full screenplay/storyboard authoring is not optimized in V2.

## Accessibility

- upload zone must work through keyboard and file picker;
- accepted/rejected file state must be expressed in text, not color alone;
- stepper buttons have accessible labels with status;
- Radix continues to own Dialog/Tabs/Accordion/DropdownMenu semantics;
- motion respects `prefers-reduced-motion` where animation is used.

## Error behavior

Explicit user-facing errors:

- unsupported extension;
- file too large;
- signature/type mismatch;
- password-protected/invalid document;
- no extractable lesson text;
- scanned PDF likely requires OCR;
- server parsing error.

Errors never start the workflow.

## Non-goals

V2 does not add:

- OCR for scanned PDF;
- cloud document storage;
- multi-file lesson merging;
- Google Docs/Drive import;
- rich DOCX layout preservation;
- a new editor framework;
- a second file manager;
- changes to canonical 13-stage generation semantics.

## Acceptance criteria

1. Flow mode no longer shows the SeeReel session sidebar.
2. VideosBatch no longer shows its own permanent left workflow sidebar or permanent right context sidebar.
3. Nine product steps are accessible from one horizontal progress rail.
4. The page has one dominant central content region.
5. Lesson step defaults to `上传文件`.
6. `.doc`, `.docx`, and `.pdf` can be parsed locally by the server without external Office software.
7. User sees and can edit extracted lesson text before workflow start.
8. Pasted text remains supported as a secondary path.
9. Existing V1 Content UX still works.
10. Switching to Canvas restores the original SeeReel shell.
11. Fake provider mode can complete the guided acceptance flow without keys.
12. Build and all existing SeeReel/VideosBatch regressions remain green.
