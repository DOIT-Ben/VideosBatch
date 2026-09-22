import express, { type Application, type Request, type Response } from "express";
import {
  createVideosBatchWorkflow,
  VIDEOS_BATCH_STAGE_ORDER,
  type VideosBatchLessonSource,
  type VideosBatchStageId
} from "../../shared/videosBatchWorkflow";
import { DATA_DIR, type CinemaStore } from "../store";
import path from "node:path";
import { RunRepository } from "../productionRuns/repository";
import { WorkflowRunHost, workflowVersion } from "../productionRuns/workflowHost";
import { ProductionEngine } from "../productionRuns/engine";
import { registerRunEvents } from "../productionRuns/events";
import { EditingService, editableStages } from "../productionRuns/editingService";
import { MAX_LESSON_FILE_BYTES, parseLessonDocument } from "./lessonDocumentParser";
import type { StageExecutionContext, StageRegistry } from "./stageContracts";
import { reconcileVideosBatchReadiness, replaceStageArtifact, restartFrom, retryLineageIssues } from "./runner";
import { contentHash } from "./canonicalStoryboard";
import { sanitizeProviderDiagnosticText } from "./providerDiagnostics";

function routeParam(req: Request, key: string) {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function queryString(req: Request, key: string) {
  const value = req.query[key];
  return Array.isArray(value) ? String(value[0] || "") : typeof value === "string" ? value : "";
}

function isStageId(value: string): value is VideosBatchStageId {
  return (VIDEOS_BATCH_STAGE_ORDER as readonly string[]).includes(value);
}

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
  attempt?: unknown;
  provider?: unknown;
};

export interface VideosBatchWorkflowApiOptions {
  /** Production callers must enforce the owning user before exposing a session. */
  authorizeSession?: (session: { ownerUserId?: string }, req: Request) => boolean;
}

type WorkflowFlight = { kind: string; promise: Promise<unknown> };
const workflowFlights = new Map<string, WorkflowFlight>();

function defaultAuthorizeSession(session: { ownerUserId?: string }) {
  // Legacy public sessions have no owner. Owned sessions require the host
  // application to inject its real user/admin authorization callback.
  return !session.ownerUserId;
}

function withWorkflowFlight<T>(sessionId: string, kind: string, operation: () => Promise<T>): Promise<T> {
  const existing = workflowFlights.get(sessionId);
  if (existing?.kind === kind) return existing.promise as Promise<T>;
  const waitFor = existing?.promise.catch(() => undefined) || Promise.resolve();
  const promise = waitFor.then(operation);
  workflowFlights.set(sessionId, { kind, promise });
  return promise.finally(() => {
    if (workflowFlights.get(sessionId)?.promise === promise) workflowFlights.delete(sessionId);
  });
}

/**
 * Flight key for a write whose outcome depends on the request body.
 *
 * `withWorkflowFlight` collapses concurrent calls that share a key into a single
 * execution. Keying only on route+stage silently dropped the second of two
 * concurrent saves carrying *different* artifacts — it resolved with the first
 * request's workflow while the user's second edit was never persisted
 * (2026-09-16). Folding in the body keeps genuine duplicates collapsed (the
 * useful case: a double click) while letting distinct writes both apply, still
 * serialized in arrival order.
 */
export function writeFlightKind(prefix: string, body: unknown) {
  return `${prefix}:${contentHash(body ?? null)}`;
}

function safeErrorMessage(value: unknown) {
  const raw = value instanceof Error ? value.message : String(value ?? "VideosBatch request failed");
  // Shared redaction set (tokens, inline data URLs, absolute URLs); collapse whitespace
  // here so the single-line response envelope stays stable.
  return sanitizeProviderDiagnosticText(raw, 0).replace(/\s+/gu, " ").trim().slice(0, 2_000);
}

