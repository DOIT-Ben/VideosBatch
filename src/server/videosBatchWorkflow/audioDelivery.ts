import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import type {
  VideosBatchAudioEvent,
  VideosBatchAudioTimeline
} from "../../shared/videosBatchWorkflow";
import { MEDIA_DIR, localMediaPathFromMediaUrl, runFfmpegCommand } from "../generators";

/**
 * VideosBatch audio delivery primitives.
 *
 * EXECUTION produces a structural audio timeline whose `tts` stream is empty and
 * whose `mix.status` is `pending`.  Those two facts are exactly what the STITCH
 * delivery gate rejects with `AUDIO_TIMELINE_NOT_READY`.  This module owns the
 * step in between: turning declared narration/dialogue/sound-effect intentions
 * into real, readable audio files and producing the final mixed track.
 *
 * The default implementations are deterministic local fakes.  They synthesize
 * silence of the correct duration so the whole pipeline — gate, timeline,
 * stitch signature and final video — can be exercised offline with zero
 * provider cost.  A real provider only has to replace these three functions.
 */

export const VIDEOS_BATCH_FAKE_AUDIO_PROVIDER = "videosbatch-fake-audio";

/** Stable file-name stem so repeated runs with identical input reuse the file. */
function audioFileStem(prefix: string, sessionId: string, identity: string) {
  const digest = createHash("sha1").update(identity).digest("hex").slice(0, 12);
  return `${prefix}-${sessionId}-${digest}`;
}

function roundSec(value: number) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Synthesize a spoken segment. The fake writes silence for the declared
 * duration; a real provider returns its own audio URL.
 */
export async function synthesizeFakeSpeech(event: VideosBatchAudioEvent, sessionId: string): Promise<string> {
  const durationSec = Math.max(0.2, roundSec(Number(event.endSec) - Number(event.startSec)));
  return writeSilentAudio({
    sessionId,
    stem: audioFileStem("tts", sessionId, `${event.id}:${event.text || ""}:${durationSec}`),
    durationSec
  });
}

/**
 * Materialize a sound-effect segment. The fake is an audible tone so a listener
 * can tell an effect apart from speech silence; a real provider returns a URL.
 */
export async function materializeFakeSoundEffect(event: VideosBatchAudioEvent, sessionId: string): Promise<string> {
  const durationSec = Math.max(0.2, roundSec(Number(event.endSec) - Number(event.startSec)));
  return writeToneAudio({
    sessionId,
    stem: audioFileStem("sfx", sessionId, `${event.id}:${event.text || ""}:${durationSec}`),
    durationSec,
    frequencyHz: 660
  });
}

/** One audible stream, kept together with the timeline position it belongs to. */
export interface AudibleMixInput {
  path: string;
  startSec: number;
}

/**
 * Filter graph for the mixed track.
 *
 * Every input is placed at its own timeline offset (`adelay`) and only then
 * padded/trimmed to the full timeline length, so the mix keeps the timing the
 * delivery gate validated. Omitting the delay collapses every event onto 0s and
 * the final film plays all speech at once — and the gate cannot see it, because
 * it only checks time ranges and URL shape (2026-09-16). Order matters: delay
 * first, then `apad,atrim`, otherwise the padding is shifted instead of the clip.
 * `aformat` pins stereo so the two-value `adelay` form is always valid.
 *
 * The per-input `apad,atrim` + equal-length `amix` shape is deliberate: padding
 * the MIX OUTPUT with a trailing `apad,atrim` deadlocks the bundled ffmpeg
 * (2026-09-12 Tier 1 finding: 20+ min busy-spin at 59 inputs, zero output).
 */
export function buildAudioMixChains(inputs: AudibleMixInput[], durationSec: number, gain: number): string[] {
  const chains: string[] = [];
  const labels: string[] = [];
  inputs.forEach((input, index) => {
    const delayMs = Math.max(0, Math.round(input.startSec * 1000));
    const delay = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : "";
    chains.push(`[${index}:a]aformat=channel_layouts=stereo${delay},apad,atrim=0:${durationSec}[p${index}]`);
    labels.push(`[p${index}]`);
  });
  chains.push(`${labels.join("")}amix=inputs=${inputs.length}:duration=longest,volume=${gain}[out]`);
  return chains;
}

/**
 * Mix every deliverable stream into one track. `amix` normalizes the summed
 * volume so overlapping speech and effects do not clip.
 */
