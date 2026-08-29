# VideosBatch Guided Studio V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign VideosBatch flow mode into a focused, attractive Guided Studio and make DOC/DOCX/PDF lesson-plan upload the default workflow entry.

**Architecture:** Keep the existing canonical workflow and SeeReel media runtime. Add a stateless server-side lesson document parser, a raw-file parse API, and a file-first LessonStage. Replace the internal three-column VideosBatch shell with a focused product header + horizontal progress rail + single wide semantic workspace; flow mode temporarily hides the outer SeeReel session dock while Canvas mode restores it.

**Tech Stack:** React 19, TypeScript, Express 5, Radix UI 1.6.7, react-dropzone 20.1.1, Mammoth 1.12.1, pdf-parse 2.4.5, word-extractor 1.0.4, Lucide React, existing SeeReel Store/API.

**Spec:** `docs/superpowers/specs/2026-08-29-videosbatch-guided-studio-v2-design.md`

## Global Constraints

- Canonical 13-stage workflow order remains unchanged.
- `lessonText` remains the sole teaching-text fact source consumed by generation stages.
- Upload parse is stateless: do not create a second document storage system.
- Supported lesson file types are exactly `.doc`, `.docx`, `.pdf` for V2.
- Max upload size is 25 MB.
- No OCR in this plan.
- File upload is primary; pasted text is secondary.
- Reuse `radix-ui@1.6.7` for accessibility primitives and `react-dropzone@20.1.1` for drag/drop.
- Canvas mode must restore the existing SeeReel shell unchanged.
- Existing V1 semantic stage pages and native Asset/Shot/Stitch integrations remain intact.

---

## File map

### New files

- `src/server/videosBatchWorkflow/lessonDocumentParser.ts` — validates and extracts text from DOC/DOCX/PDF buffers.
- `src/client/videosBatchStudio/components/WorkflowProgressRail.tsx` — 9-step horizontal product navigation.
- `src/client/videosBatchStudio/components/StudioStageToolbar.tsx` — compact current-stage status/actions replacing right context column.
- `scripts/smoke-videosbatch-lesson-document-parser.ts` — parser contract and validation smoke.
- `scripts/smoke-videosbatch-guided-studio-v2.tsx` — UI architecture/lesson upload contract smoke.
- `src/client/videosBatchStudio/guidedStudioV2.css` — V2 layout, focus shell and upload visuals.

### Modified files

- `package.json`, `package-lock.json` — add parsing/dropzone dependencies.
- `.github/workflows/phase1-verify.yml` — run new V2 smokes.
- `src/shared/videosBatchWorkflow.ts` — optional lesson source metadata.
- `src/server/videosBatchWorkflow/api.ts` — raw lesson parse endpoint and optional source start metadata.
- `src/client/api.ts` — raw file parse request and extended start payload.
- `src/client/videosBatchStudio/stages/LessonStage.tsx` — upload-first UI + parse preview confirmation.
- `src/client/videosBatchStudio/stages/StageWorkspace.tsx` — pass lesson parse callback/source metadata.
- `src/client/videosBatchStudio/VideosBatchHeader.tsx` — V2 compact product header.
- `src/client/videosBatchStudio/VideosBatchStudio.tsx` — remove sidebar/context, add rail/toolbar, preserve workflow actions.
- `src/client/App.tsx` — add `vbs-flow-focus` shell class and flow/canvas transition behavior.
- `src/client/main.tsx` — load V2 stylesheet.

---

### Task 1: Lock V2 contracts with RED tests

**Files:**
- Create: `scripts/smoke-videosbatch-lesson-document-parser.ts`
- Create: `scripts/smoke-videosbatch-guided-studio-v2.tsx`
- Modify: `.github/workflows/phase1-verify.yml`

**Interfaces:**
- Produces test expectations for `parseLessonDocument`, upload-first LessonStage, focus shell, and horizontal rail.

- [ ] **Step 1: Write parser contract smoke**

