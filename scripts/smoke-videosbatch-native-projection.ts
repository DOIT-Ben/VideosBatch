import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-native-projection-"));
process.chdir(tmp);

try {
  const [{ CinemaStore }, projection, { buildSessionGraph }] = await Promise.all([
    import("../src/server/store"),
    import("../src/server/videosBatchWorkflow/nativeProjection"),
    import("../src/client/flow/buildGraph")
  ]);

  const store = new CinemaStore();
  await store.load();
  const created = await store.createSession({
    title: "Canonical native projection smoke",
    logline: "VideosBatch projection contract",
    style: "test",
    targetDurationSec: 20,
    shotCount: 0
  });
  const sessionId = created.id;

  const assetPlan = {
    items: [
      {
        assetKey: "CHARACTER-HERO",
        category: "CHARACTER",
        name: "小宇",
        description: "故事主角",
        sourceEvidence: "故事主角参与观察推理",
        continuityNotes: "保持角色脸型和服装一致",
        prompt: "高级影视级3D国漫CG人物三视图"
      },
      {
        assetKey: "SCENE-MATH-CLUB",
        category: "SCENE",
        name: "数学社团教室",
        description: "故事主要场景",
        sourceEvidence: "故事在数学社团教室发生",
        continuityNotes: "空间布局保持一致",
        prompt: "高级影视级3D国漫CG数学社团教室空镜"
      }
    ]
  };

  const candidates = await projection.projectAssetCandidatesIntoSeeReel(store, sessionId, "P001", assetPlan);
  assert.deepEqual(candidates.items.map((item: any) => item.publicAssetId), ["P001-A001", "P001-A002"]);
  assert.ok(candidates.items.every((item: any) => item.candidateAssetIds.length === 1));

  const snapshotAfterAssets = store.snapshot();
  const nativeAssets = snapshotAfterAssets.assets
    .filter((asset: any) => asset.ownerSessionId === sessionId)
    .sort((left: any, right: any) => String(left.workflowReferenceId || "").localeCompare(String(right.workflowReferenceId || "")));
  assert.equal(nativeAssets.length, 2);
  assert.deepEqual(nativeAssets.map((asset: any) => asset.workflowReferenceId), ["P001-A001", "P001-A002"]);
  assert.ok(nativeAssets.every((asset: any) => asset.id.startsWith("asset_")));

  const storyboard = {
    schemaVersion: "2",
    title: "最终分镜",
    kind: "VIDEO_STORYBOARD",
    goal: "连续呈现观察冲突并留下课堂悬问",
    overallScript: "从异常发现推进到待解决问题。",
    visualContinuity: "人物和课堂空间保持连续。",
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
        scene: "小宇在数学社团教室观察黑布窗口",
        characters: "【人物：小宇】",
        keyProps: "【道具：观察尺】",
        references: [
          { label: "【人物：小宇】" },
          { label: "【场景：数学社团教室】" }
        ],
        screenplaySceneSequence: 1,
        evidence: [],
        visualEffects: [
          { sequence: 1, timeRange: "0-2秒", duration: 2, visual: "【人物：小宇】突然发现窗口形状异常", action: "角色停下观察", camera: "固定中景", sound: "环境声", voice: "为什么会这样？" },
          { sequence: 2, timeRange: "2-6秒", duration: 4, visual: "【道具：观察尺】呈现窗口边缘", action: "角色比较两条边", camera: "缓慢推近", sound: "轻响", voice: "无" },
          { sequence: 3, timeRange: "6-10秒", duration: 4, visual: "【场景：数学社团教室】空间回到安静", action: "角色留下待解问题", camera: "稳定跟随", sound: "提示音", voice: "怎样才能判断它？" }
        ]
      },
      {
        sequence: 2,
        duration: 10,
        scene: "同学们继续在数学社团教室讨论",
        characters: "【人物：小宇】",
        keyProps: "【道具：观察尺】",
        references: [
          { label: "【人物：小宇】" },
          { label: "【场景：数学社团教室】" }
        ],
        screenplaySceneSequence: 1,
        evidence: [],
        visualEffects: [
          { sequence: 1, timeRange: "0-2秒", duration: 2, visual: "【人物：小宇】再次看到判断出现矛盾", action: "角色迅速回头", camera: "固定全景", sound: "环境声", voice: "等等，真的一样吗？" },
          { sequence: 2, timeRange: "2-6秒", duration: 4, visual: "【道具：观察尺】对照不同方向", action: "角色指向关键位置", camera: "近景推近", sound: "轻响", voice: "无" },
          { sequence: 3, timeRange: "6-10秒", duration: 4, visual: "【场景：数学社团教室】讨论停在黑板前", action: "角色继续思考", camera: "稳定跟随", sound: "提示音", voice: "还缺少哪条线索？" }
        ]
      }
    ]
  };

  const nativeShots = await projection.projectFinalStoryboardIntoSeeReel(store, sessionId, storyboard);
  assert.equal(nativeShots.length, 2);
  assert.deepEqual(nativeShots.map((shot: any) => shot.index), [1, 2]);
  assert.ok(nativeShots.every((shot: any) => shot.durationSec === 10));
  assert.ok(nativeShots.every((shot: any) => shot.assetIds.length === 0), "asset refs resolve only at execution boundary");

  const confirmation = {
    confirmed: true,
    items: candidates.items.map((item: any) => ({
      assetKey: item.assetKey,
      publicAssetId: item.publicAssetId,
      candidateAssetIds: item.candidateAssetIds,
      selectedAssetId: item.candidateAssetIds[0]
    }))
  };

  const resolvedShots = await projection.applyConfirmedReferencesToNativeShots(store, sessionId, storyboard, confirmation);
  const snapshot = store.snapshot();
  const selectedByStable = new Map(confirmation.items.map((item: any) => [item.publicAssetId, item.selectedAssetId]));
  assert.deepEqual(resolvedShots[0].assetIds, [selectedByStable.get("P001-A001"), selectedByStable.get("P001-A002")]);
  assert.deepEqual(resolvedShots[1].assetIds, [selectedByStable.get("P001-A001"), selectedByStable.get("P001-A002")]);
  assert.ok(resolvedShots[0].rawPrompt.includes("小宇在数学社团教室观察黑布窗口"), "execution projection must retain canonical FINAL_STORYBOARD visual content");
  assert.ok(!resolvedShots[0].rawPrompt.includes("P001-A001"), "execution projection must not use COPYABLE_PROMPT stable markers");

  const foreign = await store.upsertAsset({
    ownerUserId: "different-user",
    name: "不属于当前会话的资产",
    type: "prop",
    mediaKind: "image",
    imageUrl: "https://mock.invalid/foreign.png"
  } as any);
  assert.ok(foreign);
  const foreignConfirmation = structuredClone(confirmation);
  foreignConfirmation.items[0].selectedAssetId = foreign!.id;
  await assert.rejects(
    () => projection.applyConfirmedReferencesToNativeShots(store, sessionId, storyboard, foreignConfirmation),
    /No confirmed native asset/,
    "execution projection must reject a global asset owned by another user"
  );

  const session = store.getSession(sessionId)!;
  const graph = buildSessionGraph(snapshot, session);
  for (const asset of nativeAssets) {
    assert.ok(graph.nodes.some((node) => node.id === `image-${asset.id}`), `Canvas must show projected asset ${asset.workflowReferenceId}`);
  }
  for (const shot of resolvedShots) {
    assert.ok(graph.nodes.some((node) => node.id === `shot-${shot.id}`), `Canvas must show projected shot ${shot.id}`);
  }
  assert.ok(
    graph.edges.some((edge) => edge.source === `image-${nativeAssets[0].id}` && edge.target === `shot-${resolvedShots[0].id}`),
    "Canvas must show confirmed native Asset → Shot binding"
  );

  console.log("VideosBatch canonical native projection smoke passed");
} finally {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
}