export async function mixFakeAudioTimeline(
  timeline: VideosBatchAudioTimeline,
  sessionId: string
): Promise<{ mixAudioUrl: string; durationSec: number }> {
  const durationSec = Math.max(0.2, roundSec(Number(timeline.durationSec) || 0));
  // Keep each event's own timeline position: the mix has to reproduce the timing
  // the delivery gate validated, not just the set of clips.
  const inputs: AudibleMixInput[] = [
    ...timeline.streams.tts,
    ...timeline.streams.soundEffects
  ].map((event) => ({
    path: localMediaPathFromMediaUrl(String(event.audioUrl || "")),
    startSec: Math.max(0, Number(event.startSec) || 0)
  })).filter((candidate): candidate is AudibleMixInput => Boolean(candidate.path));

  // A stream that declares audio but cannot be resolved locally used to be
  // dropped silently: the stage still reported READY and the gate still passed
  // while the final film was missing that line. Refuse instead of shipping a
  // quietly incomplete mix.
  const declared = timeline.streams.tts.length + timeline.streams.soundEffects.length;
  if (inputs.length !== declared) {
    throw Object.assign(
      new Error(`混音只能消费本机媒体：${declared} 个音频事件中有 ${declared - inputs.length} 个无法解析为本地文件`),
      { code: "AUDIO_MIX_SOURCE_UNRESOLVED", retryable: false }
    );
  }

  await mkdir(MEDIA_DIR, { recursive: true });
  const stem = audioFileStem(
    "mix",
    sessionId,
    `${timeline.sourceHash}:${durationSec}:${inputs.map((input) => `${input.startSec}@${input.path}`).join("|")}`
  );
  const outputName = `${stem}.m4a`;
  const outputPath = path.join(MEDIA_DIR, outputName);

  if (inputs.length && await fileExists(outputPath)) {
    return { mixAudioUrl: `/media/${outputName}`, durationSec };
  }

  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  if (inputs.length) {
    for (const input of inputs) args.push("-i", input.path);
    // Older bundled ffmpeg builds lack `amix`'s `normalize` option, so scale the
    // summed volume explicitly to keep the mix from clipping when tracks overlap.
    const gain = roundSec(1 / Math.max(1, inputs.length));
    args.push(
      "-filter_complex",
      buildAudioMixChains(inputs, durationSec, gain).join(";"),
      "-map",
      "[out]",
      "-c:a",
      "aac",
      "-b:a",
      "192k"
    );
  } else {
    // No audible events: still emit a real, readable, correctly-sized track so
    // the delivery gate is satisfied by an honest artifact rather than a stub.
    args.push(
      "-f",
      "lavfi",
      "-t",
      String(durationSec),
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:a",
      "aac",
      "-b:a",
      "192k"
    );
  }
  args.push(outputPath);

  try {
    await runFfmpegCommand(args);
  } catch (error) {
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
  return { mixAudioUrl: `/media/${outputName}`, durationSec };
}

/** Probe a synthesized audio file with ffmpeg; undefined means unmeasurable. */
export async function probeLocalAudioDuration(url: string): Promise<number | undefined> {
  const localPath = localMediaPathFromMediaUrl(url);
  if (!localPath) return undefined;
  if (!await fileExists(localPath)) return undefined;
  try {
    const stderr = await runFfmpegCapture(["-hide_banner", "-i", localPath]);
    const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/u.exec(stderr);
    if (!match) return undefined;
    const [, hours, minutes, seconds] = match;
    const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
    return Number.isFinite(total) ? roundSec(total) : undefined;
  } catch {
    return undefined;
  }
}

async function writeSilentAudio(options: { sessionId: string; stem: string; durationSec: number }) {
  return writeGeneratedAudio({
    ...options,
    inputArgs: [
      "-f",
      "lavfi",
      "-t",
      String(options.durationSec),
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100"
    ]
  });
}

async function writeToneAudio(options: { sessionId: string; stem: string; durationSec: number; frequencyHz: number }) {
  return writeGeneratedAudio({
    ...options,
    inputArgs: [
      "-f",
      "lavfi",
      "-t",
      String(options.durationSec),
      "-i",
      `sine=frequency=${options.frequencyHz}:sample_rate=44100`
    ]
  });
}

async function writeGeneratedAudio(options: {
  sessionId: string;
  stem: string;
  durationSec: number;
  inputArgs: string[];
}): Promise<string> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const outputName = `${options.stem}.m4a`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  if (await fileExists(outputPath)) return `/media/${outputName}`;
  try {
    await runFfmpegCommand([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...options.inputArgs,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath
    ]);
  } catch (error) {
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
  return `/media/${outputName}`;
}

async function fileExists(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function runFfmpegCapture(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg.path, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.on("error", reject);
    child.on("close", () => resolve(stderr));
  });
}
