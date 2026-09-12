import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { generateLocalH3Video, generateLocalImage, generateLocalTextStage } from "./local-providers.mjs";

export const LOCAL_RUN_SCHEMA_VERSION = 1;
export const LOCAL_STAGE_ORDER = [
  "LESSON_INPUT", "COURSE_INTRO_CANDIDATES", "COURSE_INTRO_SELECTION", "STORY_SCRIPT", "ASSET_PLAN",
  "ASSET_CANDIDATES", "ASSET_CONFIRMATION", "SCREENPLAY", "FINAL_STORYBOARD", "COPYABLE_PROMPT",
  "QUOTE", "EXECUTION", "STITCH"
];
export const LOCAL_MANUAL_STAGES = new Set(["COURSE_INTRO_SELECTION", "ASSET_CONFIRMATION"]);
export const LOCAL_WORKER_STAGES = new Set(["ASSET_CANDIDATES", "EXECUTION"]);
export const LOCAL_TEXT_STAGES = new Set(["COURSE_INTRO_CANDIDATES", "STORY_SCRIPT", "ASSET_PLAN", "SCREENPLAY", "FINAL_STORYBOARD", "COPYABLE_PROMPT"]);
export const LOCAL_STAGE_LIMITS = {
  LESSON_INPUT: 1,
  COURSE_INTRO_CANDIDATES: 1,
  STORY_SCRIPT: 1,
  ASSET_PLAN: 1,
  ASSET_CANDIDATES: 4,
  SCREENPLAY: 1,
  FINAL_STORYBOARD: 1,
  COPYABLE_PROMPT: 1,
  QUOTE: 1,
  EXECUTION: 1,
  STITCH: 1
};

export async function prepareLocalRun({ inputPath, lessonText, outDir, maxConcurrentWorkers = 4, executorMode = "fake", mediaMode = "fake", force = false }) {
  const runDir = path.resolve(outDir);
  if (!force && await exists(path.join(runDir, "run_manifest.json"))) throw new Error(`运行目录已存在：${runDir}；如需覆盖请显式使用 --force`);
  await mkdir(runDir, { recursive: true });
  for (const directory of ["input", "artifacts", "assets", "media", "reports", "final", "workers"]) await mkdir(path.join(runDir, directory), { recursive: true });

  let sourceBytes;
  let sourceName = "pasted-lesson.txt";
  let text = String(lessonText || "").trim();
  if (inputPath) {
    const absoluteInput = path.resolve(inputPath);
    const bytes = await readFile(absoluteInput);
    sourceBytes = bytes.length;
    sourceName = path.basename(absoluteInput);
    text = text || extractLessonText(absoluteInput, bytes);
    await writeFile(path.join(runDir, "input", sourceName), bytes);
  }
  if (!text) throw new Error("教案内容为空；请提供可读取的文本、Markdown 或 DOCX 文件");
  await writeFile(path.join(runDir, "input", "lesson.txt"), `${text}\n`, "utf8");

  const now = new Date().toISOString();
  const runId = path.basename(runDir);
  const canonical = await loadCanonicalSnapshot();
  await mkdir(path.join(runDir, "canonical"), { recursive: true });
  const bundledCanonical = bundledCanonicalPath();
  await copyFile(path.join(path.dirname(bundledCanonical), "manifest.json"), path.join(runDir, "canonical", "manifest.json"));
  await copyFile(bundledCanonical, path.join(runDir, "canonical", "videosbatch-workflow-canonical.md"));
  const stages = Object.fromEntries(LOCAL_STAGE_ORDER.map((stageId) => [stageId, {
    status: stageId === "LESSON_INPUT" ? "ready" : "pending",
    revision: stageId === "LESSON_INPUT" ? 1 : 0,
    artifactPath: stageId === "LESSON_INPUT" ? "artifacts/LESSON_INPUT.json" : null,
    sourceRevision: null,
    sourceHash: null,
    contentHash: stageId === "LESSON_INPUT" ? hashJson({ text }) : null,
    updatedAt: now
  }]));
  const manifest = {
    schemaVersion: LOCAL_RUN_SCHEMA_VERSION,
    runId,
    createdAt: now,
    updatedAt: now,
    currentStage: "COURSE_INTRO_CANDIDATES",
    completed: false,
    executorMode: executorMode === "llm" ? "llm" : "fake",
    mediaMode: mediaMode === "native" ? "native" : "fake",
    canonical: { specId: canonical.specId, version: canonical.version, sha256: canonical.sha256, manifestPath: "canonical/manifest.json" },
    input: { fileName: sourceName, sizeBytes: sourceBytes ?? Buffer.byteLength(text, "utf8"), lessonPath: "input/lesson.txt" },
    stages
  };
  await writeJson(path.join(runDir, "artifacts/LESSON_INPUT.json"), { projectId: runId, lessonText: text, source: { fileName: sourceName, sizeBytes: manifest.input.sizeBytes } });
  await writeJson(path.join(runDir, "run_manifest.json"), manifest);
  await writeJson(path.join(runDir, "planner.json"), { schemaVersion: 1, runId, status: "ready", planRevision: 1, objective: "教案到课程视频的本地可恢复工作流", currentStage: manifest.currentStage, updatedAt: now });
  await writeJson(path.join(runDir, "worker_jobs.json"), {
    schemaVersion: 1, runId, status: "ready", max_concurrent_workers: positiveInteger(maxConcurrentWorkers, "maxConcurrentWorkers"), stage_limits: { ...LOCAL_STAGE_LIMITS }, stages: {}, updatedAt: now
  });
  await appendEvent(runDir, { type: "run_prepared", runId, at: now });
  return manifest;
}

export async function loadLocalRun(runDir) {
  const resolved = path.resolve(runDir);
  const manifest = await readJson(path.join(resolved, "run_manifest.json"));
  if (manifest.schemaVersion !== LOCAL_RUN_SCHEMA_VERSION) throw new Error(`不支持的本地运行目录 schemaVersion：${manifest.schemaVersion}`);
  const jobs = await readJson(path.join(resolved, "worker_jobs.json"));
  await verifyCanonicalSnapshot(manifest, resolved);
  return { runDir: resolved, manifest, jobs };
}

