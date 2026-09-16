import React from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createVideosBatchWorkflow, VIDEOS_BATCH_STAGE_ORDER } from "../src/shared/videosBatchWorkflow";
import { VIDEOS_BATCH_PRODUCT_STEPS, productStepForStage } from "../src/client/videosBatchStudio/stageModel";
import { VideosBatchStudio } from "../src/client/videosBatchStudio/VideosBatchStudio";

assert.equal(VIDEOS_BATCH_PRODUCT_STEPS.length, 9, "product UI must group the canonical workflow into 9 user-facing steps");
assert.deepEqual(
  VIDEOS_BATCH_PRODUCT_STEPS.map((step) => step.label),
  ["教案", "课程导入", "故事文稿", "资产计划", "资产图片", "视频剧本", "视频分镜", "视频生成", "最终成片"]
);
assert.equal(productStepForStage("COURSE_INTRO_CANDIDATES"), "intro");
assert.equal(productStepForStage("COURSE_INTRO_SELECTION"), "intro");
assert.equal(productStepForStage("ASSET_CANDIDATES"), "assets");
assert.equal(productStepForStage("ASSET_CONFIRMATION"), "assets");
assert.equal(productStepForStage("FINAL_STORYBOARD"), "storyboard");
assert.equal(productStepForStage("COPYABLE_PROMPT"), "storyboard");
assert.equal(productStepForStage("QUOTE"), "execution");
assert.equal(productStepForStage("EXECUTION"), "execution");
assert.equal(productStepForStage("STITCH"), "final");

// Completeness: every canonical stage must belong to exactly one product step.
// An orphaned stage makes `productStepForStage` throw while rendering, which
// unmounts the entire studio (2026-09-16: AUDIO_DELIVERY was orphaned and the
// workflow page rendered as a blank page). Per-stage spot checks above cannot
// catch an omission; only comparing the two sets can.
const mappedStages = VIDEOS_BATCH_PRODUCT_STEPS.flatMap((step) => [...step.stages]);
assert.deepEqual(
  [...new Set(mappedStages)].sort(),
  [...VIDEOS_BATCH_STAGE_ORDER].sort(),
  "the product-step projection must cover every canonical stage exactly once"
);
assert.equal(mappedStages.length, new Set(mappedStages).size, "no stage may be claimed by two product steps");
assert.equal(productStepForStage("AUDIO_DELIVERY"), "final", "AUDIO_DELIVERY belongs to the final-film step");
assert.equal(productStepForStage("LESSON_INPUT"), "lesson");

const workflow = createVideosBatchWorkflow({ projectId: "P001", lessonText: "这是一份完整教案，用于产品界面测试。" }, "2026-08-29T00:00:00.000Z");
workflow.stages.COURSE_INTRO_CANDIDATES = {
  status: "ready",
  revision: 1,
  artifact: {
    candidates: [
      {
        id: "A-01",
        name: "原始问题导入",
        // Real generators suffix the sub-direction onto the canonical category.
        creativeType: "数学史与知识由来：原始问题",
        body: "学生从一个真实问题进入课堂。",
        endingQuestion: "应该怎样判断？"
      }
    ],
    recommendations: [{ id: "A-01", reason: "知识连接清晰" }]
  }
};
workflow.currentStage = "COURSE_INTRO_SELECTION";

const markup = renderToStaticMarkup(
  <VideosBatchStudio
    sessionId="session-product-ui"
    sessionTitle="观察物体（1）"
    workflow={workflow}
    onWorkflowChange={() => undefined}
    onOpenCanvas={() => undefined}
  />
);

