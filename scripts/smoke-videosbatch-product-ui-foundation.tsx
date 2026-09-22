import React from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createVideosBatchWorkflow, VIDEOS_BATCH_STAGE_ORDER } from "../src/shared/videosBatchWorkflow";
import { VIDEOS_BATCH_PRODUCT_STEPS, productStepForStage } from "../src/client/videosBatchStudio/stageModel";
import { VideosBatchStudio } from "../src/client/videosBatchStudio/VideosBatchStudio";
import { StudioErrorBoundary } from "../src/client/videosBatchStudio/components/StudioErrorBoundary";
import { AssetPlanStage } from "../src/client/videosBatchStudio/stages/AssetPlanStage";

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
    onBackToSessions={() => undefined}
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
// AUDIO_DELIVERY failure). Each of those positions must render the *full* studio
// shell, not a degraded one.
//
// `renderToStaticMarkup` uses the server renderer, and React does NOT catch
// errors at boundaries during SSR — a broken cursor THROWS out of it instead of
// rendering the fallback panel (verified experimentally 2026-09-16). So this
// loop can only prove the happy path throws nothing; it cannot prove the
// fallback works. It previously carried
// `assert.ok(!cursorMarkup.includes("这一步暂时无法显示"))`, which is unfalsifiable
// for exactly that reason and was removed rather than left as decoration.
for (const stageId of VIDEOS_BATCH_STAGE_ORDER) {
  let cursorMarkup = "";
  try {
    cursorMarkup = renderToStaticMarkup(
      <VideosBatchStudio
        sessionId="session-product-ui"
        sessionTitle="观察物体（1）"
        workflow={{ ...workflow, currentStage: stageId, completed: false }}
        onWorkflowChange={() => undefined}
        onOpenCanvas={() => undefined}
        onBackToSessions={() => undefined}
      />
    );
  } catch (error) {
    assert.fail(`guided studio must render when the cursor stops on ${stageId}: ${(error as Error).message}`);
  }
  assert.ok(
    cursorMarkup.includes("videosbatch-studio-v2"),
    `guided studio must render its V2 shell when the cursor stops on ${stageId}`
  );
  assert.ok(
    cursorMarkup.includes("vbs-v2-header"),
    `the product header must survive when the cursor stops on ${stageId}`
  );
  assert.ok(
    cursorMarkup.includes("vbs-v2-progress"),
    `the progress rail must survive when the cursor stops on ${stageId}`
  );
  assert.ok(
    cursorMarkup.includes("任务列表"),
    `the task-list escape hatch must stay reachable when the cursor stops on ${stageId}`
  );
}

// --- The fallback panel itself must be reachable and must genuinely escape ----
// `VideosBatchHeader` (which owns 「任务列表」) renders *inside* the boundary, so a
// caught render failure removes it too. A panel that only offered "reload" would
// be a dead end for a deterministic render error: the reload reproduces it. The
// fallback therefore has to re-render the header's own escape hatch.
const boundary = new StudioErrorBoundary({ children: null, onBackToSessions: () => undefined });
boundary.state = { error: new Error("注入的渲染失败") };
const fallbackMarkup = renderToStaticMarkup(boundary.render() as React.ReactElement);
// Match the *buttons*, not loose substrings: the panel's own prose mentions
// 「返回任务列表」, so a plain `includes` would pass even with the button gone —
// the exact "decorative assertion" mistake this suite was fixed for.
const buttonWith = (markup: string, className: string) => {
  const match = markup.match(new RegExp(`<button[^>]*class="${className}"[^>]*>[\\s\\S]*?</button>`));
  return match ? match[0] : "";
};
assert.ok(fallbackMarkup.includes("这一步暂时无法显示"), "the fallback panel must name the failure");
assert.ok(fallbackMarkup.includes("注入的渲染失败"), "the fallback panel must surface the underlying error message");
assert.ok(fallbackMarkup.includes("vbs-v2-header"), "the fallback must keep the product header frame so the operator is not left on a bare page");
assert.ok(fallbackMarkup.includes("不会丢失"), "the fallback must tell the operator whether the data is safe");
assert.ok(
  buttonWith(fallbackMarkup, "vbs-v2-back").includes("任务列表"),
  "the fallback must re-render the header's own escape hatch instead of inventing one"
);
assert.ok(
  buttonWith(fallbackMarkup, "vbs-primary").includes("返回任务列表"),
  "the fallback's primary action must return to the task list, not just reload a deterministic failure"
);

const studioSource = readFileSync(new URL("../src/client/videosBatchStudio/VideosBatchStudio.tsx", import.meta.url), "utf8");
assert.ok(studioSource.includes("<VideosBatchStudioView {...props} />"), "the studio must render its view as a child of the boundary");
assert.ok(
  /<StudioErrorBoundary[^>]*onBackToSessions=\{props.onBackToSessions\}/.test(studioSource),
  "the studio must forward onBackToSessions into the boundary, or the fallback can only offer a reload that reproduces the failure"
);

