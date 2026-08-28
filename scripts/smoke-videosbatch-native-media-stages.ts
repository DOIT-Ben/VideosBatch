import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-native-media-"));
process.chdir(tmp);

try {
  const [storeModule, workflowModule, runnerModule, mediaModule, projection] = await Promise.all([
    import("../src/server/store"),
    import("../src/shared/videosBatchWorkflow"),
    import("../src/server/videosBatchWorkflow/runner"),
    import("../src/server/videosBatchWorkflow/nativeMediaStages"),
    import("../src/server/videosBatchWorkflow/nativeProjection")
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
    generateShotVideo: async (shot: any) => {
      videoCalls.push(shot.id);
      return `https://mock.invalid/videos/${shot.id}.mp4`;
    },
    cacheGeneratedVideo: async (url: string) => ({ videoUrl: url, remoteVideoUrl: url }),
    stitchShotVideos: async (id: string, shots: any[]) => {
      stitchCalls.push(`${id}:${shots.length}`);
      return { finalVideoUrl: `/media/final-${id}.mp4`, signature: "sig-native-media" };
    }
  });

  let workflow = workflowModule.createVideosBatchWorkflow({ projectId: "P001", lessonText: "完整教案" });
  workflow.stages.ASSET_PLAN = {
    status: "ready",
    revision: 1,
    artifact: {
      items: [
        { assetKey: "CHARACTER-HERO", category: "CHARACTER", name: "小宇", prompt: "角色三视图" },
        { assetKey: "SCENE-CLASSROOM", category: "SCENE", name: "教室", prompt: "教室空镜" }
      ]
    }
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
    targetDuration: 20,
    segments: [
      {
        sequence: 1,
        duration: 10,
        visualPrompt: "小宇在教室观察物体",
        narration: "第一段",
        references: [
          { publicAssetId: "P001-A001", assetId: "P001-A001", label: "小宇" },
          { publicAssetId: "P001-A002", assetId: "P001-A002", label: "教室" }
        ],
        subshots: [
          { sequence: 1, duration: 3, visual: "中景", action: "观察", camera: "固定", sound: "环境声", voice: "旁白" },
          { sequence: 2, duration: 3, visual: "近景", action: "比较", camera: "推近", sound: "轻响", voice: "对白" },
          { sequence: 3, duration: 4, visual: "中景", action: "提问", camera: "稳定", sound: "提示音", voice: "悬问" }
        ]
      },
      {
        sequence: 2,
        duration: 10,
        visualPrompt: "小宇继续在教室讨论",
        narration: "第二段",
        references: [{ publicAssetId: "P001-A001", assetId: "P001-A001", label: "小宇" }],
        subshots: [
          { sequence: 1, duration: 3, visual: "全景", action: "讨论", camera: "固定", sound: "环境声", voice: "旁白" },
          { sequence: 2, duration: 3, visual: "近景", action: "指向", camera: "推近", sound: "轻响", voice: "对白" },
          { sequence: 3, duration: 4, visual: "中景", action: "思考", camera: "稳定", sound: "提示音", voice: "悬问" }
        ]
      }
    ]
  };
  await projection.projectFinalStoryboardIntoSeeReel(store, sessionId, storyboard);
  workflow.stages.FINAL_STORYBOARD = { status: "ready", revision: 1, artifact: storyboard };
  workflow.stages.ASSET_CONFIRMATION = { status: "ready", revision: 1, artifact: confirmation };
  workflow.currentStage = "EXECUTION";

  workflow = await runnerModule.runNext(makeCtx(workflow), registry);
  assert.equal(workflow.currentStage, "STITCH");
  assert.equal(workflow.stages.EXECUTION?.status, "ready");
  assert.equal(videoCalls.length, 2, "native EXECUTION must generate one video per native shot");
  const execution = workflow.stages.EXECUTION?.artifact as any;
  assert.equal(execution.renderIds.length, 2);
  assert.ok(execution.renderIds.every((id: string) => id.startsWith("render_vb_")));

  const renderedSession = store.getSession(sessionId)!;
  assert.equal(renderedSession.shots.length, 2);
  assert.ok(renderedSession.shots.every((shot: any) => shot.status === "ready"));
  assert.ok(renderedSession.shots.every((shot: any) => String(shot.videoUrl).startsWith("https://mock.invalid/videos/")));
  assert.ok(renderedSession.shots.every((shot: any) => shot.renders?.[0]?.videoUrl === shot.videoUrl));
  assert.ok(renderedSession.shots[0].assetIds.length === 2, "EXECUTION must resolve confirmed stable references into native Shot.assetIds");

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
