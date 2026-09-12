import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-native-media-"));
process.chdir(tmp);

try {
  const [storeModule, workflowModule, runnerModule, mediaModule, projection, canonicalModule, fixtureModule] = await Promise.all([
    import("../src/server/store"),
    import("../src/shared/videosBatchWorkflow"),
    import("../src/server/videosBatchWorkflow/runner"),
    import("../src/server/videosBatchWorkflow/nativeMediaStages"),
    import("../src/server/videosBatchWorkflow/nativeProjection"),
    import("../src/server/videosBatchWorkflow/canonicalStoryboard"),
    import("../src/server/videosBatchWorkflow/shotExecutionPackageFixtures")
  ]);

  const store = new storeModule.CinemaStore();
  await store.load();
  const created = await store.createSession({
    title: "VideosBatch native media smoke",
    logline: "native media wiring",
    style: "test",
    targetDurationSec: 20,
    shotCount: 0
  });
  const sessionId = created.id;

  const imageCalls: string[] = [];
  const videoCalls: string[] = [];
  const stitchCalls: string[] = [];

  const registry = mediaModule.createVideosBatchNativeMediaStageRegistry({
    defaultAssetImageModel: () => "seedream-4-5",
    generateAssetImage: async (asset: any, model: any) => {
      imageCalls.push(asset.id);
      return {
        url: `https://mock.invalid/images/${asset.id}.png`,
        composedPrompt: asset.prompt,
        model,
        credentialSource: "standard"
      };
    },
    cacheGeneratedImage: async (url: string) => ({ imageUrl: url }),
    generateShotVideo: async (shot: any, _assets: any[], options?: {
      onProviderTaskSubmitted?(taskId: string): Promise<void> | void;
      onProviderReferenceBindingsPrepared?(bindings: any[]): Promise<void> | void;
      onProviderPromptPrepared?(prompt: string): Promise<void> | void;
    }) => {
      videoCalls.push(shot.id);
      await options?.onProviderReferenceBindingsPrepared?.(
        (shot.videosBatchReferenceBindings || []).map((binding: any) => ({ ...binding, imageUrlHash: "a".repeat(64) }))
      );
      await options?.onProviderPromptPrepared?.(`compiled H3 prompt for ${shot.id}`);
      const taskId = `provider-${shot.id}`;
      await options?.onProviderTaskSubmitted?.(taskId);
      assert.equal(store.getSession(sessionId)?.shots.find((candidate: any) => candidate.id === shot.id)?.generationTaskId, taskId);
      return `https://mock.invalid/videos/${shot.id}.mp4`;
    },
    cacheGeneratedVideo: async (url: string) => ({ videoUrl: url, remoteVideoUrl: url }),
    probeVideoDuration: async () => 10,
    // In-memory audio fakes keep this smoke fast and ffmpeg-free while still
    // exercising the delivery contract: one file per event plus a ready mix.
    synthesizeSpeech: async (event: any) => `https://mock.invalid/tts/${event.id}.mp3`,
    materializeSoundEffect: async (event: any) => `https://mock.invalid/sfx/${event.id}.mp3`,
    mixAudioTimeline: async () => ({ mixAudioUrl: "https://mock.invalid/mix.mp3", durationSec: 20 }),
    probeAudioDuration: async () => 2,
    stitchShotVideos: async (id: string, shots: any[]) => {
      stitchCalls.push(`${id}:${shots.length}`);
      return { finalVideoUrl: `/media/final-${id}.mp4`, signature: "sig-native-media" };
    }
  });

  const assetPlan = structuredClone(fixtureModule.SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlan) as any;
  assetPlan.title = "媒体阶段资产计划";
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
  const assetPlanStage = {
    status: "ready" as const,
    revision: 1,
    artifact: assetPlan,
    contentHash: canonicalModule.contentHash(assetPlan)
  };
  let workflow = workflowModule.createVideosBatchWorkflow({ projectId: "P001", lessonText: "完整教案" });
  workflow.stages.ASSET_PLAN = {
    ...assetPlanStage
  };
  workflow.currentStage = "ASSET_CANDIDATES";

  const makeCtx = (state: any) => {
    const session = store.getSession(sessionId)!;
    return {
      session,
      workflow: state,
      assets: store.snapshot().assets,
      shots: session.shots,
      store
    };
  };

  workflow = await runnerModule.runNext(makeCtx(workflow), registry);
  assert.equal(workflow.currentStage, "ASSET_CONFIRMATION");
  assert.equal(workflow.stages.ASSET_CANDIDATES?.status, "ready");
  assert.equal(imageCalls.length, 2, "native ASSET_CANDIDATES must generate one image per planned asset");

  const candidates = workflow.stages.ASSET_CANDIDATES?.artifact as any;
  assert.equal(candidates.items.length, 2);
  assert.deepEqual(candidates.items.map((item: any) => item.publicAssetId), ["P001-A001", "P001-A002"]);
  assert.ok(candidates.items.every((item: any) => item.candidateAssetIds[0]?.startsWith("asset_")));

  const generatedAssets = store.snapshot().assets
    .filter((asset: any) => asset.ownerSessionId === sessionId)
    .sort((a: any, b: any) => String(a.workflowReferenceId).localeCompare(String(b.workflowReferenceId)));
  assert.equal(generatedAssets.length, 2);
  assert.ok(generatedAssets.every((asset: any) => asset.mediaKind === "image"));
  assert.ok(generatedAssets.every((asset: any) => String(asset.imageUrl).startsWith("https://mock.invalid/images/")));
  assert.ok(generatedAssets.every((asset: any) => asset.generatedAt));

  const confirmation = {
    confirmed: true,
    items: candidates.items.map((item: any) => ({
      assetKey: item.assetKey,
      publicAssetId: item.publicAssetId,
      candidateAssetIds: item.candidateAssetIds,
      selectedAssetId: item.candidateAssetIds[0]
    }))
  };
  workflow = runnerModule.replaceStageArtifact(workflow, "ASSET_CONFIRMATION", confirmation);

  const storyboard = {
    schemaVersion: "2",
    title: "最终分镜",
    kind: "VIDEO_STORYBOARD",
    goal: "连续呈现观察问题并留下悬问",
    overallScript: "从异常观察推进到待解决问题。",
    visualContinuity: "角色与教室空间连续。",
    targetDuration: 20,
    aspectRatio: "16:9",
    deliveryMode: "SEGMENTED_MP4",
    format: "FINAL_10_SECOND",
    storyType: "STORY",
    segments: [
      {
        sequence: 1,
        chapter: "第1章",
        duration: 10,
        scene: "小宇在教室观察物体",
        characters: "【人物：小宇】",
        keyProps: "【道具：观察尺】",
        references: [{ label: "【人物：小宇】" }, { label: "【场景：教室】" }],
        screenplaySceneSequence: 1,
        evidence: [],
        visualEffects: [
          { sequence: 1, timeRange: "0-2秒", duration: 2, visual: "【人物：小宇】突然发现物体形状异常", action: "角色停下观察", camera: "固定中景", sound: "环境声", voice: "为什么会这样？" },
          { sequence: 2, timeRange: "2-6秒", duration: 4, visual: "【道具：观察尺】呈现测量细节", action: "角色比较并记录", camera: "近景推近", sound: "轻响", voice: "无" },
          { sequence: 3, timeRange: "6-10秒", duration: 4, visual: "【场景：教室】回到空间全景", action: "角色留下悬念", camera: "稳定跟随", sound: "提示音", voice: "怎样才能判断？" }
        ]
      },
      {
        sequence: 2,
        duration: 10,
        scene: "小宇继续在教室讨论",
        characters: "【人物：小宇】",
        keyProps: "【道具：观察尺】",
        references: [{ label: "【人物：小宇】" }, { label: "【场景：教室】" }],
        screenplaySceneSequence: 1,
        evidence: [],
        visualEffects: [
          { sequence: 1, timeRange: "0-2秒", duration: 2, visual: "【人物：小宇】看到两次观察结果冲突", action: "角色抬头追问", camera: "固定全景", sound: "环境声", voice: "等等，哪里不同？" },
          { sequence: 2, timeRange: "2-6秒", duration: 4, visual: "【道具：观察尺】对照两个方向", action: "角色指向关键位置", camera: "缓慢推近", sound: "轻响", voice: "无" },
          { sequence: 3, timeRange: "6-10秒", duration: 4, visual: "【场景：教室】画面停在未完成记录", action: "角色继续思考", camera: "稳定跟随", sound: "提示音", voice: "还缺少哪条线索？" }
        ]
      }
    ]
  };
  const projectionOptions = {
    sourceRevision: 1,
    sourceHash: canonicalModule.canonicalStoryboardSourceHash(storyboard),
    assetPlan: assetPlanStage,
    teaching: {
      goal: storyboard.goal,
      knowledgeFocus: "通过观察与比较理解可靠判断",
      evidence: []
    },
    assetConfirmation: confirmation
  };
  await projection.projectFinalStoryboardIntoSeeReel(store, sessionId, storyboard, projectionOptions);
  const projectedFirst = store.getSession(sessionId)!.shots.sort((a: any, b: any) => a.index - b.index)[0];
  await store.updateShot(projectedFirst.id, {
    status: "draft",
    videoUrl: `https://mock.invalid/videos/${projectedFirst.id}-existing.mp4`,
    renders: [{
      id: `render-existing-${projectedFirst.id}`,
      model: "minimax_h3",
      prompt: projectedFirst.prompt,
      status: "ready",
      videoUrl: `https://mock.invalid/videos/${projectedFirst.id}-existing.mp4`,
      createdAt: new Date().toISOString()
    }]
  });
  workflow.stages.FINAL_STORYBOARD = { status: "ready", revision: 1, artifact: storyboard };
  workflow.stages.ASSET_CONFIRMATION = { status: "ready", revision: 1, artifact: confirmation };
  workflow.stages.QUOTE = {
    status: "ready",
    revision: 1,
    artifact: {
      quoteId: `quote_${sessionId}`,
      sourceStageRevision: 1,
      sourceHash: canonicalModule.contentHash(storyboard),
      targetDurationSeconds: 20,
      assetOrder: confirmation.items.map((item: any) => item.publicAssetId),
      current: true
    }
  };
  workflow.currentStage = "EXECUTION";
  await store.updateSession(sessionId, { videosBatchWorkflow: workflow });

  workflow = await runnerModule.runNext(makeCtx(workflow), registry);
  assert.equal(workflow.currentStage, "AUDIO_DELIVERY", "EXECUTION advances to AUDIO_DELIVERY before STITCH");
  assert.equal(workflow.stages.EXECUTION?.status, "ready");
  assert.equal(videoCalls.length, 1, "native EXECUTION must reuse a ready render even when legacy top-level status is draft");
  const execution = workflow.stages.EXECUTION?.artifact as any;
  assert.equal(execution.renderIds.length, 2);
  assert.equal(execution.renderIds[0], `render-existing-${projectedFirst.id}`);
  assert.match(execution.renderIds[1], /^render_vb_/);

  const renderedSession = store.getSession(sessionId)!;
  assert.equal(renderedSession.shots.length, 2);
  assert.ok(renderedSession.shots.every((shot: any) => shot.status === "ready"));
  assert.ok(renderedSession.shots.every((shot: any) => String(shot.videoUrl).startsWith("https://mock.invalid/videos/")));
  assert.ok(renderedSession.shots.every((shot: any) => shot.renders?.[0]?.videoUrl === shot.videoUrl));
  assert.ok(renderedSession.shots.slice(1).every((shot: any) => shot.renders?.[0]?.generationTaskId === `provider-${shot.id}`));
  assert.ok(renderedSession.shots.slice(1).every((shot: any) => shot.renders?.[0]?.generationStartedAt));
  assert.ok(renderedSession.shots[0].assetIds.length === 2, "EXECUTION must resolve confirmed stable references into native Shot.assetIds");
  assert.deepEqual(
    renderedSession.shots[1].renders?.[0]?.videosBatchReferenceBindings?.map((binding: any) => ({
      ordinal: binding.ordinal,
      assetId: binding.assetId,
      imageUrlHash: binding.imageUrlHash
    })),
    renderedSession.shots[1].videosBatchReferenceBindings?.map((binding: any) => ({
      ordinal: binding.ordinal,
      assetId: binding.assetId,
      imageUrlHash: "a".repeat(64)
    })),
    "ShotRender must retain the exact ordered binding snapshot used for submission"
  );
  assert.equal(
    renderedSession.shots[1].renders?.[0]?.composedPrompt,
    `compiled H3 prompt for ${renderedSession.shots[1].id}`,
    "ShotRender must retain the provider-compiled prompt used for submission"
  );

  // AUDIO_DELIVERY now owns TTS, sound effects and the mix. Running the stage
  // must produce a delivery-ready timeline; STITCH then consumes that timeline
  // rather than the structural one EXECUTION emitted.
  const executionAudio = (workflow.stages.EXECUTION!.artifact as any).audioTimeline;
  assert.equal(executionAudio.streams.tts.length, 0, "EXECUTION emits a structural timeline without TTS");
  assert.equal(executionAudio.streams.mix.status, "pending", "EXECUTION leaves the mix pending");

  workflow = await runnerModule.runNext(makeCtx(workflow), registry);
  assert.equal(workflow.currentStage, "STITCH", "AUDIO_DELIVERY advances to STITCH");
  assert.equal(workflow.stages.AUDIO_DELIVERY?.status, "ready");
  const deliveryArtifact = workflow.stages.AUDIO_DELIVERY?.artifact as any;
  assert.equal(deliveryArtifact.audioTimeline.streams.mix.status, "ready", "AUDIO_DELIVERY must produce a ready mix");
  assert.equal(
    deliveryArtifact.audioTimeline.streams.tts.length,
    executionAudio.streams.narration.length + executionAudio.streams.dialogue.length,
    "AUDIO_DELIVERY must emit one TTS file per declared voice event"
  );

  workflow = await runnerModule.runNext(makeCtx(workflow), registry);
  assert.equal(workflow.completed, true);
  assert.equal(workflow.stages.STITCH?.status, "ready");
  assert.deepEqual(stitchCalls, [`${sessionId}:2`]);

  const stitchArtifact = workflow.stages.STITCH?.artifact as any;
  assert.equal(stitchArtifact.finalVideoUrl, `/media/final-${sessionId}.mp4`);
  assert.equal(stitchArtifact.signature, "sig-native-media");
  assert.ok(stitchArtifact.stitchJobId?.startsWith("stitch_vb_"));

  const stitchedSession = store.getSession(sessionId)!;
  const job = (stitchedSession.stitchJobs || []).find((item: any) => item.id === stitchArtifact.stitchJobId);
  assert.ok(job, "native STITCH must create a SeeReel StitchJob");
  assert.equal(job.status, "ready");
  assert.equal(job.finalVideoUrl, stitchArtifact.finalVideoUrl);
  assert.equal(job.finalVideoSignature, "sig-native-media");

  console.log("VideosBatch native media stages smoke passed");
} finally {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
}