export async function localStatus(runDir) {
  const state = await loadLocalRun(runDir);
  const stageCounts = Object.fromEntries(LOCAL_STAGE_ORDER.map((stageId) => [stageId, state.manifest.stages[stageId]?.status || "missing"]));
  const workerSummary = Object.fromEntries(Object.entries(state.jobs.stages || {}).map(([stageId, stage]) => [stageId, summarizeWorkerStage(stage)]));
  return {
    action: "local-status",
    runDir: state.runDir,
    runId: state.manifest.runId,
    currentStage: state.manifest.currentStage,
    completed: state.manifest.completed,
    executorMode: state.manifest.executorMode,
    mediaMode: state.manifest.mediaMode,
    canonical: state.manifest.canonical,
    stages: stageCounts,
    workers: workerSummary,
    maxConcurrentWorkers: state.jobs.max_concurrent_workers,
    activeWorkers: Object.values(state.jobs.stages || {}).flatMap((stage) => (stage.units || []).filter((unit) => ["dispatched", "running"].includes(unit.status)).map((unit) => ({ stageId: stage.stageId, unitId: unit.unitId, workerId: unit.workerId, leaseExpiresAt: unit.leaseExpiresAt })))
  };
}

export async function localDoctor(env = process.env) {
  const canonical = await loadCanonicalSnapshot();
  const configured = (key) => Boolean(String(env[key] || "").trim());
  const textEnabled = String(env.VIDEOSBATCH_EXECUTOR_MODE || "fake").toLowerCase() === "llm";
  const mediaEnabled = String(env.VIDEOSBATCH_MEDIA_MODE || "fake").toLowerCase() === "native";
  const checks = {
    node: Number(process.versions.node.split(".")[0]) >= 18,
    canonical: Boolean(canonical.sha256),
    text: !textEnabled || (configured("VIDEOSBATCH_LLM_API_KEY") && configured("VIDEOSBATCH_LLM_BASE_URL") && configured("VIDEOSBATCH_LLM_MODEL")),
    media: !mediaEnabled || (configured("VIDEOSBATCH_IMAGE_API_KEY") || configured("VIDEOSBATCH_H3_API_KEY"))
  };
  return { action: "local-doctor", localOnly: true, nodeVersion: process.versions.node, canonical, modes: { executor: textEnabled ? "llm" : "fake", media: mediaEnabled ? "native" : "fake" }, configured: { textKey: configured("VIDEOSBATCH_LLM_API_KEY"), fallbackTextKey: configured("VIDEOSBATCH_LLM_FALLBACK_API_KEY"), imageKey: configured("VIDEOSBATCH_IMAGE_API_KEY"), videoKey: configured("VIDEOSBATCH_H3_API_KEY") }, checks, ready: Object.values(checks).every(Boolean) };
}

export async function localRunNext(runDir, { autoWorkers = false, autoFake = false, execute = false } = {}) {
  const state = await loadLocalRun(runDir);
  const { manifest, jobs } = state;
  const stageId = manifest.currentStage;
  if (!stageId) return { action: "local-run-next", status: "complete", runDir: state.runDir };
  if (LOCAL_MANUAL_STAGES.has(stageId)) {
    if (!autoFake) return { action: "local-run-next", status: "needs_human_confirmation", stageId, runDir: state.runDir, message: `${stageId} 需要人工确认；使用 --auto-fake 仅用于离线结构验证` };
    await applyFakeManualGate(state, stageId);
    return localRunNext(runDir, { autoWorkers, autoFake, execute });
  }
  if ((manifest.executorMode === "llm" || manifest.mediaMode === "native") && !autoFake && !execute) {
    return { action: "local-run-next", status: "needs_user_authorization", stageId, runDir: state.runDir, message: `${stageId} 需要显式 --execute 和本次用户授权；当前未调用 Provider` };
  }
  if (LOCAL_WORKER_STAGES.has(stageId)) {
    const stage = await ensureWorkerStage(state);
    await writeJson(path.join(state.runDir, "worker_jobs.json"), state.jobs);
    if (autoWorkers || autoFake) {
      for (const unit of stage.units.filter((item) => item.status === "pending")) {
        if (stage.units.filter((item) => ["dispatched", "running"].includes(item.status)).length >= stage.maxConcurrentWorkers) break;
        const claimed = dispatchLocalWorker(state, { unitId: unit.unitId, workerId: `fake-worker-${unit.unitId}`, auto: true });
        recordLocalWorker(state, { unitId: unit.unitId, workerId: claimed.unit.workerId, leaseId: claimed.unit.leaseId, result: await workerResult(state, stageId, unit.unitId, manifest, execute && !autoFake) });
      }
      await writeJson(path.join(state.runDir, "worker_jobs.json"), state.jobs);
    }
    if (stage.units.some((unit) => ["pending", "dispatched", "running"].includes(unit.status))) {
      return { action: "local-run-next", status: "dispatch", stageId, runDir: state.runDir, slotsAvailable: slotsAvailable(stage, stage.maxConcurrentWorkers), suggestedUnits: stage.units.filter((unit) => unit.status === "pending").slice(0, slotsAvailable(stage, stage.maxConcurrentWorkers)).map((unit) => unit.unitId) };
    }
    if (stage.units.some((unit) => unit.status !== "recorded")) {
      return { action: "local-run-next", status: "failed", stageId, runDir: state.runDir, message: "Worker 单元未全部 recorded；保留失败证据并局部重试" };
    }
    const artifact = buildWorkerStageArtifact(stageId, stage, manifest);
    await saveStageArtifact(state, stageId, artifact);
    return { action: "local-run-next", status: "ready", stageId, artifact, nextStage: manifest.currentStage, runDir: state.runDir };
  }
  const artifact = await executeLocalStage(state, stageId);
  validateLocalArtifact(stageId, artifact, manifest);
  await saveStageArtifact(state, stageId, artifact);
  if (stageId === "STITCH") {
    manifest.completed = true;
    manifest.currentStage = null;
    manifest.stages.STITCH.status = "accepted";
    manifest.updatedAt = new Date().toISOString();
    await writeJson(path.join(state.runDir, "run_manifest.json"), manifest);
    await syncPlannerState(state);
    return { action: "local-run-next", status: "complete", stageId, artifact, runDir: state.runDir };
  }
  return { action: "local-run-next", status: "ready", stageId, artifact, nextStage: manifest.currentStage, runDir: state.runDir };
}

