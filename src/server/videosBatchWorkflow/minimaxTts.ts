import { createHash } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideosBatchAudioEvent } from "../../shared/videosBatchWorkflow";
import { MEDIA_DIR } from "../generators";
import { fetchWithRetry } from "../fetchWithRetry";
/**
 * MiniMax T2A v2 speech synthesis for the AUDIO_DELIVERY stage.
 *
 * Contract notes that shaped this module:
 *  - `GroupId` is historically a URL query parameter. Credentials issued in the
 *    `sk-cp-` format are account-scoped and are accepted without it, so the
 *    parameter is only attached when `MINIMAX_GROUP_ID` is explicitly set.
 *  - The endpoint is synchronous and stateless: one POST returns the whole clip.
 *    `output_format: "hex"` inlines the audio in `data.audio`; there is no async
 *    task id to poll and no URL to expire.
 *  - MiniMax bills per synthesized character, so a request is only issued when
 *    the declared event actually carries speakable text.
 */

export const MINIMAX_TTS_PROVIDER = "minimax-t2a-v2";

export const MINIMAX_TTS_DEFAULT_BASE_URL = "https://api.minimaxi.com/v1/t2a_v2";
export const MINIMAX_TTS_DEFAULT_MODEL = "speech-02-turbo";
export const MINIMAX_TTS_DEFAULT_VOICE_ID = "male-qn-qingse";
export const MINIMAX_TTS_DEFAULT_SAMPLE_RATE = 32_000;
/** MiniMax accepts `text` up to 10 000 characters; stay well under the wire limit. */
export const MINIMAX_TTS_MAX_TEXT_LENGTH = 9_000;

export interface MiniMaxTtsConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  voiceId: string;
  /** Optional legacy query parameter; omitted for account-scoped `sk-cp-` credentials. */
  groupId?: string;
  /** Default playback rate; per-event speed overrides this when a duration is known. */
  speed: number;
  vol: number;
  pitch: number;
  sampleRate: number;
  format: "mp3" | "pcm" | "flac" | "wav";
  timeoutMs: number;
  maxRetries: number;
}

/** Raised for provider-side failures so callers can surface a precise code. */
export class MiniMaxTtsError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "MiniMaxTtsError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * `base_resp.status_code` semantics published by MiniMax. Anything not listed is
 * treated as a terminal provider error so a silent misconfiguration cannot be
 * retried into a loop.
 */
const MINIMAX_STATUS_CODES: Record<number, { code: string; retryable: boolean; message: string }> = {
  0: { code: "OK", retryable: false, message: "success" },
  1002: { code: "MINIMAX_RATE_LIMITED", retryable: true, message: "请求速率超限" },
  1004: { code: "MINIMAX_AUTH_FAILED", retryable: false, message: "鉴权失败，请检查 API Key" },
  1008: { code: "MINIMAX_INSUFFICIENT_BALANCE", retryable: false, message: "账户余额不足" },
  1039: { code: "MINIMAX_TPM_LIMITED", retryable: true, message: "TPM 速率超限" },
  1042: { code: "MINIMAX_INVALID_CHARACTERS", retryable: false, message: "文本含非法字符超过 10%" },
  2013: { code: "MINIMAX_INVALID_PARAMS", retryable: false, message: "请求参数异常" }
};

export function resolveMiniMaxTtsConfig(
  env: Record<string, string | undefined> = process.env
): MiniMaxTtsConfig | undefined {
  const apiKey = trimmed(env.MINIMAX_API_KEY);
  if (!apiKey) return undefined;

  const format = (trimmed(env.MINIMAX_AUDIO_FORMAT) || "mp3").toLowerCase();
  if (format !== "mp3" && format !== "pcm" && format !== "flac" && format !== "wav") {
    throw new Error(`MINIMAX_AUDIO_FORMAT must be one of: mp3, pcm, flac, wav (received: ${format})`);
  }

  return {
    apiKey,
    baseUrl: trimmed(env.MINIMAX_TTS_BASE_URL) || MINIMAX_TTS_DEFAULT_BASE_URL,
    model: trimmed(env.MINIMAX_TTS_MODEL) || MINIMAX_TTS_DEFAULT_MODEL,
    voiceId: trimmed(env.MINIMAX_TTS_VOICE_ID) || MINIMAX_TTS_DEFAULT_VOICE_ID,
    groupId: trimmed(env.MINIMAX_GROUP_ID) || undefined,
    speed: clampNumber(trimmed(env.MINIMAX_TTS_SPEED), 0.5, 2, 1),
    vol: clampNumber(trimmed(env.MINIMAX_TTS_VOL), 0.01, 10, 1),
    pitch: clampNumber(trimmed(env.MINIMAX_TTS_PITCH), -12, 12, 0),
    sampleRate: Math.round(clampNumber(trimmed(env.MINIMAX_TTS_SAMPLE_RATE), 8_000, 48_000, MINIMAX_TTS_DEFAULT_SAMPLE_RATE)),
    format,
    timeoutMs: Math.round(clampNumber(trimmed(env.MINIMAX_TTS_TIMEOUT_MS), 5_000, 600_000, 120_000)),
    maxRetries: Math.round(clampNumber(trimmed(env.MINIMAX_TTS_MAX_RETRIES), 0, 5, 2))
  };
}

