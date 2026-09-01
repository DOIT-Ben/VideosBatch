import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-native-resilience-"));
process.chdir(tmp);

try {
  const [{ CinemaStore }, workflowModule, runnerModule, mediaModule, projection, canonicalModule] = await Promise.all([
    import("../src/server/store"),
    import("../src/shared/videosBatchWorkflow"),
    import("../src/server/videosBatchWorkflow/runner"),
    import("../src/server/videosBatchWorkflow/nativeMediaStages"),
    import("../src/server/videosBatchWorkflow/nativeProjection"),
    import("../src/server/videosBatchWorkflow/canonicalStoryboard")
  ]);

  const store = new CinemaStore();
  await store.load();

  const hash = (value: unknown) => canonicalModule.contentHash(value);
  const ready = (artifact: unknown, revision = 1) => ({
    status: "ready" as const,
    revision,
    artifact,
    contentHash: hash(artifact),
    updatedAt: new Date().toISOString()
  });
  const context = (sessionId: string, workflow: any) => {
    const session = store.getSession(sessionId);
    if (!session) throw new Error(`Missing smoke session ${sessionId}`);
    return {
      session,
      workflow,
      assets: store.snapshot().assets,
      shots: session.shots,
      store
    };
  };

  const assetPlan = {
    schemaVersion: "1",
    title: "媒体韧性资产计划",
    kind: "VIDEO_ASSET_PLAN",
    items: [
      {
        assetKey: "CHARACTER-HERO",
        category: "CHARACTER",
        name: "小宇",
        prompt: "角色设定图",
        required: true
      },
      {
        assetKey: "SCENE-CLASSROOM",
        category: "SCENE",
        name: "教室",
        prompt: "教室空镜",
        required: true
      }
    ]
  };

  // A required image fails once. The successful sibling must remain usable and
  // the retry must call the provider only for the failed item.
  const assetSession = await store.createSession({
    title: "VideosBatch native media resilience assets",
    logline: "asset isolation",
    style: "test",
    targetDurationSec: 20,
    shotCount: 0
  });
  let assetWorkflow = workflowModule.createVideosBatchWorkflow({ projectId: "P001", lessonText: "完整教案" });
  assetWorkflow.stages.ASSET_PLAN = ready(assetPlan);
  assetWorkflow.currentStage = "ASSET_CANDIDATES";
  const assetCalls: string[] = [];
  let failHero = true;
  const assetRegistry = mediaModule.createVideosBatchNativeMediaStageRegistry({
    defaultAssetImageModel: () => "seedream-4-5",
    generateAssetImage: async (asset: any, model: any) => {
      const key = String(asset.workflowReferenceId || asset.id);
      assetCalls.push(key);
      if (key === "P001-A001" && failHero) {
        failHero = false;
        throw Object.assign(new Error("temporary image provider timeout"), {
          code: "IMAGE_PROVIDER_TIMEOUT",
          retryable: true,
          provider: "injected-image"
        });
      }
      return {
        url: `https://mock.invalid/images/${key}.png`,
        composedPrompt: asset.prompt,
        model,
        credentialSource: "standard" as const
      };
    },
    cacheGeneratedImage: async (url: string) => ({ imageUrl: url }),
    generateShotVideo: async () => "https://mock.invalid/video-unused.mp4",
    cacheGeneratedVideo: async (url: string) => ({ videoUrl: url, remoteVideoUrl: url }),
    probeVideoDuration: async () => 10,
    stitchShotVideos: async () => ({ finalVideoUrl: "/media/unused.mp4", signature: "unused" })
  });

  const firstAssetRun = await runnerModule.runNext(context(assetSession.id, assetWorkflow), assetRegistry);
  const firstAssetArtifact = firstAssetRun.stages.ASSET_CANDIDATES?.artifact as any;
  assert.equal(firstAssetRun.stages.ASSET_CANDIDATES?.status, "failed", "required media failure must expose a retryable failed stage");
  assert.equal(firstAssetArtifact.status, "PARTIAL");
  assert.equal(firstAssetArtifact.items.find((item: any) => item.assetKey === "CHARACTER-HERO")?.status, "failed");
  assert.equal(firstAssetArtifact.items.find((item: any) => item.assetKey === "SCENE-CLASSROOM")?.status, "ready");
  assert.equal(firstAssetArtifact.failedItems.length, 1);
  assert.equal(firstAssetRun.stages.ASSET_CANDIDATES?.errorInfo?.retryable, true);

  const assetRetry = runnerModule.restartFrom(firstAssetRun, "ASSET_CANDIDATES");
  const secondAssetRun = await runnerModule.runNext(context(assetSession.id, assetRetry), assetRegistry);
  const secondAssetArtifact = secondAssetRun.stages.ASSET_CANDIDATES?.artifact as any;
  assert.equal(secondAssetRun.stages.ASSET_CANDIDATES?.status, "ready");
  assert.equal(secondAssetArtifact.status, "READY");
  assert.deepEqual(assetCalls, ["P001-A001", "P001-A002", "P001-A001"], "asset retry must reuse the successful sibling");
  assert.equal(secondAssetArtifact.failedItems.length, 0);

  const confirmation = {
    confirmed: true,
    items: secondAssetArtifact.items.map((item: any) => ({
      assetKey: item.assetKey,
      publicAssetId: item.publicAssetId,
      candidateAssetIds: item.candidateAssetIds,
      selectedAssetId: item.candidateAssetIds[0]
    }))
  };
  const confirmedWorkflow = runnerModule.replaceStageArtifact(
    secondAssetRun,
    "ASSET_CONFIRMATION",
    confirmation,
    undefined,
    assetRegistry,
    context(assetSession.id, secondAssetRun)
  );
  assert.equal(confirmedWorkflow.stages.ASSET_CONFIRMATION?.status, "ready");

  const storyboard = {
    schemaVersion: "2",
    title: "最终分镜",
    kind: "VIDEO_STORYBOARD",
    goal: "连续呈现观察冲突并留下悬问",
    overallScript: "从异常发现推进到待解决问题。",
    visualContinuity: "人物与教室空间保持连续。",
    targetDuration: 20,
    aspectRatio: "16:9",
    deliveryMode: "SEGMENTED_MP4",
    format: "FINAL_10_SECOND",
    storyType: "STORY",
    segments: [1, 2].map((sequence) => ({
      sequence,
      chapter: sequence === 1 ? "第1章" : undefined,
      scene: sequence === 1 ? "小宇在教室发现观察冲突" : "小宇继续在教室追问线索",
      characters: "【人物：小宇】",
      keyProps: "【道具：观察尺】",
      references: [{ label: "【人物：小宇】" }, { label: "【场景：教室】" }],
      screenplaySceneSequence: 1,
      evidence: [],
      duration: 10,
      visualEffects: [
        { sequence: 1, timeRange: "0-2秒", duration: 2, visual: "【人物：小宇】突然发现异常", action: "角色停下观察", camera: "固定中景", sound: "环境声", voice: "为什么会这样？" },
        { sequence: 2, timeRange: "2-6秒", duration: 4, visual: "【道具：观察尺】呈现测量细节", action: "角色比较并记录", camera: "缓慢推近", sound: "轻响", voice: "无" },
        { sequence: 3, timeRange: "6-10秒", duration: 4, visual: "【场景：教室】回到空间全景", action: "角色留下悬问", camera: "稳定跟随", sound: "提示音", voice: "怎样才能判断？" }
      ]
    }))
  };

  async function prepareExecutionSession() {
    const created = await store.createSession({
      title: "VideosBatch native media resilience execution",
      logline: "shot isolation",
      style: "test",
      targetDurationSec: 20,
      shotCount: 0
    });
    const candidates = await projection.projectAssetCandidatesIntoSeeReel(store, created.id, "P001", assetPlan);
    for (const item of candidates.items) {
      const native = store.snapshot().assets.find((asset: any) => asset.id === item.candidateAssetIds[0]);
      assert.ok(native);
      await store.upsertAsset({
        id: native!.id,
        mediaKind: "image",
        imageUrl: `https://mock.invalid/assets/${item.publicAssetId}.png`,
        mediaUrl: `https://mock.invalid/assets/${item.publicAssetId}.png`,
        sourceImageUrl: `https://mock.invalid/assets/${item.publicAssetId}.png`
      });
    }
    await projection.projectFinalStoryboardIntoSeeReel(store, created.id, storyboard);
    const candidateArtifact = {
      schemaVersion: "1",
      status: "READY",
      items: candidates.items.map((item: any) => ({ ...item, required: true, status: "ready", attempt: 1 })),
      failedItems: [],
      sourceStageId: "ASSET_PLAN",
      sourceRevision: 1,
      sourceHash: hash(assetPlan)
    };
    const confirmationArtifact = {
      confirmed: true,
      items: candidates.items.map((item: any) => ({
        assetKey: item.assetKey,
        publicAssetId: item.publicAssetId,
        candidateAssetIds: item.candidateAssetIds,
        selectedAssetId: item.candidateAssetIds[0]
      }))
    };
    const workflow = workflowModule.createVideosBatchWorkflow({ projectId: "P001", lessonText: "完整教案" });
    workflow.stages.ASSET_PLAN = ready(assetPlan);
    workflow.stages.ASSET_CANDIDATES = ready(candidateArtifact);
    workflow.stages.ASSET_CONFIRMATION = ready(confirmationArtifact);
    workflow.stages.FINAL_STORYBOARD = ready(storyboard);
    workflow.stages.QUOTE = ready({
      quoteId: `quote_${created.id}`,
      sourceStageRevision: 1,
      sourceHash: hash(storyboard),
      targetDurationSeconds: 20,
      assetOrder: candidates.items.map((item: any) => item.publicAssetId),
      current: true
    });
    workflow.currentStage = "EXECUTION";
    return { sessionId: created.id, workflow };
  }

  const executionFixture = await prepareExecutionSession();
  const initialShots = store.getSession(executionFixture.sessionId)!.shots;
  const failedShotId = initialShots[0].id;
  let failShotOnce = true;
  const executionCalls: Array<{ shotId: string; taskId: string }> = [];
  const executionRegistry = mediaModule.createVideosBatchNativeMediaStageRegistry({
    defaultAssetImageModel: () => "seedream-4-5",
    generateAssetImage: async () => ({ url: "https://mock.invalid/unused.png", model: "seedream-4-5" as const }),
    cacheGeneratedImage: async (url: string) => ({ imageUrl: url }),
    generateShotVideo: async (shot: any) => {
      executionCalls.push({ shotId: shot.id, taskId: String(shot.generationTaskId || "") });
      if (shot.id === failedShotId && failShotOnce) {
        failShotOnce = false;
        throw Object.assign(new Error("temporary video provider timeout"), {
          code: "VIDEO_PROVIDER_TIMEOUT",
          retryable: true,
          provider: "injected-video"
        });
      }
      return `https://mock.invalid/videos/${shot.id}-${executionCalls.length}.mp4`;
    },
    cacheGeneratedVideo: async (url: string) => ({ videoUrl: url, remoteVideoUrl: url }),
    probeVideoDuration: async () => 10,
    stitchShotVideos: async () => ({ finalVideoUrl: "/media/unused.mp4", signature: "unused" })
  });

  const firstExecutionRun = await runnerModule.runNext(context(executionFixture.sessionId, executionFixture.workflow), executionRegistry);
  const firstExecutionArtifact = firstExecutionRun.stages.EXECUTION?.artifact as any;
  assert.equal(firstExecutionRun.stages.EXECUTION?.status, "failed", "partial execution must remain explicitly retryable");
  assert.equal(firstExecutionArtifact.status, "PARTIAL");
  assert.equal(firstExecutionArtifact.failedShots.length, 1);
  assert.equal(firstExecutionArtifact.failedShots[0].shotId, failedShotId);
  assert.equal(firstExecutionArtifact.failedShots[0].status, "failed");
  assert.equal(firstExecutionRun.currentStage, "EXECUTION");

  const executionRetry = runnerModule.restartFrom(firstExecutionRun, "EXECUTION");
  const secondExecutionRun = await runnerModule.runNext(context(executionFixture.sessionId, executionRetry), executionRegistry);
  const secondExecutionArtifact = secondExecutionRun.stages.EXECUTION?.artifact as any;
  assert.equal(secondExecutionRun.stages.EXECUTION?.status, "ready");
  assert.equal(secondExecutionArtifact.status, "READY");
  assert.equal(executionCalls.length, 3, "execution retry must render only the failed shot");
  assert.deepEqual(executionCalls.map((call) => call.shotId), [failedShotId, initialShots[1].id, failedShotId]);
  assert.ok(secondExecutionArtifact.renderIds.length === 2);

  const stitchCalls: Array<{ audioTimeline: any }> = [];
  let probedDuration = 10;
  const stitchRegistry = mediaModule.createVideosBatchNativeMediaStageRegistry({
    defaultAssetImageModel: () => "seedream-4-5",
    generateAssetImage: async () => ({ url: "https://mock.invalid/unused.png", model: "seedream-4-5" as const }),
    cacheGeneratedImage: async (url: string) => ({ imageUrl: url }),
    generateShotVideo: async () => "https://mock.invalid/unused.mp4",
    cacheGeneratedVideo: async (url: string) => ({ videoUrl: url, remoteVideoUrl: url }),
    probeVideoDuration: async () => probedDuration,
    stitchShotVideos: async (_sessionId: string, _shots: any[], options?: { audioTimeline?: any }) => {
      stitchCalls.push({ audioTimeline: options?.audioTimeline });
      return { finalVideoUrl: "/media/resilience-final.mp4", signature: "resilience-signature" };
    }
  });

  const validStitch = await stitchRegistry.STITCH!.execute(context(executionFixture.sessionId, secondExecutionRun));
  assert.equal((validStitch.artifact as any).status, "READY");
  assert.equal(stitchCalls.length, 1);
  assert.equal(stitchCalls[0].audioTimeline.durationSec, 20);
  assert.equal(stitchCalls[0].audioTimeline.streams.dialogue.length, 4);

  const durationShot = store.getShot(initialShots[1].id)!;
  probedDuration = 9;
  await store.updateShot(durationShot.id, {
    videoDurationSec: 9,
    videoDurationVerified: true,
    renders: (durationShot.renders || []).map((render: any) => ({ ...render, videoDurationSec: 9, videoDurationVerified: true }))
  });
  await assert.rejects(
    () => stitchRegistry.STITCH!.execute(context(executionFixture.sessionId, secondExecutionRun)),
    /STITCH_INPUT_INVALID|时长/
  );
  assert.equal(stitchCalls.length, 1, "duration gate must reject before calling the stitch provider");
  probedDuration = 10;
  await store.updateShot(durationShot.id, {
    videoDurationSec: 10,
    videoDurationVerified: true,
    renders: (durationShot.renders || []).map((render: any) => ({ ...render, videoDurationSec: 10, videoDurationVerified: true }))
  });

  const staleWorkflow = structuredClone(secondExecutionRun);
  staleWorkflow.stages.FINAL_STORYBOARD!.revision = 2;
  await assert.rejects(
    () => stitchRegistry.STITCH!.execute(context(executionFixture.sessionId, staleWorkflow)),
    /STITCH_INPUT_INVALID|stale/
  );
  assert.equal(stitchCalls.length, 1, "stale lineage must reject before stitching");

  const badAudioWorkflow = structuredClone(secondExecutionRun);
  (badAudioWorkflow.stages.EXECUTION!.artifact as any).audioTimeline.durationSec = 19;
  await assert.rejects(
    () => stitchRegistry.STITCH!.execute(context(executionFixture.sessionId, badAudioWorkflow)),
    /STITCH_INPUT_INVALID|audioTimeline/
  );
  assert.equal(stitchCalls.length, 1, "audio timeline gate must reject before stitching");

  // A revised storyboard must create an isolated native batch. Reordering the
  // asset plan must keep each assetKey's public id stable.
  const reorderedPlan = {
    ...assetPlan,
    items: [assetPlan.items[1], assetPlan.items[0]]
  };
  const reorderedCandidates = await projection.projectAssetCandidatesIntoSeeReel(
    store,
    assetSession.id,
    "P001",
    reorderedPlan
  );
  const firstCandidateIds = new Map(firstAssetArtifact.items.map((item: any) => [item.assetKey, item.publicAssetId]));
  for (const item of reorderedCandidates.items) {
    assert.equal(item.publicAssetId, firstCandidateIds.get(item.assetKey), `assetKey ${item.assetKey} must retain its stable public id after reorder`);
  }

  const batchSession = await store.createSession({
    title: "VideosBatch storyboard batch isolation",
    logline: "batch isolation",
    style: "test",
    targetDurationSec: 20,
    shotCount: 0
  });
  const firstStoryboard = structuredClone(storyboard);
  for (const segment of firstStoryboard.segments) delete (segment as any).nativeShotId;
  const firstBatchShots = await projection.projectFinalStoryboardIntoSeeReel(store, batchSession.id, firstStoryboard, { sourceRevision: 1 });
  const firstBatchId = firstBatchShots[0].videosBatchBatchId;
  assert.ok(firstBatchId);

  const secondStoryboard = structuredClone(storyboard);
  secondStoryboard.title = "第二版最终分镜";
  secondStoryboard.segments.forEach((segment: any) => {
    delete segment.nativeShotId;
    segment.scene = `${segment.scene}（第二版）`;
  });
  const secondBatchShots = await projection.projectFinalStoryboardIntoSeeReel(store, batchSession.id, secondStoryboard, { sourceRevision: 2 });
  const secondBatchId = secondBatchShots[0].videosBatchBatchId;
  assert.ok(secondBatchId);
  assert.notEqual(secondBatchId, firstBatchId, "changed storyboard content must create a new batch");
  assert.equal(new Set(secondBatchShots.map((shot: any) => shot.id)).size, secondStoryboard.segments.length);
  assert.equal(store.getSession(batchSession.id)!.shots.length, firstStoryboard.segments.length + secondStoryboard.segments.length);

  // Simulate a persisted/model round-trip where native runtime pointers are
  // absent. The current batch must still be found without creating duplicates.
  const secondWithoutRuntimePointers = structuredClone(secondStoryboard);
  for (const segment of secondWithoutRuntimePointers.segments) delete (segment as any).nativeShotId;
  const reprojectedSecond = await projection.projectFinalStoryboardIntoSeeReel(
    store,
    batchSession.id,
    secondWithoutRuntimePointers,
    { sourceRevision: 2 }
  );
  assert.deepEqual(
    reprojectedSecond.map((shot: any) => shot.id),
    secondBatchShots.map((shot: any) => shot.id),
    "reprojecting the same batch without native pointers must reuse its shots"
  );
  assert.equal(store.getSession(batchSession.id)!.shots.length, firstStoryboard.segments.length + secondStoryboard.segments.length);

  const batchCandidates = await projection.projectAssetCandidatesIntoSeeReel(store, batchSession.id, "P001", assetPlan);
  for (const item of batchCandidates.items) {
    const native = store.snapshot().assets.find((asset: any) => asset.id === item.candidateAssetIds[0]);
    assert.ok(native);
    await store.upsertAsset({
      id: native!.id,
      mediaKind: "image",
      imageUrl: `https://mock.invalid/batch-assets/${item.publicAssetId}.png`,
      mediaUrl: `https://mock.invalid/batch-assets/${item.publicAssetId}.png`,
      sourceImageUrl: `https://mock.invalid/batch-assets/${item.publicAssetId}.png`
    });
  }
  const oldRender = {
    id: "render_old_storyboard_batch",
    model: "old-provider",
    prompt: "old batch prompt",
    status: "ready",
    videoUrl: "https://mock.invalid/old-batch.mp4",
    remoteVideoUrl: "https://mock.invalid/old-batch.mp4",
    durationSec: 10,
    videoDurationSec: 10,
    videoDurationVerified: true,
    videosBatchBatchId: firstBatchId
  };
  await store.updateShot(firstBatchShots[0].id, {
    status: "ready",
    videoUrl: oldRender.videoUrl,
    videoDurationSec: 10,
    videoDurationVerified: true,
    renders: [oldRender as any]
  });

  const batchConfirmation = {
    confirmed: true,
    items: batchCandidates.items.map((item: any) => ({
      assetKey: item.assetKey,
      publicAssetId: item.publicAssetId,
      candidateAssetIds: item.candidateAssetIds,
      selectedAssetId: item.candidateAssetIds[0]
    }))
  };
  const batchWorkflow = workflowModule.createVideosBatchWorkflow({ projectId: "P001", lessonText: "完整教案" });
  batchWorkflow.stages.ASSET_PLAN = ready(assetPlan);
  batchWorkflow.stages.ASSET_CANDIDATES = ready({
    schemaVersion: "1",
    status: "READY",
    items: batchCandidates.items.map((item: any) => ({ ...item, required: true, status: "ready", attempt: 1 })),
    failedItems: [],
    sourceStageId: "ASSET_PLAN",
    sourceRevision: 1,
    sourceHash: hash(assetPlan)
  });
  batchWorkflow.stages.ASSET_CONFIRMATION = ready(batchConfirmation);
  batchWorkflow.stages.FINAL_STORYBOARD = ready(secondStoryboard, 2);
  batchWorkflow.stages.QUOTE = ready({
    quoteId: `quote_${batchSession.id}`,
    sourceStageRevision: 2,
    sourceHash: hash(secondStoryboard),
    targetDurationSeconds: 20,
    assetOrder: batchCandidates.items.map((item: any) => item.publicAssetId),
    current: true
  });
  batchWorkflow.currentStage = "EXECUTION";
  const batchExecutionCalls: string[] = [];
  const batchRegistry = mediaModule.createVideosBatchNativeMediaStageRegistry({
    defaultAssetImageModel: () => "seedream-4-5",
    generateAssetImage: async () => ({ url: "https://mock.invalid/unused.png", model: "seedream-4-5" as const }),
    cacheGeneratedImage: async (url: string) => ({ imageUrl: url }),
    generateShotVideo: async (shot: any) => {
      batchExecutionCalls.push(shot.id);
      return `https://mock.invalid/videos/new-batch-${shot.id}.mp4`;
    },
    cacheGeneratedVideo: async (url: string) => ({ videoUrl: url, remoteVideoUrl: url }),
    probeVideoDuration: async () => 10,
    stitchShotVideos: async () => ({ finalVideoUrl: "/media/batch-isolation-final.mp4", signature: "batch-isolation" })
  });
  const batchExecution = await runnerModule.runNext(context(batchSession.id, batchWorkflow), batchRegistry);
  assert.equal(batchExecution.stages.EXECUTION?.status, "ready");
  assert.deepEqual(
    batchExecutionCalls,
    secondBatchShots.map((shot: any) => shot.id),
    "execution must render only the current storyboard batch"
  );
  assert.ok(batchExecutionCalls.every((id) => !firstBatchShots.some((shot: any) => shot.id === id)));
  const batchExecutionArtifact = batchExecution.stages.EXECUTION?.artifact as any;
  assert.ok(batchExecutionArtifact.items.every((item: any) => item.videoUrl !== oldRender.videoUrl));
  assert.deepEqual(batchExecutionArtifact.items.map((item: any) => item.sequence), [1, 2], "execution sequence must be batch-local");

  const isolatedStitch = await batchRegistry.STITCH!.execute(context(batchSession.id, batchExecution));
  assert.equal((isolatedStitch.artifact as any).status, "READY", "a current batch must pass stitch after old-batch renders exist");

  // An unknown POST result without a persisted task id is blocked on resume;
  // the provider callback must never be invoked a second time.
  const unknownShot = store.getShot(failedShotId)!;
  await store.updateShot(unknownShot.id, {
    status: "error",
    videoUrl: undefined,
    renders: [],
    generationTaskId: undefined,
    generationStartedAt: "2026-08-31T00:00:00.000Z",
    videosBatchError: {
      code: "H3_SUBMISSION_STATE_UNKNOWN",
      message: "提交状态未知",
      retryable: false,
      attempt: 1,
      provider: "injected-h3"
    },
    error: "H3_SUBMISSION_STATE_UNKNOWN: 提交状态未知"
  });
  const unknownWorkflow = structuredClone(secondExecutionRun);
  unknownWorkflow.currentStage = "EXECUTION";
  unknownWorkflow.completed = false;
  unknownWorkflow.stages.EXECUTION = { status: "pending", revision: 0 };
  const callsBeforeUnknown = executionCalls.length;
  const unknownRun = await runnerModule.runNext(context(executionFixture.sessionId, unknownWorkflow), executionRegistry);
  const unknownArtifact = unknownRun.stages.EXECUTION?.artifact as any;
  assert.equal(unknownRun.stages.EXECUTION?.status, "failed");
  assert.equal(unknownRun.stages.EXECUTION?.errorInfo?.retryable, false);
  assert.equal(unknownArtifact.failedShots[0].status, "blocked");
  assert.equal(executionCalls.length, callsBeforeUnknown, "unknown submission must not blindly resubmit");

  console.log("VideosBatch native media resilience smoke passed");
} finally {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
}
