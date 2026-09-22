import type { RunMode, ProductionRun } from "../../shared/productionRuns";
import { RunRepository } from "./repository";
import { workflowVersion, WorkflowRunHost } from "./workflowHost";
import { currentExecutionShots, hasUnknownExecution } from "./executionRecovery";
import type { VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";

export class ProductionEngine {
  private timer?: ReturnType<typeof setTimeout>;
  private active = new Map<string, ProductionRun>();
  private lastOwner = "";
  private stopped = false;
  readonly ready: Promise<void>;
  constructor(readonly repository: RunRepository, readonly host: WorkflowRunHost, readonly concurrency = 2) {
    this.ready = this.recover();
    void this.ready.then(() => this.wake()).catch(() => { /* recovery leaves visible reconciling states */ });
  }
  private settledStatus(run: ProductionRun, workflow: VideosBatchWorkflowState, failed: boolean, progressed: boolean, recoveryOnly = false): ProductionRun["status"] {
    if (run.controlIntent === "stop" || run.status === "cancel_requested") return "cancelled";
    if (run.controlIntent === "pause" || run.status === "pause_requested") return "paused";
    if (recoveryOnly && failed) {
      const session = this.host.store.getSession(run.sessionId);
      if (!session || hasUnknownExecution(currentExecutionShots(session, workflow))) return "reconciling";
      const items = workflow.stages.EXECUTION?.artifact?.failedShots;
      if (items?.length && items.every((item: any) => item.error?.code === "WORK_NOT_SUBMITTED")) return "queued";
    }
    return failed ? "failed" : workflow.completed ? "succeeded"
      : !progressed || ["COURSE_INTRO_SELECTION", "ASSET_CONFIRMATION"].includes(workflow.currentStage) ? "waiting_input"
      : run.mode === "next" ? "succeeded" : "queued";
  }
  private async recover() {
    for (const intent of this.repository.journal.pending()) {
      try { await this.repository.journal.project(intent.operationId, this.host.apply); }
      catch { /* keep the intent; its run must not resume blindly */ }
    }
    for (const run of this.repository.list()) {
      if (!["running", "pause_requested", "cancel_requested"].includes(run.status)) continue;
      const items = this.repository.items(run.id);
      const item = items.at(-1);
      const session = this.host.store.getSession(run.sessionId);
      const workflow = session?.videosBatchWorkflow;
      if (item && workflow?.productionOperationId === `${item.id}:complete`) {
        const failed = workflow.stages[item.stageId as keyof typeof workflow.stages]?.status === "failed";
        this.repository.finish(item, failed ? "failed" : "succeeded");
        this.repository.update(run.id, { status: this.settledStatus(run, workflow, failed, workflow.currentStage !== item.stageId || workflow.completed, item.resumeKnown), inputVersion: workflowVersion(workflow), stageId: workflow.currentStage });
      } else if (item?.resultHash && workflow && workflowVersion(workflow) === run.inputVersion) {
        this.repository.update(run.id, { status: "queued", controlIntent: run.status === "cancel_requested" ? "stop" : run.status === "pause_requested" ? "pause" : run.controlIntent, message: "已返回结果可恢复" });
      } else if (item?.stageId === "EXECUTION" && workflow && workflowVersion(workflow) === run.inputVersion
        && session && currentExecutionShots(session, workflow).some(shot => Boolean(shot.generationTaskId || (shot.videoUrl && shot.videoDurationVerified)))) {
        item.resumeKnown = true; this.repository.saveItem(item);
        this.repository.update(run.id, { status: "queued", controlIntent: run.status === "cancel_requested" ? "stop" : run.status === "pause_requested" ? "pause" : run.controlIntent, message: "恢复原任务轮询，不重新提交" });
      } else {
        this.repository.update(run.id, { status: "reconciling", message: "上次执行未确认完成，请核对原任务；系统没有重复提交。" });
      }
    }
  }
  async start(sessionId: string, mode: RunMode, requestKey: string) {
    await this.ready;
    const ctx = await this.host.context(sessionId);
    const session = ctx?.session;
    if (!session?.videosBatchWorkflow) throw Object.assign(new Error("工作流尚未开始"), { status: 409 });
    const version = workflowVersion(ctx!.workflow);
    for (const active of this.repository.list(sessionId)) {
      if (["waiting_input", "paused"].includes(active.status) && active.inputVersion !== version) {
        this.repository.update(active.id, { status: "cancelled", message: "输入版本已更新" });
      }
    }
    const run = this.repository.create({ sessionId, ownerId: session.ownerUserId || "legacy", mode, requestKey,
      inputVersion: version, stageId: ctx!.workflow.currentStage });
    this.wake(); return run;
  }
  wake() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, 0);
    this.timer.unref();
  }
  private async tick() {
    if (this.stopped) return;
    const candidates = this.repository.list().filter(item => item.status === "queued" && !this.active.has(item.id));
    candidates.sort((a, b) => (Date.parse(a.updatedAt) - a.priority * 1000) - (Date.parse(b.updatedAt) - b.priority * 1000)
      || Number(a.ownerId === this.lastOwner) - Number(b.ownerId === this.lastOwner));
    for (const run of candidates) {
      if (this.active.size >= this.concurrency) break;
      if ([...this.active.values()].filter(active => active.ownerId === run.ownerId).length >= 2) continue;
      if ([...this.active.values()].some(active => active.sessionId === run.sessionId)) continue;
      this.active.set(run.id, run); this.lastOwner = run.ownerId;
      void this.execute(run);
    }
  }
  private async execute(run: ProductionRun) {
    try {
      this.repository.update(run.id, { status: "running", message: undefined });
      const last = this.repository.items(run.id).at(-1);
      const outcome = await this.host.step(run, last?.status === "running" && (last.resultHash || last.resumeKnown) ? last : undefined);
      if (this.repository.get(run.id)?.status === "cancelled") return;
      const { workflow, failed, progressed } = outcome;
      const latest = this.repository.get(run.id);
      const status = this.settledStatus(latest || run, workflow, failed, progressed, outcome.recoveryOnly);
      this.repository.update(run.id, { status,
        inputVersion: workflowVersion(workflow), stageId: workflow.currentStage, completedItems: run.completedItems + (progressed ? 1 : 0),
        message: failed ? "此步骤失败，请查看项目中的原因" : undefined });
    } catch {
      if (this.repository.get(run.id)?.status !== "cancelled") {
        this.repository.update(run.id, { status: "reconciling", message: "执行或保存未确认完成，已暂停后续工作，请核对项目状态。" });
      }
    } finally { this.active.delete(run.id); this.wake(); }
  }
  async control(id: string, action: "pause" | "resume" | "stop" | "priority", requestId: string, priority = 0) {
    await this.ready;
    const run = this.repository.get(id); if (!run) throw Object.assign(new Error("任务不存在"), { status: 404 });
    const saved = this.repository.controlResult(id, requestId, `${action}:${priority}`);
    if (saved) return saved;
    let patch: Partial<ProductionRun> = {};
    if (action === "pause") {
      patch.controlIntent = "pause";
      if (["queued", "waiting_input"].includes(run.status)) patch.status = "paused";
      else if (run.status === "running") patch.status = "pause_requested";
      else if (!["paused", "pause_requested"].includes(run.status)) throw Object.assign(new Error("当前任务不能暂停"), { status: 409 });
    } else if (action === "stop") {
      if (["succeeded", "failed", "cancelled"].includes(run.status)) return this.repository.applyControl(id, requestId, `${action}:${priority}`, {});
      patch.controlIntent = "stop";
      patch.status = this.active.has(id) ? "cancel_requested" : "cancelled";
    } else if (action === "priority") {
      if (run.status !== "queued") throw Object.assign(new Error("只能调整等待中的任务"), { status: 409 });
      patch.priority = priority;
    } else {
      if (["queued", "running"].includes(run.status)) return this.repository.applyControl(id, requestId, `${action}:${priority}`, {});
      if (!["paused", "waiting_input", "failed"].includes(run.status)) throw Object.assign(new Error("任务需先核对，不能直接继续"), { status: 409 });
      const workflow = this.host.store.getSession(run.sessionId)?.videosBatchWorkflow;
      if (!workflow || workflow.stages[workflow.currentStage]?.errorInfo?.retryable === false) throw Object.assign(new Error("请先处理当前步骤的问题"), { status: 409 });
      const session = this.host.store.getSession(run.sessionId)!;
      if (workflow.currentStage === "EXECUTION" && hasUnknownExecution(currentExecutionShots(session, workflow))) throw Object.assign(new Error("请先核对没有回执的原任务"), { status: 409 });
      patch = { status: "queued", controlIntent: undefined, inputVersion: workflowVersion(workflow), stageId: workflow.currentStage, message: undefined };
    }
    const updated = this.repository.applyControl(id, requestId, `${action}:${priority}`, patch);
    this.wake(); return updated;
  }
  async wait(id: string): Promise<ProductionRun> {
    while (true) {
      const run = this.repository.get(id); if (!run) throw new Error("RUN_NOT_FOUND");
      if (!["queued", "running"].includes(run.status)) return run;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  /** Only called for an explicit reset/restart/retry after its serialized save.
   * Never invoked by request replay. Keep attempts and abandoned projections. */
  retireForNewIntent(sessionId: string) {
    for (const run of this.repository.list(sessionId)) {
      if (["succeeded", "failed", "cancelled"].includes(run.status)) continue;
      for (const item of this.repository.items(run.id)) {
        this.repository.journal.db.prepare("UPDATE projections SET applied=-1 WHERE operationId=? AND applied=0").run(`${item.id}:complete`);
      }
      this.repository.update(run.id, { status: "cancelled", message: "用户已明确开始新的操作；旧尝试保留供核对" });
    }
  }
  close() { this.stopped = true; if (this.timer) clearTimeout(this.timer); if (this.active.size) throw new Error("ENGINE_STILL_RUNNING"); this.repository.close(); }
}
