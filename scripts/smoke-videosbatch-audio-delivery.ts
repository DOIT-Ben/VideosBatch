/**
 * AUDIO_DELIVERY contract smoke.
 *
 * Proves the stage that closes the gap between the structural audio timeline
 * produced by EXECUTION and the delivery-ready timeline required by STITCH:
 *
 *   1. AUDIO_DELIVERY refuses to run without a READY EXECUTION artifact.
 *   2. Complete input materializes TTS + sound effects + mix, and the delivery
 *      artifact passes its own validator.
 *   3. A timeline with speech but no TTS still fails with
 *      AUDIO_TIMELINE_NOT_READY, so the stage cannot silently pass a hole.
 *   4. Re-running with identical input reuses the cached mix.
 *
 * No network and no provider credentials are used; the fake synthesizer writes
 * real local audio files so the ffmpeg-backed mix path is genuinely exercised.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpeg from "@ffmpeg-installer/ffmpeg";

/** Seconds at which the mixed track first stops being silent. */
function firstSoundOnsetSeconds(filePath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpeg.path,
      ["-hide_banner", "-i", filePath, "-af", "silencedetect=noise=-45dB:d=0.2", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", () => resolve(undefined));
    child.on("close", () => {
      const match = /silence_end:\s*([\d.]+)/u.exec(stderr);
      resolve(match ? Number(match[1]) : undefined);
    });
  });
}

const originalCwd = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-audio-delivery-"));
process.chdir(tmp);
process.env.VIDEOSBATCH_MEDIA_MODE = "fake";

