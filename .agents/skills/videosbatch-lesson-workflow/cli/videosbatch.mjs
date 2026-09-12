#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  claimWorker,
  completeWorker,
  createWorkerPlan,
  failWorker,
  nextWorkerUnits,
  planFile,
  readWorkerPlan,
  resetWorker,
  summarizeWorkerPlan,
  writeWorkerPlan
} from "./worker-state.mjs";
import {
  dispatchLocalWorker,
  finalizeLocalRun,
  loadLocalRun,
  localRunNext,
  localDoctor,
  saveLocalStageArtifact,
  localStatus,
  prepareLocalRun,
  persistLocalWorkerDispatch,
  recordLocalWorker,
  resetLocalWorker
} from "./local-runtime.mjs";

const VERSION = "0.1.0";
const DEFAULT_BASE_URL = "http://localhost:5173";
const CONFIG_HOME = process.env.VIDEOSBATCH_CLI_HOME || path.join(os.homedir(), ".videosbatch");
const CONFIG_FILE = path.join(CONFIG_HOME, "config.json");
const CLI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = existsSync(path.join(CLI_ROOT, "prompts")) ? CLI_ROOT : path.resolve(CLI_ROOT, "..");
const STAGES = new Set([
  "LESSON_INPUT", "COURSE_INTRO_CANDIDATES", "COURSE_INTRO_SELECTION", "STORY_SCRIPT", "ASSET_PLAN",
  "ASSET_CANDIDATES", "ASSET_CONFIRMATION", "SCREENPLAY", "FINAL_STORYBOARD", "COPYABLE_PROMPT",
  "QUOTE", "EXECUTION", "STITCH"
]);

const HELP = `
VideosBatch CLI ${VERSION}

用法：
  videosbatch doctor --json
  videosbatch configure --base-url <url> [--access-token <token>]
  videosbatch session create --title <title> [--logline <text>] [--dry-run]
  videosbatch lesson parse --session <id> --file <path>
  videosbatch prepare <lesson-file> --out <run-dir> [--max-concurrent <n>] [--executor-mode fake|llm] [--media-mode fake|native] [--force]
  videosbatch status <run-dir> [--json]
  videosbatch run next <run-dir> [--auto-workers] [--auto-fake] [--execute] [--json]
  videosbatch run all <run-dir> --auto-fake [--json]
  videosbatch run dispatch <run-dir> --unit <id> --worker-id <id> [--lease-ms <n>]
  videosbatch run record <run-dir> --unit <id> --worker-id <id> --lease-id <id> [--result-file <path>]
  videosbatch run save <run-dir> --stage <stage> --artifact-file <path>
  videosbatch run reset <run-dir> --unit <id> --confirm-lost
  videosbatch run finalize <run-dir> [--json]
  videosbatch start --session <id> --project-id <id> (--lesson-text <text> | --lesson-file <path>)
  videosbatch status --session <id|latest> [--json]
  videosbatch run-next --session <id> [--dry-run]
  videosbatch run-all --session <id> --confirm-run-all [--dry-run]
  videosbatch artifact save --session <id> --stage <stage> (--file <path> | --json <object>) [--dry-run]
  videosbatch restart --session <id> --stage <stage> [--dry-run]
  videosbatch retry --session <id> --stage <stage> [--source-revision <n>] [--source-hash <hash>] [--json]
  videosbatch worker plan --session <id> --stage <stage> --units-json '["unit-1","unit-2"]' --max-concurrent <n> [--expected-output <kind>] [--gate <gate>]
  videosbatch worker status --session <id> --stage <stage>
  videosbatch worker next --session <id> --stage <stage>
  videosbatch worker claim --session <id> --stage <stage> --unit <id> --worker-id <id> [--lease-ms <n>]
  videosbatch worker complete --session <id> --stage <stage> --unit <id> --worker-id <id> --lease-id <id> [--result-file <path>]
  videosbatch worker fail --session <id> --stage <stage> --unit <id> --worker-id <id> --lease-id <id> --error-code <code> --message <text> [--retryable]
  videosbatch worker reset --session <id> --stage <stage> --unit <id> [--worker-id <id>] --confirm-lost
  videosbatch prompt build --stage <stage> --session <id> [--mode <mode>] [--unit <id>] [--max-concurrent <n>] [--input-snapshot <ref>] [--write-scope <scope>] [--expected-output <kind>] --out <path>
  videosbatch request --method GET --path /api/... [--json-body <object>] [--confirm-write]

全局选项：
  --base-url <url>       覆盖服务地址
  --access-token <token> 覆盖访问令牌（优先使用环境变量）
  --videosbatch-env <path> 加载 Skill 提供的环境模板或用户环境文件（不覆盖已有环境变量）
  --local                 doctor 仅检查本地 Skill/Provider 配置，不访问 Web 服务（默认）
  --remote                doctor 检查显式配置的远程/本地 Web 服务
  --json                 输出机器可读 JSON
  --dry-run              只显示将要执行的动作，不写远端状态
  --help                 显示帮助
`;