Test pure validation helpers with synthetic signatures before real parsing fixtures:

```ts
assert.equal(detectLessonDocumentType("lesson.pdf", Buffer.from("%PDF-1.7")), "pdf");
assert.equal(detectLessonDocumentType("lesson.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04])), "docx");
assert.equal(detectLessonDocumentType("lesson.doc", Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])), "doc");
assert.throws(() => validateLessonFileSize(25 * 1024 * 1024 + 1));
```

Also assert normalization removes BOM/repeated excessive blank lines and that unsupported extensions reject.

- [ ] **Step 2: Write Guided Studio V2 smoke**

Assert source-level product boundaries:

```ts
assert.ok(videosBatchStudioSource.includes("WorkflowProgressRail"));
assert.ok(!videosBatchStudioSource.includes("<WorkflowSidebar"));
assert.ok(!videosBatchStudioSource.includes('className="vbs-context"'));
assert.ok(lessonStageSource.includes("useDropzone"));
assert.ok(lessonStageSource.includes("上传文件"));
assert.ok(lessonStageSource.includes("粘贴文本"));
assert.ok(appSource.includes("vbs-flow-focus"));
```

Render `LessonStage` in its initial state and assert `DOC`, `DOCX`, `PDF`, `拖入教案` are visible.

- [ ] **Step 3: Add both smokes to CI**

Add after existing Product UI/Content UX checks:

```yaml
- name: Verify VideosBatch lesson document parser
  run: npx tsx scripts/smoke-videosbatch-lesson-document-parser.ts
- name: Verify VideosBatch Guided Studio V2
  run: npx tsx scripts/smoke-videosbatch-guided-studio-v2.tsx
```

- [ ] **Step 4: Run CI and confirm RED**

Expected: existing checks pass first; new tests fail because parser/V2 components do not exist.

- [ ] **Step 5: Commit**

```bash
git add scripts .github/workflows/phase1-verify.yml
git commit -m "test: define VideosBatch Guided Studio V2 contracts"
```

---

### Task 2: Add OSS dependencies and server lesson parser

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/server/videosBatchWorkflow/lessonDocumentParser.ts`
- Test: `scripts/smoke-videosbatch-lesson-document-parser.ts`

**Interfaces:**

```ts
export type LessonDocumentType = "doc" | "docx" | "pdf";

export interface ParsedLessonDocument {
  sourceKind: "file";
  fileName: string;
  fileType: LessonDocumentType;
  mimeType: string;
  sizeBytes: number;
  text: string;
  characterCount: number;
  paragraphCount: number;
  pageCount?: number;
  warnings: string[];
}

export function detectLessonDocumentType(fileName: string, buffer: Buffer): LessonDocumentType;
export function validateLessonFileSize(sizeBytes: number): void;
export function normalizeLessonText(value: string): string;
export async function parseLessonDocument(input: { fileName: string; mimeType?: string; buffer: Buffer }): Promise<ParsedLessonDocument>;
```

- [ ] **Step 1: Add pinned direct dependencies**

```json
"mammoth": "1.12.1",
"pdf-parse": "2.4.5",
"react-dropzone": "20.1.1",
"word-extractor": "1.0.4"
```

Use one controlled CI/npm install step to regenerate lockfile; remove any temporary workflow after the lockfile commit.

- [ ] **Step 2: Implement signature and size validation**

Constants:

```ts
export const MAX_LESSON_FILE_BYTES = 25 * 1024 * 1024;
const PDF_SIGNATURE = Buffer.from("%PDF-");
const DOC_SIGNATURE = Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
```

DOCX accepts ZIP signatures `50 4B 03 04`, `50 4B 05 06`, or `50 4B 07 08` and then relies on Mammoth to validate package content.

- [ ] **Step 3: Implement text normalization**

```ts
return value
  .replace(/^\uFEFF/, "")
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map((line) => line.replace(/[\t ]+$/g, ""))
  .join("\n")
  .replace(/\n{4,}/g, "\n\n\n")
  .trim();
