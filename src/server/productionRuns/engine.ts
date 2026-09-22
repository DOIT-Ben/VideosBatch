import type { RunMode, ProductionRun } from "../../shared/productionRuns";
import { RunRepository } from "./repository";
import { workflowVersion, WorkflowRunHost } from "./workflowHost";

export class ProductionEngine {
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private stopped = false;
  readonly ready: Promise<void>;
  constructor(readonly repository: RunRepository, readonly host: WorkflowRunHost) {
    this.ready = this.recover();
    void this.ready.then(() => this.wake()).catch(() => { /* recovery leaves visible reconciling states */ });
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
        this.repository.update(run.id, { status: failed ? "failed" : run.mode === "next" || workflow.completed ? "succeeded" : "queued", inputVersion: workflowVersion(workflow), stageId: workflow.currentStage });
      } else if (item?.resultHash && workflow && workflowVersion(workflow) === run.inputVersion) {
        this.repository.update(run.id, { status: "queued", message: "正在恢复已返回结果" });
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
    if (this.stopped || this.timer || this.busy) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, 0);
    this.timer.unref();
  }
  private async tick() {
    if (this.busy || this.stopped) return;
    const run = this.repository.list().find(item => item.status === "queued");
    if (!run) return;
    this.busy = true;
    try {
      this.repository.update(run.id, { status: "running", message: undefined });
      const last = this.repository.items(run.id).at(-1);
      const outcome = await this.host.step(run, last?.status === "running" && last.resultHash ? last : undefined);
      if (this.repository.get(run.id)?.status === "cancelled") return;
      const { workflow, failed, progressed } = outcome;
      const waiting = !progressed || ["COURSE_INTRO_SELECTION", "ASSET_CONFIRMATION"].includes(workflow.currentStage);
      this.repository.update(run.id, { status: failed ? "failed" : workflow.completed ? "succeeded" : waiting ? "waiting_input" : run.mode === "next" ? "succeeded" : "queued",
        inputVersion: workflowVersion(workflow), stageId: workflow.currentStage, completedItems: run.completedItems + (progressed ? 1 : 0),
        message: failed ? "此步骤失败，请查看项目中的原因" : undefined });
    } catch {
      if (this.repository.get(run.id)?.status !== "cancelled") {
        this.repository.update(run.id, { status: "reconciling", message: "执行或保存未确认完成，已暂停后续工作，请核对项目状态。" });
      }
    } finally { this.busy = false; this.wake(); }
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
  close() { this.stopped = true; if (this.timer) clearTimeout(this.timer); if (this.busy) throw new Error("ENGINE_STILL_RUNNING"); this.repository.close(); }
}
