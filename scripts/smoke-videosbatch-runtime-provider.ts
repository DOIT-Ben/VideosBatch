import { strict as assert } from "node:assert";
import http from "node:http";
import { once } from "node:events";
import { createVideosBatchWorkflow } from "../src/shared/videosBatchWorkflow";
import type { Session } from "../src/shared/types";
import type { StageExecutionContext } from "../src/server/videosBatchWorkflow/stageContracts";
import {
  createVideosBatchRuntimeStageRegistry,
  getVideosBatchProviderReadiness,
  resolveVideosBatchRuntimeConfig
} from "../src/server/videosBatchWorkflow/runtimeProvider";

const fakeConfig = resolveVideosBatchRuntimeConfig({
  OPENAI_API_KEY: "shared-key-that-must-not-auto-enable",
  BP_SEEDREAM_API_KEY: "image-key-that-must-not-auto-enable",
  BP_SEEDANCE_API_KEY: "video-key-that-must-not-auto-enable",
  VIDEOSBATCH_LLM_API_KEY: "dedicated-key-that-must-not-auto-enable",
  VIDEOSBATCH_LLM_MODEL: "test-model"
});
assert.equal(fakeConfig.executorMode, "fake", "missing executor mode must stay fake even when keys exist");
assert.equal(fakeConfig.mediaMode, "fake", "missing media mode must stay fake even when SeeReel media keys exist");
const fakeReadiness = getVideosBatchProviderReadiness(fakeConfig);
assert.equal(fakeReadiness.executorMode, "fake");
assert.equal(fakeReadiness.mediaMode, "fake");
assert.equal(fakeReadiness.text.enabled, false);
assert.equal(fakeReadiness.text.ready, true);
assert.equal(fakeReadiness.media.enabled, false);
assert.equal(JSON.stringify(fakeReadiness).includes("dedicated-key-that-must-not-auto-enable"), false, "readiness must never expose API key material");
assert.equal(JSON.stringify(fakeReadiness).includes("image-key-that-must-not-auto-enable"), false, "readiness must never expose media keys");

assert.throws(() => resolveVideosBatchRuntimeConfig({ VIDEOSBATCH_EXECUTOR_MODE: "surprise" }), /VIDEOSBATCH_EXECUTOR_MODE.*fake.*llm/i);
assert.throws(() => resolveVideosBatchRuntimeConfig({ VIDEOSBATCH_MEDIA_MODE: "surprise" }), /VIDEOSBATCH_MEDIA_MODE.*fake.*native/i);
assert.throws(() => resolveVideosBatchRuntimeConfig({ VIDEOSBATCH_EXECUTOR_MODE: "llm", VIDEOSBATCH_LLM_MODEL: "test-model", OPENAI_API_KEY: "shared-key-must-not-be-used" }), /VIDEOSBATCH_LLM_API_KEY/);
assert.throws(() => resolveVideosBatchRuntimeConfig({ VIDEOSBATCH_EXECUTOR_MODE: "llm", VIDEOSBATCH_LLM_API_KEY: "test-key" }), /VIDEOSBATCH_LLM_MODEL/);

const nativeMediaConfig = resolveVideosBatchRuntimeConfig({ VIDEOSBATCH_MEDIA_MODE: "native" });
assert.equal(nativeMediaConfig.executorMode, "fake");
assert.equal(nativeMediaConfig.mediaMode, "native");
const nativeMediaReadiness = getVideosBatchProviderReadiness(nativeMediaConfig);
assert.equal(nativeMediaReadiness.media.enabled, true);
assert.equal(nativeMediaReadiness.media.mode, "native");

