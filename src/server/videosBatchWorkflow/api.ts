import express, { type Application, type Request, type Response } from "express";
import {
  createVideosBatchWorkflow,
  VIDEOS_BATCH_STAGE_ORDER,
  type VideosBatchLessonSource,
  type VideosBatchStageId
} from "../../shared/videosBatchWorkflow";
import type { CinemaStore } from "../store";
import { MAX_LESSON_FILE_BYTES, parseLessonDocument } from "./lessonDocumentParser";
import type { StageExecutionContext, StageRegistry } from "./stageContracts";
import { replaceStageArtifact, restartFrom, retryLineageIssues, runAll, runNext } from "./runner";
import { contentHash } from "./canonicalStoryboard";

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

function safeErrorMessage(value: unknown) {
  const raw = value instanceof Error ? value.message : String(value ?? "VideosBatch request failed");
  return raw
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*[^,\s}]+/giu, "$1=[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
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
    store
  };
}

async function persistWorkflow(store: CinemaStore, sessionId: string, workflow: NonNullable<ReturnType<typeof workflowContext>>["workflow"]) {
  const updated = await store.updateSession(sessionId, { videosBatchWorkflow: workflow });
  return updated?.videosBatchWorkflow;
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
      const workflow = await withWorkflowFlight(session.id, "start", async () => {
        const latest = store.getSession(session.id);
        if (!latest) throw Object.assign(new Error("Session not found"), { code: "SESSION_NOT_FOUND", retryable: false, status: 404 });
        const next = createVideosBatchWorkflow({ projectId, lessonText, source });
        await persistWorkflow(store, session.id, next);
        return next;
      });
      res.json(workflow);
    } catch (error) {
      const status = typeof (error as any)?.status === "number" ? (error as any).status : 400;
      sendCaughtError(res, status, error, "WORKFLOW_START_INVALID");
    }
  });

  app.get("/api/sessions/:sessionId/videosbatch", (req, res) => {
    const workflow = requireWorkflow(store, req, res, options);
    if (!workflow) return;
    res.json(workflow);
  });

  app.post("/api/sessions/:sessionId/videosbatch/run-next", async (req, res) => {
    const sessionId = routeParam(req, "sessionId");
    if (!requireSession(store, req, res, options)) return;
    try {
      const workflow = await withWorkflowFlight(sessionId, "run-next", async () => {
        const ctx = workflowContext(store, sessionId);
        if (!ctx) {
          if (!store.getSession(sessionId)) throw Object.assign(new Error("Session not found"), { code: "SESSION_NOT_FOUND", retryable: false, status: 404 });
          throw Object.assign(new Error("VideosBatch workflow has not been started"), { code: "WORKFLOW_NOT_STARTED", retryable: false, status: 409 });
        }
        const next = await runNext(ctx, registry);
        await persistWorkflow(store, sessionId, next);
        return next;
      });
      res.json(workflow);
    } catch (error) {
      const status = typeof (error as any)?.status === "number" ? (error as any).status : 500;
      sendCaughtError(res, status, error);
    }
  });

  app.post("/api/sessions/:sessionId/videosbatch/run-all", async (req, res) => {
    const sessionId = routeParam(req, "sessionId");
    if (!requireSession(store, req, res, options)) return;
    try {
      const workflow = await withWorkflowFlight(sessionId, "run-all", async () => {
        const ctx = workflowContext(store, sessionId);
        if (!ctx) {
          if (!store.getSession(sessionId)) throw Object.assign(new Error("Session not found"), { code: "SESSION_NOT_FOUND", retryable: false, status: 404 });
          throw Object.assign(new Error("VideosBatch workflow has not been started"), { code: "WORKFLOW_NOT_STARTED", retryable: false, status: 409 });
        }
        const next = await runAll(ctx, registry);
        await persistWorkflow(store, sessionId, next);
        return next;
      });
      res.json(workflow);
    } catch (error) {
      const status = typeof (error as any)?.status === "number" ? (error as any).status : 500;
      sendCaughtError(res, status, error);
    }
  });

  app.put("/api/sessions/:sessionId/videosbatch/stages/:stageId/artifact", async (req, res) => {
    const workflow = requireWorkflow(store, req, res, options);
    if (!workflow) return;
    const stageId = routeParam(req, "stageId");
    const sessionId = routeParam(req, "sessionId");
    if (!isStageId(stageId)) return sendWorkflowError(res, 400, { code: "UNKNOWN_STAGE", message: "Unknown VideosBatch stage" });
    if (!Object.hasOwn(req.body || {}, "artifact")) return sendWorkflowError(res, 400, { code: "ARTIFACT_REQUIRED", message: "artifact is required" });
    try {
      const next = await withWorkflowFlight(sessionId, `artifact:${stageId}`, async () => {
        const latestSession = store.getSession(sessionId);
        const latestWorkflow = latestSession?.videosBatchWorkflow;
        if (!latestSession || !latestWorkflow) throw Object.assign(new Error("VideosBatch workflow has not been started"), { code: "WORKFLOW_NOT_STARTED", retryable: false, status: 409 });
        const latestCtx = workflowContext(store, sessionId);
        if (!latestCtx) throw Object.assign(new Error("VideosBatch workflow has not been started"), { code: "WORKFLOW_NOT_STARTED", retryable: false, status: 409 });
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
        await persistWorkflow(store, sessionId, restarted);
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
    const workflow = session.videosBatchWorkflow;
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
      const next = await withWorkflowFlight(sessionId, `retry:${stageId}`, async () => {
        const latestSession = store.getSession(sessionId);
        const latestWorkflow = latestSession?.videosBatchWorkflow;
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
        const retryCtx: StageExecutionContext = {
          ...latestCtx,
          workflow: restarted,
          session: { ...latestCtx.session, videosBatchWorkflow: restarted }
        };
        const result = await runNext(retryCtx, registry);
        await persistWorkflow(store, sessionId, result);
        return result;
      });
      res.json(next);
    } catch (error) {
      const status = typeof (error as any)?.status === "number" ? (error as any).status : 500;
      sendCaughtError(res, status, error, "STAGE_RETRY_FAILED");
    }
  });
}
