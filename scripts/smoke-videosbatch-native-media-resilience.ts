import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-native-resilience-"));
process.chdir(tmp);

try {
  const [{ CinemaStore }, workflowModule, runnerModule, mediaModule, projection, canonicalModule, fixtureModule] = await Promise.all([
    import("../src/server/store"),
    import("../src/shared/videosBatchWorkflow"),
    import("../src/server/videosBatchWorkflow/runner"),
    import("../src/server/videosBatchWorkflow/nativeMediaStages"),
    import("../src/server/videosBatchWorkflow/nativeProjection"),
    import("../src/server/videosBatchWorkflow/canonicalStoryboard"),
    import("../src/server/videosBatchWorkflow/shotExecutionPackageFixtures")
  ]);

  const store = new CinemaStore();
  await store.load();

  const hash = (value: unknown) => canonicalModule.contentHash(value);
  const completeAudioTimeline = (executionArtifact: any) => {
    const timeline = executionArtifact.audioTimeline;
    timeline.streams.tts = [
      ...timeline.streams.narration,
      ...timeline.streams.dialogue
    ].map((event: any) => ({
      ...event,
      id: `tts-${event.id}`,
      audioUrl: `https://mock.invalid/tts/${event.id}.mp3`,
      source: "TTS"
    }));
    timeline.streams.soundEffects = timeline.streams.soundEffects.map((event: any) => ({
      ...event,
      audioUrl: `https://mock.invalid/sfx/${event.id}.mp3`
    }));
    timeline.streams.mix = {
      status: "ready",
      audioUrl: "https://mock.invalid/mix.mp3",
      generatedAt: new Date().toISOString()
    };
    return executionArtifact;
  };
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

  const assetPlan = structuredClone(fixtureModule.SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlan) as any;
  assetPlan.title = "媒体韧性资产计划";
  assetPlan.candidateAssets = ["小宇", "教室", "观察尺", "课堂小鸟"];
  assetPlan.candidateInventory = [
    { assetKey: "CHARACTER-HERO", name: "小宇", category: "CHARACTER", required: true, sourceEvidence: "故事主角。", decision: "required" },
    { assetKey: "SCENE-CLASSROOM", name: "教室", category: "SCENE", required: true, sourceEvidence: "故事场景。", decision: "required" },
    { assetKey: "PROP-RULER", name: "观察尺", category: "PROP", required: false, sourceEvidence: "故事核对过的道具。", decision: "omitted" },
    { assetKey: "CREATURE-BIRD", name: "课堂小鸟", category: "CREATURE", required: false, sourceEvidence: "故事核对过的生物。", decision: "omitted" }
  ];
  assetPlan.omissionCheck = "已逐段回看故事，并按人物、场景、道具、生物完成四类二次核对；观察尺和课堂小鸟不进入本次资产计划。";
  assetPlan.items = [
    {
      ...assetPlan.items[0],
      assetKey: "CHARACTER-HERO",
      name: "小宇",
      description: "故事主角。",
      sourceEvidence: "故事主角参与观察推理。",
      usage: "跨分镜保持主角一致。"
    },
    {
      ...assetPlan.items[0],
      assetKey: "SCENE-CLASSROOM",
      category: "SCENE",
      name: "教室",
      description: "故事主要场景。",
      sourceEvidence: "故事在教室发生。",
      usage: "建立连续的课堂空间。",
      prompt: "影视级 3D 国漫 CG 风格教室空镜；不要文字，不要水印，不要logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。"
    }
  ];
  const assetPlanStage = { status: "ready" as const, revision: 1, artifact: assetPlan, contentHash: hash(assetPlan) };

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
    const screenplay = {
      schemaVersion: "1",
      kind: "VIDEO_SCREENPLAY",
      storyType: "STORY",
      scenes: [{ sequence: 1, knowledgeFocus: "通过观察与比较理解可靠判断", evidence: [] }]
    };
    await projection.projectFinalStoryboardIntoSeeReel(store, created.id, storyboard, {
      sourceRevision: 1,
      sourceHash: canonicalModule.canonicalStoryboardSourceHash(storyboard),
      assetPlan: assetPlanStage,
      screenplay,
      assetConfirmation: confirmationArtifact
    });
    const workflow = workflowModule.createVideosBatchWorkflow({ projectId: "P001", lessonText: "完整教案" });
    workflow.stages.ASSET_PLAN = assetPlanStage;
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
  await store.updateSession(executionFixture.sessionId, { videosBatchWorkflow: executionFixture.workflow });
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

  const audioReadyExecution = structuredClone(secondExecutionRun);
  completeAudioTimeline(audioReadyExecution.stages.EXECUTION!.artifact as any);

  const validStitch = await stitchRegistry.STITCH!.execute(context(executionFixture.sessionId, audioReadyExecution));
  assert.equal((validStitch.artifact as any).status, "READY");
  assert.equal(stitchCalls.length, 1);
  assert.equal(stitchCalls[0].audioTimeline.durationSec, 20);
  assert.equal(stitchCalls[0].audioTimeline.streams.dialogue.length, 4);

  const forgedReady = structuredClone(validStitch.artifact);
  const forgedValidation = stitchRegistry.STITCH!.validate(forgedReady, context(executionFixture.sessionId, secondExecutionRun));
  assert.equal(forgedValidation.ok, false, "a forged STITCH READY artifact must not bypass the delivery audio gate");
  assert.ok(forgedValidation.errors.some((message: string) => message.startsWith("AUDIO_TIMELINE_NOT_READY:")));

  const pendingMixWorkflow = structuredClone(audioReadyExecution);
  (pendingMixWorkflow.stages.EXECUTION!.artifact as any).audioTimeline.streams.mix = { status: "pending" };
  await assert.rejects(
    () => stitchRegistry.STITCH!.execute(context(executionFixture.sessionId, pendingMixWorkflow)),
    /AUDIO_TIMELINE_NOT_READY|mix.status/,
    "pending mix must block STITCH before creating a provider call"
  );
  assert.equal(stitchCalls.length, 1, "pending mix must not call the stitch provider");

  const emptyTtsWorkflow = structuredClone(audioReadyExecution);
  (emptyTtsWorkflow.stages.EXECUTION!.artifact as any).audioTimeline.streams.tts = [];
  await assert.rejects(
    () => stitchRegistry.STITCH!.execute(context(executionFixture.sessionId, emptyTtsWorkflow)),
    /AUDIO_TIMELINE_NOT_READY|TTS/,
    "voice events without TTS audio must block STITCH"
  );
  assert.equal(stitchCalls.length, 1, "empty TTS must not call the stitch provider");

  const blockedStageWorkflow = structuredClone(secondExecutionRun);
  blockedStageWorkflow.currentStage = "STITCH";
  const blockedStageRun = await runnerModule.runNext(
    context(executionFixture.sessionId, blockedStageWorkflow),
    stitchRegistry
  );
  assert.equal(blockedStageRun.stages.STITCH?.status, "failed", "audio-incomplete STITCH must fail the workflow stage");
  assert.equal(blockedStageRun.stages.STITCH?.errorInfo?.code, "AUDIO_TIMELINE_NOT_READY");
  assert.equal(blockedStageRun.stages.STITCH?.errorInfo?.retryable, true);
  assert.equal(blockedStageRun.completed, false);
  assert.equal(stitchCalls.length, 1, "blocked STITCH stage must not create a provider call");

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
  const batchReferenceBindings = [
    { referenceId: "CHARACTER-HERO", ordinal: 1, assetKey: "CHARACTER-HERO", semanticLabel: "【人物：小宇】", assetId: "asset_batch_character" },
    { referenceId: "SCENE-CLASSROOM", ordinal: 2, assetKey: "SCENE-CLASSROOM", semanticLabel: "【场景：教室】", assetId: "asset_batch_scene" }
  ];
  const batchTeaching = {
    goal: storyboard.goal,
    knowledgeFocus: "通过观察与比较理解可靠判断",
    evidence: []
  };
  const firstStoryboard = structuredClone(storyboard);
  for (const segment of firstStoryboard.segments) delete (segment as any).nativeShotId;
  const firstBatchShots = await projection.projectFinalStoryboardIntoSeeReel(store, batchSession.id, firstStoryboard, {
    sourceRevision: 1,
    sourceHash: canonicalModule.canonicalStoryboardSourceHash(firstStoryboard),
    assetPlan: assetPlanStage,
    teaching: batchTeaching,
    referenceBindings: batchReferenceBindings
  });
  const firstBatchId = firstBatchShots[0].videosBatchBatchId;
  assert.ok(firstBatchId);

  const secondStoryboard = structuredClone(firstStoryboard);
  secondStoryboard.title = "第二版最终分镜";
  secondStoryboard.segments.forEach((segment: any) => {
    segment.scene = `${segment.scene}（第二版）`;
  });
  const secondBatchShots = await projection.projectFinalStoryboardIntoSeeReel(store, batchSession.id, secondStoryboard, {
    sourceRevision: 2,
    sourceHash: canonicalModule.canonicalStoryboardSourceHash(secondStoryboard),
    assetPlan: assetPlanStage,
    teaching: batchTeaching,
    referenceBindings: batchReferenceBindings
  });
  const secondBatchId = secondBatchShots[0].videosBatchBatchId;
  assert.ok(secondBatchId);
  assert.notEqual(secondBatchId, firstBatchId, "changed storyboard content must create a new batch");
  assert.equal(new Set(secondBatchShots.map((shot: any) => shot.id)).size, secondStoryboard.segments.length);
  assert.deepEqual(
    secondStoryboard.segments.map((segment: any) => segment.nativeShotId),
    secondBatchShots.map((shot: any) => shot.id),
    "a changed storyboard must replace stale UI runtime pointers with the new batch pointers"
  );
  assert.equal(store.getSession(batchSession.id)!.shots.length, firstStoryboard.segments.length + secondStoryboard.segments.length);

  // Simulate a persisted/model round-trip where native runtime pointers are
  // absent. The current batch must still be found without creating duplicates.
  const secondWithoutRuntimePointers = structuredClone(secondStoryboard);
  for (const segment of secondWithoutRuntimePointers.segments) delete (segment as any).nativeShotId;
  const reprojectedSecond = await projection.projectFinalStoryboardIntoSeeReel(
    store,
    batchSession.id,
    secondWithoutRuntimePointers,
    {
      sourceRevision: 2,
      sourceHash: canonicalModule.canonicalStoryboardSourceHash(secondWithoutRuntimePointers),
      assetPlan: assetPlanStage,
      teaching: batchTeaching,
      referenceBindings: batchReferenceBindings
    }
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
  await store.updateSession(batchSession.id, { videosBatchWorkflow: batchWorkflow });
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
  completeAudioTimeline(batchExecutionArtifact);

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
