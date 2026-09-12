import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const WORKER_PLAN_SCHEMA_VERSION = 1;
export const WORKER_STATUSES = new Set(["pending", "running", "ready", "failed", "stale"]);

export function planFile(sessionId, stageId) {
  return path.join(getWorkerHome(), safePart(sessionId), `${safePart(stageId)}.json`);
}

export function getWorkerHome() {
  return process.env.VIDEOSBATCH_WORKER_HOME || path.join(os.homedir(), ".videosbatch", "workers");
}

export function createWorkerPlan(input) {
  const sessionId = requiredPart(input.sessionId, "sessionId");
  const stageId = requiredPart(input.stageId, "stageId");
  const units = normalizeUnits(input.units);
  const maxConcurrentWorkers = positiveInteger(input.maxConcurrentWorkers, "maxConcurrentWorkers");
  const now = new Date().toISOString();
  const seed = JSON.stringify({ sessionId, stageId, sourceRevision: input.sourceRevision ?? null, sourceHash: input.sourceHash ?? null, sourceHashes: input.sourceHashes || {}, units: units.map((unit) => unit.unitId) });
  return {
    schemaVersion: WORKER_PLAN_SCHEMA_VERSION,
    planId: `plan_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`,
    sessionId,
    stageId,
    status: "open",
    sourceRevision: normalizeRevision(input.sourceRevision),
    sourceHash: normalizeHash(input.sourceHash),
    sourceHashes: normalizeHashMap(input.sourceHashes),
    expectedOutput: String(input.expectedOutput || "").trim() || null,
    gate: String(input.gate || "").trim() || null,
    maxConcurrentWorkers,
    retryBudget: positiveInteger(input.retryBudget ?? 1, "retryBudget"),
    createdAt: now,
    updatedAt: now,
    units
  };
}