```

- [ ] **Step 4: Implement format routers**

DOCX:

```ts
const result = await mammoth.extractRawText({ buffer });
```

DOC:

```ts
const extractor = new WordExtractor();
const document = await extractor.extract(buffer);
const text = document.getBody();
```

PDF:

```ts
const parser = new PDFParse({ data: new Uint8Array(buffer) });
try {
  const [textResult, infoResult] = await Promise.all([
    parser.getText(),
    parser.getInfo({ parsePageInfo: false })
  ]);
  // textResult.text; infoResult.total
} finally {
  await parser.destroy();
}
```

If normalized extracted text is under 40 non-whitespace characters, throw a user-facing error explaining that the file has no meaningful extractable text; for PDF mention likely scanned/OCR requirement.

- [ ] **Step 5: Run parser smoke**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/server/videosBatchWorkflow/lessonDocumentParser.ts scripts/smoke-videosbatch-lesson-document-parser.ts
git commit -m "feat: parse lesson plan DOC DOCX and PDF files"
```

---

### Task 3: Add stateless lesson parse API and source metadata

**Files:**
- Modify: `src/shared/videosBatchWorkflow.ts`
- Modify: `src/server/videosBatchWorkflow/api.ts`
- Modify: `src/client/api.ts`
- Modify: `scripts/smoke-videosbatch-api.ts`

**Interfaces:**

Extend source metadata:

```ts
export interface VideosBatchLessonSource {
  kind: "file" | "pasted_text";
  fileName?: string;
  fileType?: "doc" | "docx" | "pdf";
  sizeBytes?: number;
}
```

`createVideosBatchWorkflow` input accepts optional `source?: VideosBatchLessonSource`.

Client:

```ts
parseVideosBatchLesson(sessionId: string, file: File): Promise<ParsedLessonDocument>
startVideosBatch(sessionId: string, payload: { projectId: string; lessonText: string; source?: VideosBatchLessonSource })
```

- [ ] **Step 1: Extend LESSON_INPUT artifact types**

Source remains optional so every old fixture stays compatible.

- [ ] **Step 2: Add raw parse route**

Register before normal workflow routes:

```ts
app.post(
  "/api/sessions/:sessionId/videosbatch/lesson/parse",
  express.raw({ type: () => true, limit: MAX_LESSON_FILE_BYTES }),
  async (req, res) => { ... }
);
```

Require an existing Session but do not require an existing VideosBatch workflow.

Read `filename` from query, `req.body` as Buffer, `content-type` from headers, call `parseLessonDocument`, return JSON.

- [ ] **Step 3: Extend start route**

Pass sanitized optional source metadata into `createVideosBatchWorkflow`.

- [ ] **Step 4: Add raw-file client request helper**

Do not route file bytes through the JSON `request()` helper because it defaults to JSON headers.

Use a focused helper that includes access headers and surfaces server JSON errors.

- [ ] **Step 5: Extend API smoke**

At minimum verify unsupported extension returns 400 and existing start workflow path remains compatible.

- [ ] **Step 6: Run API/parser/workflow smokes**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/videosBatchWorkflow.ts src/server/videosBatchWorkflow/api.ts src/client/api.ts scripts/smoke-videosbatch-api.ts
git commit -m "feat: add lesson plan parse API"
```

---

### Task 4: Rebuild LessonStage as upload-first onboarding

**Files:**
- Modify: `src/client/videosBatchStudio/stages/LessonStage.tsx`
- Modify: `src/client/videosBatchStudio/stages/StageWorkspace.tsx`
- Modify: `src/client/videosBatchStudio/VideosBatchStudio.tsx`
- Test: `scripts/smoke-videosbatch-guided-studio-v2.tsx`

**Interfaces:**

`LessonStage` new props:

```ts
onParseFile?: (file: File) => Promise<ParsedLessonDocument>;
onStart: (lessonText: string, source?: VideosBatchLessonSource) => Promise<void> | void;
```

- [ ] **Step 1: Replace textarea-first UI with Radix Tabs**

Default value: `upload`.

Tabs:

```text
上传文件 | 粘贴文本
```

- [ ] **Step 2: Add `useDropzone`**

Accepted extensions and MIME families include PDF, legacy Word, OOXML Word and `application/octet-stream` fallback. Enforce one file and 25 MB client limit.

- [ ] **Step 3: Add parse states**

State machine inside LessonStage:

```ts
type ParseState =
  | { kind: "idle" }
  | { kind: "parsing"; fileName: string }
  | { kind: "ready"; document: ParsedLessonDocument; draftText: string }
  | { kind: "error"; message: string };