export async function saveLocalStageArtifact(runDir, stageId, artifact) {
  const state = await loadLocalRun(runDir);
  if (state.manifest.currentStage !== stageId) throw new Error(`只能保存当前阶段：当前为 ${state.manifest.currentStage}，收到 ${stageId}`);
  validateLocalArtifact(stageId, artifact, state.manifest);
  if (stageId === "COURSE_INTRO_SELECTION" && artifact.selectedIntroId !== "CUSTOM") {
    const candidates = await readArtifact(state, "COURSE_INTRO_CANDIDATES");
    if (!(candidates.candidates || []).some((candidate) => candidate.id === artifact.selectedIntroId)) throw new Error("课程导入选择必须属于当前候选集");
  }
  if (stageId === "ASSET_CONFIRMATION") {
    const candidates = await readArtifact(state, "ASSET_CANDIDATES");
    const candidateKeys = new Set((candidates.items || []).map((item) => item.assetKey));
    if ((artifact.items || []).some((item) => !candidateKeys.has(item.assetKey))) throw new Error("资产确认不能引用当前候选集之外的 assetKey");
  }
  await saveStageArtifact(state, stageId, artifact);
  return { action: "local-stage-save", status: "ready", runDir: state.runDir, stageId, artifact, nextStage: state.manifest.currentStage };
}

export function dispatchLocalWorker(state, { unitId, workerId, leaseMs = 15 * 60 * 1000, auto = false }) {
  const stage = currentWorkerStage(state);
  const unit = findUnit(stage, unitId);
  if (unit.status !== "pending") throw new Error(`Worker 单元不可 dispatch：${unitId} 当前为 ${unit.status}`);
  if (activeCount(stage) >= state.jobs.max_concurrent_workers) throw new Error(`并发上限已达到：${state.jobs.max_concurrent_workers}`);
  const now = Date.now();
  unit.status = auto ? "running" : "dispatched";
  unit.workerId = String(workerId || "").trim() || `worker-${unitId}`;
  unit.leaseId = `lease_${randomUUID()}`;
  unit.claimedAt = new Date(now).toISOString();
  unit.leaseExpiresAt = new Date(now + boundedInteger(leaseMs, 1000, 86_400_000, "leaseMs")).toISOString();
  unit.attempt += 1;
  unit.updatedAt = new Date(now).toISOString();
  return { stage, unit: structuredClone(unit) };
}

export async function persistLocalWorkerDispatch(state, result) {
  const stage = result.stage;
  const unitDir = path.join(state.runDir, "workers", stage.stageId, safePart(result.unit.unitId));
  await mkdir(unitDir, { recursive: true });
  await writeJson(path.join(unitDir, "worker_request.json"), {
    schemaVersion: 1,
    runId: state.manifest.runId,
    stageId: stage.stageId,
    unitId: result.unit.unitId,
    workerId: result.unit.workerId,
    leaseId: result.unit.leaseId,
    source: stage.source,
    allowedWriteScope: unitDir,
    expectedOutput: stage.expectedOutput,
    promptPath: path.relative(state.runDir, path.join(unitDir, "worker_prompt.md")),
    createdAt: new Date().toISOString()
  });
  await writeFile(path.join(unitDir, "worker_prompt.md"), buildWorkerPrompt(state, stage, result.unit, unitDir), "utf8");
  await writeJson(path.join(state.runDir, "worker_jobs.json"), state.jobs);
  await appendEvent(state.runDir, { type: "worker_dispatched", stageId: stage.stageId, unitId: result.unit.unitId, workerId: result.unit.workerId, at: new Date().toISOString() });
  return unitDir;
}

export function recordLocalWorker(state, { unitId, workerId, leaseId, result }) {
  const stage = currentWorkerStage(state);
  const unit = findUnit(stage, unitId);
  if (!["dispatched", "running"].includes(unit.status)) throw new Error(`Worker 单元不可 record：${unitId} 当前为 ${unit.status}`);
  if (unit.workerId !== workerId || unit.leaseId !== leaseId) throw new Error("Worker identity 或 leaseId 不匹配");
  if (result?.status === "failed" || result?.status === "stale") {
    unit.status = result.status;
    unit.error = result.error || { code: "WORKER_FAILED", message: "Worker returned failure", retryable: false };
  } else {
    validateWorkerResult(stage.stageId, unitId, result, state.manifest);
    unit.status = "recorded";
    unit.result = result ?? null;
    unit.error = null;
  }
  unit.completedAt = new Date().toISOString();
  unit.leaseExpiresAt = null;
  unit.updatedAt = new Date().toISOString();
  return structuredClone(unit);
}

export function resetLocalWorker(state, { unitId, workerId, confirmLost = false }) {
  const stage = currentWorkerStage(state);
  const unit = findUnit(stage, unitId);
  if (["dispatched", "running"].includes(unit.status) && !confirmLost) throw new Error("active Worker 只能在确认丢失后 reset");
  if (workerId && unit.workerId !== workerId) throw new Error("Worker identity 不匹配");
  if (unit.status === "recorded") throw new Error("recorded Worker 不允许 reset；请从上游重新规划");
  if (unit.attempt >= (stage.retryBudget + 1)) throw new Error(`Worker 重试预算已耗尽：${unitId}`);
  unit.status = "pending";
  unit.workerId = null;
  unit.leaseId = null;
  unit.claimedAt = null;
  unit.leaseExpiresAt = null;
  unit.result = null;
  unit.error = null;
  unit.updatedAt = new Date().toISOString();
  return structuredClone(unit);
}

export async function finalizeLocalRun(runDir) {
  const state = await loadLocalRun(runDir);
  const { manifest } = state;
  if (!manifest.completed) {
    if (manifest.currentStage !== "STITCH") throw new Error(`不能 finalize：当前阶段为 ${manifest.currentStage}`);
    await localRunNext(runDir, { autoWorkers: false, autoFake: false, execute: false });
  }
  const refreshed = await loadLocalRun(runDir);
  const finalPath = path.join(refreshed.runDir, "final", "FINAL_DELIVERY.json");
  if (!await exists(finalPath)) throw new Error("final/FINAL_DELIVERY.json 不存在");
  return { action: "local-finalize", status: "complete", runDir: refreshed.runDir, finalPath, manifest: refreshed.manifest };
}