/**
 * Convert a declared event window into a MiniMax `speed` value.
 *
 * The timeline decides how long a line may occupy; MiniMax only accepts a rate
 * multiplier. We estimate the natural speaking duration from the character count
 * and scale the rate so the clip lands near the window instead of overrunning the
 * shot. The result is clamped to MiniMax's documented [0.5, 2] range — when the
 * window is far too short for the text we stop at the fastest legal rate rather
 * than emit an unsupported value.
 */
export function deriveSpeechSpeed(text: string, durationSec: number, baseSpeed = 1): number {
  const characters = countSpeakableCharacters(text);
  if (!characters || !Number.isFinite(durationSec) || durationSec <= 0) return clampSpeed(baseSpeed);
  // ~4.8 Chinese characters per second reads as natural conversational pacing.
  const naturalSec = characters / 4.8;
  const ratio = naturalSec / durationSec;
  if (!Number.isFinite(ratio) || ratio <= 0) return clampSpeed(baseSpeed);
  return clampSpeed(baseSpeed * ratio);
}

/**
 * Synthesize one narration/dialogue event and return a locally readable
 * `/media/...` URL. Files are content-addressed so a re-run with identical text,
 * voice and window reuses the existing clip instead of paying for it again.
 */
export async function synthesizeMiniMaxSpeech(
  event: VideosBatchAudioEvent,
  sessionId: string,
  config?: MiniMaxTtsConfig
): Promise<string> {
  const resolved = config ?? resolveMiniMaxTtsConfig();
  if (!resolved) {
    throw new MiniMaxTtsError(
      "MINIMAX_API_KEY_MISSING",
      "MINIMAX_API_KEY 未配置；请设置该变量或把 VIDEOSBATCH_TTS_PROVIDER 切回 fake"
    );
  }

  const spoken = (event.text || "").trim();
  if (!spoken) {
    // Nothing to say: this is a contract violation upstream, not a provider error.
    throw new MiniMaxTtsError("MINIMAX_EMPTY_TEXT", `音频事件 ${event.id} 没有可合成的文本`);
  }
  if (spoken.length > MINIMAX_TTS_MAX_TEXT_LENGTH) {
    throw new MiniMaxTtsError(
      "MINIMAX_TEXT_TOO_LONG",
      `音频事件 ${event.id} 文本长度 ${spoken.length} 超过上限 ${MINIMAX_TTS_MAX_TEXT_LENGTH}`
    );
  }

  const durationSec = Math.max(0.2, roundSec(Number(event.endSec) - Number(event.startSec)));
  const speed = deriveSpeechSpeed(spoken, durationSec, resolved.speed);

  const stem = audioFileStem(sessionId, {
    model: resolved.model,
    voiceId: resolved.voiceId,
    speed,
    vol: resolved.vol,
    pitch: resolved.pitch,
    format: resolved.format,
    sampleRate: resolved.sampleRate,
    text: spoken
  });
  const outputName = `${stem}.${resolved.format}`;
  const outputPath = path.join(MEDIA_DIR, outputName);

  await mkdir(MEDIA_DIR, { recursive: true });
  // Content-addressed cache: only skip the call when a non-empty artifact exists.
  if (await fileExists(outputPath)) return `/media/${outputName}`;

  const audio = await requestMiniMaxAudio({ ...resolved, speed }, spoken);
  try {
    await writeFile(outputPath, audio);
  } catch (error) {
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
  return `/media/${outputName}`;
}

/**
 * POST one non-streaming synthesis request and return the decoded audio bytes.
 * Exported for tests so the wire contract can be asserted without a network call.
 */
export async function requestMiniMaxAudio(
  config: MiniMaxTtsConfig & { speed: number },
  text: string
): Promise<Buffer> {
  const url = buildRequestUrl(config);
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      text,
      stream: false,
      // `output_format: "hex"` is the only mode guaranteed to work for every
      // credential; it inlines the clip so there is no short-lived URL to chase.
      output_format: "hex",
      voice_setting: {
        voice_id: config.voiceId,
        speed: config.speed,
        vol: config.vol,
        pitch: config.pitch
      },
      audio_setting: {
        sample_rate: config.sampleRate,
        format: config.format,
        channel: 1
      }
    }),
    timeoutMs: config.timeoutMs,
    retries: config.maxRetries,
    // Synthesis is billed per character; a timed-out POST may still have produced
    // audio server-side, so only pre-flight network errors are retried.
    idempotent: false,
    tag: "minimax-t2a"
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new MiniMaxTtsError(
      `MINIMAX_HTTP_${response.status}`,
      `MiniMax TTS 返回 HTTP ${response.status}: ${truncate(raw, 300)}`,
      { retryable: response.status === 429 || response.status >= 500 }
    );
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new MiniMaxTtsError("MINIMAX_BAD_JSON", `MiniMax TTS 返回了非 JSON 响应: ${truncate(raw, 300)}`);
  }

  const statusCode = Number(payload?.base_resp?.status_code ?? 0);
  if (statusCode !== 0) {
    const known = MINIMAX_STATUS_CODES[statusCode];
    throw new MiniMaxTtsError(
      known?.code || `MINIMAX_STATUS_${statusCode}`,
      known
        ? `${known.message} (status_code=${statusCode}${payload?.base_resp?.status_msg ? `, ${payload.base_resp.status_msg}` : ""})`
        : `MiniMax TTS 失败 status_code=${statusCode}: ${truncate(String(payload?.base_resp?.status_msg || raw), 200)}`,
      { retryable: known?.retryable ?? false }
    );
  }

  const hex = payload?.data?.audio;
  if (typeof hex !== "string" || !hex.length) {
    // A successful status with no payload usually means the text was filtered or
    // the account is out of quota; surface it instead of writing an empty file.
    throw new MiniMaxTtsError(
      "MINIMAX_EMPTY_AUDIO",
      `MiniMax TTS 未返回音频数据 (extra_info=${truncate(JSON.stringify(payload?.extra_info ?? {}), 200)})`
    );
  }

  const audio = decodeHexAudio(hex);
  if (!audio.length) {
    throw new MiniMaxTtsError("MINIMAX_EMPTY_AUDIO", "MiniMax TTS 返回的音频数据长度为 0");
  }
  return audio;
}

