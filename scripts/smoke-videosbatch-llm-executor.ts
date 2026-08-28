import { strict as assert } from "node:assert";
import http from "node:http";
import { once } from "node:events";
import {
  createVideosBatchLlmExecutor,
  resolveVideosBatchLlmConfig
} from "../src/server/videosBatchWorkflow/llmExecutor";

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
  assert.equal(body.metadata.operation, "COURSE_INTRO_CANDIDATES");

  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    id: "resp_test",
    model: "test-model",
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify({ ok: true }) }]
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
    VIDEOSBATCH_LLM_MODEL: "test-model"
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

  assert.deepEqual(result.data, { ok: true });
  assert.equal(result.provider, "openai-responses");
  assert.equal(result.model, "test-model");
  assert.equal(result.responseId, "resp_test");
  assert.equal(result.usage?.totalTokens, 16);

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
}