for (const text of ["VideosBatch", "流程制作", "制作画布", "教案", "课程导入", "故事文稿", "资产计划", "资产图片", "视频剧本", "视频分镜", "视频生成", "最终成片"]) {
  assert.ok(markup.includes(text), `guided studio must render ${text}`);
}
assert.ok(markup.includes("videosbatch-studio-v2"), "guided studio must render the V2 product shell");
assert.ok(markup.includes("vbs-v2-progress"), "guided studio must render the single top progress rail");
assert.ok(markup.includes("vbs-v2-workspace"), "guided studio must render one wide semantic workspace");
assert.ok(!markup.includes("vbs-sidebar"), "Guided Studio V2 must not render the internal left workflow sidebar");
assert.ok(!markup.includes('class="vbs-context"'), "Guided Studio V2 must not render a permanent right context rail");
assert.ok(markup.includes("选择课程导入方案"), "intro step must render semantic content instead of raw JSON");
assert.ok(markup.includes("原始问题导入"), "a creativeType carrying a sub-direction suffix must still render its candidate card");
assert.ok(markup.includes("数学史与知识由来"), "intro candidates must group under their canonical creative category instead of falling out of the grid");
assert.ok(!markup.includes("videosbatch-stage-rail"), "old horizontal engineering rail must not be the primary product UI");
assert.ok(!markup.includes("revision 1"), "revision/debug metadata must not dominate the primary workspace");
assert.ok(!markup.includes("高级 · 原始数据"), "raw JSON must stay hidden until the advanced drawer is explicitly opened");

// The cursor really does stop on every canonical stage — including AUDIO_DELIVERY
// (a single-step advance past EXECUTION, or a run-all that halts on an
// AUDIO_DELIVERY failure). Each of those positions must render the studio, not
// the error-boundary fallback.
for (const stageId of VIDEOS_BATCH_STAGE_ORDER) {
  const cursorMarkup = renderToStaticMarkup(
    <VideosBatchStudio
      sessionId="session-product-ui"
      sessionTitle="观察物体（1）"
      workflow={{ ...workflow, currentStage: stageId, completed: false }}
      onWorkflowChange={() => undefined}
      onOpenCanvas={() => undefined}
    />
  );
  assert.ok(
    cursorMarkup.includes("videosbatch-studio-v2"),
    `guided studio must render its V2 shell when the cursor stops on ${stageId}`
  );
  assert.ok(
    !cursorMarkup.includes("这一步暂时无法显示"),
    `guided studio must not fall back to the error boundary when the cursor stops on ${stageId}`
  );
}

const drawerSource = readFileSync(new URL("../src/client/videosBatchStudio/components/ArtifactDebugDrawer.tsx", import.meta.url), "utf8");
assert.ok(drawerSource.includes('from "radix-ui"'), "advanced drawer must use Radix primitives");
assert.ok(drawerSource.includes("Dialog.Root"), "advanced drawer must preserve an accessible dialog surface");
assert.ok(drawerSource.includes("高级 · 原始数据"), "advanced drawer must preserve raw artifact access");
assert.ok(drawerSource.includes("JSON.parse"), "advanced drawer must preserve raw artifact editing and validation");

const appSource = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
assert.ok(appSource.includes('import { VideosBatchStudio } from "./videosBatchStudio/VideosBatchStudio"'), "App must import the Guided Studio product boundary");
assert.ok(appSource.includes('import { VideosBatchHeader } from "./videosBatchStudio/VideosBatchHeader"'), "canvas mode must reuse the VideosBatch product header");
assert.ok(appSource.includes("<VideosBatchStudio"), "App must render Guided Studio in workflow mode");
assert.ok(appSource.includes("videosBatchMode === \"workflow\""), "App must own an explicit workflow/canvas mode branch");
assert.ok(appSource.includes("videosbatch-canvas-mode"), "canvas mode must use the shared VideosBatch shell instead of the legacy app shell");
assert.ok(appSource.includes("<FlowView"), "App must preserve the native SeeReel Canvas");
assert.ok(!appSource.includes("<WorkflowRail"), "App must not render the old horizontal WorkflowRail");

console.log("VideosBatch product UI foundation smoke: PASS");
