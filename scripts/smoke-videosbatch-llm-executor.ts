import { strict as assert } from "node:assert";
import http from "node:http";
import { once } from "node:events";
import {
  createVideosBatchLlmExecutor,
  resolveVideosBatchLlmConfig
} from "../src/server/videosBatchWorkflow/llmExecutor";

const previousNoProxy = process.env.NO_PROXY;
const previousNoProxyLower = process.env.no_proxy;
process.env.NO_PROXY = [previousNoProxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
process.env.no_proxy = [previousNoProxyLower, "127.0.0.1", "localhost"].filter(Boolean).join(",");

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/responses") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);

  assert.equal(req.headers.authorization, "Bearer test-key");
  assert.equal(body.model, "test-model");
  assert.equal(body.store, false);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.name, "course_intro_candidates");
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.text.format.schema.required, ["ok"]);
  assert.equal(body.input[0].role, "system");
  assert.equal(body.input[1].role, "user");
  assert.equal(body.metadata, undefined, "provider request bodies must not include unsupported metadata");
  assert.equal(req.headers["x-videosbatch-operation"], "COURSE_INTRO_CANDIDATES");

  res.setHeader("content-type", "application/json");
  const malformedStringJson = "{\"ok\":true,\"note\":\"line1" + "\n" + "line2\"}";
  res.end(JSON.stringify({
    id: "resp_test",
    model: "test-model",
    output: [{
      type: "message",
       content: [{ type: "output_text", text: "```json\n" + malformedStringJson + "\n```" }]
    }],
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 }
  }));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");