async function executeLocalStage(state, stageId) {
  const { manifest } = state;
  if (manifest.executorMode === "llm" && LOCAL_TEXT_STAGES.has(stageId) && stageId !== "COPYABLE_PROMPT") {
    const resolvedArtifacts = {};
    for (const dependency of dependencyStages(stageId)) resolvedArtifacts[dependency] = await readArtifact(state, dependency);
    const canonicalPath = bundledCanonicalPath();
    return (await generateLocalTextStage(stageId, { artifacts: resolvedArtifacts, canonicalPath, env: process.env, runId: manifest.runId })).artifact;
  }
  if (manifest.executorMode === "llm" && LOCAL_TEXT_STAGES.has(stageId)) throw new Error("COPYABLE_PROMPT 使用本地确定性派生，不调用 Provider");
  if (stageId === "COURSE_INTRO_CANDIDATES") {
    const ids = ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"];
    return { candidates: ids.map((id) => ({ id, name: `课程导入 ${id}`, creativeType: "围绕本课数学问题的可视化情境", body: (`${id} 从一个清晰的问题开始，人物发现仅凭直觉无法完成判断，于是观察线索、比较差异并逐步推进冲突。本课数学知识成为解决问题的关键线索，但故事停在学生仍然想知道怎样判断、怎样计算或怎样比较的位置。`).repeat(4).slice(0, 220), endingQuestion: "究竟应该怎样解决这个问题？", truthfulnessCategory: "完全虚构的故事化情境", truthfulnessNote: "用于本地结构验证的虚构教学情境。" })), recommendations: [{ id: "A-01", reason: "课堂冲突清晰、知识连接紧密且便于制作。" }, { id: "B-01", reason: "真实需求明确、画面可控且适合继续扩写。" }, { id: "C-01", reason: "生活代入感强、问题直观且易于视频化。" }] };
  }
  if (stageId === "STORY_SCRIPT") return { schemaVersion: "2", kind: "LESSON_INTRO_VIDEO_SCRIPT", title: "本地课程故事", storyType: "故事叙事型", truthfulnessNote: "完全虚构的故事化情境，用于本地结构验证。", content: "故事从一个清晰的课堂问题开始，人物发现眼前的现象和最初的直觉判断发生了冲突。大家先观察线索，再比较不同条件，尝试解释为什么同一件事会得到不同结果。随着问题逐步升级，人物意识到必须使用本课数学知识来组织证据、建立关系并找到可靠的判断方法。故事保持适合小学生理解的语言和简单动作，不提前讲透公式、性质或最终结论，最后停在一个需要课堂继续讨论的问题上：究竟应该怎样用更可靠的方法解决眼前的难题？".repeat(4).slice(0, 700) };
  if (stageId === "ASSET_PLAN") return fakeAssetPlan();
  if (stageId === "SCREENPLAY") return fakeScreenplay();
  if (stageId === "FINAL_STORYBOARD") return fakeStoryboard();
  if (stageId === "COPYABLE_PROMPT") {
    const storyboard = await readArtifact(state, "FINAL_STORYBOARD");
    return { schemaVersion: "1", fullText: storyboard.segments.map((segment) => `分镜${segment.sequence}：${segment.scene}`).join("\n"), status: "READY", failedSegments: [], segments: storyboard.segments.map((segment) => ({ sequence: segment.sequence, text: segment.scene, referenceAssetIds: [] })) };
  }
  if (stageId === "QUOTE") {
    const storyboard = await readArtifact(state, "FINAL_STORYBOARD");
    return { schemaVersion: "1", quoteId: `quote_${randomUUID()}`, sourceRevision: manifest.stages.FINAL_STORYBOARD.revision, sourceHash: manifest.stages.FINAL_STORYBOARD.contentHash, segmentCount: storyboard.segments.length, assetOrder: ["CHARACTER-HERO", "SCENE-CLASSROOM", "PROP-RULER", "CREATURE-BIRD"], status: "READY" };
  }
  if (stageId === "STITCH") {
    const execution = await readArtifact(state, "EXECUTION");
    if (manifest.mediaMode === "native" && (execution.audioTimeline?.mix?.status !== "ready" || !execution.audioTimeline?.mix?.audioUrl)) throw new Error("AUDIO_TIMELINE_NOT_READY：真实拼接前必须提供交付就绪的独立音频 mix");
    const delivery = { schemaVersion: "1", kind: "FINAL_VIDEO", status: "READY", mode: manifest.mediaMode, segmentCount: execution.items.length, segments: execution.items, audioTimeline: execution.audioTimeline, sourceRevision: manifest.stages.EXECUTION.revision, sourceHash: manifest.stages.EXECUTION.contentHash, note: manifest.mediaMode === "fake" ? "fake 模式仅验证本地工作流结构，不代表真实 MP4 已生成。" : "native 模式已通过输入和音频门禁；最终 MP4 拼接需使用配置的本地媒体合成器。" };
    await writeJson(path.join(state.runDir, "final", "FINAL_DELIVERY.json"), delivery);
    return delivery;
  }
  throw new Error(`本地阶段未实现：${stageId}`);
}

function fakeAssetPlan() {
  const items = [
    ["CHARACTER-HERO", "CHARACTER", "示例学生角色", true],
    ["SCENE-CLASSROOM", "SCENE", "课堂观察区", true],
    ["PROP-RULER", "PROP", "观察尺", true],
    ["CREATURE-BIRD", "CREATURE", "课堂小鸟", false]
  ];
  return { schemaVersion: "1", title: "本地视频资产计划", kind: "VIDEO_ASSET_PLAN", subject: "数学", gradeBand: "小学", candidateAssets: items.map((item) => item[2]), candidateInventory: items.map(([assetKey, category, name, required]) => ({ assetKey, category, name, required, sourceEvidence: "本地 fake 故事中的视觉对象", decision: required ? "required" : "optional" })), omissionCheck: "已按人物、场景、道具、生物四类完成二次核对。", styleSpec: "影视级 3D 国漫 CG 风格，16:9，跨镜头保持连续。", negativePrompt: "不要文字，不要水印，不要 logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景。", items: items.map(([assetKey, category, name, required]) => ({ assetKey, category, name, description: `${name}用于本地结构验证。`, sourceEvidence: "本地 fake 故事情节", required, usage: "保持跨镜头可追踪", prompt: `${name}，影视级 3D 国漫 CG 风格，16:9，主体完整。`, negativePrompt: "不要文字，不要水印，不要主体裁切。", aspectRatio: "16:9", continuityNotes: "保持外观连续", variantNotes: null })) };
}