class CliError extends Error {
  constructor(message, code = 1, details = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

class ApiError extends CliError {
  constructor(message, status, details = {}) {
    super(message, status === 401 ? 3 : 1, { status, ...details });
    this.status = status;
  }
}

const { command, positionals, options } = parseArgs(process.argv.slice(2));

if (options.help || options.version || command === "help") {
  if (options.version) console.log(VERSION);
  else console.log(HELP.trim());
  process.exit(0);
}

if (command === "--version") {
  console.log(VERSION);
  process.exit(0);
}

if (command === "--help") {
  console.log(HELP.trim());
  process.exit(0);
}

try {
  await loadEnvFile(options["videosbatch-env"] || process.env.VIDEOSBATCH_ENV_FILE);
  const config = await readConfig();
  const runtime = resolveRuntime(config, options);
  const result = await dispatch(command, positionals, options, runtime, config);
  printResult(result, options.json);
} catch (error) {
  const payload = errorPayload(error);
  if (options.json) console.log(JSON.stringify({ error: payload }, null, 2));
  else console.error(`videosbatch: ${payload.message}`);
  process.exit(error instanceof CliError ? error.code : 1);
}

function parseArgs(argv) {
  const args = [...argv];
  let command = "help";
  let commandFound = false;
  const positionals = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--") && !commandFound) {
      command = token;
      commandFound = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    if (equal > 2) {
      options[token.slice(2, equal)] = token.slice(equal + 1);
      continue;
    }
    const key = token.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { command, positionals, options };
}

async function loadEnvFile(file) {
  if (!file) return;
  const envPath = path.resolve(String(file));
  let source;
  try {
    source = await readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new CliError(`环境文件不存在：${envPath}`, 2);
    throw new CliError(`环境文件无法读取：${envPath}`, 2);
  }
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const value = rawValue.trim().replace(/^(["'])(.*)\1$/u, "$2");
    process.env[key] = value;
  }
}

async function dispatch(command, positionals, options, runtime, config) {
  if (command === "configure" || command === "config") return configure(options, config);
  if (command === "doctor") return options.remote === true ? doctor(runtime) : localDoctor(process.env);
  if (command === "session" && positionals[0] === "create") return createSession(runtime, options);
  if (command === "lesson" && positionals[0] === "parse") return parseLesson(runtime, options);
  if (command === "prepare") return prepareLocalCommand(positionals, options);
  if (command === "status" && !options.session && positionals[0]) return localStatus(positionals[0]);
  if (command === "run") return localRunCommand(positionals, options);
  if (command === "start") return startWorkflow(runtime, options);
  if (command === "status") return status(runtime, options);
  if (command === "run-next") return runNext(runtime, options);
  if (command === "run-all") return runAll(runtime, options);
  if (command === "artifact" && positionals[0] === "save") return saveArtifact(runtime, options);
  if (command === "restart") return restart(runtime, options);
  if (command === "retry") return retry(runtime, options);
  if (command === "worker") return workerCommand(runtime, positionals, options);
  if (command === "prompt" && positionals[0] === "build") return buildPrompt(options);
  if (command === "request") return rawRequest(runtime, options);
  throw new CliError(`未知命令：${command}。使用 --help 查看命令树。`, 2);
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new CliError(`配置文件无法读取：${CONFIG_FILE}`, 2);
  }
}

function resolveRuntime(config, options) {
  const baseUrl = normalizeBaseUrl(String(options["base-url"] || process.env.VIDEOSBATCH_BASE_URL || config.baseUrl || DEFAULT_BASE_URL));
  const envToken = process.env.VIDEOSBATCH_ACCESS_TOKEN || process.env.SEEREEL_ACCESS_TOKEN || "";
  const accessToken = String(options["access-token"] || envToken || config.accessToken || "").trim();
  return { baseUrl, accessToken, cookies: config.cookies || {} };
}

async function configure(options, config) {
  const next = { ...config };
  if (options["base-url"]) next.baseUrl = normalizeBaseUrl(String(options["base-url"]));
  if (options["access-token"]) next.accessToken = String(options["access-token"]).trim();
  if (options["clear-access-token"]) delete next.accessToken;
  if (options["dry-run"]) return preview("CONFIG", CONFIG_FILE, { baseUrl: next.baseUrl || DEFAULT_BASE_URL, accessTokenConfigured: Boolean(next.accessToken) });
  await mkdir(CONFIG_HOME, { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    action: "configure",
    configFile: CONFIG_FILE,
    baseUrl: next.baseUrl || DEFAULT_BASE_URL,
    accessTokenConfigured: Boolean(next.accessToken)
  };
}

async function doctor(runtime) {
  const health = await probe(runtime, "/api/healthz");
  const ready = await probe(runtime, "/api/readyz");
  const state = await probe(runtime, "/api/state");
  if (health.networkError) throw new CliError(`服务不可达：${runtime.baseUrl}`, 1, { baseUrl: runtime.baseUrl });
  return {
    action: "doctor",
    cliVersion: VERSION,
    nodeVersion: process.versions.node,
    nodeSupported: Number(process.versions.node.split(".")[0]) >= 18,
    baseUrl: runtime.baseUrl,
    auth: { configured: Boolean(runtime.accessToken), source: authSource(runtime) },
    probes: {
      healthz: compactProbe(health),
      readyz: compactProbe(ready),
      state: compactProbe(state)
    },
    ready: health.ok && (ready.ok || ready.status === 503)
  };
}

function authSource(runtime) {
  if (runtime.accessToken === String(process.env.VIDEOSBATCH_ACCESS_TOKEN || "").trim() && runtime.accessToken) return "env";
  if (runtime.accessToken === String(process.env.SEEREEL_ACCESS_TOKEN || "").trim() && runtime.accessToken) return "env-compatible";
  return runtime.accessToken ? "config-or-flag" : "missing";
}

async function createSession(runtime, options) {
  const title = required(options, "title");
  const body = { title, logline: String(options.logline || "") };
  if (options.style) body.style = String(options.style);
  if (options["target-duration-sec"]) body.targetDurationSec = numberOption(options["target-duration-sec"], "target-duration-sec");
  if (options["dry-run"]) return preview("POST", "/api/sessions", body);
  const session = await api(runtime, "/api/sessions", { method: "POST", body });
  return { action: "session-create", sessionId: session.id, session };
}

async function parseLesson(runtime, options) {
  const sessionId = required(options, "session");
  const file = path.resolve(required(options, "file"));
  const bytes = await readFile(file);
  const filename = path.basename(file);
  return api(runtime, `/api/sessions/${encode(sessionId)}/videosbatch/lesson/parse?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    rawBody: bytes,
    headers: { "Content-Type": contentType(filename) }
  });
}

async function prepareLocalCommand(positionals, options) {
  const inputPath = positionals[0] || options["lesson-file"];
  if (!inputPath) throw new CliError("prepare 必须提供教案文件路径", 2);
  const outDir = required(options, "out");
  return prepareLocalRun({ inputPath, outDir, maxConcurrentWorkers: options["max-concurrent"] || 4, executorMode: options["executor-mode"] || process.env.VIDEOSBATCH_EXECUTOR_MODE || "fake", mediaMode: options["media-mode"] || process.env.VIDEOSBATCH_MEDIA_MODE || "fake", force: options.force === true });
}

async function localRunCommand(positionals, options) {
  const action = positionals[0];
  const runDir = positionals[1];
  if (!action || !runDir) throw new CliError("run 命令必须是 next/all/dispatch/record/reset/finalize，并提供运行目录", 2);
  if (action === "next") return localRunNext(runDir, { autoWorkers: options["auto-workers"] === true, autoFake: options["auto-fake"] === true, execute: options.execute === true });
  if (action === "all") return localRunAll(runDir, options);
  if (action === "finalize") return finalizeLocalRun(runDir);
  if (action === "save") return localSaveCommand(runDir, options);
  const state = await loadLocalRun(runDir);
  if (action === "dispatch") return localDispatchCommand(state, options);
  if (action === "record") return localRecordCommand(state, options);
  if (action === "reset") return localResetCommand(state, options);
  throw new CliError(`未知本地 run 动作：${action}`, 2);
}

async function localSaveCommand(runDir, options) {
  const stage = validStage(required(options, "stage"));
  const artifactFile = path.resolve(required(options, "artifact-file"));
  let artifact;
  try { artifact = JSON.parse(await readFile(artifactFile, "utf8")); } catch { throw new CliError(`artifact 文件无法读取或不是有效 JSON：${artifactFile}`, 2); }
  return saveLocalStageArtifact(runDir, stage, artifact);
}

async function localRunAll(runDir, options) {
  if (options["auto-fake"] !== true) throw new CliError("本地 run all 仅接受显式 --auto-fake", 2);
  let result;
  for (let index = 0; index < 32; index += 1) {
    result = await localRunNext(runDir, { autoWorkers: true, autoFake: true });
    if (result.status === "complete" || result.status === "needs_human_confirmation" || result.status === "failed") return { action: "local-run-all", ...result, iterations: index + 1 };
  }
  throw new CliError("本地 fake 工作流超过 32 次阶段循环，疑似状态无法收敛", 1);
}

async function localDispatchCommand(state, options) {
  const result = dispatchLocalWorker(state, { unitId: required(options, "unit"), workerId: required(options, "worker-id"), leaseMs: options["lease-ms"] });
  const unitDir = await persistLocalWorkerDispatch(state, result);
  return { action: "local-worker-dispatch", runDir: state.runDir, stageId: result.stage.stageId, unit: result.unit, unitDir };
}

async function localRecordCommand(state, options) {
  const unitId = required(options, "unit");
  const stage = state.jobs.stages?.[state.manifest.currentStage];
  if (!stage) throw new CliError(`当前阶段没有 Worker 计划：${state.manifest.currentStage}`, 2);
  const unitDir = path.join(state.runDir, "workers", stage.stageId, safeUnitPath(unitId));
  const result = options["result-file"]
    ? JSON.parse(await readFile(path.resolve(String(options["result-file"])), "utf8"))
    : await readWorkerResult(unitDir);
  const unit = recordLocalWorker(state, { unitId, workerId: required(options, "worker-id"), leaseId: required(options, "lease-id"), result });
  await writeLocalWorkerJobs(state);
  return { action: "local-worker-record", runDir: state.runDir, stageId: stage.stageId, unit, unitDir };
}

async function localResetCommand(state, options) {
  const unit = resetLocalWorker(state, { unitId: required(options, "unit"), workerId: options["worker-id"], confirmLost: options["confirm-lost"] === true });
  await writeLocalWorkerJobs(state);
  return { action: "local-worker-reset", runDir: state.runDir, stageId: state.manifest.currentStage, unit };
}

async function readWorkerResult(unitDir) {
  try { return JSON.parse(await readFile(path.join(unitDir, "worker_result.json"), "utf8")); } catch { throw new CliError(`找不到 Worker 结果：${path.join(unitDir, "worker_result.json")}`, 2); }
}

async function writeLocalWorkerJobs(state) {
  const { writeFile: writeState } = await import("node:fs/promises");
  await writeState(path.join(state.runDir, "worker_jobs.json"), `${JSON.stringify({ ...state.jobs, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

function safeUnitPath(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "unit";
}

async function startWorkflow(runtime, options) {
  const sessionId = required(options, "session");
  const projectId = required(options, "project-id");
  let lessonText = String(options["lesson-text"] || "");
  let source;
  if (options["lesson-file"]) {
    const file = path.resolve(String(options["lesson-file"]));
    const bytes = await readFile(file);
    const filename = path.basename(file);
    const parsed = await api(runtime, `/api/sessions/${encode(sessionId)}/videosbatch/lesson/parse?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      rawBody: bytes,
      headers: { "Content-Type": contentType(filename) }
    });
    lessonText = String(parsed.text || "");
    source = { kind: "file", fileName: filename, fileType: fileType(filename), sizeBytes: bytes.length };
  }
  if (!lessonText.trim()) throw new CliError("必须提供 --lesson-text 或 --lesson-file", 2);
  const body = { projectId, lessonText, ...(source ? { source } : {}) };
  if (options["dry-run"]) return preview("POST", `/api/sessions/${sessionId}/videosbatch/start`, body);
  return api(runtime, `/api/sessions/${encode(sessionId)}/videosbatch/start`, { method: "POST", body });
}

async function status(runtime, options) {
  const sessionId = await resolveSessionId(runtime, options.session || "latest");
  const workflow = await api(runtime, `/api/sessions/${encode(sessionId)}/videosbatch`);
  return { action: "status", sessionId, workflow };
}

async function runNext(runtime, options) {
  const sessionId = required(options, "session");
  if (options["dry-run"]) return preview("POST", `/api/sessions/${sessionId}/videosbatch/run-next`);
  return api(runtime, `/api/sessions/${encode(sessionId)}/videosbatch/run-next`, { method: "POST" });
}

async function runAll(runtime, options) {
  const sessionId = required(options, "session");
  if (!options["confirm-run-all"]) throw new CliError("run-all 需要显式 --confirm-run-all", 2);
  if (options["dry-run"]) return preview("POST", `/api/sessions/${sessionId}/videosbatch/run-all`);
  return api(runtime, `/api/sessions/${encode(sessionId)}/videosbatch/run-all`, { method: "POST" });
}

async function saveArtifact(runtime, options) {
  const sessionId = required(options, "session");
  const stage = validStage(required(options, "stage"));
  const artifact = options.file ? JSON.parse(await readFile(path.resolve(String(options.file)), "utf8")) : parseJsonOption(options.json);
  if (artifact === undefined) throw new CliError("必须提供 --file 或 --json", 2);
  const body = { artifact };
  if (options["dry-run"]) return preview("PUT", `/api/sessions/${sessionId}/videosbatch/stages/${stage}/artifact`, body);
  return api(runtime, `/api/sessions/${encode(sessionId)}/videosbatch/stages/${encode(stage)}/artifact`, { method: "PUT", body });
}

async function restart(runtime, options) {
  const sessionId = required(options, "session");
  const stage = validStage(required(options, "stage"));
  if (options["dry-run"]) return preview("POST", `/api/sessions/${sessionId}/videosbatch/restart-from/${stage}`);
  return api(runtime, `/api/sessions/${encode(sessionId)}/videosbatch/restart-from/${encode(stage)}`, { method: "POST" });
}

async function retry(runtime, options) {
  const sessionId = required(options, "session");
  const stage = validStage(required(options, "stage"));
  const current = await api(runtime, `/api/sessions/${encode(sessionId)}/videosbatch`);
  const state = current?.stages?.[stage];
  if (!state) throw new CliError(`阶段未初始化：${stage}`, 2);
  const body = {
    sourceRevision: options["source-revision"] !== undefined ? numberOption(options["source-revision"], "source-revision") : state.sourceRevision,
    sourceHash: String(options["source-hash"] || state.sourceHash || ""),
    ...(state.sourceHashes ? { sourceHashes: state.sourceHashes } : {})
  };
  if (!body.sourceRevision || !body.sourceHash) throw new CliError("重试缺少当前来源 revision/hash", 2);
  if (options["dry-run"]) return preview("POST", `/api/sessions/${sessionId}/videosbatch/retry/${stage}`, body);
  return api(runtime, `/api/sessions/${encode(sessionId)}/videosbatch/retry/${encode(stage)}`, { method: "POST", body });
}

async function workerCommand(runtime, positionals, options) {
  const action = positionals[0];
  if (!action || !["plan", "status", "next", "claim", "complete", "fail", "reset"].includes(action)) {
    throw new CliError("worker 命令必须是 plan/status/next/claim/complete/fail/reset", 2);
  }
  const sessionId = required(options, "session");
  const stage = validStage(required(options, "stage"));
  if (action === "plan") return workerPlan(runtime, sessionId, stage, options);
  const plan = await readWorkerPlan(sessionId, stage);
  if (!plan) throw new CliError(`Worker plan 不存在：${planFile(sessionId, stage)}`, 2);
  if (action === "status") return { action: "worker-status", plan: summarizeWorkerPlan(plan), planFile: planFile(sessionId, stage) };
  if (action === "next") return { action: "worker-next", planId: plan.planId, units: nextWorkerUnits(plan), planFile: planFile(sessionId, stage) };
  if (action === "claim") return workerClaim(plan, options);
  if (action === "complete") return workerComplete(plan, options);
  if (action === "fail") return workerFail(plan, options);
  return workerReset(plan, options);
}

async function workerPlan(runtime, sessionId, stage, options) {
  const units = options["units-file"]
    ? JSON.parse(await readFile(path.resolve(String(options["units-file"])), "utf8"))
    : parseJsonOption(options["units-json"] || options.units);
  if (!Array.isArray(units) || !units.length) throw new CliError("worker plan 必须提供非空 --units-json 或 --units-file", 2);
  const workflow = await api(runtime, `/api/sessions/${encode(sessionId)}/videosbatch`);
  const stageState = workflow?.stages?.[stage] || {};
  const plan = createWorkerPlan({
    sessionId,
    stageId: stage,
    units,
    sourceRevision: options["source-revision"] ?? stageState.sourceRevision,
    sourceHash: options["source-hash"] ?? stageState.sourceHash,
    sourceHashes: options["source-hashes"] ? parseJsonOption(options["source-hashes"]) : stageState.sourceHashes,
    expectedOutput: options["expected-output"],
    gate: options.gate,
    maxConcurrentWorkers: options["max-concurrent"],
    retryBudget: options["retry-budget"] ?? 1
  });
  const existing = await readWorkerPlan(sessionId, stage);
  if (existing?.units?.some((unit) => unit.status === "running") && options.replace !== true) {
    throw new CliError("已有 running Worker，拒绝覆盖计划；先完成或确认丢失后 reset", 2);
  }
  if (options["dry-run"]) return { action: "worker-plan", dryRun: true, plan, planFile: planFile(sessionId, stage) };
  const file = await writeWorkerPlan(plan);
  return { action: "worker-plan", planId: plan.planId, planFile: file, plan: summarizeWorkerPlan(plan) };
}

async function workerClaim(plan, options) {
  const result = claimWorker(plan, { unitId: required(options, "unit"), workerId: required(options, "worker-id"), leaseMs: options["lease-ms"] });
  if (options["dry-run"]) return { action: "worker-claim", dryRun: true, unit: result.unit, planId: plan.planId };
  const file = await writeWorkerPlan(result.plan);
  return { action: "worker-claim", planId: plan.planId, planFile: file, unit: result.unit };
}

async function workerComplete(plan, options) {
  const result = options["result-file"] ? JSON.parse(await readFile(path.resolve(String(options["result-file"])), "utf8")) : parseJsonOption(options["result-json"] || options.result);
  const updated = completeWorker(plan, { unitId: required(options, "unit"), workerId: required(options, "worker-id"), leaseId: required(options, "lease-id"), result });
  if (options["dry-run"]) return { action: "worker-complete", dryRun: true, unit: updated.unit, planId: plan.planId };
  const file = await writeWorkerPlan(updated.plan);
  return { action: "worker-complete", planId: plan.planId, planFile: file, unit: updated.unit, summary: summarizeWorkerPlan(updated.plan) };
}

async function workerFail(plan, options) {
  const updated = failWorker(plan, { unitId: required(options, "unit"), workerId: required(options, "worker-id"), leaseId: required(options, "lease-id"), errorCode: required(options, "error-code"), message: required(options, "message"), retryable: options.retryable === true });
  if (options["dry-run"]) return { action: "worker-fail", dryRun: true, unit: updated.unit, planId: plan.planId };
  const file = await writeWorkerPlan(updated.plan);
  return { action: "worker-fail", planId: plan.planId, planFile: file, unit: updated.unit, summary: summarizeWorkerPlan(updated.plan) };
}

async function workerReset(plan, options) {
  const updated = resetWorker(plan, { unitId: required(options, "unit"), workerId: options["worker-id"], confirmLost: options["confirm-lost"] === true, force: options.force === true });
  if (options["dry-run"]) return { action: "worker-reset", dryRun: true, unit: updated.unit, planId: plan.planId };
  const file = await writeWorkerPlan(updated.plan);
  return { action: "worker-reset", planId: plan.planId, planFile: file, unit: updated.unit, summary: summarizeWorkerPlan(updated.plan) };
}

function buildPrompt(options) {
  const stage = validStage(required(options, "stage"));
  const session = required(options, "session");
  const mode = String(options.mode || "inspect");
  const out = path.resolve(required(options, "out"));
  const script = path.join(SKILL_ROOT, "scripts", "build-stage-prompt.mjs");
  const args = [script, "--stage", stage, "--session", session, "--mode", mode, "--out", out];
  if (options.unit) args.push("--unit", String(options.unit));
  if (options["max-concurrent"]) args.push("--max-concurrent", String(options["max-concurrent"]));
  if (options["input-snapshot"]) args.push("--input-snapshot", String(options["input-snapshot"]));
  if (options["write-scope"]) args.push("--write-scope", String(options["write-scope"]));
  if (options["expected-output"]) args.push("--expected-output", String(options["expected-output"]));
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.status !== 0) throw new CliError((result.stderr || result.stdout || "提示词构建失败").trim(), result.status || 1);
  try { return JSON.parse(result.stdout); } catch { return { action: "prompt-build", promptFile: out }; }
}

async function rawRequest(runtime, options) {
  const method = String(options.method || "GET").toUpperCase();
  const route = String(options.path || "");
  if (!route.startsWith("/api/")) throw new CliError("--path 必须以 /api/ 开头", 2);
  if (!["GET", "HEAD"].includes(method) && !options["confirm-write"]) throw new CliError("raw 写操作需要 --confirm-write", 2);
  const body = options["json-body"] ? parseJsonOption(options["json-body"]) : undefined;
  return api(runtime, route, { method, body });
}

async function resolveSessionId(runtime, value) {
  if (value && value !== "latest") return String(value);
  const state = await api(runtime, "/api/state");
  const session = Array.isArray(state.sessions) ? state.sessions[0] : undefined;
  if (!session?.id) throw new CliError("没有可用 Session", 2);
  return session.id;
}

async function api(runtime, route, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(runtime.accessToken ? { "x-seereel-access": runtime.accessToken } : {}),
    ...(cookieHeader(runtime) ? { Cookie: cookieHeader(runtime) } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(`${runtime.baseUrl}${route}`, {
    method: options.method || "GET",
    headers,
    ...(options.rawBody !== undefined ? { body: options.rawBody } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  }).catch((error) => {
    throw new CliError(`请求失败：${error?.message || "网络错误"}`, 1, { route });
  });
  rememberCookies(runtime, response.headers);
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  if (!response.ok) {
    const source = parsed?.error || parsed?.message || parsed?.code || text || response.statusText;
    const message = typeof source === "string" ? source : JSON.stringify(source);
    throw new ApiError(message, response.status, { body: parsed });
  }
  await persistCookies(runtime);
  return parsed;
}

async function probe(runtime, route) {
  try {
    const headers = {
      Accept: "application/json",
      ...(runtime.accessToken ? { "x-seereel-access": runtime.accessToken } : {}),
      ...(cookieHeader(runtime) ? { Cookie: cookieHeader(runtime) } : {})
    };
    const response = await fetch(`${runtime.baseUrl}${route}`, { headers });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    return { ok: response.ok, status: response.status, body, networkError: false };
  } catch (error) {
    return { ok: false, status: 0, networkError: true, error: error?.message || "network error" };
  }
}

function compactProbe(probeResult) {
  return { ok: probeResult.ok, status: probeResult.status, ...(probeResult.body?.code ? { code: probeResult.body.code } : {}), ...(probeResult.networkError ? { error: probeResult.error } : {}) };
}

function rememberCookies(runtime, headers) {
  const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : splitSetCookie(headers.get("set-cookie") || "");
  if (!lines.length) return;
  runtime.cookies ||= {};
  for (const line of lines) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = decodeURIComponent(pair.slice(index + 1).trim());
    if (value) runtime.cookies[name] = value;
    else delete runtime.cookies[name];
  }
}

async function persistCookies(runtime) {
  if (!runtime.cookies || !Object.keys(runtime.cookies).length) return;
  const config = await readConfig();
  config.cookies = runtime.cookies;
  await mkdir(CONFIG_HOME, { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function cookieHeader(runtime) {
  return Object.entries(runtime.cookies || {}).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}

function splitSetCookie(value) {
  return value ? value.split(/,(?=[^;,]+=)/).map((item) => item.trim()).filter(Boolean) : [];
}

function required(options, key) {
  const value = options[key];
  if (value === undefined || value === true || !String(value).trim()) throw new CliError(`缺少 --${key}`, 2);
  return String(value).trim();
}

function validStage(value) {
  const stage = String(value).trim();
  if (!STAGES.has(stage)) throw new CliError(`未知阶段：${stage}`, 2);
  return stage;
}

function parseJsonOption(value) {
  if (value === undefined || value === true) return undefined;
  try { return JSON.parse(String(value)); } catch { throw new CliError("JSON 参数无法解析", 2); }
}

function numberOption(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new CliError(`--${name} 必须是数字`, 2);
  return number;
}

function normalizeBaseUrl(value) {
  const url = String(value).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) throw new CliError(`服务地址无效：${value}`, 2);
  return url;
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function fileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  return "doc";
}

function contentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/msword";
}

function preview(method, route, body) {
  return { action: "dry-run", method, route, ...(body === undefined ? {} : { body }) };
}

function errorPayload(error) {
  if (error instanceof ApiError) {
    const apiError = error.details?.body?.error || error.details?.body || {};
    return { code: apiError.code || "API_ERROR", message: safeMessage(apiError.message || error.message), retryable: apiError.retryable === true, status: error.status };
  }
  if (error instanceof CliError) return { code: error.details?.code || "CLI_ERROR", message: safeMessage(error.message), retryable: false, ...(error.details?.status ? { status: error.details.status } : {}) };
  return { code: "CLI_UNEXPECTED_ERROR", message: safeMessage(error?.message || String(error)), retryable: false };
}

function safeMessage(value) {
  return String(value).replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]").replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*[^,\s}]+/giu, "$1=[redacted]").slice(0, 2000);
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result?.action === "doctor") {
    console.log(`VideosBatch: ${result.baseUrl}`);
    console.log(`Node: ${result.nodeVersion}${result.nodeSupported ? "" : " (unsupported)"}`);
    console.log(`Health: ${result.probes.healthz.ok ? "ok" : `status ${result.probes.healthz.status}`}`);
    console.log(`Ready: ${result.ready ? "yes" : "no"}`);
    console.log(`Access token: ${result.auth.configured ? "configured" : "missing"}`);
    return;
  }
  if (result?.action === "local-doctor") {
    console.log(`Local Skill: ${result.ready ? "ready" : "blocked"}`);
    console.log(`Node: ${result.nodeVersion}`);
    console.log(`Canonical: ${result.canonical.specId}@${result.canonical.version}`);
    console.log(`Executor: ${result.modes.executor}`);
    console.log(`Media: ${result.modes.media}`);
    return;
  }
  if (result?.action === "dry-run") {
    console.log(`[dry-run] ${result.method} ${result.route}`);
    return;
  }
  if (result?.action === "configure") {
    console.log(`Config: ${result.configFile}`);
    console.log(`Base URL: ${result.baseUrl}`);
    console.log(`Access token: ${result.accessTokenConfigured ? "configured" : "missing"}`);
    return;
  }
  if (result?.sessionId) console.log(`Session: ${result.sessionId}`);
  if (result?.promptFile) console.log(`Prompt: ${result.promptFile}`);
  else console.log("完成。使用 --json 查看完整结果。");
}
