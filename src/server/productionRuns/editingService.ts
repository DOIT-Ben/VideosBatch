import { randomUUID } from "node:crypto";
import type { EditOperation, EditRequest } from "../../shared/editing";
import type { VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";
import type { ProductionEngine } from "./engine";
import { workflowVersion } from "./workflowHost";
import { editFailure } from "./editingStore";
import { contentHash } from "../videosBatchWorkflow/canonicalStoryboard";
import { replaceStageArtifact } from "../videosBatchWorkflow/runner";

export const editableStages = ["STORY_SCRIPT", "SCREENPLAY", "FINAL_STORYBOARD", "COURSE_INTRO_SELECTION", "ASSET_CONFIRMATION"];

/** Publishing is serialized with frozen work. Durable intent precedes JSON;
 * dispatch follows projection and pins the resulting workflow version. */
export class EditingService {
  constructor(readonly engine: ProductionEngine) {}
  private get repository() { return this.engine.repository; }
  private get store() { return this.repository.editing; }
  private current(sessionId: string) { return this.engine.host.store.getSession(sessionId)?.videosBatchWorkflow; }

  async publish(sessionId: string, ownerId: string, request: EditRequest) {
    await this.engine.ready;
    const id = `edit_${contentHash([ownerId, sessionId, request.requestId])}`;
    return this.engine.host.exclusive(sessionId, `${id}:${contentHash(request)}`, async () => {
      let operation = this.store.operation(id);
      if (operation && operation.requestHash !== contentHash(request)) throw editFailure("请求标识已用于另一份修改。", "EDIT_REQUEST_CONFLICT");
      if (!operation) {
        const ctx = await this.engine.host.context(sessionId);
        if (!ctx || (ctx.session.ownerUserId || "legacy") !== ownerId) throw editFailure("项目不存在", "SESSION_NOT_FOUND", 404);
        if ((ctx.workflow.stages[request.stageId]?.revision ?? 0) !== request.expectedRevision) throw editFailure("服务器内容已有更新，请保留草稿并核对新版。", "ARTIFACT_REVISION_CONFLICT");
        if (request.draftId) {
          const draft = this.store.draft(request.draftId);
          if (!draft || draft.sessionId !== sessionId || draft.ownerId !== ownerId || draft.instanceId !== request.instanceId || draft.stageId !== request.stageId || draft.clientVersion < request.clientVersion! || draft.baseRevision !== request.expectedRevision) throw editFailure("草稿版本或编辑页面已变化，请重新同步。", "DRAFT_VERSION_CONFLICT");
        }
        const updated = replaceStageArtifact(ctx.workflow, request.stageId, request.artifact, undefined, this.engine.host.registry, ctx);
        updated.productionIntentId = randomUUID();
        const resultHash = this.repository.journal.writeResult(updated);
        operation = { id, ownerId, sessionId, requestHash: contentHash(request), request, state: "prepared", resultHash,
          expectedVersion: workflowVersion(ctx.workflow), savedRevision: updated.stages[request.stageId]!.revision };
        this.repository.journal.transaction(() => {
          this.store.saveOperation(operation!);
          this.repository.journal.record({ operationId: id, ownerId, sessionId, expectedVersion: operation!.expectedVersion, resultHash });
        });
      }
      await this.complete(operation);
      return this.response(this.store.operation(id)!);
    });
  }

  private async complete(operation: EditOperation) {
    const { id, request, sessionId } = operation;
    if (operation.state === "conflict" || operation.state === "queued") return;
    if (operation.state === "prepared") {
      const current = this.current(sessionId);
      if (!current) throw editFailure("项目不存在", "SESSION_NOT_FOUND", 404);
      const result = this.repository.journal.readResult(operation.resultHash) as VideosBatchWorkflowState;
      // An applied marker may have been followed by native projection before a
      // crash. Its intent ID still identifies this version; never overwrite a later edit.
      if (current.productionIntentId !== result.productionIntentId && workflowVersion(current) !== operation.expectedVersion) {
        operation.state = "conflict"; operation.error = "保存前版本已变化，请核对服务器内容。";
        this.store.saveOperation(operation);
        this.repository.journal.db.prepare("UPDATE projections SET applied=-1 WHERE operationId=? AND applied=0").run(id);
        return;
      }
      await this.repository.journal.project(id, this.engine.host.apply);
      const next = structuredClone(this.current(sessionId)!);
      const definition = this.engine.host.registry[request.stageId];
      if (request.stageId === "FINAL_STORYBOARD" && definition?.project) {
        const ctx = await this.engine.host.context(sessionId);
        if (!ctx) throw new Error("EDIT_SESSION_MISSING");
        await definition.project(next.stages[request.stageId]?.artifact, { ...ctx, workflow: next, session: { ...ctx.session, videosBatchWorkflow: next } });
        next.stages[request.stageId]!.contentHash = contentHash(next.stages[request.stageId]!.artifact);
        await this.engine.host.store.checkpointWorkflow(sessionId, next);
      }
      this.engine.retireForNewIntent(sessionId);
      operation.resultVersion = workflowVersion(this.current(sessionId)!);
      operation.publishedHash = this.repository.journal.writeResult(this.current(sessionId)!);
      operation.state = "ready";
      if (request.draftId) this.store.published(request.draftId, request.instanceId!, request.clientVersion!);
      this.store.saveOperation(operation);
      // Existing runs carry invalidation without changing their frozen inputs.
      const last = this.repository.list(sessionId)[0];
      if (last) this.repository.update(last.id, {});
    }
    if (!request.continue) return;
    // A crash after queue commit can be recovered even after the run advanced.
    const alias = this.repository.journal.db.prepare("SELECT runId FROM run_requests WHERE ownerId=? AND sessionId=? AND requestKey=?").get(operation.ownerId, sessionId, id);
    if (alias) { operation.state = "queued"; operation.runId = String(alias.runId); operation.error = undefined; this.store.saveOperation(operation); return; }
    if (workflowVersion(this.current(sessionId)!) !== operation.resultVersion) {
      operation.state = "conflict"; operation.error = "内容又有更新，旧版本的推进请求没有启动。"; this.store.saveOperation(operation); return;
    }
    try {
      const run = await this.engine.start(sessionId, "all", id);
      if (run.inputVersion !== operation.resultVersion) throw editFailure("已有其他版本的执行计划，请核对。", "EDIT_RUN_CONFLICT");
      operation.state = "queued"; operation.runId = run.id; operation.error = undefined;
    } catch { operation.error = "已保存，尚未开始；可重试推进，不会重复保存。"; }
    this.store.saveOperation(operation);
  }

  async recover() {
    for (const operation of this.store.operations().filter(op => op.state === "prepared" || (op.state === "ready" && op.request.continue))) {
      try { await this.engine.host.exclusive(operation.sessionId, `recover:${operation.id}`, () => this.complete(this.store.operation(operation.id)!)); }
      catch { /* persisted prepared intent blocks dispatch and remains retryable */ }
    }
  }
  private response(operation: EditOperation) {
    const published = this.repository.journal.readResult(operation.publishedHash || operation.resultHash) as VideosBatchWorkflowState;
    return { workflow: this.current(operation.sessionId), operationId: operation.id, savedRevision: operation.savedRevision, savedArtifact: published.stages[operation.request.stageId]?.artifact,
      continuation: { status: operation.state === "conflict" ? "blocked" : operation.state === "prepared" ? "pending" : !operation.request.continue ? "none" : operation.state === "queued" ? "queued" : "pending", runId: operation.runId, reason: operation.error } };
  }
}