```

- [ ] **Step 4: Render parsed confirmation card**

Show filename, file type, human-readable size, characters, paragraphs, optional pages, warnings, editable extracted text, reupload action and confirm CTA.

- [ ] **Step 5: Keep pasted text fallback**

Pasted path calls:

```ts
onStart(draft.trim(), { kind: "pasted_text" });
```

File path calls:

```ts
onStart(parsedDraft.trim(), {
  kind: "file",
  fileName: document.fileName,
  fileType: document.fileType,
  sizeBytes: document.sizeBytes
});
```

- [ ] **Step 6: Wire VideosBatchStudio**

Add `parseLessonFile(file)` using client API and pass it through StageWorkspace.

- [ ] **Step 7: Run V2 + Content UX + Foundation smokes**

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/client/videosBatchStudio scripts/smoke-videosbatch-guided-studio-v2.tsx
git commit -m "feat: make lesson upload the VideosBatch entry"
```

---

### Task 5: Replace three-column Guided Studio with product shell

**Files:**
- Create: `src/client/videosBatchStudio/components/WorkflowProgressRail.tsx`
- Create: `src/client/videosBatchStudio/components/StudioStageToolbar.tsx`
- Modify: `src/client/videosBatchStudio/VideosBatchHeader.tsx`
- Modify: `src/client/videosBatchStudio/VideosBatchStudio.tsx`
- Modify: `src/client/App.tsx`
- Create: `src/client/videosBatchStudio/guidedStudioV2.css`
- Modify: `src/client/main.tsx`

**Interfaces:**

`WorkflowProgressRail` consumes the existing `VIDEOS_BATCH_PRODUCT_STEPS`, derived status function, current/selected ids and `onSelectStep`.

`StudioStageToolbar` consumes selected/current step/status and callbacks for run-all, restart and debug drawer.

- [ ] **Step 1: Create horizontal progress rail**

Use semantic buttons in a horizontal scroller. No new progress/state model.

- [ ] **Step 2: Create compact stage toolbar**

Use Radix `DropdownMenu` for advanced actions. Keep auto-run visible; place restart/raw data in menu or secondary controls.

- [ ] **Step 3: Remove internal sidebar/context**

Delete `WorkflowSidebar` and `.vbs-context` usage from `VideosBatchStudio`; preserve files if other tests/imports still reference them, but they must not render in V2.

Layout becomes:

```tsx
<VideosBatchHeader />
<WorkflowProgressRail />
<StudioStageToolbar />
<main className="vbs-v2-workspace">...</main>
<WorkflowFooter />
```

- [ ] **Step 4: Add outer focus-mode class**

In App:

```tsx
const videosBatchFlowFocus = activeView === "studio" && Boolean(selectedSession) && videosBatchMode === "workflow";
<main className={`app-shell ${videosBatchFlowFocus ? "vbs-flow-focus" : ""}`}>
```

- [ ] **Step 5: Add focus-shell CSS**

At minimum:

```css
.app-shell.vbs-flow-focus { grid-template-columns: 1fr; }
.app-shell.vbs-flow-focus > .sidebar { display: none; }
.app-shell.vbs-flow-focus > .workspace { padding: 0; background: #f4f3ef; }
```

