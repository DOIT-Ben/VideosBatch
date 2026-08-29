import React from "react";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
const mainSource = readFileSync(new URL("../src/client/main.tsx", import.meta.url), "utf8");
const lessonClientUrl = new URL("../src/client/videosBatchStudio/lessonDocumentClient.ts", import.meta.url);
const focusCssUrl = new URL("../src/client/videosBatchStudio/guidedStudioV2Focus.css", import.meta.url);

assert.ok(studioSource.includes("WorkflowProgressRail"), "Guided Studio V2 must use one horizontal progress rail");
assert.ok(!studioSource.includes("<WorkflowSidebar"), "Guided Studio V2 must not render the internal left workflow sidebar");
assert.ok(!studioSource.includes('className="vbs-context"'), "Guided Studio V2 must not render a permanent right context sidebar");
assert.ok(lessonSource.includes("useDropzone"), "lesson file interaction must reuse react-dropzone rather than hand-roll drag/drop behavior");
assert.ok(mainSource.includes('import "./videosBatchStudio/guidedStudioV2.css"'), "browser entry must load Guided Studio V2 visual styles");
assert.ok(mainSource.includes('import "./videosBatchStudio/guidedStudioV2Focus.css"'), "browser entry must load workflow focus styles");
assert.ok(existsSync(lessonClientUrl), "lesson parsing must live in a focused client adapter instead of patching the giant api.ts");
assert.ok(existsSync(focusCssUrl), "workflow focus mode must live in a scoped CSS adapter instead of patching the giant App.tsx");

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
    /\.app-shell:has\(\.videosbatch-studio-v2\)[\s\S]*?\.topbar\s*\{[\s\S]*?display:\s*none;/,
    "workflow focus mode must remove the duplicate SeeReel topbar"
  );
  assert.ok(focusCssSource.includes("> .sidebar"), "workflow focus mode must remove the outer SeeReel session sidebar");
}

console.log("VideosBatch Guided Studio V2 contract smoke: PASS");
