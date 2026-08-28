import type { Application, Request, Response } from "express";
import { createVideosBatchWorkflow, VIDEOS_BATCH_STAGE_ORDER, type VideosBatchStageId } from "../../shared/videosBatchWorkflow";
import type { CinemaStore } from "../store";
import type { StageExecutionContext, StageRegistry } from "./stageContracts";
import { replaceStageArtifact, restartFrom, runAll, runNext } from "./runner";

function isStageId(value: string): value is VideosBatchStageId {
  return (VIDEOS_BATCH_STAGE_ORDER as readonly string[]).includes(value);
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
    shots: session.shots
  };
}

async function persistWorkflow(store: CinemaStore, sessionId: string, workflow: NonNullable<ReturnType<typeof workflowContext>>["workflow"]) {
  const updated = await store.updateSession(sessionId, { videosBatchWorkflow: workflow });
  return updated?.videosBatchWorkflow;
}

function requireSession(store: CinemaStore, req: Request, res: Response) {
  const session = store.getSession(req.params.sessionId);
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
  app.post("/api/sessions/:sessionId/videosbatch/start", async (req, res) => {
    const session = requireSession(store, req, res);
    if (!session) return;
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
    const lessonText = typeof req.body?.lessonText === "string" ? req.body.lessonText : "";
    try {
      const workflow = createVideosBatchWorkflow({ projectId, lessonText });
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
    const ctx = workflowContext(store, req.params.sessionId);
    if (!ctx) {
      if (!store.getSession(req.params.sessionId)) return res.status(404).json({ error: "Session not found" });
      return res.status(409).json({ error: "VideosBatch workflow has not been started" });
    }
    const workflow = await runNext(ctx, registry);
    await persistWorkflow(store, req.params.sessionId, workflow);
    res.json(workflow);
  });

  app.post("/api/sessions/:sessionId/videosbatch/run-all", async (req, res) => {
    const ctx = workflowContext(store, req.params.sessionId);
    if (!ctx) {
      if (!store.getSession(req.params.sessionId)) return res.status(404).json({ error: "Session not found" });
      return res.status(409).json({ error: "VideosBatch workflow has not been started" });
    }
    const workflow = await runAll(ctx, registry);
    await persistWorkflow(store, req.params.sessionId, workflow);
    res.json(workflow);
  });

  app.put("/api/sessions/:sessionId/videosbatch/stages/:stageId/artifact", async (req, res) => {
    const workflow = requireWorkflow(store, req, res);
    if (!workflow) return;
    if (!isStageId(req.params.stageId)) return res.status(400).json({ error: "Unknown VideosBatch stage" });
    if (!Object.hasOwn(req.body || {}, "artifact")) return res.status(400).json({ error: "artifact is required" });

    const next = replaceStageArtifact(workflow, req.params.stageId, req.body.artifact);
    await persistWorkflow(store, req.params.sessionId, next);
    res.json(next);
  });

  app.post("/api/sessions/:sessionId/videosbatch/restart-from/:stageId", async (req, res) => {
    const workflow = requireWorkflow(store, req, res);
    if (!workflow) return;
    if (!isStageId(req.params.stageId)) return res.status(400).json({ error: "Unknown VideosBatch stage" });

    const next = restartFrom(workflow, req.params.stageId);
    await persistWorkflow(store, req.params.sessionId, next);
    res.json(next);
  });
}
