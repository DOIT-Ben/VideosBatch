import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { VIDEOS_BATCH_STAGE_ORDER } from "../src/shared/videosBatchWorkflow";

const baseUrl = process.env.SEEREEL_BASE_URL || process.env.REELYAI_BASE_URL || "http://127.0.0.1:5173";
let cookieHeader = "";

function rememberCookies(headers: Headers) {
  const raw = headers.get("set-cookie");
  if (!raw) return;
  cookieHeader = raw
    .split(/,(?=[^;,]+=)/)
    .map((item) => item.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(init?.headers || {})
    }
  });
  rememberCookies(res.headers);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${init?.method || "GET"} ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json() as Promise<T>;
}

type StageState = {
  status: "pending" | "running" | "ready" | "failed" | "stale";
  revision: number;
  artifact?: any;
};

type Workflow = {
  currentStage: string;
  selectedIntroId?: string;
  introLocked: boolean;
  completed?: boolean;
  stages: Record<string, StageState>;
};

type Session = { id: string };
type NativeState = {
  assets: Array<{ id: string; ownerSessionId?: string; workflowReferenceId?: string }>;
  shots: Array<{ id: string; sessionId: string; assetIds: string[]; rawPrompt?: string; durationSec: number }>;
};

async function isServerReachable() {
  try {
    return (await fetch(`${baseUrl}/api/healthz`)).ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Server did not become ready at ${baseUrl}`);
}

function terminateServer(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      // SIGTERM only reaches the cmd.exe wrapper spawned with shell:true;
      // taskkill /T kills the whole npm -> tsx -> node process tree.
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }
}

async function withServer<T>(fn: () => Promise<T>): Promise<T> {
  if (await isServerReachable()) return fn();
  const child = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: new URL(baseUrl).port || "5173", VIDEOSBATCH_EXECUTOR_MODE: "fake" },
    detached: process.platform !== "win32",
    // Windows resolves npm via npm.cmd; shell:true keeps spawn portable across platforms.
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  try {
    await waitForServer();
    return await fn();
  } finally {
    terminateServer(child);
  }
}

await withServer(async () => {
  const session = await request<Session>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: "VideosBatch canonical Phase 1 E2E",
      logline: "Deterministic canonical lesson-to-video chain",
      style: "test",
      targetDurationSec: 120,
      shotCount: 0
    })
  });

  try {
    let workflow = await request<Workflow>(`/api/sessions/${session.id}/videosbatch/start`, {
      method: "POST",
      body: JSON.stringify({
        projectId: "P001",
        lessonText: "完整教案：通过从正面、左面、上面观察物体，理解同一物体在不同方向看到的图形可能不同。"
      })
    });
    assert.equal(workflow.stages.LESSON_INPUT.status, "ready");
    assert.equal(workflow.currentStage, "COURSE_INTRO_CANDIDATES");

    workflow = await request<Workflow>(`/api/sessions/${session.id}/videosbatch/run-all`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(workflow.currentStage, "COURSE_INTRO_SELECTION", "canonical chain must pause before story generation");
    assert.equal(workflow.stages.COURSE_INTRO_CANDIDATES.artifact.candidates.length, 9);
    assert.equal(workflow.stages.COURSE_INTRO_CANDIDATES.artifact.recommendations.length, 3);
    assert.equal(workflow.stages.STORY_SCRIPT.status, "pending");

    workflow = await request<Workflow>(`/api/sessions/${session.id}/videosbatch/stages/COURSE_INTRO_SELECTION/artifact`, {
      method: "PUT",
      body: JSON.stringify({
        artifact: {
          selectedIntroId: "A-01",
          selectionMode: "user_selected",
          selectionReason: "用户确认该方案最适合继续制作",
          locked: true
        }
      })
    });
    assert.equal(workflow.selectedIntroId, "A-01");
    assert.equal(workflow.introLocked, true);

    workflow = await request<Workflow>(`/api/sessions/${session.id}/videosbatch/run-all`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(workflow.currentStage, "ASSET_CONFIRMATION", "canonical chain must pause until all assets are confirmed");
    assert.equal(workflow.stages.STORY_SCRIPT.status, "ready");
    assert.equal(workflow.stages.STORY_SCRIPT.artifact.kind, "LESSON_INTRO_VIDEO_SCRIPT");
    assert.equal(Array.isArray(workflow.stages.STORY_SCRIPT.artifact.stories), false, "story stage must expose one story document only");
    assert.equal(workflow.stages.ASSET_PLAN.artifact.items[0].assetKey, "CHARACTER-HERO");
    assert.equal(workflow.stages.ASSET_PLAN.artifact.items[0].assetId, undefined, "model-owned asset plan must not contain stable public ids before server projection/confirmation");

    const candidateItems = workflow.stages.ASSET_CANDIDATES.artifact.items;
    assert.equal(candidateItems[0].publicAssetId, "P001-A001");
    assert.ok(candidateItems[0].candidateAssetIds[0], "asset candidate stage must expose a native candidate id");

    workflow = await request<Workflow>(`/api/sessions/${session.id}/videosbatch/stages/ASSET_CONFIRMATION/artifact`, {
      method: "PUT",
      body: JSON.stringify({
        artifact: {
          confirmed: true,
          items: candidateItems.map((item: any) => ({
            assetKey: item.assetKey,
            publicAssetId: item.publicAssetId,
            candidateAssetIds: item.candidateAssetIds,
            selectedAssetId: item.candidateAssetIds[0]
          }))
        }
      })
    });
    assert.equal(workflow.currentStage, "SCREENPLAY");

    workflow = await request<Workflow>(`/api/sessions/${session.id}/videosbatch/run-all`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(workflow.completed, true, "workflow must reach DONE after native/fake stitch");

    for (const stageId of VIDEOS_BATCH_STAGE_ORDER) {
      const stage = workflow.stages[stageId];
      assert.ok(stage, `${stageId} must be persisted`);
      assert.equal(stage.status, "ready", `${stageId} must be ready at completion`);
      assert.notEqual(stage.artifact, undefined, `${stageId} must have an inspectable artifact`);
    }

    const screenplay = workflow.stages.SCREENPLAY.artifact;
    assert.equal(screenplay.targetDurationSeconds, 120);
    assert.ok([90, 100, 110, 120, 130, 140, 150].includes(screenplay.targetDurationSeconds));

    const storyboard = workflow.stages.FINAL_STORYBOARD.artifact;
    assert.equal(storyboard.targetDuration, screenplay.targetDurationSeconds);
    assert.equal(storyboard.segments.length, screenplay.targetDurationSeconds / 10);
    assert.ok(storyboard.segments.every((segment: any) => segment.duration === 10));
    assert.ok(storyboard.segments.every((segment: any) => segment.subshots.length >= 3 && segment.subshots.length <= 5));
    assert.ok(storyboard.segments.every((segment: any) => segment.subshots.reduce((sum: number, item: any) => sum + item.duration, 0) === 10));

    const copyable = workflow.stages.COPYABLE_PROMPT.artifact;
    assert.equal(copyable.status, "READY");
    assert.equal(copyable.segments.length, storyboard.segments.length);
    assert.ok(copyable.segments.every((segment: any) => segment.referenceAssetIds.length <= 7));
    assert.ok(copyable.segments[0].text.includes("【P001-A001】"));

    assert.ok(workflow.stages.QUOTE.artifact.quoteId);
    assert.equal(workflow.stages.EXECUTION.artifact.status, "READY");
    assert.equal(workflow.stages.STITCH.artifact.finalVideoUrl, "fake://videosbatch/final.mp4");

    const finalSnapshot = await request<Workflow>(`/api/sessions/${session.id}/videosbatch`);
    assert.equal(finalSnapshot.completed, true, "completed canonical chain must survive a fresh GET");

    const nativeState = await request<NativeState>("/api/state");
    const sessionAssets = nativeState.assets.filter((asset) => asset.ownerSessionId === session.id);
    const sessionShots = nativeState.shots.filter((shot) => shot.sessionId === session.id);
    assert.equal(sessionAssets.length, 1, "ASSET_CANDIDATES must project one native SeeReel Asset for the fake plan");
    assert.equal(sessionAssets[0].workflowReferenceId, "P001-A001");
    assert.equal(sessionShots.length, 12, "120-second FINAL_STORYBOARD must project twelve native SeeReel Shots");
    assert.ok(sessionShots.every((shot) => shot.durationSec === 10));
    assert.ok(sessionShots.every((shot) => shot.assetIds.includes(sessionAssets[0].id)), "EXECUTION projection must resolve stable public refs to the confirmed native asset");
    assert.ok(!(sessionShots[0].rawPrompt || "").includes("【P001-A001】"), "native execution prompt must stay based on FINAL_STORYBOARD, not COPYABLE_PROMPT display text");

    workflow = await request<Workflow>(`/api/sessions/${session.id}/videosbatch/restart-from/COURSE_INTRO_SELECTION`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(workflow.completed, false);
    assert.equal(workflow.currentStage, "COURSE_INTRO_SELECTION");
    assert.equal(workflow.introLocked, false);
    assert.equal(workflow.stages.STORY_SCRIPT.status, "stale");
    assert.ok(workflow.stages.STORY_SCRIPT.artifact, "stale propagation must preserve prior artifacts for inspection");
  } finally {
    await request<{ ok: true }>(`/api/sessions/${session.id}`, { method: "DELETE" }).catch(() => undefined);
  }
});

console.log("VideosBatch canonical Phase 1 orchestration E2E passed");
