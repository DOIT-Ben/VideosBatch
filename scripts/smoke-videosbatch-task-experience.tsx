import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { selectTasks, taskCategory } from "../src/client/videosBatchStudio/TaskList";
import { WorkflowFooter } from "../src/client/videosBatchStudio/WorkflowFooter";
import type { Session } from "../src/shared/types";

const sessions = [
  { id: "draft", title: "Alpha 教案", updatedAt: "2026-09-20", createdAt: "2026-09-19" },
  { id: "ready", title: "成片", updatedAt: "2026-09-21", videosBatchWorkflow: { completed: true } },
  { id: "failed", title: "失败任务", updatedAt: "2026-09-22", videosBatchWorkflow: { currentStage: "STORY_SCRIPT", stages: { STORY_SCRIPT: { status: "failed" } } } },
  { id: "gate", title: "待确认", updatedAt: "2026-09-23", videosBatchWorkflow: { currentStage: "COURSE_INTRO_SELECTION", stages: {} } }
] as Session[];
assert.deepEqual(selectTasks(sessions, "  ALPHA  ", "all", "recent").map(s => s.id), ["draft"]);
assert.deepEqual(selectTasks(sessions, "", "attention", "recent").map(s => s.id), ["gate", "failed"]);
assert.deepEqual(selectTasks(sessions, "", "done", "recent").map(s => s.id), ["ready"]);
assert.equal(selectTasks(sessions, "missing", "all", "recent").length, 0);
assert.equal(selectTasks(sessions, "", "all", "oldest")[0].id, "draft");
assert.equal(sessions[0].id, "draft", "sorting must not reorder source data");
assert.equal(taskCategory(sessions[3]), "attention");
const base = { selectedStepId: "final" as const, primaryLabel: "流程已完成", onPrimary() {}, onPrevious() {}, onRunAll() {} };
const done = renderToStaticMarkup(<WorkflowFooter {...base} completed primaryDisabled hint="制作完成，可预览或下载成片。" />);
assert(!done.includes('class="vbs-primary"'), "completed current step must not show an inert primary action");
assert(!done.includes("自动运行"), "completed workflow must not offer automatic execution");
assert(done.includes("制作完成，可预览或下载成片。"));
const working = renderToStaticMarkup(<WorkflowFooter {...base} busy busyLabel="正在生成故事文稿，可以查看其他步骤。" />);
assert(working.includes('role="status"') && working.includes("正在生成故事文稿"));
assert(!working.includes('disabled="" class="vbs-secondary"'), "browsing previous steps remains possible during generation");
console.log("task experience smoke passed: search, filters, sorting, truthful actions and running feedback");