const mediaWorkflow = createVideosBatchWorkflow({ projectId: "P001", lessonText: "完整教案：观察物体。" });
mediaWorkflow.stages.ASSET_PLAN = {
  status: "ready",
  revision: 1,
  artifact: { items: [{ assetKey: "CHARACTER-HERO", category: "CHARACTER", name: "小宇", prompt: "角色三视图" }] }
};
mediaWorkflow.currentStage = "ASSET_CANDIDATES";
const mediaNow = new Date().toISOString();
const mediaSession = { id: "ses_media_overlay", title: "Media overlay", logline: "", style: "test", targetDurationSec: 120, videosBatchWorkflow: mediaWorkflow, createdAt: mediaNow, updatedAt: mediaNow } as Session;
const mediaCtx: StageExecutionContext = { session: mediaSession, workflow: mediaWorkflow, assets: [], shots: [] };
const nativeMediaRegistry = createVideosBatchRuntimeStageRegistry({ VIDEOSBATCH_MEDIA_MODE: "native" });
await assert.rejects(
  () => nativeMediaRegistry.ASSET_CANDIDATES!.execute(mediaCtx),
  /CinemaStore/,
  "native media mode must overlay the fake ASSET_CANDIDATES stage with the SeeReel-native executor"
);

let requests = 0;
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/responses") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  requests += 1;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  assert.equal(req.headers.authorization, "Bearer test-key");
  assert.equal(body.model, "test-model");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.name, "videosbatch_course_intro_candidates");

  const ids = ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"];
  const artifact = {
    candidates: ids.map((id, index) => ({
      id,
      name: `导入${id}`,
      creativeType: index < 3 ? "数学史与知识由来" : index < 6 ? "历史需求与古今应用" : "创意故事与现代情境",
      body: "学生围绕一个清晰的问题展开观察、比较和推理，情境逐步产生认知冲突。本课数学知识成为解决问题的关键线索，但导入阶段只呈现问题和必要背景，不提前揭示结论。".repeat(3).slice(0, 230),
      endingQuestion: "究竟应该怎样判断并解决这个问题？",
      truthfulnessCategory: "完全虚构的故事化情境",
      truthfulnessNote: "用于接口契约测试的虚构教学情境。"
    })),
    recommendations: [
      { id: "A-01", reason: "课堂吸引力、知识连接和视频可行性综合较强。" },
      { id: "B-01", reason: "真实需求清晰，便于自然引出数学问题。" },
      { id: "C-01", reason: "冲突直观，学生容易代入且便于视觉表达。" }
    ]
  };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: "resp_runtime_test", model: "test-model", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(artifact) }] }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("mock provider did not expose a TCP port");

try {
  const env = {
    VIDEOSBATCH_EXECUTOR_MODE: "llm",
    VIDEOSBATCH_MEDIA_MODE: "fake",
    VIDEOSBATCH_LLM_PROVIDER: "openai-responses",
    VIDEOSBATCH_LLM_API_KEY: "test-key",
    VIDEOSBATCH_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    VIDEOSBATCH_LLM_MODEL: "test-model",
    VIDEOSBATCH_LLM_TIMEOUT_MS: "5000"
  };
  const config = resolveVideosBatchRuntimeConfig(env);
  assert.equal(config.executorMode, "llm");
  assert.equal(config.mediaMode, "fake");
  const readiness = getVideosBatchProviderReadiness(config);
  assert.equal(readiness.text.enabled, true);
  assert.equal(readiness.text.ready, true);
  assert.equal(readiness.text.provider, "openai-responses");
  assert.equal(readiness.text.model, "test-model");
  assert.equal(readiness.text.keyConfigured, true);
  assert.equal(readiness.media.enabled, false);
  assert.equal(JSON.stringify(readiness).includes("test-key"), false);

  const registry = createVideosBatchRuntimeStageRegistry(env);
  const workflow = createVideosBatchWorkflow({ projectId: "P001", lessonText: "完整教案：观察物体。" });
  const now = new Date().toISOString();
  const session = { id: "ses_runtime_provider", title: "Runtime provider", logline: "", style: "test", targetDurationSec: 120, videosBatchWorkflow: workflow, createdAt: now, updatedAt: now } as Session;
  const ctx: StageExecutionContext = { session, workflow, assets: [], shots: [] };
  const result = await registry.COURSE_INTRO_CANDIDATES!.execute(ctx);
  const validation = registry.COURSE_INTRO_CANDIDATES!.validate(result.artifact, ctx);
  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(requests, 1, "explicit llm mode must route the text stage through the provider exactly once");
} finally {
  server.close();
  await once(server, "close");
}

console.log("VideosBatch runtime provider smoke passed");