function fakeScreenplay() {
  return { schemaVersion: "1", kind: "VIDEO_SCREENPLAY", title: "本地正式视频剧本", subject: "数学", gradeBand: "小学", storyType: "STORY", targetDurationSeconds: 120, scenes: [{ sequence: 1, title: "问题出现与推理推进", knowledgeFocus: "围绕本课数学问题组织线索", emotionalPurpose: "从好奇走向认知冲突", visualPresentation: "角色故事与观察演示", ambientSound: "轻微课堂环境声", effectSound: "简短提示音", interactionSound: "摆放和观察物体的轻响", voice: "自然清晰的对白和旁白", visualAction: "角色观察、比较并提出问题", dialogue: "我们看到的现象真的足以判断整体吗？", evidence: [] }] };
}

function fakeStoryboard() {
  const segments = Array.from({ length: 12 }, (_, index) => ({ sequence: index + 1, screenplaySceneSequence: 1, duration: 10, chapter: index === 0 ? "第1章" : null, scene: `课堂观察区中出现第${index + 1}个新的问题，人物继续组织线索。`, characters: "【人物：示例学生角色】", keyProps: "【道具：观察尺】", visualEffects: [{ sequence: 1, timeRange: "0-2秒", duration: 2, visual: "【人物：示例学生角色】突然发现异常", action: "角色停下并观察", camera: "固定中景", sound: "轻微提示音", voice: "为什么会这样？" }, { sequence: 2, timeRange: "2-6秒", duration: 4, visual: "【道具：观察尺】呈现测量细节", action: "角色比较线索", camera: "缓慢推近", sound: "记录声", voice: "无" }, { sequence: 3, timeRange: "6-10秒", duration: 4, visual: "【场景：课堂观察区】回到连续空间", action: "角色提出新问题", camera: "稳定跟随", sound: "短促提示音", voice: "这个问题该怎么解决？" }], evidence: [], references: [{ label: "【人物：示例学生角色】" }, { label: "【场景：课堂观察区】" }, { label: "【道具：观察尺】" }] }));
  return { schemaVersion: "2", title: "本地最终分镜", kind: "VIDEO_STORYBOARD", goal: "完整呈现课程问题并留下课堂悬问", overallScript: "从问题出现、冲突推进到课堂悬问。", visualContinuity: "角色和场景保持连续。", targetDuration: 120, aspectRatio: "16:9", deliveryMode: "SEGMENTED_MP4", format: "FINAL_10_SECOND", storyType: "STORY", segments };
}

function buildWorkerStageArtifact(stageId, stage, manifest) {
  if (stageId === "ASSET_CANDIDATES") return { schemaVersion: "1", status: "READY", items: stage.units.map((unit) => ({ assetKey: unit.unitId, publicAssetId: `${manifest.runId}-A${String(stage.units.indexOf(unit) + 1).padStart(3, "0")}`, candidateAssetIds: [unit.result.candidateAssetId], status: "ready", attempt: unit.attempt })), failedItems: [], sourceStageId: "ASSET_PLAN", sourceRevision: manifest.stages.ASSET_PLAN.revision, sourceHash: manifest.stages.ASSET_PLAN.contentHash };
  return { schemaVersion: "1", executionId: `execution_${manifest.runId}`, batchId: `batch_${manifest.runId}`, status: "READY", renderIds: stage.units.map((unit) => unit.result.renderId), nativeShotIds: [], renderMap: stage.units.map((unit, index) => ({ sequence: index + 1, status: "ready", renderId: unit.result.renderId, videoUrl: unit.result.videoUrl, durationSec: 10, durationVerified: true, attempt: unit.attempt })), items: stage.units.map((unit, index) => ({ sequence: index + 1, status: "ready", videoUrl: unit.result.videoUrl, durationSec: 10, durationVerified: true, attempt: unit.attempt })), failedShots: [], audioTimeline: { schemaVersion: "1", sourceStageId: "FINAL_STORYBOARD", sourceRevision: manifest.stages.FINAL_STORYBOARD.revision, sourceHash: manifest.stages.FINAL_STORYBOARD.contentHash, narration: [], dialogue: [], soundEffects: [], mix: manifest.mediaMode === "native" ? { status: "pending", audioUrl: null } : { status: "ready", audioUrl: `fake://audio/${manifest.runId}.wav` } }, sourceStageId: "FINAL_STORYBOARD", sourceRevision: manifest.stages.FINAL_STORYBOARD.revision, sourceHash: manifest.stages.FINAL_STORYBOARD.contentHash, sourceHashes: { FINAL_STORYBOARD: manifest.stages.FINAL_STORYBOARD.contentHash }, sourceRevisions: { FINAL_STORYBOARD: manifest.stages.FINAL_STORYBOARD.revision } };
}

async function workerResult(state, stageId, unitId, manifest, execute) {
  if (execute && stageId === "ASSET_CANDIDATES" && manifest.mediaMode === "native") {
    const plan = await readArtifact(state, "ASSET_PLAN");
    const item = (plan.items || []).find((candidate) => candidate.assetKey === unitId);
    if (!item) throw new Error(`找不到资产计划项：${unitId}`);
    const outputPath = path.join(state.runDir, "assets", safePart(unitId), `candidate-${Date.now()}.png`);
    const generated = await generateLocalImage({ prompt: item.prompt, outPath: outputPath, env: process.env });
    return { status: "ready", candidateAssetId: generated.path, path: generated.path, sourceRevision: manifest.stages.ASSET_PLAN.revision, sourceHash: manifest.stages.ASSET_PLAN.contentHash };
  }
  if (execute && stageId === "EXECUTION" && manifest.mediaMode === "native") {
    const storyboard = await readArtifact(state, "FINAL_STORYBOARD");
    const segment = (storyboard.segments || []).find((candidate) => String(candidate.sequence) === unitId);
    if (!segment) throw new Error(`找不到最终分镜：${unitId}`);
    const assetStage = state.jobs.stages?.ASSET_CANDIDATES;
    const referencePaths = (assetStage?.units || []).map((unit) => unit.result?.path).filter(Boolean).slice(0, 9);
    const outputPath = path.join(state.runDir, "media", `segment-${String(unitId).padStart(3, "0")}.mp4`);
    const generated = await generateLocalH3Video({ prompt: segment.scene, referencePaths, outPath: outputPath, idempotencyKey: `videosbatch-local-${manifest.runId}-${unitId}`, env: process.env });
    return { status: "ready", renderId: generated.taskId, videoUrl: generated.path, path: generated.path, durationSec: 10, durationVerified: true, sourceRevision: manifest.stages.FINAL_STORYBOARD.revision, sourceHash: manifest.stages.FINAL_STORYBOARD.contentHash };
  }
  return fakeWorkerResult(stageId, unitId, manifest);
}

