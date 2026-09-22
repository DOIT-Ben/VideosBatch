import type { Application, Request } from "express";
import type { ProductionEngine } from "./engine";
import type { BatchAction, BatchItem, BatchResult } from "../../shared/batchControls";
import { workflowVersion } from "./workflowHost";
import { contentHash } from "../videosBatchWorkflow/canonicalStoryboard";
import { currentExecutionShots, hasUnknownExecution } from "./executionRecovery";

const actions = ["start", "pause", "resume", "stop", "retry", "priority"];
export function registerBatchApi(app: Application, engine: ProductionEngine, authorize: (session: { ownerUserId?: string }, req: Request) => boolean) {
  const { repository, host } = engine;
  repository.journal.db.exec("CREATE TABLE IF NOT EXISTS batch_receipts(id TEXT PRIMARY KEY, command TEXT NOT NULL, result TEXT)");
  const allowed = (id: string, req: Request) => { const session = host.store.getSession(id); try { return session && authorize(session, req) ? session : undefined; } catch { return undefined; } };
  const preview = (sessionId: string, action: BatchAction, req: Request): BatchItem => {
    const session = allowed(sessionId, req);
    const workflow = session?.videosBatchWorkflow;
    const run = repository.list(sessionId)[0];
    const base = { sessionId, runId: session ? run?.id : undefined, expectedVersion: workflow ? workflowVersion(workflow) : "", eligible: false };
    if (!session) return { ...base, reason: "项目不存在或无权限" };
    if (!workflow) return { ...base, reason: "请先上传或粘贴教案" };
    if (["start", "resume", "retry"].includes(action)) {
      if (workflow.completed) return { ...base, reason: "项目已完成" };
      if (["COURSE_INTRO_SELECTION", "ASSET_CONFIRMATION"].includes(workflow.currentStage)) return { ...base, reason: "请先完成人工确认" };
      if (repository.editing.blocked(sessionId, workflow.currentStage)) return { ...base, reason: "有未发布草稿，请先处理编辑" };
      if (workflow.stages[workflow.currentStage]?.errorInfo?.retryable === false || (workflow.currentStage === "EXECUTION" && hasUnknownExecution(currentExecutionShots(session, workflow)))) return { ...base, reason: "原任务需要核对，不能自动重试" };
    }
    const eligible = action === "start" ? !run || ["succeeded", "cancelled"].includes(run.status)
      : action === "pause" ? Boolean(run && ["queued", "running", "waiting_input"].includes(run.status))
      : action === "resume" ? Boolean(run && ["paused", "waiting_input"].includes(run.status))
      : action === "retry" ? run?.status === "failed"
      : action === "priority" ? run?.status === "queued"
      : Boolean(run && !["succeeded", "failed", "cancelled"].includes(run.status));
    return { ...base, eligible, reason: eligible ? undefined : "当前状态不适用此操作" };
  };
  app.post("/api/production/batch/preview", async (req, res) => {
    await engine.ready;
    const { action, sessionIds } = req.body || {};
    if (!actions.includes(action) || !Array.isArray(sessionIds) || sessionIds.length > 100 || !sessionIds.every(id => typeof id === "string")) return res.status(400).json({ error: "请选择1至100个任务及有效操作" });
    res.json([...new Set<string>(sessionIds)].map(id => preview(id, action, req)));
  });
  const flights = new Map<string, Promise<BatchResult>>();
  app.post("/api/production/batch", async (req, res) => {
    await engine.ready;
    const { action, items, requestId, priority = 0 } = req.body || {};
    if (!actions.includes(action) || !Array.isArray(items) || !items.length || items.length > 100 || !items.every(item => typeof item?.sessionId === "string" && typeof item?.expectedVersion === "string")
      || typeof requestId !== "string" || !requestId.length || requestId.length > 120 || ![0, 1, 2].includes(priority)) return res.status(400).json({ error: "批量请求不完整" });
    const results: BatchResult[] = [];
    for (const item of items as BatchItem[]) {
      const session = allowed(item.sessionId, req);
      if (!session) { results.push({ sessionId: item.sessionId, ok: false, reason: "项目不存在或无权限" }); continue; }
      if (!item.eligible) { results.push({ sessionId: session.id, ok: false, reason: "预览时不适用，本次未执行" }); continue; }
      const id = contentHash([session.ownerUserId || "legacy", session.id, requestId]);
      const command = contentHash([action, item, priority]);
      const previous = repository.journal.db.prepare("SELECT command,result FROM batch_receipts WHERE id=?").get(id);
      if (previous && previous.command !== command) { results.push({ sessionId: session.id, ok: false, reason: "请求标识已用于其他操作" }); continue; }
      if (previous?.result) { results.push(JSON.parse(String(previous.result))); continue; }
      let flight = flights.get(id);
      if (!flight) {
        repository.journal.db.prepare("INSERT OR IGNORE INTO batch_receipts VALUES(?,?,NULL)").run(id, command);
        flight = (async (): Promise<BatchResult> => {
          try {
            // Replaying a partially committed action uses the engine's receipt first.
            const alias = action === "start" ? repository.journal.db.prepare("SELECT runId FROM run_requests WHERE ownerId=? AND sessionId=? AND requestKey=?").get(session.ownerUserId || "legacy", session.id, `batch:${id}`) : undefined;
            const control = item.runId ? repository.controlResult(item.runId, `batch:${id}`, `${action === "retry" ? "resume" : action}:${priority}`) : undefined;
            if (alias || control) return { sessionId: session.id, ok: true, reason: "操作已接收", runId: control?.id || String(alias!.runId) };
            const accept = async (): Promise<BatchResult> => {
            const current = preview(session.id, action, req);
            if (!current.eligible) return { sessionId: session.id, ok: false, reason: current.reason! };
            if (current.expectedVersion !== item.expectedVersion || current.runId !== item.runId) return { sessionId: session.id, ok: false, reason: "任务状态已变化，请重新预览操作" };
            const run = action === "start" ? await engine.start(session.id, "all", `batch:${id}`)
              : await engine.control(item.runId!, action === "retry" ? "resume" : action, `batch:${id}`, priority);
            return { sessionId: session.id, ok: true, reason: "操作已接收", runId: run.id };
            };
            // New dispatch shares the save/restart barrier. Pause/stop must remain
            // immediate while an in-flight stage holds that barrier.
            return await (["start", "resume", "retry"].includes(action)
              ? host.exclusive(session.id, `batch:${id}`, accept) : accept());
          } catch { return { sessionId: session.id, ok: false, reason: "操作未完成，请重新预览后重试" }; }
        })();
        flights.set(id, flight);
      }
      const result = await flight;
      repository.journal.db.prepare("UPDATE batch_receipts SET result=? WHERE id=?").run(JSON.stringify(result), id);
      flights.delete(id); results.push(result);
    }
    res.json(results);
  });
}
