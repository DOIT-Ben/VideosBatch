import { strict as assert } from "node:assert";
import { readResponsesStream, ResponsesStreamError } from "../src/server/videosBatchWorkflow/responsesStream";
import { createVideosBatchLlmExecutor, resolveVideosBatchLlmConfig, createVideosBatchLlmAttemptBudget } from "../src/server/videosBatchWorkflow/llmExecutor";

const event = (value: any) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const delta = event({ type: "response.output_text.delta", delta: '{"text":"中文"}' });
const completed = event({ type: "response.completed", response: { status: "completed", id: "r1", model: "model", usage: { input_tokens: 2, output_tokens: 3 } } });
function response(text: string, failAfter = false) {
  const bytes = new TextEncoder().encode(text); let i = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (i < bytes.length) controller.enqueue(bytes.slice(i, ++i));
    else if (failAfter) controller.error(new Error("socket reset"));
    else controller.close();
  }}), { headers: { "content-type": "text/event-stream" } });
}
for (const ending of ["\n", "\r", "\r\n"]) {
  const result = await readResponsesStream(response((delta + completed).replaceAll("\r\n", ending)));
  assert.equal(result.output_text, '{"text":"中文"}');
}
const fullTerminal = event({ type: "response.completed", response: { status: "completed", output: [{ content: [{ type: "output_text", text: '{"text":"final"}' }] }] } });
assert.equal((await readResponsesStream(response(delta + fullTerminal))).output[0].content[0].text, '{"text":"final"}');
const parsed = await readResponsesStream(response(": ping\r\n\r\n" + delta + completed));
assert.equal(parsed.output_text, '{"text":"中文"}'); assert.equal(parsed.id, "r1");
assert.deepEqual(parsed.usage, { input_tokens: 2, output_tokens: 3 });
for (const tail of ["data: [DONE]\n\n", event({ type: "response.incomplete" }), event({ type: "response.failed" }), "data: broken\n\n"]) {
  await assert.rejects(readResponsesStream(response(delta + tail)), (e: any) => e instanceof ResponsesStreamError && e.partialText.includes("中文"));
}
await assert.rejects(readResponsesStream(response(delta, true)), (e: any) => e.code === "STREAM_INTERRUPTED" && e.partialText.includes("中文"));
const original = globalThis.fetch;
let captured: any;
try {
  const executor = createVideosBatchLlmExecutor(resolveVideosBatchLlmConfig({ VIDEOSBATCH_LLM_MODEL: "model", VIDEOSBATCH_LLM_API_KEY: "fixture", VIDEOSBATCH_LLM_BASE_URL: "https://example.invalid/v1" }));
  const request = { operation: "STREAM", systemPrompt: "test", userPrompt: "test", schemaName: "test", jsonSchema: { type: "object" } };
  globalThis.fetch = async (_url, init) => { captured = JSON.parse(String(init?.body)); return response(delta + completed); };
  const result = await executor.generateStructured<{text:string}>(request);
  assert.equal(captured.stream, true); assert.equal(captured.text.format.strict, true);
  assert.equal(result.data.text, "中文"); assert.equal(result.attemptLog![0].metadata?.response_transport, "sse");
  assert.ok(result.attemptLog![0].metadata?.first_text_ms);
  await executor.generateStructured({ ...request, providerRoute: "same-model", routeId: result.routeId, model: result.requestedModel });
  assert.equal(captured.stream, true);
  let diagnostic: any;
  globalThis.fetch = async () => response(delta);
  await assert.rejects(executor.generateStructured({ ...request, budget: createVideosBatchLlmAttemptBudget(1), onInvalidResponse: async value => { diagnostic = value; } }), (e: any) => e.code === "STREAM_INTERRUPTED");
  assert.equal(diagnostic.rawText, '{"text":"中文"}');
  globalThis.fetch = async () => response(delta + event({ type: "response.reasoning_text.delta", delta: "private reasoning" }) + completed);
  assert.ok(!JSON.stringify(await executor.generateStructured(request)).includes("private reasoning"));
} finally { globalThis.fetch = original; }
console.log("Responses SSE chunks, completion, interruption, diagnostics and repair passed");