function fakeWorkerResult(stageId, unitId, manifest) {
  if (stageId === "ASSET_CANDIDATES") return { status: "ready", candidateAssetId: `asset_${safePart(unitId)}`, sourceRevision: manifest.stages.ASSET_PLAN.revision, sourceHash: manifest.stages.ASSET_PLAN.contentHash };
  return { status: "ready", renderId: `render_${safePart(unitId)}`, videoUrl: `fake://video/${safePart(unitId)}.mp4`, durationSec: 10, durationVerified: true, sourceRevision: manifest.stages.FINAL_STORYBOARD.revision, sourceHash: manifest.stages.FINAL_STORYBOARD.contentHash };
}

async function ensureWorkerStage(state) {
  const stageId = state.manifest.currentStage;
  const existing = state.jobs.stages?.[stageId];
  if (existing) return existing;
  const sourceStageId = stageId === "ASSET_CANDIDATES" ? "ASSET_PLAN" : "FINAL_STORYBOARD";
  const sourceArtifact = await readArtifact(state, sourceStageId);
  const units = stageId === "ASSET_CANDIDATES"
    ? (Array.isArray(sourceArtifact.items) ? sourceArtifact.items : []).map((item) => String(item?.assetKey || "").trim()).filter(Boolean)
    : (Array.isArray(sourceArtifact.segments) ? sourceArtifact.segments : []).map((item) => String(item?.sequence || "").trim()).filter(Boolean);
  if (!units.length) throw new Error(`${stageId} 无法从 ${sourceStageId} 生成 Worker 单元`);
  const stageLimit = Number(state.jobs.stage_limits?.[stageId]) || state.jobs.max_concurrent_workers;
  const stage = { stageId, status: "dispatchable", expectedOutput: stageId === "ASSET_CANDIDATES" ? "IMAGE_CANDIDATES" : "VIDEO_SEGMENT", retryBudget: 1, maxConcurrentWorkers: Math.min(state.jobs.max_concurrent_workers, stageLimit), source: { stageId: sourceStageId, revision: state.manifest.stages[sourceStageId].revision, hash: state.manifest.stages[sourceStageId].contentHash }, units: units.map((unitId) => ({ unitId, status: "pending", workerId: null, leaseId: null, attempt: 0, claimedAt: null, leaseExpiresAt: null, result: null, error: null, updatedAt: null })) };
  state.jobs.stages ||= {};
  state.jobs.stages[stageId] = stage;
  return stage;
}

function currentWorkerStage(state) {
  const stage = state.jobs.stages?.[state.manifest.currentStage];
  if (!stage) throw new Error(`当前阶段没有 Worker 计划：${state.manifest.currentStage}`);
  return stage;
}

async function saveStageArtifact(state, stageId, artifact) {
  const manifest = state.manifest;
  const current = manifest.stages[stageId];
  const dependencies = dependencyStages(stageId);
  const first = dependencies[0] ? manifest.stages[dependencies[0]] : undefined;
  const revision = (current.revision || 0) + 1;
  current.status = "ready";
  current.revision = revision;
  current.artifactPath = `artifacts/${stageId}.json`;
  current.contentHash = hashJson(artifact);
  current.sourceRevision = first?.revision ?? null;
  current.sourceHash = first?.contentHash ?? null;
  current.sourceHashes = Object.fromEntries(dependencies.map((dependency) => [dependency, manifest.stages[dependency]?.contentHash]).filter(([, hash]) => hash));
  current.sourceRevisions = Object.fromEntries(dependencies.map((dependency) => [dependency, manifest.stages[dependency]?.revision]).filter(([, revisionValue]) => Number.isInteger(revisionValue)));
  current.updatedAt = new Date().toISOString();
  await writeJson(path.join(state.runDir, current.artifactPath), artifact);
  const next = LOCAL_STAGE_ORDER[LOCAL_STAGE_ORDER.indexOf(stageId) + 1];
  markLocalDescendantsStale(manifest, stageId);
  manifest.currentStage = next || null;
  manifest.updatedAt = new Date().toISOString();
  await writeJson(path.join(state.runDir, "run_manifest.json"), manifest);
  await writeJson(path.join(state.runDir, "worker_jobs.json"), state.jobs);
  await syncPlannerState(state);
  await appendEvent(state.runDir, { type: "stage_ready", stageId, revision, contentHash: current.contentHash, at: new Date().toISOString() });
}

