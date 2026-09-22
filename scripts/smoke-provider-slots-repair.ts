import { strict as assert } from "node:assert";
import { createVideosBatchLlmExecutor, createVideosBatchLlmAttemptBudget, resolveVideosBatchLlmConfig } from "../src/server/videosBatchWorkflow/llmExecutor";
import { createVideosBatchLlmTextStageRegistry } from "../src/server/videosBatchWorkflow/llmTextStages";
import { createVideosBatchWorkflow } from "../src/shared/videosBatchWorkflow";
import { runNext } from "../src/server/videosBatchWorkflow/runner";
import { sanitizeProviderDiagnosticText } from "../src/server/videosBatchWorkflow/providerDiagnostics";

// No dotenv and no external traffic: every HTTP request is intercepted.
const config = resolveVideosBatchLlmConfig({ VIDEOSBATCH_LLM_MODEL: "m1", VIDEOSBATCH_LLM_API_KEY: "fixture-1",
  VIDEOSBATCH_LLM_BASE_URL: "https://one.invalid/v1", VIDEOSBATCH_LLM_FALLBACK_MODELS: "m2",
  VIDEOSBATCH_LLM_FALLBACK_API_KEY: "fixture-2", VIDEOSBATCH_LLM_FALLBACK_BASE_URL: "https://two.invalid/v1",
  VIDEOSBATCH_LLM_FALLBACK_REASONING: "low", VIDEOSBATCH_LLM_FALLBACK_2_MODEL: "m3",
  VIDEOSBATCH_LLM_FALLBACK_2_BASE_URL: "https://three.invalid/v1", VIDEOSBATCH_LLM_FALLBACK_2_API_KEY: "fixture-3",
  VIDEOSBATCH_LLM_RETRY_DELAYS_MS: "0" });
const request = { operation: "TEST", systemPrompt: "test", userPrompt: "test", schemaName: "test",
  jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; model: string; auth: string; body: any }> = [];