try {
  const [mediaModule, canonicalModule] = await Promise.all([
    import("../src/server/videosBatchWorkflow/nativeMediaStages"),
    import("../src/server/videosBatchWorkflow/canonicalStoryboard")
  ]);

  const registry = mediaModule.createVideosBatchNativeMediaStageRegistry();
  const audioStage = (registry as any).AUDIO_DELIVERY;
  assert.ok(audioStage, "AUDIO_DELIVERY must be registered");

  const session = { id: "ses_audio_smoke" } as any;

  // The audio timeline must carry the current FINAL_STORYBOARD lineage. The
  // fixture therefore pins one stable hash for both the storyboard stage and
  // the timeline, mirroring how the real runner stamps them: both sides use
  // the canonical storyboard source hash (the stage wrapper's generic
  // contentHash is NOT the identity the audio gates compare against).
  const STORYBOARD_HASH = canonicalModule.canonicalStoryboardSourceHash({ targetDuration: 20 });

  const timelineWithEvents = () => ({
    schemaVersion: "1",
    durationSec: 20,
    sourceStageId: "FINAL_STORYBOARD",
    sourceRevision: 1,
    sourceHash: STORYBOARD_HASH,
    streams: {
      narration: [{ id: "shot-1-voice-1", startSec: 0, endSec: 5, text: "为什么月亮不会掉下来？", source: "FINAL_STORYBOARD" }],
      dialogue: [{ id: "shot-2-voice-1", startSec: 10, endSec: 15, text: "原来是这样！", source: "FINAL_STORYBOARD" }],
      soundEffects: [{ id: "shot-1-sound-1", startSec: 5, endSec: 7, text: "轻响", source: "FINAL_STORYBOARD" }],
      tts: [],
      mix: { status: "pending" }
    }
  });

  const buildWorkflow = (timeline: any, executionStatus = "ready") => ({
    version: 1,
    currentStage: "AUDIO_DELIVERY",
    completed: false,
    introLocked: false,
    stages: {
      EXECUTION: {
        status: executionStatus,
        revision: 1,
        contentHash: "",
        artifact: {
          schemaVersion: "1",
          executionId: "execution_smoke",
          batchId: "batch_smoke",
          status: "READY",
          renderIds: ["render_1", "render_2"],
          nativeShotIds: ["shot_1", "shot_2"],
          renderMap: [],
          items: [],
          failedShots: [],
          audioTimeline: timeline,
          sourceStageId: "FINAL_STORYBOARD",
          sourceRevision: 1,
          sourceHash: STORYBOARD_HASH,
          sourceHashes: {},
          sourceRevisions: {}
        }
      },
      FINAL_STORYBOARD: {
        status: "ready",
        revision: 1,
        artifact: { targetDuration: 20 },
        contentHash: STORYBOARD_HASH
      }
    },
    updatedAt: new Date().toISOString()
  });

  // 1. No READY EXECUTION => refuse, with the canonical missing-timeline code.
  await assert.rejects(
    () => audioStage.execute({ session, workflow: buildWorkflow(timelineWithEvents(), "pending") as any, assets: [], shots: [] }),
    (error: any) => error?.code === "AUDIO_TIMELINE_MISSING",
    "AUDIO_DELIVERY must require a READY EXECUTION artifact"
  );

  // 2. Complete synthesis.
  const workflowForBuild = buildWorkflow(timelineWithEvents()) as any;
  const ready = await audioStage.execute({ session, workflow: workflowForBuild, assets: [], shots: [] });
  const delivered: any = ready.artifact;
  assert.equal(delivered.status, "READY", "complete input must yield a READY delivery artifact");
  assert.equal(delivered.audioTimeline.streams.tts.length, 2, "one TTS file per voice event");
  assert.equal(delivered.audioTimeline.streams.mix.status, "ready", "mix must become ready");

  for (const event of delivered.audioTimeline.streams.tts) {
    assert.match(String(event.audioUrl), /^\/media\//u, "TTS must expose a readable /media URL");
    const localPath = path.join(tmp, "data", "media", path.basename(String(event.audioUrl)));
    assert.ok((await stat(localPath)).size > 0, `TTS file must exist and be non-empty: ${event.audioUrl}`);
  }
  for (const event of delivered.audioTimeline.streams.soundEffects) {
    assert.match(String(event.audioUrl), /^\/media\//u, "sound effects must expose a readable /media URL");
  }
  const mixLocal = path.join(tmp, "data", "media", path.basename(String(delivered.audioTimeline.streams.mix.audioUrl)));
  assert.ok((await stat(mixLocal)).size > 0, "mixed track must exist and be non-empty");

  // Delivery artifact must pass its own stage validator. Lineage is checked
  // against the same workflow the artifact was built from, so only the audio
  // readiness contract is under test here.
  const validation = audioStage.validate(delivered, {
    session,
    workflow: workflowForBuild,
    assets: [],
    shots: []
  });
  assert.equal(validation.ok, true, `delivery artifact must validate: ${validation.errors.join("; ")}`);

  // 3. Speech present but TTS missing => the gate must still reject.
  const brokenTimeline = {
    ...timelineWithEvents(),
    streams: { ...timelineWithEvents().streams, tts: [], mix: { status: "ready", audioUrl: "/media/fake-mix.m4a" } }
  };
  const brokenWorkflow = buildWorkflow(brokenTimeline) as any;
  const brokenValidation = audioStage.validate(
    { schemaVersion: "1", status: "READY", provider: "fake", audioTimeline: brokenTimeline, items: [], failedItems: [] },
    { session, workflow: brokenWorkflow, assets: [], shots: [] }
  );
  assert.equal(brokenValidation.ok, false, "speech without TTS must not validate");
  assert.equal(brokenValidation.code, "AUDIO_TIMELINE_NOT_READY", "missing TTS must report AUDIO_TIMELINE_NOT_READY");

  // 4. Idempotency: identical input reuses the same mix file.
  const second = await audioStage.execute({ session, workflow: buildWorkflow(timelineWithEvents()) as any, assets: [], shots: [] });
  assert.equal(
    (second.artifact as any).audioTimeline.streams.mix.audioUrl,
    delivered.audioTimeline.streams.mix.audioUrl,
    "repeated runs with identical input must reuse the cached mix"
  );

  // 5. The mix must reproduce the timeline's TIMING, not just its clip set.
  //    Every fake voice clip is silence, so the only audible content is the
  //    660 Hz sound effect declared at 5s. A mixer that ignored `startSec` would
  //    place that tone at 0s and this measures where sound actually begins.
  const onset = await firstSoundOnsetSeconds(mixLocal);
  assert.ok(
    onset !== undefined && onset > 4 && onset < 6.5,
    `mix must place the 5s sound effect at ~5s (first audible frame measured at ${onset}s)`
  );

  // 6. Reuse must be tied to the text, not just the event id. Ids are positional
  //    (`shot-<seq>-voice-<n>`), so an edited line keeps its id; without the
  //    check the clip synthesized from the previous text silently ships in the
  //    new film while every gate still passes.
  const editedWorkflow = buildWorkflow({
    ...timelineWithEvents(),
    streams: {
      ...timelineWithEvents().streams,
      narration: [{ id: "shot-1-voice-1", startSec: 0, endSec: 5, text: "改写过的一句台词，和上一版不同。", source: "FINAL_STORYBOARD" }]
    }
  }) as any;
  editedWorkflow.stages.AUDIO_DELIVERY = { status: "ready", revision: 1, artifact: delivered };
  const edited = await audioStage.execute({ session, workflow: editedWorkflow, assets: [], shots: [] });
  const editedTts = (edited.artifact as any).audioTimeline.streams.tts.find((event: any) => event.id === "tts-shot-1-voice-1");
  const previousTts = delivered.audioTimeline.streams.tts.find((event: any) => event.id === "tts-shot-1-voice-1");
  assert.ok(editedTts && previousTts, "both runs must produce the shot-1 narration clip");
  assert.notEqual(
    editedTts.audioUrl,
    previousTts.audioUrl,
    "an edited line must not reuse the clip synthesized from the previous text"
  );

  console.log("VideosBatch AUDIO_DELIVERY smoke passed");
  console.log(`  tts events: ${delivered.audioTimeline.streams.tts.length}`);
  console.log(`  sfx events: ${delivered.audioTimeline.streams.soundEffects.length}`);
  console.log(`  mix status: ${delivered.audioTimeline.streams.mix.status}`);
  console.log(`  mix url: ${delivered.audioTimeline.streams.mix.audioUrl}`);
} finally {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
}
