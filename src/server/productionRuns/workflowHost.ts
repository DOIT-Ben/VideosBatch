import type { CinemaStore } from "../store";
import type { VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";
import type { StageExecutionContext, StageRegistry, StageResult } from "../videosBatchWorkflow/stageContracts";
import { runNext } from "../videosBatchWorkflow/runner";
import { contentHash } from "../videosBatchWorkflow/canonicalStoryboard";
import type { ProductionRun } from "../../shared/productionRuns";
import type { ProjectionIntent } from "./projectionJournal";
import type { RunRepository, WorkItem } from "./repository";

export function workflowVersion(workflow: VideosBatchWorkflowState) {
  return contentHash({ intentId: workflow.productionIntentId, currentStage: workflow.currentStage, completed: workflow.completed, stages: Object.fromEntries(
    Object.entries(workflow.stages).map(([id, stage]) => [id, { revision: stage?.revision, hash: contentHash(stage?.artifact ?? null) }])) });
}

export class WorkflowRunHost {
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
      if (workflowVersion(ctx.workflow) !== run.inputVersion) throw new Error("RUN_INPUT_CHANGED");
      const item = previous || this.repository.begin(run, ctx.workflow.currentStage, ctx.workflow);
      const frozen = previous ? this.repository.journal.readResult(item.inputHash) as VideosBatchWorkflowState : ctx.workflow;
      const stageId = frozen.currentStage;
      const registry = { ...this.registry };
      if (item.resultHash && registry[stageId]) {
        const result = this.repository.journal.readResult(item.resultHash) as StageResult;
        registry[stageId] = { ...registry[stageId]!, execute: async () => result };
      }
      const workflow = await runNext({ ...ctx, workflow: frozen, session: { ...ctx.session, videosBatchWorkflow: frozen },
        resultCheckpoint: async result => this.repository.result(item, result),
        checkpoint: async next => {
          if (next.stages[stageId]?.status === "running") {
            if (!await this.store.checkpointWorkflow(run.sessionId, next)) throw new Error("RUN_SESSION_MISSING");
            return;
          }
          const resultHash = this.repository.journal.writeResult(next);
          const operationId = `${item.id}:complete`;
          this.repository.journal.transaction(() => this.repository.journal.record({ operationId, ownerId: run.ownerId,
            sessionId: run.sessionId, expectedVersion: run.inputVersion, resultHash }));
          await this.repository.journal.project(operationId, this.apply);
        }
      }, registry);
      const failed = workflow.stages[stageId]?.status === "failed" || workflow.stages[stageId]?.status === "stale";
      this.repository.finish(item, failed ? "failed" : "succeeded");
      return { workflow, failed, progressed: workflow.currentStage !== stageId || workflow.completed };
    });
  }
}