try {
  const config = resolveVideosBatchLlmConfig({
    VIDEOSBATCH_LLM_PROVIDER: "openai-responses",
    VIDEOSBATCH_LLM_API_KEY: "test-key",
    VIDEOSBATCH_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    VIDEOSBATCH_LLM_MODEL: "test-model",
    VIDEOSBATCH_LLM_MAX_RETRIES: "1",
    VIDEOSBATCH_LLM_RETRY_DELAYS_MS: "0"
  });
  const executor = createVideosBatchLlmExecutor(config);
  const result = await executor.generateStructured<{ ok: boolean }>({
    operation: "COURSE_INTRO_CANDIDATES",
    systemPrompt: "Return canonical structured course-intro candidates.",
    userPrompt: "Generate the result for this lesson.",
    schemaName: "course_intro_candidates",
    jsonSchema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false
    }
  });

  assert.deepEqual(result.data, { ok: true, note: "line1\nline2" });
  assert.equal(result.provider, "openai-responses");
  assert.equal(result.model, "test-model");
  assert.equal(result.responseId, "resp_test");
  assert.equal(result.usage?.totalTokens, 16);

  let retryRequests = 0;
  const retryKeys: string[] = [];
  const retryServer = http.createServer(async (req, res) => {
    retryRequests += 1;
    retryKeys.push(String(req.headers["idempotency-key"] || ""));
    if (retryRequests === 1) {
      res.statusCode = 503;
      res.end("temporary upstream failure");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ ok: true }) }] }] }));
  });
  retryServer.listen(0, "127.0.0.1");
  await once(retryServer, "listening");
  const retryAddress = retryServer.address();
  if (!retryAddress || typeof retryAddress === "string") throw new Error("retry server did not expose a TCP port");
  try {
    const retryConfig = resolveVideosBatchLlmConfig({
      VIDEOSBATCH_LLM_API_KEY: "test-key",
      VIDEOSBATCH_LLM_BASE_URL: `http://127.0.0.1:${retryAddress.port}/v1`,
      VIDEOSBATCH_LLM_MODEL: "test-model",
      VIDEOSBATCH_LLM_MAX_RETRIES: "1",
      VIDEOSBATCH_LLM_RETRY_DELAYS_MS: "0"
    });
    const retryResult = await createVideosBatchLlmExecutor(retryConfig).generateStructured<{ ok: boolean }>({ operation: "RETRY", systemPrompt: "x", userPrompt: "y", schemaName: "retry", jsonSchema: { type: "object" }, idempotencyKey: "retry-operation-key" });
    assert.deepEqual(retryResult.data, { ok: true });
    assert.equal(retryRequests, 2, "503 should be retried once");
    assert.ok(retryKeys[0] && retryKeys[0] === retryKeys[1], "network retries must reuse the same idempotency key");
  } finally {
    retryServer.close();
    await once(retryServer, "close");
  }

  let exhaustedRequests = 0;
  const exhaustedServer = http.createServer((_req, res) => {
    exhaustedRequests += 1;
    res.statusCode = 524;
    res.end("temporary upstream failure");
  });
  exhaustedServer.listen(0, "127.0.0.1");
  await once(exhaustedServer, "listening");
  const exhaustedAddress = exhaustedServer.address();
  if (!exhaustedAddress || typeof exhaustedAddress === "string") throw new Error("exhausted server did not expose a TCP port");
  try {
    const exhaustedConfig = resolveVideosBatchLlmConfig({
      VIDEOSBATCH_LLM_API_KEY: "test-key",
      VIDEOSBATCH_LLM_BASE_URL: `http://127.0.0.1:${exhaustedAddress.port}/v1`,
      VIDEOSBATCH_LLM_MODEL: "test-model",
      VIDEOSBATCH_LLM_MAX_RETRIES: "2",
      VIDEOSBATCH_LLM_RETRY_DELAYS_MS: "0"
    });
    await assert.rejects(
      () => createVideosBatchLlmExecutor(exhaustedConfig).generateStructured({ operation: "EXHAUSTED", systemPrompt: "x", userPrompt: "y", schemaName: "exhausted", jsonSchema: { type: "object" } }),
      (error: any) => error?.code === "HTTP_524"
        && error?.attempts === 3
        && Array.isArray(error?.attemptLog)
        && error.attemptLog.length === 3
    );
    assert.equal(exhaustedRequests, 3, "bounded provider failure must expose all three attempts");
  } finally {
    exhaustedServer.close();
    await once(exhaustedServer, "close");
  }

  let fallbackRequests = 0;
  const fallbackKeys: string[] = [];
  let primaryFailureRequests = 0;
  const fallbackServer = http.createServer(async (req, res) => {
    fallbackRequests += 1;
    fallbackKeys.push(String(req.headers["idempotency-key"] || ""));
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, "deepseek-v4-flash");
    assert.equal(req.headers.authorization, "Bearer test-fallback-key");
    assert.equal(body.text.format.type, "json_schema");
    assert.deepEqual(body.reasoning, { effort: "none" }, "an explicit stage reasoning=none must be sent on the fallback route");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ ok: true }) }] }] }));
  });
  let primaryKey = "";
  const primaryFailureServer = http.createServer((req, res) => {
    primaryFailureRequests += 1;
    primaryKey = String(req.headers["idempotency-key"] || "");
    res.statusCode = 503;
    res.end("primary unavailable");
  });
  fallbackServer.listen(0, "127.0.0.1");
  primaryFailureServer.listen(0, "127.0.0.1");
  await Promise.all([once(fallbackServer, "listening"), once(primaryFailureServer, "listening")]);
  const fallbackAddress = fallbackServer.address();
  const primaryFailureAddress = primaryFailureServer.address();
  if (!fallbackAddress || typeof fallbackAddress === "string" || !primaryFailureAddress || typeof primaryFailureAddress === "string") {
    throw new Error("fallback servers did not expose TCP ports");
  }
  try {
    const fallbackConfig = resolveVideosBatchLlmConfig({
      VIDEOSBATCH_LLM_API_KEY: "test-primary-key",
      VIDEOSBATCH_LLM_BASE_URL: `http://127.0.0.1:${primaryFailureAddress.port}/v1`,
      VIDEOSBATCH_LLM_MODEL: "gpt-5.6-terra",
      VIDEOSBATCH_LLM_FALLBACK_MODELS: "deepseek-v4-flash",
      VIDEOSBATCH_LLM_FALLBACK_API_KEY: "test-fallback-key",
      VIDEOSBATCH_LLM_FALLBACK_BASE_URL: `http://127.0.0.1:${fallbackAddress.port}/v1`,
      VIDEOSBATCH_LLM_FALLBACK_OUTPUT_MODE: "json_schema",
       VIDEOSBATCH_LLM_FALLBACK_REASONING: "none",
      VIDEOSBATCH_LLM_MAX_RETRIES: "0"
    });
    const fallbackResult = await createVideosBatchLlmExecutor(fallbackConfig).generateStructured<{ ok: boolean }>({
      operation: "FALLBACK",
      systemPrompt: "x",
      userPrompt: "y",
      schemaName: "fallback",
      jsonSchema: { type: "object" },
      reasoningEffort: "medium",
      idempotencyKey: "fallback-operation-key"
    });
    assert.deepEqual(fallbackResult.data, { ok: true });
    assert.equal(fallbackResult.model, "deepseek-v4-flash");
    assert.equal(fallbackRequests, 1, "a failed primary model should route once to the configured fallback");
    assert.ok(fallbackKeys[0] && fallbackKeys[0] !== primaryKey, "provider switch must use a distinct idempotency key");
    const fallbackOnlyResult = await createVideosBatchLlmExecutor(fallbackConfig).generateStructured<{ ok: boolean }>({
      operation: "CONTRACT_REPAIR",
      systemPrompt: "x",
      userPrompt: "repair exact validation errors",
      schemaName: "fallback",
      jsonSchema: { type: "object" },
      reasoningEffort: "medium",
      providerRoute: "fallback-only",
      idempotencyKey: "repair-operation-key"
    });
    assert.deepEqual(fallbackOnlyResult.data, { ok: true });
    assert.equal(primaryFailureRequests, 1, "fallback-only contract repair must not call the primary provider again");
    assert.equal(fallbackRequests, 2, "fallback-only contract repair must call the fallback provider directly");
  } finally {
    primaryFailureServer.close();
    fallbackServer.close();
    await Promise.all([once(primaryFailureServer, "close"), once(fallbackServer, "close")]);
  }

  const missing = createVideosBatchLlmExecutor(resolveVideosBatchLlmConfig({
    VIDEOSBATCH_LLM_PROVIDER: "openai-responses",
    VIDEOSBATCH_LLM_MODEL: "test-model"
  }));
  await assert.rejects(
    () => missing.generateStructured({
      operation: "STORY_SCRIPT",
      systemPrompt: "x",
      userPrompt: "y",
      schemaName: "story_script",
      jsonSchema: { type: "object", properties: {}, additionalProperties: false }
    }),
    /VIDEOSBATCH_LLM_API_KEY|OPENAI_API_KEY/
  );

  console.log("VideosBatch canonical LLM executor smoke passed");
} finally {
  server.close();
  await once(server, "close");
  if (previousNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = previousNoProxy;
  if (previousNoProxyLower === undefined) delete process.env.no_proxy;
  else process.env.no_proxy = previousNoProxyLower;
}
