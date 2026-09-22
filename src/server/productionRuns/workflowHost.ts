import type { CinemaStore } from "../store";
import type { VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";
import type { StageExecutionContext, StageRegistry, StageResult } from "../videosBatchWorkflow/stageContracts";
import { runNext } from "../videosBatchWorkflow/runner";
import { contentHash } from "../videosBatchWorkflow/canonicalStoryboard";
import type { ProductionRun } from "../../shared/productionRuns";
import type { ProjectionIntent } from "./projectionJournal";
import type { RunRepository, WorkItem } from "./repository";
import { WorkLimiter } from "./scheduling";

export function workflowVersion(workflow: VideosBatchWorkflowState) {
  return contentHash({ intentId: workflow.productionIntentId, currentStage: workflow.currentStage, completed: workflow.completed, stages: Object.fromEntries(
    Object.entries(workflow.stages).map(([id, stage]) => [id, { revision: stage?.revision, hash: contentHash(stage?.artifact ?? null) }])) });
}

export class WorkflowRunHost {
  readonly limiter = new WorkLimiter();
  constructor(readonly store: CinemaStore, readonly registry: StageRegistry, readonly repository: RunRepository,
    readonly context: (sessionId: string) => Promise<StageExecutionContext | undefined>,
    readonly exclusive: <T>(sessionId: string, kind: string, fn: () => Promise<T>) => Promise<T>) {}

  apply = async (intent: ProjectionIntent, value: unknown) => {
    const current = this.store.getSession(intent.sessionId);
    if (!current?.videosBatchWorkflow || (current.ownerUserId || "legacy") !== intent.ownerId) throw new Error("PROJECTION_OWNER_CHANGED");
    if (current.videosBatchWorkflow.productionOperationId === intent.operationId) return;
    if (workflowVersion(current.videosBatchWorkflow) !== intent.expectedVersion) throw new Error("PROJECTION_VERSION_CONFLICT");
    const saved = await this.store.checkpointWorkflow(intent.sessionId, { ...(value as VideosBatchWorkflowState), productionOperationId: intent.operationId });
    if (!saved) throw new Error("PROJECTION_SESSION_MISSING");
  };

  async step(run: ProductionRun, previous?: WorkItem) {
    return this.exclusive(run.sessionId, `production:${run.id}`, async () => {
      const ctx = await this.context(run.sessionId);
      if (!ctx || (ctx.session.ownerUserId || "legacy") !== run.ownerId) throw new Error("RUN_SESSION_MISSING");
      if (!previous && this.repository.editing.blocked(run.sessionId, ctx.workflow.currentStage)) throw new Error("EDIT_HOLD");
      if (workflowVersion(ctx.workflow) !== run.inputVersion) throw new Error("RUN_INPUT_CHANGED");
      const item = previous || this.repository.begin(run, ctx.workflow.currentStage, ctx.workflow);
      const recoveryOnly = Boolean(previous?.resumeKnown);
      const frozen = previous ? this.repository.journal.readResult(item.inputHash) as VideosBatchWorkflowState : ctx.workflow;
      const stageId = frozen.currentStage;
      const registry = { ...this.registry };
      let completedWork = 0;
      const previews = new Map<string, { id: string; text: string }>();
      const feedback = (kind: NonNullable<ProductionRun["feedback"]>["kind"], extra: Partial<NonNullable<ProductionRun["feedback"]>> = {}) => {
        if (this.repository.get(run.id)?.status === "cancelled") return;
        const old = this.repository.get(run.id)?.feedback;
        this.repository.update(run.id, { feedback: { ...(old?.itemId === item.id ? old : {}), kind, itemId: item.id, completedWork, ...extra } });
      };
      const shouldStopWork = () => {
        const latest = this.repository.get(run.id);
        return Boolean(recoveryOnly || this.repository.editing.blocked(run.sessionId, stageId) || latest?.controlIntent || ["pause_requested", "cancel_requested", "cancelled"].includes(latest?.status || ""));
      };
      const scheduleWork = <T>(provider: string, operation: () => Promise<T>) => this.limiter.run({ owner: run.ownerId, session: run.sessionId, provider }, async () => {
        if (shouldStopWork() && provider !== "video-resume") throw Object.assign(new Error("任务已暂停，尚未提交"), { code: "WORK_NOT_SUBMITTED", retryable: true });
        const result = await operation();
        completedWork++; feedback("working");
        return result;
      });
      if (item.resultHash && registry[stageId]) {
        const result = this.repository.journal.readResult(item.resultHash) as StageResult;
        registry[stageId] = { ...registry[stageId]!, execute: async () => result };
      } else if (registry[stageId] && !["ASSET_CANDIDATES", "EXECUTION"].includes(stageId)) {
        const definition = registry[stageId]!;
        registry[stageId] = { ...definition, execute: context => scheduleWork("text-audio", () => definition.execute(context)) };
      }
      const workflow = await runNext({ ...ctx, workflow: frozen, session: { ...ctx.session, videosBatchWorkflow: frozen },
        scheduleWork, shouldStopWork, workConcurrency: 2,
        previewCheckpoint: stageId !== "QUOTE" && registry[stageId]?.validatePreview ? async block => {
          if (!block || typeof block.id !== "string" || block.id.length > 100 || typeof block.text !== "string" || block.text.length > 20000
            || !registry[stageId]!.validatePreview!(block, ctx)) return;
          if (previews.size >= 100 && !previews.has(block.id)) return;
          previews.set(block.id, block);
          const previewRef = this.repository.journal.writeResult({ blocks: [...previews.values()], itemId: item.id, inputVersion: run.inputVersion });
          feedback("preview", { previewRef });
        } : undefined,
        resultCheckpoint: async result => { this.repository.result(item, result); feedback("validating"); },
        checkpoint: async next => {
          if (next.stages[stageId]?.status === "running") {
            if (!await this.store.checkpointWorkflow(run.sessionId, next)) throw new Error("RUN_SESSION_MISSING");
            feedback("working");
            return;
          }
          const resultHash = this.repository.journal.writeResult(next);
          const operationId = `${item.id}:complete`;
          this.repository.journal.transaction(() => this.repository.journal.record({ operationId, ownerId: run.ownerId,
            sessionId: run.sessionId, expectedVersion: run.inputVersion, resultHash }));
          feedback("saving");
          await this.repository.journal.project(operationId, this.apply);
          feedback("saved", { outputRevision: next.stages[stageId]?.revision });
        }
      }, registry);
      const failed = workflow.stages[stageId]?.status === "failed" || workflow.stages[stageId]?.status === "stale";
      this.repository.finish(item, failed ? "failed" : "succeeded");
      return { workflow, failed, progressed: workflow.currentStage !== stageId || workflow.completed, recoveryOnly };
    });
  }
}