export async function readWorkerPlan(sessionId, stageId) {
  const file = planFile(sessionId, stageId);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Worker plan 无法读取：${file}`);
  }
}

export async function writeWorkerPlan(plan) {
  validatePlan(plan);
  const file = planFile(plan.sessionId, plan.stageId);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...plan, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, file);
  } catch (error) {
    // Windows may reject replacing an existing file; the target is exact and scoped.
    await writeFile(file, `${JSON.stringify({ ...plan, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  }
  return file;
}

export function claimWorker(plan, input) {
  validatePlan(plan);
  const unit = findUnit(plan, input.unitId);
  const workerId = requiredPart(input.workerId, "workerId");
  if (unit.status !== "pending") throw new Error(`Worker 单元不可 claim：${unit.unitId} 当前为 ${unit.status}`);
  if (unit.attempt >= plan.retryBudget + 1) throw new Error(`Worker 重试预算已耗尽：${unit.unitId}`);
  const running = plan.units.filter((item) => item.status === "running").length;
  if (running >= plan.maxConcurrentWorkers) throw new Error(`并发上限已达到：${running}/${plan.maxConcurrentWorkers}`);
  const leaseMs = boundedInteger(input.leaseMs ?? 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000, "leaseMs");
  const now = Date.now();
  unit.status = "running";
  unit.workerId = workerId;
  unit.leaseId = `lease_${randomUUID()}`;
  unit.claimedAt = new Date(now).toISOString();
  unit.leaseExpiresAt = new Date(now + leaseMs).toISOString();
  unit.attempt = (unit.attempt || 0) + 1;
  unit.updatedAt = new Date(now).toISOString();
  return { plan, unit: structuredClone(unit) };
}

export function completeWorker(plan, input) {
  const unit = assertLease(plan, input);
  unit.status = "ready";
  unit.result = input.result ?? null;
  unit.error = null;
  unit.completedAt = new Date().toISOString();
  unit.leaseExpiresAt = null;
  plan.status = plan.units.every((item) => item.status === "ready") ? "complete" : "open";
  return { plan, unit: structuredClone(unit) };
}

export function failWorker(plan, input) {
  const unit = assertLease(plan, input);
  unit.status = input.status === "stale" ? "stale" : "failed";
  unit.error = {
    code: requiredPart(input.errorCode, "errorCode"),
    message: String(input.message || "Worker 失败").slice(0, 2000),
    retryable: input.retryable === true
  };
  unit.result = input.result ?? null;
  unit.failedAt = new Date().toISOString();
  unit.leaseExpiresAt = null;
  plan.status = "open";
  return { plan, unit: structuredClone(unit) };
}

export function resetWorker(plan, input) {
  validatePlan(plan);
  const unit = findUnit(plan, input.unitId);
  if (unit.status === "running" && input.confirmLost !== true) throw new Error("running Worker 只能在确认丢失后 reset");
  if (unit.status === "ready" && input.force !== true) throw new Error("ready Worker 不允许 reset；如确需重做请重新建立计划");
  if (unit.status === "failed" && unit.attempt >= plan.retryBudget + 1) throw new Error(`Worker 重试预算已耗尽：${unit.unitId}`);
  if (input.workerId && unit.workerId !== input.workerId) throw new Error("Worker 身份不匹配，拒绝 reset");
  unit.status = "pending";
  unit.workerId = null;
  unit.leaseId = null;
  unit.claimedAt = null;
  unit.leaseExpiresAt = null;
  unit.completedAt = null;
  unit.failedAt = null;
  unit.result = null;
  unit.error = null;
  unit.updatedAt = new Date().toISOString();
  plan.status = "open";
  return { plan, unit: structuredClone(unit) };
}

export function nextWorkerUnits(plan) {
  validatePlan(plan);
  const running = plan.units.filter((unit) => unit.status === "running").length;
  const capacity = Math.max(0, plan.maxConcurrentWorkers - running);
  return plan.units.filter((unit) => unit.status === "pending").slice(0, capacity).map((unit) => structuredClone(unit));
}

export function summarizeWorkerPlan(plan) {
  validatePlan(plan);
  const counts = Object.fromEntries([...WORKER_STATUSES].map((status) => [status, 0]));
  for (const unit of plan.units) counts[unit.status] = (counts[unit.status] || 0) + 1;
  return {
    planId: plan.planId,
    sessionId: plan.sessionId,
    stageId: plan.stageId,
    status: plan.status,
    maxConcurrentWorkers: plan.maxConcurrentWorkers,
    running: counts.running,
    counts,
    units: plan.units.map((unit) => ({ unitId: unit.unitId, status: unit.status, workerId: unit.workerId, attempt: unit.attempt, leaseExpiresAt: unit.leaseExpiresAt, error: unit.error }))
  };
}

export function validatePlan(plan) {
  if (!plan || plan.schemaVersion !== WORKER_PLAN_SCHEMA_VERSION) throw new Error("Worker plan schemaVersion 不支持");
  if (!plan.sessionId || !plan.stageId || !Array.isArray(plan.units) || !plan.units.length) throw new Error("Worker plan 缺少 session/stage/units");
  if (!Number.isInteger(plan.maxConcurrentWorkers) || plan.maxConcurrentWorkers < 1) throw new Error("Worker plan maxConcurrentWorkers 无效");
  const ids = plan.units.map((unit) => unit.unitId);
  if (new Set(ids).size !== ids.length) throw new Error("Worker plan 存在重复 unitId");
  for (const unit of plan.units) {
    if (!unit.unitId || !WORKER_STATUSES.has(unit.status)) throw new Error("Worker plan 包含无效 unit");
  }
}

function assertLease(plan, input) {
  validatePlan(plan);
  const unit = findUnit(plan, input.unitId);
  if (unit.status !== "running") throw new Error(`Worker 单元不是 running：${unit.unitId}`);
  if (unit.workerId !== input.workerId) throw new Error("Worker 身份不匹配，拒绝写入");
  if (!input.leaseId || unit.leaseId !== input.leaseId) throw new Error("leaseId 不匹配，拒绝写入");
  unit.updatedAt = new Date().toISOString();
  return unit;
}

function findUnit(plan, unitId) {
  const unit = plan.units.find((item) => item.unitId === String(unitId || "").trim());
  if (!unit) throw new Error(`不存在 Worker 单元：${unitId}`);
  return unit;
}

function normalizeUnits(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("units 必须是非空数组");
  const units = value.map((item) => {
    const unitId = typeof item === "string" ? item.trim() : String(item?.unitId || "").trim();
    if (!unitId) throw new Error("Worker unitId 不能为空");
    return { unitId, status: "pending", workerId: null, leaseId: null, claimedAt: null, leaseExpiresAt: null, attempt: 0, result: null, error: null, updatedAt: null };
  });
  if (new Set(units.map((unit) => unit.unitId)).size !== units.length) throw new Error("units 不能重复");
  return units;
}

function normalizeRevision(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error("sourceRevision 必须是非负整数");
  return number;
}

function normalizeHash(value) {
  const hash = String(value || "").trim();
  return hash || null;
}

function normalizeHashMap(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("sourceHashes 必须是对象");
  return Object.fromEntries(Object.entries(value).map(([key, hash]) => [key, String(hash || "").trim()]).filter(([, hash]) => hash));
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} 必须是正整数`);
  return number;
}

function boundedInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} 必须是 ${min} 至 ${max} 的整数`);
  return number;
}

function requiredPart(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${name} 不能为空`);
  return result;
}

function safePart(value) {
  return requiredPart(value, "path part").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "_";
}