function sendWorkflowError(
  res: Response,
  status: number,
  input: {
    code: string;
    message: string;
    retryable?: boolean;
    attempt?: number;
    provider?: string | null;
  }
) {
  return res.status(status).json({
    error: {
      code: input.code,
      message: safeErrorMessage(input.message),
      retryable: input.retryable === true,
      attempt: Number.isFinite(input.attempt) ? Math.max(0, Number(input.attempt)) : 0,
      provider: input.provider || null
    }
  });
}

function sendCaughtError(res: Response, status: number, error: unknown, fallbackCode = "VIDEOSBATCH_REQUEST_FAILED") {
  const value = (error && typeof error === "object" ? error : {}) as ErrorLike;
  return sendWorkflowError(res, status, {
    code: typeof value.code === "string" && value.code ? value.code : fallbackCode,
    message: safeErrorMessage(error),
    retryable: value.retryable === true,
    attempt: typeof value.attempt === "number" ? value.attempt : 0,
    provider: typeof value.provider === "string" ? value.provider : null
  });
}

function sanitizeLessonSource(value: unknown): VideosBatchLessonSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (source.kind !== "file" && source.kind !== "pasted_text") return undefined;
  if (source.kind === "pasted_text") return { kind: "pasted_text" };

  const fileType = source.fileType === "doc" || source.fileType === "docx" || source.fileType === "pdf"
    ? source.fileType
    : undefined;
  const fileName = typeof source.fileName === "string" ? source.fileName.trim() : "";
  const sizeBytes = typeof source.sizeBytes === "number" && Number.isFinite(source.sizeBytes) && source.sizeBytes > 0
    ? Math.floor(source.sizeBytes)
    : undefined;
  return {
    kind: "file",
    ...(fileName ? { fileName } : {}),
    ...(fileType ? { fileType } : {}),
    ...(sizeBytes ? { sizeBytes } : {})
  };
}

function workflowContext(store: CinemaStore, sessionId: string): StageExecutionContext | undefined {
  const session = store.getSession(sessionId);
  if (!session?.videosBatchWorkflow) return undefined;
  const snapshot = store.snapshot();
  const shotIds = new Set(session.shots.map((shot) => shot.id));
  const assets = snapshot.assets.filter((asset) => {
    if (asset.ownerSessionId === session.id) return true;
    if (asset.ownerShotId && shotIds.has(asset.ownerShotId)) return true;
    return session.shots.some((shot) => (shot.assetIds || []).includes(asset.id));
  });
  return {
    session,
    workflow: session.videosBatchWorkflow,
    assets,
    shots: session.shots,
    store,
    checkpoint: async (workflow) => {
      const saved = await store.checkpointWorkflow(sessionId, workflow);
      if (!saved) throw new Error("Workflow session disappeared during checkpoint");
    }
  };
}

async function persistWorkflow(store: CinemaStore, sessionId: string, workflow: NonNullable<ReturnType<typeof workflowContext>>["workflow"]) {
  const updated = await store.updateSession(sessionId, { videosBatchWorkflow: structuredClone(workflow) });
  return updated?.videosBatchWorkflow;
}

async function reconcilePersistedWorkflow(
  store: CinemaStore,
  sessionId: string,
  workflow: NonNullable<ReturnType<typeof workflowContext>>["workflow"]
) {
  const reconciled = reconcileVideosBatchReadiness(workflow);
  if (reconciled === workflow) return workflow;
  return (await persistWorkflow(store, sessionId, reconciled)) || reconciled;
}

async function reconciledWorkflowContext(store: CinemaStore, sessionId: string) {
  const initial = workflowContext(store, sessionId);
  if (!initial) return undefined;
  const workflow = await reconcilePersistedWorkflow(store, sessionId, initial.workflow);
  if (workflow === initial.workflow) return initial;
  const latest = workflowContext(store, sessionId);
  return latest || { ...initial, workflow, session: { ...initial.session, videosBatchWorkflow: workflow } };
}

