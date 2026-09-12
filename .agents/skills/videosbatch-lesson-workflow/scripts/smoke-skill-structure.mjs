#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "SKILL.md",
  "README.md",
  "canonical/manifest.json",
  "canonical/videosbatch-workflow-canonical.md",
  "agents/openai.yaml",
  "prompts/planner.md",
  "prompts/stage-execution.md",
  "references/planner-orchestration.md",
  "references/stage-map.md",
  "references/tool-routing.md",
  "references/output-report.md",
  "references/failure-recovery.md",
  "scripts/build-stage-prompt.mjs",
  "scripts/sync-canonical.mjs",
  "scripts/smoke-worker-state.mjs",
  "scripts/smoke-local-runtime.mjs",
  "cli/package.json",
  "cli/env.example",
  "cli/videosbatch.mjs",
  "cli/worker-state.mjs",
  "cli/local-runtime.mjs",
  "cli/local-providers.mjs",
  "cli/canonical/manifest.json",
  "cli/canonical/videosbatch-workflow-canonical.md",
  "cli/prompts/planner.md",
  "cli/scripts/build-stage-prompt.mjs"
];

for (const relative of required) await access(path.join(root, relative));
const digest = (value) => createHash("sha256").update(value).digest("hex").toUpperCase();
const canonical = await readFile(path.join(root, "canonical", "videosbatch-workflow-canonical.md"));
const cliCanonical = await readFile(path.join(root, "cli", "canonical", "videosbatch-workflow-canonical.md"));
if (digest(canonical) !== digest(cliCanonical)) throw new Error("CLI canonical snapshot differs from Skill canonical snapshot");
const canonicalManifest = JSON.parse(await readFile(path.join(root, "canonical", "manifest.json"), "utf8"));
const cliCanonicalManifest = JSON.parse(await readFile(path.join(root, "cli", "canonical", "manifest.json"), "utf8"));
if (JSON.stringify(canonicalManifest) !== JSON.stringify(cliCanonicalManifest)) throw new Error("CLI canonical manifest differs from Skill canonical manifest");
const repositoryCanonical = path.resolve(root, "../../../../specs/videosbatch-workflow-canonical.md");
if (existsSync(repositoryCanonical)) {
  const repositoryBytes = await readFile(repositoryCanonical);
  if (digest(repositoryBytes) !== digest(canonical)) throw new Error("Skill canonical snapshot differs from repository canonical spec");
  if (canonicalManifest.sourceSha256 !== digest(repositoryBytes) || canonicalManifest.snapshotSha256 !== digest(canonical)) throw new Error("canonical manifest hashes do not match source/snapshot");
}
for (const name of ["01-intake-intro.md", "02-story-asset-plan.md", "03-assets-confirmation.md", "04-screenplay-storyboard.md", "05-execution-delivery.md", "planner.md", "stage-execution.md"]) {
  const source = await readFile(path.join(root, "prompts", name));
  const bundled = await readFile(path.join(root, "cli", "prompts", name));
  if (digest(source) !== digest(bundled)) throw new Error(`CLI prompt differs from Skill prompt: ${name}`);
}
const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
const envExample = await readFile(path.join(root, "cli/env.example"), "utf8");
const planner = await readFile(path.join(root, "references/planner-orchestration.md"), "utf8");
const worker = await readFile(path.join(root, "prompts/stage-execution.md"), "utf8");
for (const token of ["总控 Planner", "ExecutionPlan", "maxConcurrentWorkers", "全局复盘", "Validator"]) {
  if (!skill.includes(token) && !planner.includes(token)) throw new Error(`missing planner token: ${token}`);
}
for (const token of ["Worker 单元", "并发预算", "输入快照", "允许写入范围", "Worker 只报告结果", "workerId", "inspect", "execute"]) {
  if (!worker.includes(token)) throw new Error(`missing worker token: ${token}`);
}
for (const token of [
  "VIDEOSBATCH_LLM_BASE_URL=https://jingai.cc/v1",
  "VIDEOSBATCH_LLM_FALLBACK_BASE_URL=https://api.deepseek.com/",
  "VIDEOSBATCH_IMAGE_BASE_URL=https://api.lyaiapp.com/v1",
  "VIDEOSBATCH_H3_BASE_URL=http://122.228.216.60/v1"
]) {
  if (!envExample.includes(token)) throw new Error(`provider route missing from env.example: ${token}`);
}
for (const key of ["VIDEOSBATCH_LLM_API_KEY", "VIDEOSBATCH_LLM_FALLBACK_API_KEY", "VIDEOSBATCH_IMAGE_API_KEY", "VIDEOSBATCH_H3_API_KEY"]) {
  const match = envExample.match(new RegExp(`^${key}=(.*)$`, "mu"));
  if (!match || match[1].trim()) throw new Error(`env.example must leave ${key} empty`);
}
console.log(`VideosBatch Skill structure smoke passed (${required.length} required files)`);
