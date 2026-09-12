#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalSpec = "canonical/videosbatch-workflow-canonical.md";
const canonicalOverride = process.env.VIDEOSBATCH_CANONICAL_SPEC || "";
const canonicalReference = canonicalOverride || canonicalSpec;
const modes = new Set(["inspect", "draft", "save", "confirm", "retry", "execute"]);
const groups = {
  LESSON_INPUT: "01-intake-intro.md",
  COURSE_INTRO_CANDIDATES: "01-intake-intro.md",
  COURSE_INTRO_SELECTION: "01-intake-intro.md",
  STORY_SCRIPT: "02-story-asset-plan.md",
  ASSET_PLAN: "02-story-asset-plan.md",
  ASSET_CANDIDATES: "03-assets-confirmation.md",
  ASSET_CONFIRMATION: "03-assets-confirmation.md",
  SCREENPLAY: "04-screenplay-storyboard.md",
  FINAL_STORYBOARD: "04-screenplay-storyboard.md",
  COPYABLE_PROMPT: "04-screenplay-storyboard.md",
  QUOTE: "05-execution-delivery.md",
  EXECUTION: "05-execution-delivery.md",
  STITCH: "05-execution-delivery.md"
};

const args = parseArgs(process.argv.slice(2));
const stageId = String(args.stage || "").trim();
const sessionId = String(args.session || "").trim();
const mode = String(args.mode || "inspect").trim();
const output = String(args.out || "").trim();

if (!groups[stageId]) fail(`未知阶段：${stageId || "<empty>"}`);
if (!sessionId) fail("必须提供 --session");
if (!modes.has(mode)) fail(`未知模式：${mode}`);
if (!output) fail("必须提供 --out");

const canonicalPath = path.isAbsolute(canonicalReference)
  ? canonicalReference
  : path.resolve(canonicalOverride ? process.cwd() : skillRoot, canonicalReference);
try {
  await access(canonicalPath);
} catch {
  fail(`找不到 canonical spec：${canonicalPath}。请确认 Skill/CLI 包含 canonical 快照，或将 VIDEOSBATCH_CANONICAL_SPEC 指向可读规范文件`);
}
const canonicalText = await readFile(canonicalPath, "utf8");
if (!canonicalText.includes("Spec ID: `VIDEOSBATCH_WORKFLOW_CANONICAL`")) {
  fail(`canonical spec ID 不匹配：${canonicalPath}`);
}
const canonicalManifestPath = path.join(skillRoot, "canonical", "manifest.json");
const canonicalManifest = JSON.parse(await readFile(canonicalManifestPath, "utf8"));
if (canonicalManifest.specId !== "VIDEOSBATCH_WORKFLOW_CANONICAL" || canonicalManifest.snapshotSha256 !== (await import("node:crypto")).createHash("sha256").update(canonicalText).digest("hex").toUpperCase()) {
  fail(`canonical 快照 manifest 校验失败：${canonicalManifestPath}`);
}

const template = await readFile(path.join(skillRoot, "prompts", "stage-execution.md"), "utf8");
const promptGroup = groups[stageId];
const prompt = template
  .replaceAll("{{STAGE_ID}}", stageId)
  .replaceAll("{{SESSION_ID}}", sessionId)
  .replaceAll("{{MODE}}", mode)
  .replaceAll("{{PROMPT_GROUP}}", `prompts/${promptGroup}`)
  .replaceAll("{{CANONICAL_SPEC}}", canonicalReference)
  .replaceAll("{{UNIT_ID}}", String(args.unit || "<planner-assigned-unit>"))
  .replaceAll("{{MAX_CONCURRENT_WORKERS}}", String(args["max-concurrent"] || "planner-assigned"))
  .replaceAll("{{INPUT_SNAPSHOT}}", String(args["input-snapshot"] || "planner-provided-current-lineage"))
  .replaceAll("{{WRITE_SCOPE}}", String(args["write-scope"] || "planner-assigned-unit-only"))
  .replaceAll("{{EXPECTED_OUTPUT}}", String(args["expected-output"] || "canonical-stage-output"));
const groupText = await readFile(path.join(skillRoot, "prompts", promptGroup), "utf8");
const outputPath = path.resolve(output);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${prompt.trim()}\n\n--- 当前阶段提示词组 ---\n\n${groupText.trim()}\n`, "utf8");

console.log(JSON.stringify({
  stageId,
  sessionId,
  mode,
  promptFile: outputPath,
  promptGroup: `prompts/${promptGroup}`,
  canonicalSpec: canonicalReference,
  canonicalPath
}, null, 2));

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) fail(`不支持的位置参数：${token}`);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail(`参数缺少值：--${key}`);
    result[key] = value;
    i += 1;
  }
  return result;
}

function fail(message) {
  console.error(`build-stage-prompt: ${message}`);
  process.exit(2);
}
