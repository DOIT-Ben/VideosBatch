import React from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { LessonStage } from "../src/client/videosBatchStudio/stages/LessonStage";
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

const studioSource = readFileSync(new URL("../src/client/videosBatchStudio/VideosBatchStudio.tsx", import.meta.url), "utf8");
const lessonSource = readFileSync(new URL("../src/client/videosBatchStudio/stages/LessonStage.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../src/client/api.ts", import.meta.url), "utf8");
const v2CssSource = readFileSync(new URL("../src/client/videosBatchStudio/guidedStudioV2.css", import.meta.url), "utf8");

assert.ok(studioSource.includes("WorkflowProgressRail"), "Guided Studio V2 must use one horizontal progress rail");
assert.ok(!studioSource.includes("<WorkflowSidebar"), "Guided Studio V2 must not render the internal left workflow sidebar");
assert.ok(!studioSource.includes('className="vbs-context"'), "Guided Studio V2 must not render a permanent right context sidebar");
assert.ok(lessonSource.includes("useDropzone"), "lesson file interaction must reuse react-dropzone rather than hand-roll drag/drop behavior");
assert.ok(appSource.includes('import "./videosBatchStudio/guidedStudioV2.css"'), "App must load Guided Studio V2 styles in production");
assert.ok(appSource.includes("vbs-flow-focus"), "App shell must enter focused VideosBatch mode during guided workflow production");
assert.ok(apiSource.includes("parseVideosBatchLesson"), "client API must expose lesson document parsing");
assert.ok(apiSource.includes("VideosBatchParsedLessonDocument"), "lesson parsing must use the shared parsed-document contract");
assert.ok(apiSource.includes("source?: VideosBatchLessonSource"), "workflow start must preserve lesson source metadata");
assert.match(
  v2CssSource,
  /\.app-shell\.vbs-flow-focus\s+\.topbar\s*\{[\s\S]*?display:\s*none;/,
  "workflow focus mode must remove the duplicate SeeReel topbar so Guided Studio owns the page"
);
assert.ok(v2CssSource.includes(".app-shell.vbs-flow-focus > .sidebar"), "workflow focus mode must remove the outer SeeReel session sidebar");

console.log("VideosBatch Guided Studio V2 contract smoke: PASS");
