import { strict as assert } from "node:assert";
import http from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { VideosBatchAudioEvent } from "../src/shared/videosBatchWorkflow";
import {
  MINIMAX_TTS_DEFAULT_BASE_URL,
  MINIMAX_TTS_DEFAULT_MODEL,
  MINIMAX_TTS_DEFAULT_VOICE_ID,
  buildRequestUrl,
  decodeHexAudio,
  deriveSpeechSpeed,
  requestMiniMaxAudio,
  resolveMiniMaxTtsConfig,
  synthesizeMiniMaxSpeech
} from "../src/server/videosBatchWorkflow/minimaxTts";
import {
  buildVideosBatchNativeMediaDeps,
  resolveVideosBatchTtsProvider
} from "../src/server/videosBatchWorkflow/nativeMediaStages";

/**
 * MiniMax TTS contract smoke.
 *
 * The default run is fully offline: it pins the request shape, the hex decoding,
 * the error-code mapping and the deps wiring against a local mock server. Set
 * VIDEOSBATCH_SMOKE_MINIMAX_LIVE=1 with a real MINIMAX_API_KEY to additionally
 * exercise one billed round-trip against the actual provider.
 */

const SAFE_KEY = "minimax-test-key-that-must-not-leak";

// ---------------------------------------------------------------- config layer

assert.equal(resolveMiniMaxTtsConfig({}), undefined, "no key means no minimax config");

const config = resolveMiniMaxTtsConfig({ MINIMAX_API_KEY: ` ${SAFE_KEY} `, MINIMAX_TTS_SPEED: "9" });
assert.ok(config, "a key must produce a config");
assert.equal(config!.apiKey, SAFE_KEY, "config must trim the key");
assert.equal(config!.baseUrl, MINIMAX_TTS_DEFAULT_BASE_URL);
assert.equal(config!.model, MINIMAX_TTS_DEFAULT_MODEL);
assert.equal(config!.voiceId, MINIMAX_TTS_DEFAULT_VOICE_ID);
assert.equal(config!.speed, 2, "out-of-range speed must clamp to MiniMax's documented maximum");
assert.equal(config!.format, "mp3");
assert.equal(config!.groupId, undefined, "GroupId must stay absent unless explicitly configured");

assert.throws(
  () => resolveMiniMaxTtsConfig({ MINIMAX_API_KEY: SAFE_KEY, MINIMAX_AUDIO_FORMAT: "ogg" }),
  /MINIMAX_AUDIO_FORMAT/,
  "an unsupported container must be rejected instead of sent to the provider"
);

// GroupId is a legacy URL query parameter — attach it only when configured.
assert.equal(buildRequestUrl({ baseUrl: MINIMAX_TTS_DEFAULT_BASE_URL }), MINIMAX_TTS_DEFAULT_BASE_URL);
assert.equal(
  buildRequestUrl({ baseUrl: MINIMAX_TTS_DEFAULT_BASE_URL, groupId: " 12345 " }),
  `${MINIMAX_TTS_DEFAULT_BASE_URL}?GroupId=12345`
);
assert.equal(
  buildRequestUrl({ baseUrl: `${MINIMAX_TTS_DEFAULT_BASE_URL}?x=1`, groupId: "1" }),
  `${MINIMAX_TTS_DEFAULT_BASE_URL}?x=1&GroupId=1`
);

// ------------------------------------------------------------- speed derivation

assert.equal(deriveSpeechSpeed("", 5), 1, "empty text keeps the base speed");
assert.equal(deriveSpeechSpeed("你好世界", 0), 1, "an unknown window keeps the base speed");
// 24 characters over 2 seconds needs ~2.5x natural pace, clamped to the 2.0 ceiling.
assert.equal(deriveSpeechSpeed("这是一段需要加速朗读以塞进很短时间窗口的文字内容", 2), 2);
// 5 characters over 30 seconds is slow but legal — the estimator must not floor it to 0.5 blindly.
assert.ok(deriveSpeechSpeed("你好世界啊", 30) >= 0.5, "speed must never fall below the provider minimum");
assert.ok(deriveSpeechSpeed("你好世界啊", 300) === 0.5, "an absurdly long window clamps to the provider minimum");
// Punctuation and whitespace must not consume speech budget.
assert.equal(deriveSpeechSpeed("你好，世界！", 10), deriveSpeechSpeed("你好世界", 10));

