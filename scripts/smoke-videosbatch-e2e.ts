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
  selectedStoryId?: string;
  completed?: boolean;
  stages: Record<string, StageState>;
};

type Session = { id: string };

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
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
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
      title: "VideosBatch Phase 1 E2E",
      logline: "Deterministic lesson-to-video chain",
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
    assert.ok(workflow.stages.LESSON_INPUT.artifact, "lesson input must be a visible artifact");

    workflow = await request<Workflow>(`/api/sessions/${session.id}/videosbatch/run-all`, {
      method: "POST",
      body: "{}"
    });

    assert.equal(workflow.currentStage, "STORY_SELECTION", "automatic chain must pause at the human story-selection gate");
    assert.equal(workflow.stages.INTRO_GENERATION.status, "ready");
    assert.equal(workflow.stages.STORY_EXPANSION.status, "ready");
    assert.equal(workflow.stages.INTRO_GENERATION.artifact.candidates.length, 9, "fake intro stage must expose 9 candidates");
    assert.equal(workflow.stages.INTRO_GENERATION.artifact.recommendedIds.length, 3, "fake intro stage must expose 3 recommendations");
    assert.equal(workflow.stages.STORY_EXPANSION.artifact.stories.length, 3, "fake story stage must expose 3 stories");

    workflow = await request<Workflow>(`/api/sessions/${session.id}/videosbatch/stages/STORY_SELECTION/artifact`, {
      method: "PUT",
      body: JSON.stringify({ artifact: { selectedStoryId: "story-1" } })
    });
    assert.equal(workflow.selectedStoryId, "story-1");

    workflow = await request<Workflow>(`/api/sessions/${session.id}/videosbatch/run-all`, {
      method: "POST",
      body: "{}"
    });

    assert.equal(workflow.completed, true, "workflow must reach DONE after STITCH");
    assert.equal(workflow.stages.STITCH.status, "ready");

    for (const stageId of VIDEOS_BATCH_STAGE_ORDER) {
      const stage = workflow.stages[stageId];
      assert.ok(stage, `${stageId} must be persisted`);
      assert.equal(stage.status, "ready", `${stageId} must be ready at completion`);
      assert.notEqual(stage.artifact, undefined, `${stageId} must have an inspectable artifact`);
    }

    const finalSnapshot = await request<Workflow>(`/api/sessions/${session.id}/videosbatch`);
    assert.equal(finalSnapshot.completed, true, "completed chain must survive a fresh GET");
    assert.equal(finalSnapshot.stages.VIDEO_GENERATION.artifact.renderIds[0], "render_fake_1");
    assert.equal(finalSnapshot.stages.STITCH.artifact.finalVideoUrl, "fake://videosbatch/final.mp4");

    const oldAssetArtifact = finalSnapshot.stages.ASSET_PROMPT_GENERATION.artifact;
    const edited = await request<Workflow>(`/api/sessions/${session.id}/videosbatch/stages/STORY_EXPANSION/artifact`, {
      method: "PUT",
      body: JSON.stringify({
        artifact: {
          stories: [
            { id: "story-1", title: "人工修改后的故事", content: "edited" },
            { id: "story-2", title: "故事2", content: "old" },
            { id: "story-3", title: "故事3", content: "old" }
          ]
        }
      })
    });
    assert.equal(edited.stages.STORY_EXPANSION.status, "ready");
    assert.equal(edited.stages.ASSET_PROMPT_GENERATION.status, "stale");
    assert.deepEqual(edited.stages.ASSET_PROMPT_GENERATION.artifact, oldAssetArtifact, "stale propagation must preserve old artifacts for inspection");
  } finally {
    await request<{ ok: true }>(`/api/sessions/${session.id}`, { method: "DELETE" }).catch(() => undefined);
  }
});

console.log("VideosBatch Phase 1 orchestration E2E passed");