let respond = (_index: number, _body: any) => new Response("{}", { status: 503 });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  assert.equal(body.text.format.type, "json_schema"); assert.equal(body.text.format.strict, true);
  calls.push({ url: String(url), model: body.model, auth: String((init?.headers as any).Authorization), body });
  return respond(calls.length, body);
};
const ok = (value: unknown, model = "reported-model-alias") => new Response(JSON.stringify({ model, status: "completed", output_text: JSON.stringify(value) }));
try {
  const executor = createVideosBatchLlmExecutor(config);
  respond = (index) => index < 3 ? new Response("unavailable", { status: 503 }) : ok({ ok: true });
  const third = await executor.generateStructured(request);
  assert.deepEqual(calls.map(c => c.model), ["m1", "m2", "m3"]);
  assert.deepEqual(calls.map(c => c.auth), ["Bearer fixture-1", "Bearer fixture-2", "Bearer fixture-3"]);
  assert.equal(third.routeId, "third"); assert.equal(third.requestedModel, "m3");
  const repairBudget = createVideosBatchLlmAttemptBudget(2);
  const before = calls.length;
  for (let i = 0; i < 2; i++) await executor.generateStructured({ ...request, providerRoute: "same-model", routeId: third.routeId, model: third.requestedModel, budget: repairBudget });
  assert.deepEqual(calls.slice(before).map(c => c.url), ["https://three.invalid/v1/responses", "https://three.invalid/v1/responses"]);
  await assert.rejects(executor.generateStructured({ ...request, providerRoute: "same-model", routeId: "third", model: "m3", budget: repairBudget }));
  assert.equal(calls.length, before + 2);

  calls.length = 0; respond = () => ok({ ok: true });
  const override = await executor.generateStructured({ ...request, model: "legacy-override" });
  await executor.generateStructured({ ...request, providerRoute: "same-model", routeId: override.routeId, model: override.requestedModel, budget: createVideosBatchLlmAttemptBudget(2) });
  assert.deepEqual(calls.map(c => c.model), ["legacy-override", "legacy-override"]);
  assert.ok(calls.every(c => c.url.includes("one.invalid")));
  calls.length = 0;
  await executor.generateStructured({ ...request, model: "m2" });
  assert.ok(calls[0].url.includes("two.invalid")); assert.equal(calls[0].body.reasoning.effort, "low");

  calls.length = 0; respond = index => index < 3 ? new Response("unavailable", { status: 503 }) : ok({ ok: true });
  await createVideosBatchLlmExecutor({ ...config, secondFallback: { ...config.secondFallback!, model: "m1" } }).generateStructured(request);
  assert.deepEqual(calls.map(c => c.model), ["m1", "m2", "m1"], "same model on a different endpoint remains a separate slot");

  const context = () => { const workflow = createVideosBatchWorkflow({ projectId: "PTEST", lessonText: "从不同方向观察物体，比较形状差异，保留课堂讨论问题。" });
    return { session: { id: "ses_fixture", videosBatchWorkflow: workflow } as any, workflow, assets: [], shots: [] }; };
  calls.length = 0; respond = () => ok({ candidates: [], recommendations: [] });
  const checkpoints: any[] = [];
  const failed = await runNext({ ...context(), checkpoint: async state => { checkpoints.push(structuredClone(state)); } }, createVideosBatchLlmTextStageRegistry(executor));
  assert.equal(calls.length, 3, "one generation plus exactly two same-model repairs");
  assert.ok(calls.every(c => c.model === "m1" && c.url.includes("one.invalid")));
  assert.equal(failed.stages.COURSE_INTRO_CANDIDATES?.textDiagnostics?.length, 3);
  assert.match(failed.stages.COURSE_INTRO_CANDIDATES!.error!, /exactly 9 candidates/);
  assert.equal(checkpoints.at(-1).stages.COURSE_INTRO_CANDIDATES.textDiagnostics.length, 3);

  calls.length = 0;
  const syntheticCredential = "fixture-sensitive-value";
  respond = index => index === 1 ? ok({ candidates: [], recommendations: [], api_key: syntheticCredential }) : new Response("payment required", { status: 402 });
  const rejected = await runNext(context(), createVideosBatchLlmTextStageRegistry(executor));
  const diagnostic = rejected.stages.COURSE_INTRO_CANDIDATES!.textDiagnostics![0];
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c.model === "m1"));
  assert.match(diagnostic.validationErrors.join(" "), /exactly 9 candidates/);
  assert.ok(!JSON.stringify(diagnostic).includes("fixture-sensitive-value"));
  assert.equal(rejected.stages.COURSE_INTRO_CANDIDATES!.errorInfo?.code, "HTTP_402");

  calls.length = 0; respond = () => new Response(JSON.stringify({ status: "completed", output_text: '{"ok":true,0}' }));
  const malformed = await runNext(context(), createVideosBatchLlmTextStageRegistry(createVideosBatchLlmExecutor({ ...config, fallbackModels: [], secondFallback: undefined })));
  assert.equal(calls.length, 3);
  assert.equal(malformed.stages.COURSE_INTRO_CANDIDATES!.textDiagnostics!.length, 3);
  assert.match(malformed.stages.COURSE_INTRO_CANDIDATES!.textDiagnostics![0].validationErrors[0], /INVALID_JSON/);

  calls.length = 0; respond = () => ok({ candidates: [], recommendations: [] });
  let checkpointsSeen = 0;
  const diskFailure = await runNext({ ...context(), checkpoint: async () => { if (++checkpointsSeen === 2) throw new Error("disk failure"); } }, createVideosBatchLlmTextStageRegistry(executor));
  assert.equal(calls.length, 1, "failed diagnostic persistence must stop before repair");
  assert.equal(diskFailure.stages.COURSE_INTRO_CANDIDATES!.errorInfo?.code, "TEXT_DIAGNOSTIC_CHECKPOINT_FAILED");

  for (const sample of ['{"api_key":"fixture-secret"}', JSON.stringify('{"token":"fixture-secret"}'), 'token=fixture-secret', 'Bearer fixture-secret', 'https://example.invalid/?token=fixture-secret']) {
    assert.ok(!sanitizeProviderDiagnosticText(sample).includes("fixture-secret"));
  }
  console.log("Provider slots, same-model repair and durable diagnostics smoke passed");
} finally { globalThis.fetch = originalFetch; }
