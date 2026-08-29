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
import { replaceStageArtifact, restartFrom, runAll, runNext } from "./runner";

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

function requireSession(store: CinemaStore, req: Request, res: Response) {
  const session = store.getSession(routeParam(req, "sessionId"));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return undefined;
  }
  return session;
}

function requireWorkflow(store: CinemaStore, req: Request, res: Response) {
  const session = requireSession(store, req, res);
  if (!session) return undefined;
  if (!session.videosBatchWorkflow) {
    res.status(409).json({ error: "VideosBatch workflow has not been started" });
    return undefined;
  }
  return session.videosBatchWorkflow;
}

export function registerVideosBatchWorkflowApi(
  app: Application,
  store: CinemaStore,
  registry: StageRegistry
) {
  app.post(
    "/api/sessions/:sessionId/videosbatch/lesson/parse",
    express.raw({ type: () => true, limit: MAX_LESSON_FILE_BYTES }),
    async (req, res) => {
      const session = requireSession(store, req, res);
      if (!session) return;
      const fileName = queryString(req, "filename").trim();
      if (!fileName) return res.status(400).json({ error: "filename is required" });
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "lesson document body must be raw file bytes" });
      try {
        const parsed = await parseLessonDocument({
          fileName,
          mimeType: req.header("content-type") || "application/octet-stream",
          buffer: req.body
        });
        res.json(parsed);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Lesson document parsing failed" });
      }
    }
  );

  app.post("/api/sessions/:sessionId/videosbatch/start", async (req, res) => {
    const session = requireSession(store, req, res);
    if (!session) return;
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
    const lessonText = typeof req.body?.lessonText === "string" ? req.body.lessonText : "";
    const source = sanitizeLessonSource(req.body?.source);
    try {
      const workflow = createVideosBatchWorkflow({ projectId, lessonText, source });
      await persistWorkflow(store, session.id, workflow);
      res.json(workflow);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid VideosBatch start payload" });
    }
  });

  app.get("/api/sessions/:sessionId/videosbatch", (req, res) => {
    const workflow = requireWorkflow(store, req, res);
    if (!workflow) return;
    res.json(workflow);
  });

  app.post("/api/sessions/:sessionId/videosbatch/run-next", async (req, res) => {
    const sessionId = routeParam(req, "sessionId");
    const ctx = workflowContext(store, sessionId);
    if (!ctx) {
      if (!store.getSession(sessionId)) return res.status(404).json({ error: "Session not found" });
      return res.status(409).json({ error: "VideosBatch workflow has not been started" });
    }
    const workflow = await runNext(ctx, registry);
    await persistWorkflow(store, sessionId, workflow);
    res.json(workflow);
  });

  app.post("/api/sessions/:sessionId/videosbatch/run-all", async (req, res) => {
    const sessionId = routeParam(req, "sessionId");
    const ctx = workflowContext(store, sessionId);
    if (!ctx) {
      if (!store.getSession(sessionId)) return res.status(404).json({ error: "Session not found" });
      return res.status(409).json({ error: "VideosBatch workflow has not been started" });
    }
    const workflow = await runAll(ctx, registry);
    await persistWorkflow(store, sessionId, workflow);
    res.json(workflow);
  });

  app.put("/api/sessions/:sessionId/videosbatch/stages/:stageId/artifact", async (req, res) => {
    const workflow = requireWorkflow(store, req, res);
    if (!workflow) return;
    const stageId = routeParam(req, "stageId");
    const sessionId = routeParam(req, "sessionId");
    if (!isStageId(stageId)) return res.status(400).json({ error: "Unknown VideosBatch stage" });
    if (!Object.hasOwn(req.body || {}, "artifact")) return res.status(400).json({ error: "artifact is required" });

    const next = replaceStageArtifact(workflow, stageId, req.body.artifact);
    await persistWorkflow(store, sessionId, next);
    res.json(next);
  });

  app.post("/api/sessions/:sessionId/videosbatch/restart-from/:stageId", async (req, res) => {
    const workflow = requireWorkflow(store, req, res);
    if (!workflow) return;
    const stageId = routeParam(req, "stageId");
    const sessionId = routeParam(req, "sessionId");
    if (!isStageId(stageId)) return res.status(400).json({ error: "Unknown VideosBatch stage" });

    const next = restartFrom(workflow, stageId);
    await persistWorkflow(store, sessionId, next);
    res.json(next);
  });
}
