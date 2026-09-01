import { strict as assert } from "node:assert";
import { generateAssetImage } from "../src/server/generators";

const previous = {
  key: process.env.VIDEOSBATCH_IMAGE_API_KEY,
  base: process.env.VIDEOSBATCH_IMAGE_BASE_URL,
  model: process.env.VIDEOSBATCH_IMAGE_MODEL,
  size: process.env.VIDEOSBATCH_IMAGE_SIZE,
  fetch: globalThis.fetch
};

const asset = { id: "asset_lyaiapp_smoke", name: "测试素材", prompt: "一间明亮的教室" } as any;

try {
  delete process.env.VIDEOSBATCH_IMAGE_API_KEY;
  await assert.rejects(() => generateAssetImage(asset, "gpt-image-2-1k"), /VIDEOSBATCH_IMAGE_API_KEY/);

  process.env.VIDEOSBATCH_IMAGE_API_KEY = "test-only-image-key";
  process.env.VIDEOSBATCH_IMAGE_BASE_URL = "https://mock.lyaiapp.test/v1";
  process.env.VIDEOSBATCH_IMAGE_MODEL = "gpt-image-2-1k";
  process.env.VIDEOSBATCH_IMAGE_SIZE = "16:9";

  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), "https://mock.lyaiapp.test/v1/images/generations");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-image-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "gpt-image-2-1k");
    assert.equal(body.size, "16:9");
    assert.equal(body.prompt, "一间明亮的教室");
    return new Response(JSON.stringify({ data: [{ url: "https://cdn.test/image.png" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const urlResult = await generateAssetImage(asset, "gpt-image-2-1k");
  assert.equal(urlResult.url, "https://cdn.test/image.png");

  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: "ZmFrZQ==" }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const b64Result = await generateAssetImage(asset, "gpt-image-2-1k");
  assert.equal(b64Result.url, "data:image/png;base64,ZmFrZQ==");
  assert.equal(calls, 1, "the mocked URL request should be observed exactly once");
  console.log("VideosBatch LyAIApp image smoke passed");
} finally {
  if (previous.key === undefined) delete process.env.VIDEOSBATCH_IMAGE_API_KEY;
  else process.env.VIDEOSBATCH_IMAGE_API_KEY = previous.key;
  if (previous.base === undefined) delete process.env.VIDEOSBATCH_IMAGE_BASE_URL;
  else process.env.VIDEOSBATCH_IMAGE_BASE_URL = previous.base;
  if (previous.model === undefined) delete process.env.VIDEOSBATCH_IMAGE_MODEL;
  else process.env.VIDEOSBATCH_IMAGE_MODEL = previous.model;
  if (previous.size === undefined) delete process.env.VIDEOSBATCH_IMAGE_SIZE;
  else process.env.VIDEOSBATCH_IMAGE_SIZE = previous.size;
  globalThis.fetch = previous.fetch;
}