/** Attach the legacy `GroupId` query parameter only when it is explicitly configured. */
export function buildRequestUrl(config: Pick<MiniMaxTtsConfig, "baseUrl" | "groupId">): string {
  const groupId = trimmed(config.groupId);
  if (!groupId) return config.baseUrl;
  const separator = config.baseUrl.includes("?") ? "&" : "?";
  return `${config.baseUrl}${separator}GroupId=${encodeURIComponent(groupId)}`;
}

/**
 * `data.audio` is a hex-encoded byte string. Reject malformed input explicitly so
 * a truncated payload cannot be written to disk as a plausible-looking clip.
 */
export function decodeHexAudio(hex: string): Buffer {
  const normalized = hex.trim();
  if (!normalized.length) return Buffer.alloc(0);
  if (normalized.length % 2 !== 0) {
    throw new MiniMaxTtsError("MINIMAX_HEX_INVALID", "MiniMax TTS 返回的 hex 长度为奇数，数据被截断");
  }
  if (!/^[0-9a-fA-F]+$/u.test(normalized)) {
    throw new MiniMaxTtsError("MINIMAX_HEX_INVALID", "MiniMax TTS 返回的音频不是合法的 hex 编码");
  }
  return Buffer.from(normalized, "hex");
}

function audioFileStem(sessionId: string, identity: Record<string, unknown>) {
  const digest = createHash("sha1").update(JSON.stringify(identity)).digest("hex").slice(0, 12);
  return `tts-minimax-${sessionId}-${digest}`;
}

/** Count characters that actually consume speech budget; whitespace and punctuation do not. */
function countSpeakableCharacters(text: string) {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

function clampSpeed(value: number) {
  return roundSec(Math.min(2, Math.max(0.5, Number.isFinite(value) ? value : 1)));
}

function clampNumber(raw: string, min: number, max: number, fallback: number) {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function roundSec(value: number) {
  return Math.round(value * 1000) / 1000;
}

function trimmed(value: unknown) {
  return String(value ?? "").trim();
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function fileExists(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
