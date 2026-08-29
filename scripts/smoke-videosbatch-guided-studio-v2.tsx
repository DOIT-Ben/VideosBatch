import React from "react";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { LessonStage } from "../src/client/videosBatchStudio/stages/LessonStage";
import { VideosBatchStudio } from "../src/client/videosBatchStudio/VideosBatchStudio";
import { WorkflowProgressRail } from "../src/client/videosBatchStudio/components/WorkflowProgressRail";
import { VIDEOS_BATCH_PRODUCT_STEPS } from "../src/client/videosBatchStudio/stageModel";

const lessonMarkup = renderToStaticMarkup(
  <LessonStage
    sessionTitle="观察物体（1）"
    busy={false}
    started={false}
    onStart={() => undefined}
  />
);

assert.ok(lessonMarkup.includes("上传文件"), "lesson entry must default to a file-upload product path");
assert.ok(lessonMarkup.includes("粘贴文本"), "pasted text must remain available as the secondary lesson input path");
assert.ok(lessonMarkup.includes("DOC"), "lesson upload must advertise DOC support");
assert.ok(lessonMarkup.includes("DOCX"), "lesson upload must advertise DOCX support");
assert.ok(lessonMarkup.includes("PDF"), "lesson upload must advertise PDF support");
assert.ok(lessonMarkup.includes("拖入教案") || lessonMarkup.includes("选择文件"), "lesson upload must render a clear dropzone affordance");

const retainedDraftMarkup = renderToStaticMarkup(
  <LessonStage
    sessionTitle="观察物体（1）"
    busy={false}
    started={false}
    parsedDraft={{
      document: {
        sourceKind: "file",
        fileName: "观察物体.docx",
        fileType: "docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 1024,
        text: "原始教案内容",
        characterCount: 6,
        paragraphCount: 1,
        warnings: []
      },
      draftText: "返回教案步骤后仍可继续编辑的内容"
    }}
    onStart={() => undefined}
  />
);
assert.ok(retainedDraftMarkup.includes("观察物体.docx"), "parsed file metadata must render from a retained parent draft");
assert.ok(retainedDraftMarkup.includes("返回教案步骤后仍可继续编辑的内容"), "parsed lesson draft must survive a stage remount");

const railMarkup = renderToStaticMarkup(
  <WorkflowProgressRail
    steps={VIDEOS_BATCH_PRODUCT_STEPS}
    selectedStepId="lesson"
    currentStepId="lesson"
    getStatus={() => "pending"}
    onSelectStep={() => undefined}
  />
);
assert.ok(railMarkup.includes("教案"));
assert.ok(railMarkup.includes("最终成片"));

const preStartStudioMarkup = renderToStaticMarkup(
  <VideosBatchStudio
    sessionId="session-v2-layout"
    sessionTitle="观察物体（1）"
    onWorkflowChange={() => undefined}
    onOpenCanvas={() => undefined}
  />
);
assert.ok(preStartStudioMarkup.includes("从一份教案，开始制作课程视频"));
assert.ok(!preStartStudioMarkup.includes("当前查看"), "pre-start lesson onboarding must not waste vertical space on a redundant stage toolbar");