// ---------------------------------------------------------------- hex decoding

assert.equal(decodeHexAudio("").length, 0);
assert.equal(decodeHexAudio("  48656c6c6f  ").toString("utf8"), "Hello", "hex must decode after trimming");
assert.deepEqual([...decodeHexAudio("00ff10")], [0, 255, 16]);
assert.throws(() => decodeHexAudio("abc"), /hex/i, "an odd-length hex payload is truncated data");
assert.throws(() => decodeHexAudio("zz11"), /hex/i, "non-hex characters must be rejected");

// ------------------------------------------------------------- request contract

const audioBytes = Buffer.from("seereel-minimax-audio-payload", "utf8");
let captured: { url: string; auth: string; body: any } | undefined;

const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  captured = {
    url: String(req.url),
    auth: String(req.headers.authorization || ""),
    body: JSON.parse(raw)
  };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    data: { audio: audioBytes.toString("hex") },
    extra_info: { audio_length: 1234, audio_sample_rate: 32000, audio_format: "mp3" },
    base_resp: { status_code: 0, status_msg: "success" }
  }));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("mock minimax server did not expose a TCP port");

try {
  const baseUrl = `http://127.0.0.1:${address.port}/v1/t2a_v2`;
  const mockConfig = {
    ...config!,
    baseUrl,
    speed: 1.25,
    timeoutMs: 5_000,
    maxRetries: 0
  };
  const audio = await requestMiniMaxAudio(mockConfig, "第一段旁白");
  assert.equal(audio.toString("utf8"), audioBytes.toString("utf8"), "the decoded payload must round-trip byte for byte");

  assert.ok(captured, "the provider must receive exactly one request");
  assert.equal(captured!.auth, `Bearer ${SAFE_KEY}`);
  assert.equal(captured!.url, "/v1/t2a_v2", "GroupId must be omitted when not configured");
  assert.equal(captured!.body.model, MINIMAX_TTS_DEFAULT_MODEL);
  assert.equal(captured!.body.text, "第一段旁白");
  assert.equal(captured!.body.stream, false, "synthesis must be non-streaming");
  assert.equal(captured!.body.output_format, "hex", "hex is the only mode with no expiring URL to chase");
  assert.equal(captured!.body.voice_setting.voice_id, MINIMAX_TTS_DEFAULT_VOICE_ID);
  assert.equal(captured!.body.voice_setting.speed, 1.25);
  assert.notEqual(captured!.body.voice_setting.speed, undefined, "speed must be sent per request so the window can be matched");
  assert.equal(captured!.body.audio_setting.format, "mp3");
  assert.equal(captured!.body.audio_setting.sample_rate, 32000);
  assert.equal(captured!.body.audio_setting.channel, 1);
  assert.equal("GroupId" in captured!.body, false, "GroupId belongs in the query string, never the body");

  // A configured GroupId must reach the wire as a query parameter.
  captured = undefined;
  await requestMiniMaxAudio({ ...mockConfig, groupId: "98765" }, "第二段");
  assert.equal(captured!.url, "/v1/t2a_v2?GroupId=98765");
} finally {
  server.close();
  await once(server, "close");
}

// ------------------------------------------------------------ error mapping

