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
    title: "Native projection smoke",
    logline: "VideosBatch projection contract",
    style: "test",
    targetDurationSec: 20,
    shotCount: 0
  });

  const sessionId = created.id;
  const assetPlan = {
    assets: [
      {
        referenceId: "P001-A001",
        type: "character",
        name: "小宇",
        source: "故事主角",
        usage: "角色一致性参考",
        prompt: "少年学生角色设定"
      },
      {
        referenceId: "P001-A002",
        type: "scene",
        name: "数学社团教室",
        source: "故事主要场景",
        usage: "场景一致性参考",
        prompt: "小学数学社团教室"
      }
    ]
  };

  const nativeAssets = await projection.projectAssetsIntoSeeReel(store, sessionId, assetPlan);
  assert.equal(nativeAssets.length, 2);
  assert.deepEqual(nativeAssets.map((asset: any) => asset.workflowReferenceId), ["P001-A001", "P001-A002"]);
  assert.ok(nativeAssets.every((asset: any) => asset.id.startsWith("asset_")));
  assert.ok(nativeAssets.every((asset: any) => asset.ownerSessionId === sessionId));
  assert.ok(nativeAssets.every((asset: any) => asset.mediaKind === "none"));

  const storyboard = {
    shots: [
      {
        id: "shot-plan-1",
        title: "发现正方形",
        script: "小宇观察黑布窗口。",
        camera: "中景推进",
        durationSec: 10,
        prompt: "小宇在数学社团教室观察黑布窗口"
      },
      {
        id: "shot-plan-2",
        title: "继续推理",
        script: "同学们继续讨论。",
        camera: "全景固定",
        durationSec: 10,
        prompt: "学生在数学社团教室继续讨论"
      }
    ]
  };

  const nativeShots = await projection.projectStoryboardIntoSeeReel(store, sessionId, storyboard);
  assert.equal(nativeShots.length, 2);
  assert.deepEqual(nativeShots.map((shot: any) => shot.index), [1, 2]);
  assert.ok(nativeShots.every((shot: any) => shot.id.startsWith("shot_")));
  assert.ok(nativeShots.every((shot: any) => shot.assetIds.length === 0));

  const bound = {
    shots: [
      {
        id: "shot-plan-1",
        assetIds: ["P001-A001", "P001-A002"],
        prompt: "[P001-A001] 在 [P001-A002] 中观察"
      },
      {
        id: "shot-plan-2",
        assetIds: ["P001-A002"],
        prompt: "学生继续在 [P001-A002] 中讨论"
      }
    ]
  };

  const boundShots = await projection.bindStableReferencesIntoShots(store, sessionId, bound);
  const snapshot = store.snapshot();
  const assetByStable = new Map(snapshot.assets.map((asset: any) => [asset.workflowReferenceId, asset.id]));

  assert.deepEqual(boundShots[0].assetIds, [assetByStable.get("P001-A001"), assetByStable.get("P001-A002")]);
  assert.deepEqual(boundShots[1].assetIds, [assetByStable.get("P001-A002")]);
  assert.equal(boundShots[0].rawPrompt, "[P001-A001] 在 [P001-A002] 中观察");
  assert.ok(boundShots.every((shot: any) => shot.assetIds.every((assetId: string) => snapshot.assets.some((asset: any) => asset.id === assetId))));

  const session = store.getSession(sessionId)!;
  assert.equal(session.shots.length, 2);
  assert.deepEqual(session.shots.map((shot: any) => shot.id), boundShots.map((shot: any) => shot.id));

  const graph = buildSessionGraph(snapshot, session);
  for (const asset of nativeAssets) {
    assert.ok(graph.nodes.some((node) => node.id === `image-${asset.id}`), `Canvas must show projected asset ${asset.workflowReferenceId}`);
  }
  for (const shot of boundShots) {
    assert.ok(graph.nodes.some((node) => node.id === `shot-${shot.id}`), `Canvas must show projected shot ${shot.id}`);
  }
  assert.ok(
    graph.edges.some((edge) => edge.source === `image-${nativeAssets[0].id}` && edge.target === `shot-${boundShots[0].id}`),
    "Canvas must show the resolved Asset → Shot binding"
  );

  console.log("VideosBatch native projection smoke passed");
} finally {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
}