const studioSource = readFileSync(new URL("../src/client/videosBatchStudio/VideosBatchStudio.tsx", import.meta.url), "utf8");
const lessonSource = readFileSync(new URL("../src/client/videosBatchStudio/stages/LessonStage.tsx", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../src/client/main.tsx", import.meta.url), "utf8");
const headerSource = readFileSync(new URL("../src/client/videosBatchStudio/VideosBatchHeader.tsx", import.meta.url), "utf8");
const railSource = readFileSync(new URL("../src/client/videosBatchStudio/components/WorkflowProgressRail.tsx", import.meta.url), "utf8");
const v2CssSource = readFileSync(new URL("../src/client/videosBatchStudio/guidedStudioV2.css", import.meta.url), "utf8");
const finalStageSource = readFileSync(new URL("../src/client/videosBatchStudio/stages/FinalVideoStage.tsx", import.meta.url), "utf8");
const lessonClientUrl = new URL("../src/client/videosBatchStudio/lessonDocumentClient.ts", import.meta.url);
const focusCssUrl = new URL("../src/client/videosBatchStudio/guidedStudioV2Focus.css", import.meta.url);

assert.ok(studioSource.includes("WorkflowProgressRail"), "Guided Studio V2 must use one horizontal progress rail");
assert.ok(!studioSource.includes("<WorkflowSidebar"), "Guided Studio V2 must not render the internal left workflow sidebar");
assert.ok(!studioSource.includes('className="vbs-context"'), "Guided Studio V2 must not render a permanent right context sidebar");
assert.ok(lessonSource.includes("useDropzone"), "lesson file interaction must reuse react-dropzone rather than hand-roll drag/drop behavior");
assert.ok(studioSource.includes("parsedLessonDraft"), "the studio must own unconfirmed parsed lesson state across stage changes");
assert.ok(lessonSource.includes("onParsedDraftChange"), "the lesson stage must report parsed draft edits to the persistent parent state");
assert.ok(lessonSource.includes("保存草稿"), "parsed lesson edits must expose an explicit save draft action");
assert.ok(lessonSource.includes('role="status"'), "draft persistence state must be announced as a live status");
assert.ok(lessonSource.includes("event.ctrlKey || event.metaKey"), "parsed lesson editor must support the platform save shortcut");
assert.ok(studioSource.includes("sessionStorage"), "unconfirmed lesson drafts must persist in the browser session scope");
assert.ok(mainSource.includes('import "./videosBatchStudio/guidedStudioV2.css"'), "browser entry must load Guided Studio V2 visual styles");
assert.ok(mainSource.includes('import "./videosBatchStudio/guidedStudioV2Focus.css"'), "browser entry must load workflow focus styles");
assert.ok(existsSync(lessonClientUrl), "lesson parsing must live in a focused client adapter instead of patching the giant api.ts");
assert.ok(existsSync(focusCssUrl), "workflow focus mode must live in a scoped CSS adapter instead of patching the giant App.tsx");

assert.ok(headerSource.includes("AI 课程视频工作室"), "product header must use the consolidated Editorial AI Studio identity");
assert.ok(railSource.includes("vbs-v2-progress-node"), "progress rail must expose a timeline node instead of only pill-style step content");
assert.ok(v2CssSource.includes("--vbs-v2-radius-card"), "Guided Studio V2 must define one canonical card radius token");
assert.ok(v2CssSource.includes("--vbs-v2-shadow-raised"), "Guided Studio V2 must define one canonical raised-surface shadow token");
assert.match(v2CssSource, /\.vbs-v2-parse-editor textarea,[\s\S]*?min-height:\s*560px;[\s\S]*?font-weight:\s*400;/, "parsed lesson text must be tall and use normal reading weight");
assert.ok(v2CssSource.includes("--vbs-bg: var(--vbs-v2-canvas)"), "legacy stage surfaces must inherit the canonical V2 palette inside Guided Studio");
assert.ok(finalStageSource.includes("vbs-final-delivery"), "final step must expose a dedicated delivery surface while preserving native playback behavior");

if (existsSync(lessonClientUrl)) {
  const lessonClientSource = readFileSync(lessonClientUrl, "utf8");
  assert.ok(lessonClientSource.includes("/videosbatch/lesson/parse"), "lesson client must call the server document parser route");
  assert.ok(lessonClientSource.includes("VideosBatchParsedLessonDocument"), "lesson parser must use the shared parsed-document contract");
  assert.ok(studioSource.includes("parseLessonDocumentFile"), "Guided Studio must use the focused lesson parser adapter");
}

if (existsSync(focusCssUrl)) {
  const focusCssSource = readFileSync(focusCssUrl, "utf8");
  assert.ok(focusCssSource.includes(":has(.videosbatch-studio-v2)"), "workflow focus must activate from the mounted Guided Studio itself");
  assert.match(
    focusCssSource,
    /\.app-shell:has\(\.videosbatch-studio-v2\)[\s\S]*?min-height:\s*100vh;[\s\S]*?height:\s*auto;[\s\S]*?overflow:\s*visible;/,
    "guided workflow must use natural document scrolling instead of a clipped 100vh app shell"
  );
  assert.match(
    focusCssSource,
    /\.videosbatch-studio-v2\s*\{[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*100vh;[\s\S]*?overflow:\s*visible;/,
    "Guided Studio itself must not create a nested clipped viewport"
  );
  assert.match(
    focusCssSource,
    /\.vbs-v2-workspace\s*\{[\s\S]*?overflow:\s*visible;/,
    "workflow content must stay in the page scroll instead of hiding the footer in an inner scroll area"
  );
  assert.match(
    focusCssSource,
    /\.app-shell:has\(\.videosbatch-studio-v2\)[\s\S]*?\.topbar\s*\{[\s\S]*?display:\s*none;/,
    "workflow focus mode must remove the duplicate SeeReel topbar"
  );
  assert.ok(focusCssSource.includes("> .sidebar"), "workflow focus mode must remove the outer SeeReel session sidebar");
}

console.log("VideosBatch Guided Studio V2 contract smoke: PASS");
