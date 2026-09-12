import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-native-projection-"));
process.chdir(tmp);

try {
  const [{ CinemaStore }, projection, { buildSessionGraph }, canonicalModule] = await Promise.all([
    import("../src/server/store"),
    import("../src/server/videosBatchWorkflow/nativeProjection"),
    import("../src/client/flow/buildGraph"),
    import("../src/server/videosBatchWorkflow/canonicalStoryboard")
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
    schemaVersion: "1",
    title: "投影资产计划",
    kind: "VIDEO_ASSET_PLAN",
    subject: "数学",
    gradeBand: "小学",
    candidateAssets: ["小宇", "数学社团教室", "观察尺", "课堂小鸟"],
    candidateInventory: [
      { assetKey: "CHARACTER-HERO", name: "小宇", category: "CHARACTER", required: true, sourceEvidence: "故事主角。", decision: "required" },
      { assetKey: "SCENE-MATH-CLUB", name: "数学社团教室", category: "SCENE", required: true, sourceEvidence: "故事发生的主要场景。", decision: "required" },
      { assetKey: "PROP-RULER", name: "观察尺", category: "PROP", required: true, sourceEvidence: "故事中的关键道具。", decision: "required" },
      { assetKey: "CREATURE-BIRD", name: "课堂小鸟", category: "CREATURE", required: false, sourceEvidence: "故事核对过的非拟人生物。", decision: "omitted" }
    ],
    omissionCheck: "已逐段回看故事，并按人物、场景、道具、生物完成四类二次核对；不存在课堂小鸟。",
    styleSpec: "影视级 3D 国漫 CG 风格，保持角色、空间和道具连续。",
    negativePrompt: "不要文字，不要水印，不要logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。",
    items: [
      {
        assetKey: "CHARACTER-HERO",
        category: "CHARACTER",
        name: "小宇",
        description: "故事主角",
        sourceEvidence: "故事主角参与观察推理",
        continuityNotes: "保持角色脸型和服装一致",
        usage: "跨分镜保持主角一致",
        required: true,
        aspectRatio: "16:9",
        negativePrompt: "不要文字，不要水印，不要logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。",
        prompt: "影视级 3D 国漫 CG 风格人物三视图；不要文字，不要水印，不要logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。"
      },
      {
        assetKey: "SCENE-MATH-CLUB",
        category: "SCENE",
        name: "数学社团教室",
        description: "故事主要场景",
        sourceEvidence: "故事在数学社团教室发生",
        continuityNotes: "空间布局保持一致",
        usage: "建立连续的课堂空间",
        required: true,
        aspectRatio: "16:9",
        negativePrompt: "不要文字，不要水印，不要logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。",
        prompt: "影视级 3D 国漫 CG 风格数学社团教室空镜；不要文字，不要水印，不要logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。"
      },
      {
        assetKey: "PROP-RULER",
        category: "PROP",
        name: "观察尺",
        description: "故事关键道具",
        sourceEvidence: "故事中的测量线索",
        continuityNotes: "比例和刻度保持一致",
        usage: "呈现观察细节",
        required: true,
        aspectRatio: "16:9",
        negativePrompt: "不要文字，不要水印，不要logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。",
        prompt: "影视级 3D 国漫 CG 风格单体道具设定图；不要文字，不要水印，不要logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。"
      }
    ]
  };

  const candidates = await projection.projectAssetCandidatesIntoSeeReel(store, sessionId, "P001", assetPlan);
  assert.deepEqual(candidates.items.map((item: any) => item.publicAssetId), ["P001-A001", "P001-A002", "P001-A003"]);
  assert.ok(candidates.items.every((item: any) => item.candidateAssetIds.length === 1));

  const snapshotAfterAssets = store.snapshot();
  const nativeAssets = snapshotAfterAssets.assets
    .filter((asset: any) => asset.ownerSessionId === sessionId)
    .sort((left: any, right: any) => String(left.workflowReferenceId || "").localeCompare(String(right.workflowReferenceId || "")));
  assert.equal(nativeAssets.length, 3);
  assert.deepEqual(nativeAssets.map((asset: any) => asset.workflowReferenceId), ["P001-A001", "P001-A002", "P001-A003"]);
  assert.ok(nativeAssets.every((asset: any) => asset.id.startsWith("asset_")));
  const declaredOrderProbe = store.getAssetsForShot({
    id: "shot_order_probe",
    sessionId,
    assetIds: [nativeAssets[1].id, nativeAssets[0].id],
    prompt: "",
    rawPrompt: ""
  } as any);
  assert.deepEqual(
    declaredOrderProbe.map((asset: any) => asset.id),
    [nativeAssets[1].id, nativeAssets[0].id],
    "VideosBatch reference reads must follow Shot.assetIds, not global asset insertion order"
  );

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
          { label: "【场景：数学社团教室】" },
          { label: "【道具：观察尺】" }
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
          { label: "【场景：数学社团教室】" },
          { label: "【道具：观察尺】" }
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

  const assetPlanStage = {
    status: "ready",
    revision: 1,
    contentHash: canonicalModule.contentHash(assetPlan),
    artifact: assetPlan
  };
  const screenplay = {
    schemaVersion: "1",
    kind: "VIDEO_SCREENPLAY",
    storyType: "STORY",
    scenes: [{ sequence: 1, knowledgeFocus: "通过观察与比较理解可靠判断", evidence: [] }]
  };
  const confirmation = {
    confirmed: true,
    items: candidates.items.map((item: any) => ({
      assetKey: item.assetKey,
      publicAssetId: item.publicAssetId,
      candidateAssetIds: item.candidateAssetIds,
      selectedAssetId: item.candidateAssetIds[0]
    }))
  };
  const projectionOptions = {
    sourceRevision: 1,
    sourceHash: canonicalModule.canonicalStoryboardSourceHash(storyboard),
    assetPlan: assetPlanStage,
    screenplay,
    assetConfirmation: confirmation
  };
  const nativeShots = await projection.projectFinalStoryboardIntoSeeReel(store, sessionId, storyboard, projectionOptions);
  assert.equal(nativeShots.length, 2);
  assert.deepEqual(nativeShots.map((shot: any) => shot.index), [1, 2]);
  assert.ok(nativeShots.every((shot: any) => shot.durationSec === 10));
  assert.ok(nativeShots.every((shot: any) => shot.assetIds.length === 0), "asset refs resolve only at execution boundary");

  for (const shot of nativeShots) {
    assert.equal(shot.rawPrompt, shot.prompt, "Shot.rawPrompt and prompt must use the same compiled text");
    assert.match(shot.rawPrompt || "", /^\[教学目标与知识点\]/u);
    assert.match(shot.rawPrompt || "", /visual\.effects\[1\]\.camera：[^\n]+/u);
    assert.match(shot.rawPrompt || "", /audioIntent\.voices\[1\]\.text（原文）：[^\n]+/u);
    assert.match(shot.rawPrompt || "", /audioIntent\.sounds\[1\]\.text（原文）：环境声/u);
    assert.match(shot.rawPrompt || "", /visual\.globalContinuity：人物和课堂空间保持连续。/u);
    assert.match(shot.rawPrompt || "", /Image 1 = 【人物：小宇】/u);
    assert.doesNotMatch(shot.rawPrompt || "", /P001-A00\d/u, "stable public asset ids must not enter provider prompt");
    assert.match(String(shot.videosBatchSourceHash), /^[a-f0-9]{64}$/u);
    assert.equal(shot.videosBatchAssetPlanRevision, 1);
    assert.equal(shot.videosBatchAssetPlanHash, assetPlanStage.contentHash);
    assert.match(String(shot.videosBatchPackageContentHash), /^[a-f0-9]{64}$/u);
    assert.match(String(shot.videosBatchPromptHash), /^[a-f0-9]{64}$/u);
    assert.equal(shot.videosBatchPromptCompilerVersion, "2");
    assert.equal(shot.videosBatchPromptRendering, "full");
  }

  const resolvedShots = await projection.applyConfirmedReferencesToNativeShots(store, sessionId, storyboard, confirmation, projectionOptions);
  const snapshot = store.snapshot();
  const selectedByStable = new Map(confirmation.items.map((item: any) => [item.publicAssetId, item.selectedAssetId]));
  assert.deepEqual(resolvedShots[0].assetIds, [selectedByStable.get("P001-A001"), selectedByStable.get("P001-A002"), selectedByStable.get("P001-A003")]);
  assert.deepEqual(resolvedShots[1].assetIds, [selectedByStable.get("P001-A001"), selectedByStable.get("P001-A002"), selectedByStable.get("P001-A003")]);
  assert.deepEqual(
    resolvedShots[0].videosBatchReferenceBindings?.map((binding: any) => ({
      ordinal: binding.ordinal,
      assetKey: binding.assetKey,
      assetId: binding.assetId,
      semanticLabel: binding.semanticLabel
    })),
    [
      { ordinal: 1, assetKey: "CHARACTER-HERO", assetId: selectedByStable.get("P001-A001"), semanticLabel: "小宇" },
      { ordinal: 2, assetKey: "SCENE-MATH-CLUB", assetId: selectedByStable.get("P001-A002"), semanticLabel: "数学社团教室" },
      { ordinal: 3, assetKey: "PROP-RULER", assetId: selectedByStable.get("P001-A003"), semanticLabel: "观察尺" }
    ],
    "native projection must persist semantic references in declared ordinal order"
  );
  const reloaded = new CinemaStore();
  await reloaded.load();
  assert.deepEqual(
    reloaded.getShot(resolvedShots[0].id)?.videosBatchReferenceBindings?.map((binding: any) => binding.ordinal),
    [1, 2, 3],
    "reference binding snapshot must survive store serialization"
  );
  assert.ok(resolvedShots[0].rawPrompt.includes("小宇在数学社团教室观察黑布窗口"), "execution projection must retain canonical FINAL_STORYBOARD visual content");
  assert.ok(!resolvedShots[0].rawPrompt.includes("P001-A001"), "execution projection must not use COPYABLE_PROMPT stable markers");

  const bindingSnapshot = structuredClone(resolvedShots[0].videosBatchReferenceBindings);
  const promptSnapshot = {
    id: resolvedShots[0].id,
    rawPrompt: resolvedShots[0].rawPrompt,
    prompt: resolvedShots[0].prompt,
    packageHash: resolvedShots[0].videosBatchPackageContentHash,
    promptHash: resolvedShots[0].videosBatchPromptHash,
    assetIds: [...resolvedShots[0].assetIds]
  };
  const repeated = await projection.projectFinalStoryboardIntoSeeReel(store, sessionId, storyboard, projectionOptions);
  assert.deepEqual(repeated.map((shot: any) => shot.id), nativeShots.map((shot: any) => shot.id), "repeat projection must reuse native Shots");
  assert.equal(store.getSession(sessionId)!.shots.length, 2, "repeat projection must not append duplicate Shots");
  assert.deepEqual(repeated[0].videosBatchReferenceBindings, bindingSnapshot, "repeat projection must preserve valid bindings");
  assert.deepEqual(repeated[0].assetIds, promptSnapshot.assetIds, "repeat projection must preserve ordered assetIds");
  assert.equal(repeated[0].rawPrompt, promptSnapshot.rawPrompt, "repeat projection must keep the exact compiled Prompt");
  assert.equal(repeated[0].prompt, promptSnapshot.prompt);
  assert.equal(repeated[0].videosBatchPackageContentHash, promptSnapshot.packageHash);
  assert.equal(repeated[0].videosBatchPromptHash, promptSnapshot.promptHash);

  const persistedBindingSnapshot = structuredClone(repeated[0].videosBatchReferenceBindings);
  await store.updateShot(repeated[0].id, {
    videosBatchReferenceBindings: persistedBindingSnapshot?.map((binding: any, index: number) => index === 0
      ? { ...binding, semanticLabel: "已替换的旧语义" }
      : binding)
  });
  await assert.rejects(
    () => projection.projectFinalStoryboardIntoSeeReel(store, sessionId, storyboard, {
      ...projectionOptions,
      assetConfirmation: undefined,
      referenceBindings: undefined
    }),
    /persisted semantic binding is stale/u,
    "a stale persisted semantic binding must not be overwritten and self-accepted"
  );
  await store.updateShot(repeated[0].id, { videosBatchReferenceBindings: persistedBindingSnapshot });

  const duplicatePointerStoryboard = structuredClone(storyboard);
  duplicatePointerStoryboard.segments[1].nativeShotId = repeated[0].id;
  await assert.rejects(
    () => projection.applyConfirmedReferencesToNativeShots(store, sessionId, duplicatePointerStoryboard, confirmation, projectionOptions),
    /same native Shot/u,
    "execution binding must reject multiple storyboard segments resolving to one native Shot"
  );

  const bindingBeforeStalePlan = structuredClone(repeated[0].videosBatchReferenceBindings);
  await assert.rejects(
    () => projection.applyConfirmedReferencesToNativeShots(store, sessionId, storyboard, confirmation, {
      ...projectionOptions,
      assetPlan: { ...assetPlanStage, revision: 2 }
    }),
    /ASSET_PLAN.*lineage/
  );
  assert.deepEqual(
    store.getShot(repeated[0].id)?.videosBatchReferenceBindings,
    bindingBeforeStalePlan,
    "stale ASSET_PLAN must not rebind an existing native Shot"
  );

  const shotCountBeforeRejectedProjection = store.getSession(sessionId)!.shots.length;
  await assert.rejects(
    () => projection.projectFinalStoryboardIntoSeeReel(store, sessionId, storyboard, { ...projectionOptions, assetPlan: undefined }),
    /ASSET_PLAN.*wrapper/
  );
  await assert.rejects(
    () => projection.projectFinalStoryboardIntoSeeReel(store, sessionId, storyboard, { ...projectionOptions, sourceHash: "0".repeat(64) }),
    /sourceHash.*canonical/
  );
  await assert.rejects(
    () => projection.projectFinalStoryboardIntoSeeReel(store, sessionId, storyboard, {
      ...projectionOptions,
      assetPlan: { ...assetPlanStage, status: "pending" }
    }),
    /status=ready/
  );
  assert.equal(store.getSession(sessionId)!.shots.length, shotCountBeforeRejectedProjection, "rejected lineage must not create or alter Shots");

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
    () => projection.applyConfirmedReferencesToNativeShots(store, sessionId, storyboard, foreignConfirmation, projectionOptions),
    /No unique confirmed native asset/,
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