function requireSession(store: CinemaStore, req: Request, res: Response, options: VideosBatchWorkflowApiOptions) {
  const session = store.getSession(routeParam(req, "sessionId"));
  const authorize = options.authorizeSession || defaultAuthorizeSession;
  let allowed = false;
  try {
    allowed = Boolean(session && authorize(session, req));
  } catch {
    allowed = false;
  }
  if (!session || !allowed) {
    sendWorkflowError(res, 404, { code: "SESSION_NOT_FOUND", message: "Session not found", retryable: false });
    return undefined;
  }
  return session;
}

function requireWorkflow(store: CinemaStore, req: Request, res: Response, options: VideosBatchWorkflowApiOptions) {
  const session = requireSession(store, req, res, options);
  if (!session) return undefined;
  if (!session.videosBatchWorkflow) {
    sendWorkflowError(res, 409, { code: "WORKFLOW_NOT_STARTED", message: "VideosBatch workflow has not been started", retryable: false });
    return undefined;
  }
  return session.videosBatchWorkflow;
}

export function registerVideosBatchWorkflowApi(
  app: Application,
  store: CinemaStore,
  registry: StageRegistry,
  options: VideosBatchWorkflowApiOptions = {}
) {
  const repository = new RunRepository(path.join(DATA_DIR, "production-runs"));
  const host = new WorkflowRunHost(store, registry, repository, id => reconciledWorkflowContext(store, id), withWorkflowFlight);
  const engine = new ProductionEngine(repository, host);
  const editing = new EditingService(engine);
  // Startup recovery precedes dispatch once. Live publishing owns its session
  // barrier; scanning it on every tick would make other projects wait on it.
  let recoveredEdits: Promise<void> | undefined;
  engine.beforeDispatch = () => recoveredEdits ||= editing.recover();
  app.get("/api/sessions/:sessionId/videosbatch/drafts", (req, res) => {
    const session = requireSession(store, req, res, options); if (!session) return;
    res.setHeader("Cache-Control", "no-store");
    res.json(repository.editing.drafts(session.id).filter(draft => draft.active && draft.ownerId === (session.ownerUserId || "legacy")));
  });
  app.put("/api/sessions/:sessionId/videosbatch/drafts/:draftId", (req, res) => {
    const session = requireSession(store, req, res, options); if (!session) return;
    const body = req.body || {};
    const validId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
    if (!validId(routeParam(req, "draftId")) || !validId(body.instanceId) || !editableStages.includes(body.stageId)
      || !Number.isSafeInteger(body.clientVersion) || body.clientVersion < 1 || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0
      || typeof body.baseSignature !== "string" || !Object.hasOwn(body, "value") || JSON.stringify(body).length > 500000) return res.status(400).json({ error: { message: "草稿格式不正确或内容过长" } });
    try { res.json(repository.editing.sync({ id: routeParam(req, "draftId"), sessionId: session.id, ownerId: session.ownerUserId || "legacy",
      stageId: body.stageId, instanceId: body.instanceId, clientVersion: body.clientVersion, baseRevision: body.baseRevision, baseSignature: body.baseSignature, value: body.value })); }
    catch (error) { sendCaughtError(res, (error as any).status || 409, error); }
  });
  app.post("/api/sessions/:sessionId/videosbatch/drafts/:draftId/release", (req, res) => {
    const session = requireSession(store, req, res, options); if (!session) return;
    const draft = repository.editing.draft(routeParam(req, "draftId"));
    if (!draft || draft.sessionId !== session.id || draft.ownerId !== (session.ownerUserId || "legacy")) return res.status(404).json({ error: { message: "草稿不存在" } });
    try { repository.editing.release(draft.id, req.body?.instanceId, req.body?.clientVersion, req.body?.discard === true); res.json({ released: true }); }
    catch (error) { sendCaughtError(res, (error as any).status || 409, error); }
  });
  app.post("/api/sessions/:sessionId/videosbatch/edits", async (req, res) => {
    const session = requireSession(store, req, res, options); if (!session) return;
    const body = req.body || {};
    if (!editableStages.includes(body.stageId) || typeof body.requestId !== "string" || body.requestId.length < 1 || body.requestId.length > 120
      || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || typeof body.continue !== "boolean"
      || body.artifact == null || (body.draftId && (typeof body.instanceId !== "string" || !Number.isSafeInteger(body.clientVersion)))) return res.status(400).json({ error: { message: "保存请求不完整" } });
    try { res.json(await editing.publish(session.id, session.ownerUserId || "legacy", body)); }
    catch (error) { sendCaughtError(res, (error as any).status || 400, error); }
  });
  registerRunEvents(app, store, engine, options.authorizeSession || defaultAuthorizeSession);
  app.get("/api/sessions/:sessionId/videosbatch/previews/:hash", (req, res) => {
    const session = requireSession(store, req, res, options); if (!session) return;
    const hash = routeParam(req, "hash");
    if (!repository.list(session.id).some(run => run.feedback?.previewRef === hash)) return res.status(404).json({ error: "预览已更新" });
    res.setHeader("Cache-Control", "no-store"); res.json(repository.journal.readResult(hash));
  });

  app.get("/api/sessions/:sessionId/videosbatch/view", (req, res) => {
    const session = requireSession(store, req, res, options); if (!session) return;
    const ctx = workflowContext(store, session.id);
    res.setHeader("Cache-Control", "no-store");
    res.json({ workflow: ctx?.workflow, shots: ctx?.shots || [], assets: ctx?.assets || [] });
  });

  app.get("/api/sessions/:sessionId/videosbatch/runs", async (req, res) => {
    const session = requireSession(store, req, res, options); if (!session) return;
    await engine.ready;
    res.json({ runs: repository.list(session.id) });
  });
  app.post("/api/sessions/:sessionId/videosbatch/runs", async (req, res) => {
    const session = requireSession(store, req, res, options); if (!session) return;
    if (!["next", "all"].includes(req.body?.mode) || typeof req.body?.requestId !== "string" || !/^[A-Za-z0-9_:-]{1,100}$/.test(req.body.requestId)) {
      return sendWorkflowError(res, 400, { code: "RUN_REQUEST_INVALID", message: "mode and requestId are required" });
    }
    try { res.status(202).json(await engine.start(session.id, req.body.mode, req.body.requestId)); }
    catch (error) { sendCaughtError(res, (error as any)?.status || 500, error, "RUN_START_FAILED"); }
  });
  app.post("/api/sessions/:sessionId/videosbatch/runs/:runId/control", async (req, res) => {
    const session = requireSession(store, req, res, options); if (!session) return;
    const run = repository.get(routeParam(req, "runId"));
    if (!run || run.sessionId !== session.id) return sendWorkflowError(res, 404, { code: "RUN_NOT_FOUND", message: "任务不存在" });
    const { action, requestId, priority = 0 } = req.body || {};
    if (!["pause", "resume", "stop", "priority"].includes(action) || typeof requestId !== "string" || !/^[A-Za-z0-9_:-]{1,100}$/.test(requestId)
      || !Number.isInteger(priority) || priority < 0 || priority > 2) return sendWorkflowError(res, 400, { code: "RUN_CONTROL_INVALID", message: "任务操作无效" });
    try { res.json(await engine.control(run.id, action, requestId, priority)); }
    catch (error) { sendCaughtError(res, (error as any)?.status || 500, error, "RUN_CONTROL_FAILED"); }
  });

  app.post(
    "/api/sessions/:sessionId/videosbatch/lesson/parse",
    express.raw({ type: () => true, limit: MAX_LESSON_FILE_BYTES }),
    async (req, res) => {
      const session = requireSession(store, req, res, options);
      if (!session) return;
      const fileName = queryString(req, "filename").trim();
      if (!fileName) return sendWorkflowError(res, 400, { code: "LESSON_FILENAME_REQUIRED", message: "filename is required" });
      if (!Buffer.isBuffer(req.body)) return sendWorkflowError(res, 400, { code: "LESSON_BYTES_REQUIRED", message: "lesson document body must be raw file bytes" });
      try {
        const parsed = await parseLessonDocument({
          fileName,
          mimeType: req.header("content-type") || "application/octet-stream",
          buffer: req.body
        });
        res.json(parsed);
      } catch (error) {
        sendCaughtError(res, 400, error, "LESSON_PARSE_FAILED");
      }
    }
  );

  app.post("/api/sessions/:sessionId/videosbatch/start", async (req, res) => {
    const session = requireSession(store, req, res, options);
    if (!session) return;
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
    const lessonText = typeof req.body?.lessonText === "string" ? req.body.lessonText : "";
    const source = sanitizeLessonSource(req.body?.source);
    try {
      const workflow = await withWorkflowFlight(session.id, writeFlightKind("start", { projectId, lessonText, source }), async () => {
        const latest = store.getSession(session.id);
        if (!latest) throw Object.assign(new Error("Session not found"), { code: "SESSION_NOT_FOUND", retryable: false, status: 404 });
        const next = createVideosBatchWorkflow({ projectId, lessonText, source });
        next.productionIntentId = crypto.randomUUID();
        await persistWorkflow(store, session.id, next);
        engine.retireForNewIntent(session.id);
        return next;
      });
      res.json(workflow);
    } catch (error) {
      const status = typeof (error as any)?.status === "number" ? (error as any).status : 400;
      sendCaughtError(res, status, error, "WORKFLOW_START_INVALID");
    }
  });

  app.get("/api/sessions/:sessionId/videosbatch", async (req, res) => {
    const session = requireSession(store, req, res, options);
    if (!session) return;
    if (!session.videosBatchWorkflow) {
      sendWorkflowError(res, 409, { code: "WORKFLOW_NOT_STARTED", message: "VideosBatch workflow has not been started", retryable: false });
      return;
    }
    try {
      const workflow = await reconcilePersistedWorkflow(store, session.id, session.videosBatchWorkflow);
      res.json(workflow);
    } catch (error) {
      sendCaughtError(res, 500, error, "WORKFLOW_READINESS_RECONCILE_FAILED");
    }
  });

  for (const mode of ["next", "all"] as const) {
    app.post(`/api/sessions/:sessionId/videosbatch/run-${mode}`, async (req, res) => {
      const session = requireSession(store, req, res, options); if (!session) return;
      if (!session.videosBatchWorkflow) return sendWorkflowError(res, 409, { code: "WORKFLOW_NOT_STARTED", message: "VideosBatch workflow has not been started" });
      try {
        const key = `compat:${mode}:${workflowVersion(session.videosBatchWorkflow)}`;
        const run = await engine.start(session.id, mode, key);
        await engine.wait(run.id);
        res.json(store.getSession(session.id)?.videosBatchWorkflow);
      } catch (error) { sendCaughtError(res, (error as any)?.status || 500, error); }
    });
  }

  app.put("/api/sessions/:sessionId/videosbatch/stages/:stageId/artifact", async (req, res) => {
    const workflow = requireWorkflow(store, req, res, options);
    if (!workflow) return;
    const stageId = routeParam(req, "stageId");
    const sessionId = routeParam(req, "sessionId");
    if (!isStageId(stageId)) return sendWorkflowError(res, 400, { code: "UNKNOWN_STAGE", message: "Unknown VideosBatch stage" });
    // `null` is not an artifact. A stage with no registered validator (LESSON_INPUT
    // is in no registry) would otherwise accept it, be marked READY and let the
    // cursor advance on an empty lesson (2026-09-16).
    if (!Object.hasOwn(req.body || {}, "artifact") || req.body.artifact === null) {
      return sendWorkflowError(res, 400, { code: "ARTIFACT_REQUIRED", message: "artifact is required" });
    }
    try {
      const next = await withWorkflowFlight(sessionId, writeFlightKind(`artifact:${stageId}`, req.body), async () => {
        const latestSession = store.getSession(sessionId);
        const latestWorkflow = latestSession?.videosBatchWorkflow
          ? await reconcilePersistedWorkflow(store, sessionId, latestSession.videosBatchWorkflow)
          : undefined;
        if (!latestSession || !latestWorkflow) throw Object.assign(new Error("VideosBatch workflow has not been started"), { code: "WORKFLOW_NOT_STARTED", retryable: false, status: 409 });
        const latestCtx = workflowContext(store, sessionId);
        if (!latestCtx) throw Object.assign(new Error("VideosBatch workflow has not been started"), { code: "WORKFLOW_NOT_STARTED", retryable: false, status: 409 });
        if (req.body.expectedRevision !== undefined && req.body.expectedRevision !== latestWorkflow.stages[stageId]?.revision) {
          throw Object.assign(new Error("服务器内容已有更新，草稿未覆盖新版。请刷新并核对修改。"), { code: "ARTIFACT_REVISION_CONFLICT", retryable: false, status: 409 });
        }
        const updated = replaceStageArtifact(latestWorkflow, stageId, req.body.artifact, undefined, registry, latestCtx);
        const definition = registry[stageId];
        if (stageId === "FINAL_STORYBOARD" && definition?.project) {
          // Persist the user's canonical edit before touching native projections.
          // A projection failure must never erase the text that was just saved.
          await persistWorkflow(store, sessionId, updated);
          try {
            const projectionBase = workflowContext(store, sessionId);
            if (!projectionBase) throw new Error("VideosBatch workflow disappeared while projecting FINAL_STORYBOARD");
            await definition.project(updated.stages[stageId]?.artifact, {
              ...projectionBase,
              workflow: updated,
              session: { ...projectionBase.session, videosBatchWorkflow: updated }
            });
            const finalState = updated.stages[stageId];
            if (finalState?.artifact !== undefined) finalState.contentHash = contentHash(finalState.artifact);
            await persistWorkflow(store, sessionId, updated);
          } catch (error) {
            throw Object.assign(
              error instanceof Error ? error : new Error(String(error)),
              { code: "FINAL_STORYBOARD_PROJECTION_FAILED", retryable: true, status: 500 }
            );
          }
        } else {
          await persistWorkflow(store, sessionId, updated);
        }
        return updated;
      });
      res.json(next);
    } catch (error) {
      const status = typeof (error as any)?.status === "number" ? (error as any).status : 400;
      sendCaughtError(res, status, error, "ARTIFACT_INVALID");
    }
  });

  app.post("/api/sessions/:sessionId/videosbatch/restart-from/:stageId", async (req, res) => {
    const workflow = requireWorkflow(store, req, res, options);
    if (!workflow) return;
    const stageId = routeParam(req, "stageId");
    const sessionId = routeParam(req, "sessionId");
    if (!isStageId(stageId)) return sendWorkflowError(res, 400, { code: "UNKNOWN_STAGE", message: "Unknown VideosBatch stage" });

    try {
      const next = await withWorkflowFlight(sessionId, `restart:${stageId}`, async () => {
        const latest = store.getSession(sessionId);
        if (!latest?.videosBatchWorkflow) throw Object.assign(new Error("VideosBatch workflow has not been started"), { code: "WORKFLOW_NOT_STARTED", retryable: false, status: 409 });
        const restarted = restartFrom(latest.videosBatchWorkflow, stageId);
        restarted.productionIntentId = crypto.randomUUID();
        await persistWorkflow(store, sessionId, restarted);
        engine.retireForNewIntent(sessionId);
        return restarted;
      });
      res.json(next);
    } catch (error) {
      const status = typeof (error as any)?.status === "number" ? (error as any).status : 400;
      sendCaughtError(res, status, error, "RESTART_INVALID");
    }
  });

  app.post("/api/sessions/:sessionId/videosbatch/retry/:stageId", async (req, res) => {
    const sessionId = routeParam(req, "sessionId");
    const session = requireSession(store, req, res, options);
    if (!session) return;
    const workflow = session.videosBatchWorkflow
      ? await reconcilePersistedWorkflow(store, sessionId, session.videosBatchWorkflow)
      : undefined;
    if (!workflow) return sendWorkflowError(res, 409, { code: "WORKFLOW_NOT_STARTED", message: "VideosBatch workflow has not been started" });
    const stageId = routeParam(req, "stageId");
    if (!isStageId(stageId)) return sendWorkflowError(res, 400, { code: "UNKNOWN_STAGE", message: "Unknown VideosBatch stage" });
    if (stageId === "LESSON_INPUT" || stageId === "COURSE_INTRO_SELECTION" || stageId === "ASSET_CONFIRMATION") {
      return sendWorkflowError(res, 409, { code: "STAGE_RETRY_NOT_ALLOWED", message: `${stageId} is a manual or source gate and cannot use provider retry`, retryable: false });
    }
    const stage = workflow.stages[stageId];
    if (!stage) return sendWorkflowError(res, 409, { code: "STAGE_NOT_INITIALIZED", message: `${stageId} is not initialized` });
    if (stage.status !== "failed") return sendWorkflowError(res, 409, { code: "STAGE_NOT_FAILED", message: `${stageId} is not currently failed` });
    if (stage.errorInfo?.retryable === false) return sendWorkflowError(res, 409, { code: "STAGE_RETRY_NOT_ALLOWED", message: `${stageId} failure is not retryable` });

    const lineageIssues = retryLineageIssues(workflow, stageId, {
      sourceRevision: req.body?.sourceRevision,
      sourceHash: req.body?.sourceHash,
      sourceHashes: req.body?.sourceHashes
    });
    if (lineageIssues.length) {
      return sendWorkflowError(res, 409, {
        code: "RETRY_LINEAGE_CONFLICT",
        message: lineageIssues.join("\n"),
        retryable: false,
        attempt: stage.errorInfo?.attempt || stage.attempts || 0,
        provider: stage.errorInfo?.provider || stage.provider || null
      });
    }

    try {
      const next = await withWorkflowFlight(sessionId, writeFlightKind(`retry:${stageId}`, req.body ?? null), async () => {
        const latestSession = store.getSession(sessionId);
        const latestWorkflow = latestSession?.videosBatchWorkflow
          ? await reconcilePersistedWorkflow(store, sessionId, latestSession.videosBatchWorkflow)
          : undefined;
        if (!latestSession || !latestWorkflow) throw Object.assign(new Error("VideosBatch workflow has not been started"), { code: "WORKFLOW_NOT_STARTED", retryable: false, status: 409 });
        const latestLineageIssues = retryLineageIssues(latestWorkflow, stageId, {
          sourceRevision: req.body?.sourceRevision,
          sourceHash: req.body?.sourceHash,
          sourceHashes: req.body?.sourceHashes
        });
        if (latestLineageIssues.length) throw Object.assign(new Error(latestLineageIssues.join("\n")), { code: "RETRY_LINEAGE_CONFLICT", retryable: false, status: 409 });
        const latestCtx = workflowContext(store, sessionId);
        if (!latestCtx) throw Object.assign(new Error("VideosBatch workflow has not been started"), { code: "WORKFLOW_NOT_STARTED", retryable: false, status: 409 });
        // An explicit retry is a new user operation: restartFrom preserves the
        // failed artifact and runNext creates fresh bounded budgets.
        const restarted = restartFrom(latestWorkflow, stageId);
        restarted.productionIntentId = crypto.randomUUID();
        const retryCtx: StageExecutionContext = {
          ...latestCtx,
          workflow: restarted,
          session: { ...latestCtx.session, videosBatchWorkflow: restarted }
        };
        await persistWorkflow(store, sessionId, retryCtx.workflow);
        engine.retireForNewIntent(sessionId);
        return retryCtx.workflow;
      });
      const run = await engine.start(sessionId, "next", `retry:${crypto.randomUUID()}`);
      await engine.wait(run.id);
      res.json(store.getSession(sessionId)?.videosBatchWorkflow || next);
    } catch (error) {
      const status = typeof (error as any)?.status === "number" ? (error as any).status : 500;
      sendCaughtError(res, status, error, "STAGE_RETRY_FAILED");
    }
  });
  return engine;
}