// --- Every artifact save that closes an editor must surface a rejection -------
// `perform` swallows the error and leaves the UI looking saved. That is fine for
// an action which only advances the cursor — `select-intro` and `confirm-assets`
// re-render from the returned workflow and leave no draft behind — but wrong for
// a save whose success path exits edit mode: the editor would close over an
// unsaved edit and the user's text would vanish with no error. StoryStage did
// exactly that (2026-09-16 review).
const swallowedSaveLabels = [...studioSource.matchAll(/perform\(\s*"(save-[a-z-]+)"/g)].map((match) => match[1]);
assert.deepEqual(swallowedSaveLabels, [], "an artifact save must never run through the swallowing performer");
assert.ok(studioSource.includes('performOrThrow("save-story"'), "the story editor's save must throw on rejection");
assert.ok(studioSource.includes('performOrThrow("save-debug"'), "the advanced drawer's save must throw so the panel cannot exit edit mode as if it saved");
assert.ok(
  /performOrThrow\(stageId === "SCREENPLAY"/.test(studioSource),
  "both structured editors must throw on rejection"
);
// `select-intro` / `confirm-assets` legitimately keep the swallowing performer —
// they must not be "fixed" into throwing, which would surface a duplicate error
// for an action that already reports inline.
assert.ok(studioSource.includes(`perform("select-intro"`), "select-intro must stay on the swallowing performer");
assert.ok(studioSource.includes(`perform("confirm-assets"`), "confirm-assets must stay on the swallowing performer");

const drawerSource = readFileSync(new URL("../src/client/videosBatchStudio/components/ArtifactDebugDrawer.tsx", import.meta.url), "utf8");
assert.ok(drawerSource.includes('from "radix-ui"'), "advanced drawer must use Radix primitives");
assert.ok(drawerSource.includes("Dialog.Root"), "advanced drawer must preserve an accessible dialog surface");
assert.ok(drawerSource.includes("高级 · 原始数据"), "advanced drawer must preserve raw artifact access");
assert.ok(drawerSource.includes("JSON.parse"), "advanced drawer must preserve raw artifact editing and validation");

const appSource = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
// The studio ships its own stages/styles, so App loads it through a route-level
// lazy import (kept out of the shell bundle). Pin the lazy wiring, not a static
// import — reverting to a static import would silently re-merge both bundles.
assert.ok(
  /const VideosBatchStudio = lazy\(\(\) =>\s*\n?\s*import\("\.\/videosBatchStudio\/VideosBatchStudio"\)/.test(appSource),
  "App must lazily import the Guided Studio product boundary (route-level code split)"
);
assert.ok(appSource.includes('import { VideosBatchHeader } from "./videosBatchStudio/VideosBatchHeader"'), "canvas mode must reuse the VideosBatch product header");
assert.ok(appSource.includes("<VideosBatchStudio"), "App must render Guided Studio in workflow mode");
assert.ok(appSource.includes("videosBatchMode === \"workflow\""), "App must own an explicit workflow/canvas mode branch");
assert.ok(appSource.includes("videosbatch-canvas-mode"), "canvas mode must use the shared VideosBatch shell instead of the legacy app shell");
assert.ok(appSource.includes("<FlowView"), "App must preserve the native SeeReel Canvas");
assert.ok(!appSource.includes("<WorkflowRail"), "App must not render the old horizontal WorkflowRail");

// --- Asset-plan grouping must survive qualifiers that name another category ---
// The server validates `category` against the exact CHARACTER/SCENE/PROP/CREATURE
// enum (llmTextStages), so this only has to hold for legacy or hand-edited
// artifacts — but a declaration-order scan silently mis-filed anything whose
// qualifier contained another canonical name ("生物：场景中的小鸟" landed under
// 场景). The earliest mention now wins, because canonical output is
// `<canonical>：<sub-direction>`.
const collidingPlanMarkup = renderToStaticMarkup(
  <AssetPlanStage artifact={{
    title: "资产计划",
    items: [
      { assetKey: "CREATURE-BIRD", category: "生物：场景中的小鸟", name: "课堂小鸟" },
      { assetKey: "SCENE-CLASSROOM", category: "SCENE", name: "教室" },
      { assetKey: "CHARACTER-HERO", category: "数学主人公（人物）", name: "小主人公" },
      { assetKey: "PROP-RULER", category: "", name: "直尺" },
      { assetKey: "MISC-DESK", category: "背景装饰", name: "课桌" }
    ]
  }} />
);
const planGroup = (label: string) => {
  const start = collidingPlanMarkup.indexOf(`<h3>${label}</h3>`);
  if (start < 0) return "";
  const end = collidingPlanMarkup.indexOf("</section>", start);
  return collidingPlanMarkup.slice(start, end < 0 ? undefined : end);
};
assert.ok(planGroup("生物").includes("课堂小鸟"), "an asset whose category starts with the canonical name must group under it even when its qualifier names another category");
assert.ok(!planGroup("场景").includes("课堂小鸟"), "a qualifier naming another category must not drag the asset into that group");
assert.ok(planGroup("场景").includes("教室"), "an exact canonical category must group under its own label");
assert.ok(planGroup("人物").includes("小主人公"), "a trailing canonical name in parentheses must still resolve");
assert.ok(planGroup("道具").includes("直尺"), "an empty category must fall back to the validated assetKey prefix instead of disappearing");
assert.ok(planGroup("背景装饰").includes("课桌"), "an unrecognised category must fall back to its raw value so no asset is dropped");

console.log("VideosBatch product UI foundation smoke: PASS");