function validateLocalArtifact(stageId, artifact, manifest) {
  if (!artifact || typeof artifact !== "object") throw new Error(`${stageId} artifact 必须是对象`);
  if (stageId === "COURSE_INTRO_CANDIDATES") {
    const ids = Array.isArray(artifact.candidates) ? artifact.candidates.map((item) => item?.id) : [];
    if (ids.length !== 9 || new Set(ids).size !== 9 || !ids.every((id) => /^([ABC])-0[1-3]$/u.test(String(id)))) throw new Error("课程导入必须包含唯一的 A-01 至 C-03 九套候选");
    if (!Array.isArray(artifact.recommendations) || artifact.recommendations.length !== 3) throw new Error("课程导入必须包含三条推荐");
  } else if (stageId === "COURSE_INTRO_SELECTION") {
    if (artifact.locked !== true || !/^([ABC])-0[1-3]$|^CUSTOM$/u.test(String(artifact.selectedIntroId || ""))) throw new Error("课程导入选择必须锁定一套候选或 CUSTOM");
  } else if (stageId === "STORY_SCRIPT") {
    const content = String(artifact.content || "");
    if (artifact.kind !== "LESSON_INTRO_VIDEO_SCRIPT" || content.length < 600 || content.length > 800) throw new Error("故事文稿必须是 600-800 字的 LESSON_INTRO_VIDEO_SCRIPT");
  } else if (stageId === "ASSET_PLAN") {
    const items = Array.isArray(artifact.items) ? artifact.items : [];
    const categories = new Set(items.map((item) => item?.category));
    if (artifact.kind !== "VIDEO_ASSET_PLAN" || !items.length || !["CHARACTER", "SCENE", "PROP", "CREATURE"].every((category) => categories.has(category))) throw new Error("资产计划必须包含四类资产和有效 items");
  } else if (stageId === "ASSET_CANDIDATES") {
    if (artifact.status !== "READY" || !Array.isArray(artifact.items) || artifact.items.length === 0) throw new Error("资产候选必须是 READY 且包含 items");
  } else if (stageId === "ASSET_CONFIRMATION") {
    if (artifact.confirmed !== true || !Array.isArray(artifact.items) || !artifact.items.length) throw new Error("资产确认必须 confirmed=true 且包含 items");
  } else if (stageId === "SCREENPLAY") {
    if (artifact.kind !== "VIDEO_SCREENPLAY" || ![90, 100, 110, 120, 130, 140, 150].includes(artifact.targetDurationSeconds) || !Array.isArray(artifact.scenes) || !artifact.scenes.length) throw new Error("正式剧本字段或目标时长无效");
  } else if (stageId === "FINAL_STORYBOARD") {
    const target = Number(artifact.targetDuration);
    const segments = Array.isArray(artifact.segments) ? artifact.segments : [];
    if (artifact.kind !== "VIDEO_STORYBOARD" || !["STORY", "SCIENCE", "KNOWLEDGE"].includes(artifact.storyType) || !Number.isInteger(target) || target % 10 !== 0 || segments.length !== target / 10) throw new Error("最终分镜必须满足类型、时长和 segment 数量合同");
    if (segments.some((segment) => segment.duration !== 10 || !Array.isArray(segment.visualEffects) || segment.visualEffects.length < 3 || segment.visualEffects.length > 5)) throw new Error("最终分镜每条必须是 10 秒并包含 3-5 个子镜头");
  } else if (stageId === "COPYABLE_PROMPT") {
    if (artifact.status !== "READY" || !Array.isArray(artifact.segments)) throw new Error("可复制提示词必须是 READY 且包含 segments");
  } else if (stageId === "QUOTE") {
    if (artifact.status !== "READY" || !artifact.sourceHash || artifact.sourceHash !== manifest.stages.FINAL_STORYBOARD.contentHash) throw new Error("报价必须绑定当前最终分镜 Hash");
  } else if (stageId === "EXECUTION") {
    if (artifact.status !== "READY" || !Array.isArray(artifact.items) || artifact.items.some((item) => item.status !== "ready" || item.durationVerified !== true || item.durationSec !== 10)) throw new Error("视频执行必须包含全部已验证的 10 秒片段");
  } else if (stageId === "STITCH") {
    if (artifact.kind !== "FINAL_VIDEO" || artifact.status !== "READY" || !artifact.audioTimeline?.mix?.audioUrl) throw new Error("最终成片必须包含 READY 状态和音频 mix");
  }
}

async function applyFakeManualGate(state, stageId) {
  const current = state.manifest.stages[stageId];
  const artifact = stageId === "COURSE_INTRO_SELECTION" ? { selectedIntroId: "A-01", selectionMode: "system_recommended", selectionReason: "fake 离线验证", locked: true } : { confirmed: true, items: ["CHARACTER-HERO", "SCENE-CLASSROOM", "PROP-RULER", "CREATURE-BIRD"].map((assetKey, index) => ({ assetKey, selectedAssetId: `asset_fake_${index + 1}`, publicAssetId: `${state.manifest.runId}-A${String(index + 1).padStart(3, "0")}` })) };
  validateLocalArtifact(stageId, artifact, state.manifest);
  current.status = "ready";
  current.revision = (current.revision || 0) + 1;
  current.artifactPath = `artifacts/${stageId}.json`;
  current.contentHash = hashJson(artifact);
  const dependency = dependencyStages(stageId)[0];
  current.sourceRevision = dependency ? state.manifest.stages[dependency].revision : null;
  current.sourceHash = dependency ? state.manifest.stages[dependency].contentHash : null;
  current.updatedAt = new Date().toISOString();
  await writeJson(path.join(state.runDir, current.artifactPath), artifact);
  state.manifest.currentStage = LOCAL_STAGE_ORDER[LOCAL_STAGE_ORDER.indexOf(stageId) + 1];
  state.manifest.updatedAt = new Date().toISOString();
  await writeJson(path.join(state.runDir, "run_manifest.json"), state.manifest);
  await syncPlannerState(state);
}

function markLocalDescendantsStale(manifest, sourceStageId) {
  const pending = [sourceStageId];
  const visited = new Set();
  while (pending.length) {
    const source = pending.shift();
    if (visited.has(source)) continue;
    visited.add(source);
    for (const stageId of LOCAL_STAGE_ORDER) {
      if (!dependencyStages(stageId).includes(source)) continue;
      const state = manifest.stages[stageId];
      if (state && stageId !== sourceStageId && state.artifactPath) {
        state.status = "stale";
        state.staleReason = `上游 ${sourceStageId} 版本已变化`;
      }
      pending.push(stageId);
    }
  }
}

async function syncPlannerState(state) {
  const file = path.join(state.runDir, "planner.json");
  let planner = {};
  try { planner = await readJson(file); } catch { planner = {}; }
  planner.schemaVersion = 1;
  planner.runId = state.manifest.runId;
  planner.status = state.manifest.completed ? "complete" : "ready";
  planner.currentStage = state.manifest.currentStage;
  planner.planRevision = Number(planner.planRevision || 0) + 1;
  planner.updatedAt = new Date().toISOString();
  await writeJson(file, planner);
}

async function readArtifact(state, stageId) {
  const entry = state.manifest.stages[stageId];
  if (!entry?.artifactPath) throw new Error(`阶段没有 artifact：${stageId}`);
  return readJson(path.join(state.runDir, entry.artifactPath));
}

function dependencyStages(stageId) {
  const map = { COURSE_INTRO_CANDIDATES: ["LESSON_INPUT"], COURSE_INTRO_SELECTION: ["COURSE_INTRO_CANDIDATES"], STORY_SCRIPT: ["COURSE_INTRO_SELECTION", "LESSON_INPUT"], ASSET_PLAN: ["STORY_SCRIPT"], ASSET_CANDIDATES: ["ASSET_PLAN"], ASSET_CONFIRMATION: ["ASSET_CANDIDATES"], SCREENPLAY: ["STORY_SCRIPT", "ASSET_CONFIRMATION"], FINAL_STORYBOARD: ["SCREENPLAY", "ASSET_CONFIRMATION"], COPYABLE_PROMPT: ["FINAL_STORYBOARD", "ASSET_CONFIRMATION"], QUOTE: ["FINAL_STORYBOARD"], EXECUTION: ["QUOTE", "COPYABLE_PROMPT"], STITCH: ["EXECUTION"] };
  return map[stageId] || [];
}