Shrink `.topbar` and hide developer-only top actions in flow focus without altering Canvas mode selectors.

- [ ] **Step 6: Load V2 stylesheet from client entry**

Keep component TSX SSR-loadable; import CSS from `main.tsx`, not from components used by Node smokes.

- [ ] **Step 7: Run V2/Foundation/Content UX tests**

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/client/App.tsx src/client/main.tsx src/client/videosBatchStudio
git commit -m "feat: redesign VideosBatch Guided Studio shell"
```

---

### Task 6: Visual polish existing semantic stage pages

**Files:**
- Modify: `src/client/videosBatchStudio/guidedStudioV2.css`
- Modify only if required: existing stage components for semantic wrapper classes, not data behavior.

**Interfaces:** None new.

- [ ] **Step 1: Apply V2 tokens and card hierarchy**

Use warm neutral canvas, white cards, restrained amber accent and dark text. Remove excessive borders; widen semantic workspace to max 1180–1240px.

- [ ] **Step 2: Polish Intro Cards**

Three-column cards at wide desktop; stronger selected state; less vertical dead space; recommendation as compact chip.

- [ ] **Step 3: Polish asset gallery**

Use consistent image ratio, 2–3 columns depending width, clear selection affordance, large preview dialog unchanged.

- [ ] **Step 4: Polish screenplay/storyboard**

Improve spacing, typography, locked-structure notices and accordion density without changing edit contracts.

- [ ] **Step 5: Polish execution/final video**

Make video previews dominant; metadata secondary; final video gets one hero playback card.

- [ ] **Step 6: Add responsive rail/workspace rules**

No wrapping stepper. At <= 960px allow horizontal rail scrolling and single-column content cards.

- [ ] **Step 7: Verify reduced motion**

Disable nonessential transition animations under `prefers-reduced-motion: reduce`.

- [ ] **Step 8: Run build and product UI smokes**

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/client/videosBatchStudio/guidedStudioV2.css src/client/videosBatchStudio/stages
git commit -m "style: polish VideosBatch Guided Studio V2"
```

---

### Task 7: Final verification and PR acceptance candidate

**Files:**
- Potentially modify: PR #6 body only; no product code unless a verified regression is found.

- [ ] **Step 1: Run fresh full CI on final branch head**

Required passing gates:

```text
no-legacy contract
workflow state
runner
API
UI
Product UI Foundation
Content UX
COPYABLE_PROMPT UI
Lesson document parser
Guided Studio V2
full fake E2E
native projection
LLM executor/runtime
real text server path
native media
FrameFlow canonical
TypeScript + Vite build
Canvas CRUD
Shot generation
Skill boundaries
Stitch
```

- [ ] **Step 2: Compare against master**

Confirm no temporary dependency-install workflow or unrelated files remain.

- [ ] **Step 3: Update Draft PR #6**

Document V2 focus-mode layout, file formats, parser dependencies and acceptance instructions.

- [ ] **Step 4: Keep PR unmerged**

Local browser acceptance remains the merge gate.

---

## Self-review

### Spec coverage

- Focus shell: Task 5.
- Remove duplicated internal sidebars: Task 5.
- 9-step horizontal navigation: Task 5.
- DOC/DOCX/PDF parsing: Tasks 2–3.
- Upload-first LessonStage: Task 4.
- Parse preview/edit/confirm: Task 4.
- OSS reuse: Tasks 2, 4, 5.
- Existing stage UX preserved: Tasks 5–6.
- OCR explicitly excluded: Global Constraints / parser behavior.
- Canvas restoration: Task 5 + final regression.
- Full verification: Task 7.

### Placeholder scan

No TBD/TODO implementation placeholders remain in this plan.

### Type consistency

`ParsedLessonDocument` and `VideosBatchLessonSource` interfaces are defined before client/server usage. `lessonText` remains unchanged for downstream model stages.