async function expectProviderError(
  respond: (res: http.ServerResponse) => void,
  pattern: RegExp,
  label: string
): Promise<void> {
  const errorServer = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    respond(res);
  });
  errorServer.listen(0, "127.0.0.1");
  await once(errorServer, "listening");
  const errorAddress = errorServer.address();
  if (!errorAddress || typeof errorAddress === "string") throw new Error("error mock did not expose a port");
  try {
    await assert.rejects(
      () => requestMiniMaxAudio(
        { ...config!, baseUrl: `http://127.0.0.1:${errorAddress.port}/v1/t2a_v2`, speed: 1, timeoutMs: 5_000, maxRetries: 0 },
        "触发错误"
      ),
      pattern,
      label
    );
  } finally {
    errorServer.close();
    await once(errorServer, "close");
  }
}

await expectProviderError(
  (res) => { res.statusCode = 500; res.end("upstream exploded"); },
  /HTTP 500/,
  "an HTTP failure must surface the status"
);
await expectProviderError(
  (res) => { res.setHeader("content-type", "application/json"); res.end("not json at all"); },
  /非 JSON/,
  "a non-JSON body must not be mistaken for success"
);
await expectProviderError(
  (res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "auth failed" } }));
  },
  /鉴权失败/,
  "status_code 1004 must map to an auth failure, not a generic error"
);
await expectProviderError(
  (res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ base_resp: { status_code: 1039, status_msg: "tpm limited" } }));
  },
  /TPM/,
  "status_code 1039 must map to a rate-limit code so the caller can back off"
);
await expectProviderError(
  (res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: null, base_resp: { status_code: 0, status_msg: "success" } }));
  },
  /未返回音频数据/,
  "a null data payload with a success status must not be written as an empty clip"
);
await expectProviderError(
  (res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: { audio: "abc" }, base_resp: { status_code: 0 } }));
  },
  /hex/i,
  "a truncated hex payload must be rejected before it reaches disk"
);

// ------------------------------------------------------- synthesis + caching

const event: VideosBatchAudioEvent = {
  id: "narration-1",
  startSec: 0,
  endSec: 3,
  text: "同学们，今天我们来学习新的课文。",
  source: "TTS"
};

assert.ok(resolveMiniMaxTtsConfig({ MINIMAX_API_KEY: SAFE_KEY }), "config must resolve for the synthesis path");

async function expectSynthesisFailure(
  badEvent: VideosBatchAudioEvent,
  pattern: RegExp,
  label: string
): Promise<void> {
  await assert.rejects(
    () => synthesizeMiniMaxSpeech(badEvent, "ses_minimax_smoke", config!),
    pattern,
    label
  );
}

await expectSynthesisFailure({ ...event, text: "   " }, /没有可合成的文本/, "empty text must not be billed");
await expectSynthesisFailure(
  { ...event, text: "字".repeat(9_001) },
  /超过上限/,
  "text beyond the provider limit must be rejected locally instead of wasting a call"
);

// A real synthesis against the mock must produce a readable file. It has to land in
// the app's MEDIA_DIR — the directory the delivery gate reads back from.
const writeServer = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* drain */ }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    data: { audio: Buffer.from("real-clip-bytes").toString("hex") },
    base_resp: { status_code: 0 }
  }));
});
writeServer.listen(0, "127.0.0.1");
await once(writeServer, "listening");
const writeAddress = writeServer.address();
if (!writeAddress || typeof writeAddress === "string") throw new Error("write mock did not expose a port");