function validateWorkerResult(stageId, unitId, result, manifest) {
  if (!result || result.status !== "ready") throw new Error(`Worker ${unitId} 返回结果不是 ready`);
  if (stageId === "ASSET_CANDIDATES" && (!result.candidateAssetId || result.sourceHash !== manifest.stages.ASSET_PLAN.contentHash)) throw new Error(`资产 Worker ${unitId} 的结果或来源 Hash 无效`);
  if (stageId === "EXECUTION" && (result.durationSec !== 10 || result.durationVerified !== true || !result.videoUrl)) throw new Error(`视频 Worker ${unitId} 必须返回已验证的 10 秒片段`);
}

function summarizeWorkerStage(stage) {
  const counts = {};
  for (const unit of stage.units || []) counts[unit.status] = (counts[unit.status] || 0) + 1;
  return { stageId: stage.stageId, status: stage.status, counts, active: activeCount(stage), total: stage.units?.length || 0, slotsAvailable: Math.max(0, (stage.maxConcurrentWorkers || 0) - activeCount(stage)) };
}

function activeCount(stage) { return (stage.units || []).filter((unit) => ["dispatched", "running"].includes(unit.status)).length; }
function slotsAvailable(stage, max) { return Math.max(0, max - activeCount(stage)); }
function findUnit(stage, unitId) { const unit = stage.units.find((item) => item.unitId === String(unitId || "").trim()); if (!unit) throw new Error(`不存在 Worker 单元：${unitId}`); return unit; }
function hashJson(value) { return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex"); }
function sortValue(value) { if (Array.isArray(value)) return value.map(sortValue); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortValue(entry)])); return value; }
async function writeJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); try { await rename(temp, file); } catch { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); } }
async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
async function exists(file) { try { await readFile(file); return true; } catch { return false; } }
async function appendEvent(runDir, event) { await mkdir(path.join(runDir, "reports"), { recursive: true }); await writeFile(path.join(runDir, "reports", "events.ndjson"), `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" }); }
function positiveInteger(value, name) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error(`${name} 必须是正整数`); return number; }
function boundedInteger(value, min, max, name) { const number = Number(value); if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} 必须是 ${min} 至 ${max} 的整数`); return number; }
function safePart(value) { return String(value || "").trim().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "unit"; }

function buildWorkerPrompt(state, stage, unit, unitDir) {
  return `# VideosBatch 本地 Worker\n\n运行目录：${state.runDir}\n阶段：${stage.stageId}\n单元：${unit.unitId}\nWorker：${unit.workerId}\nLease：${unit.leaseId}\n输入来源：${JSON.stringify(stage.source)}\n预期输出：${stage.expectedOutput}\n允许写入：${unitDir}\n\n先读取运行目录中的 run_manifest.json、worker_jobs.json 和当前阶段 artifact。你只拥有本单元，不得修改兄弟单元、全局计划、其他阶段或 final/。完成后在允许目录写入 worker_result.json，并由父 Planner 执行 run record。不得伪造 revision、Hash、公开资产 ID、Provider 任务 ID 或完成状态。失败时返回 status=failed、错误码、可重试性和具体根因。`;
}

async function loadCanonicalSnapshot(directory) {
  const packageDir = fileURLToPath(new URL("./canonical", import.meta.url));
  const fallbackDir = existsSync(path.join(packageDir, "manifest.json")) ? packageDir : fileURLToPath(new URL("../canonical", import.meta.url));
  const canonicalDir = directory && await exists(path.join(directory, "manifest.json")) ? directory : fallbackDir;
  const manifestPath = path.join(canonicalDir, "manifest.json");
  const snapshotPath = path.join(canonicalDir, "videosbatch-workflow-canonical.md");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const text = await readFile(snapshotPath, "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex").toUpperCase();
  if (manifest.specId !== "VIDEOSBATCH_WORKFLOW_CANONICAL" || manifest.snapshotSha256 !== sha256) throw new Error("canonical 快照 manifest 校验失败");
  return { specId: manifest.specId, version: manifest.canonicalVersion, sha256 };
}

function bundledCanonicalPath() {
  const packagePath = fileURLToPath(new URL("./canonical/videosbatch-workflow-canonical.md", import.meta.url));
  return existsSync(packagePath) ? packagePath : fileURLToPath(new URL("../canonical/videosbatch-workflow-canonical.md", import.meta.url));
}

async function verifyCanonicalSnapshot(manifest, runDir) {
  const canonical = await loadCanonicalSnapshot(path.join(runDir, "canonical"));
  if (manifest.canonical?.specId !== canonical.specId || manifest.canonical?.sha256 !== canonical.sha256) throw new Error("运行目录的 canonical 快照与当前 Skill 不一致，请重新 prepare");
}

function extractLessonText(file, bytes) {
  const ext = path.extname(file).toLowerCase();
  if ([".txt", ".md", ".markdown", ".json", ".csv"].includes(ext)) return bytes.toString("utf8").replace(/^\uFEFF/u, "").trim();
  if (ext === ".docx") return extractDocxDocumentXml(bytes);
  if (ext === ".pdf") throw new Error("本地 PDF 解析需要先安装 pdftotext；请先转为 DOCX/TXT/Markdown 后再 prepare");
  return bytes.toString("utf8").replace(/^\uFEFF/u, "").trim();
}

function extractDocxDocumentXml(bytes) {
  const entry = readZipEntry(bytes, "word/document.xml");
  if (!entry) throw new Error("DOCX 中没有 word/document.xml，无法读取教案文本");
  return entry.toString("utf8").replace(/<w:tab\s*\/?\s*>/giu, "\t").replace(/<w:br\s*\/?\s*>/giu, "\n").replace(/<[^>]+>/gu, " ").replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/\s+/gu, " ").trim();
}

function readZipEntry(buffer, target) {
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    const payload = buffer.subarray(start, start + compressedSize);
    if (name === target) {
      if (method === 0) return payload;
      if (method === 8) return inflateRawSync(payload);
      throw new Error(`DOCX 压缩方式不支持：${method}`);
    }
    offset = start + compressedSize;
  }
  return null;
}
