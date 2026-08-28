import { strict as assert } from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createVideosBatchWorkflow, VIDEOS_BATCH_STAGE_ORDER } from "../src/shared/videosBatchWorkflow";
import { WORKFLOW_LABELS } from "../src/client/videosBatchWorkflow/workflowLabels";
import { WorkflowRail } from "../src/client/videosBatchWorkflow/WorkflowRail";

const workflow = createVideosBatchWorkflow({ projectId: "P001", lessonText: "完整教案" });
workflow.stages.INTRO_GENERATION = {
  status: "ready",
  revision: 1,
  artifact: { candidates: [{ id: "A1", title: "示例导入" }] }
};
workflow.currentStage = "STORY_EXPANSION";

const html = renderToStaticMarkup(
  React.createElement(WorkflowRail, {
    sessionId: "ses_ui",
    workflow,
    onWorkflowChange: () => undefined
  })
);

for (const stageId of VIDEOS_BATCH_STAGE_ORDER) {
  assert.ok(WORKFLOW_LABELS[stageId], `missing label for ${stageId}`);
  assert.ok(html.includes(WORKFLOW_LABELS[stageId]), `rail must render ${stageId} label`);
}

assert.ok(html.includes("三类九套课程导入"), "intro stage label must be visible");
assert.ok(html.includes("三个完整故事"), "story stage label must be visible");
assert.ok(html.includes("查看"), "artifact stages must expose inspect action");
assert.ok(html.includes("编辑"), "artifact panel must expose edit action");
assert.ok(html.includes("重新生成"), "completed stages must expose regenerate action");
assert.ok(html.includes("从这里继续"), "rail must expose continue-from action");
assert.ok(html.includes("data-current=\"true\""), "current stage must be identifiable in markup");
assert.ok(html.includes("data-status=\"ready\""), "stage status must be visible in markup");

console.log("VideosBatch workflow UI smoke passed");