try {
  const writeConfig = {
    ...config!,
    baseUrl: `http://127.0.0.1:${writeAddress.port}/v1/t2a_v2`,
    timeoutMs: 5_000,
    maxRetries: 0
  };
  const url = await synthesizeMiniMaxSpeech(event, "ses_minimax_smoke", writeConfig);
  assert.match(url, /^\/media\/tts-minimax-ses_minimax_smoke-[0-9a-f]{12}\.mp3$/u, "synthesis must return a locally readable /media URL");

  const localPath = `${process.cwd()}/data/media/${url.replace("/media/", "")}`;
  assert.ok(existsSync(localPath), `synthesis must write ${localPath}`);
  assert.ok((await stat(localPath)).size > 0, "the synthesized file must not be empty");

  // Content-addressed reuse: an identical request must not hit the provider twice.
  let providerHits = 0;
  const countingServer = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    providerHits += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: { audio: Buffer.from("cached-clip").toString("hex") }, base_resp: { status_code: 0 } }));
  });
  countingServer.listen(0, "127.0.0.1");
  await once(countingServer, "listening");
  const countingAddress = countingServer.address();
  if (!countingAddress || typeof countingAddress === "string") throw new Error("counting mock did not expose a port");
  try {
    const countingConfig = { ...writeConfig, baseUrl: `http://127.0.0.1:${countingAddress.port}/v1/t2a_v2` };
    await synthesizeMiniMaxSpeech(event, "ses_minimax_smoke", countingConfig);
    assert.equal(providerHits, 0, "an identical event must reuse the on-disk clip instead of paying again");
  } finally {
    countingServer.close();
    await once(countingServer, "close");
  }
} finally {
  writeServer.close();
  await once(writeServer, "close");
}

// -------------------------------------------------------------- deps wiring

assert.equal(resolveVideosBatchTtsProvider({}), "fake", "an absent switch must keep the free fake path");
assert.equal(resolveVideosBatchTtsProvider({ VIDEOSBATCH_TTS_PROVIDER: " MINIMAX " }), "minimax");
assert.throws(() => resolveVideosBatchTtsProvider({ VIDEOSBATCH_TTS_PROVIDER: "elevenlabs" }), /VIDEOSBATCH_TTS_PROVIDER/);

const fakeDeps = buildVideosBatchNativeMediaDeps({});
const realDeps = buildVideosBatchNativeMediaDeps({ VIDEOSBATCH_TTS_PROVIDER: "minimax", MINIMAX_API_KEY: SAFE_KEY });
assert.notEqual(
  realDeps.synthesizeSpeech,
  fakeDeps.synthesizeSpeech,
  "minimax mode must swap in a real speech synthesizer"
);
assert.equal(
  realDeps.materializeSoundEffect,
  fakeDeps.materializeSoundEffect,
  "sound effects stay on the local fake — MiniMax T2A cannot synthesize them"
);
assert.equal(
  realDeps.mixAudioTimeline,
  fakeDeps.mixAudioTimeline,
  "mixing stays local; every stream is already a file on this machine"
);
assert.throws(
  () => buildVideosBatchNativeMediaDeps({ VIDEOSBATCH_TTS_PROVIDER: "minimax" }),
  /MINIMAX_API_KEY/,
  "minimax mode without a key must fail loudly rather than silently produce silence"
);

// ------------------------------------------------- optional billed round-trip

if (process.env.VIDEOSBATCH_SMOKE_MINIMAX_LIVE === "1") {
  const liveKey = (process.env.MINIMAX_API_KEY || "").trim();
  if (!liveKey) {
    console.log("VIDEOSBATCH_SMOKE_MINIMAX_LIVE=1 but MINIMAX_API_KEY is unset — skipping the billed round-trip");
  } else {
    const liveConfig = resolveMiniMaxTtsConfig(process.env);
    assert.ok(liveConfig, "live config must resolve");
    const liveUrl = await synthesizeMiniMaxSpeech(
      { id: "narration-live", startSec: 0, endSec: 4, text: "这是一次真实的语音合成验证。", source: "TTS" },
      "ses_minimax_live",
      liveConfig!
    );
    const livePath = `${process.cwd()}/data/media/${liveUrl.replace("/media/", "")}`;
    const liveSize = (await stat(livePath)).size;
    assert.ok(liveSize > 1_000, `live synthesis returned only ${liveSize} bytes`);
    console.log(`MiniMax live round-trip OK: ${liveUrl} (${liveSize} bytes)`);
  }
}

console.log("VideosBatch MiniMax TTS smoke passed");
