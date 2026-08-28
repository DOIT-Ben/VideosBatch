import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";

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

type WorkflowStageState = {
  status: "pending" | "running" | "ready" | "failed" | "stale";
  revision: number;
  artifact?: any;
  error?: string;
};

type WorkflowState = {
  version: 1;
  currentStage: string;
  selectedStoryId?: string;
  completed?: boolean;
  stages: Record<string, WorkflowStageState>;
};

type Session = {
  id: string;
  videosBatchWorkflow?: WorkflowState;
};

async function isServerReachable() {
  try {
    const res = await fetch(`${baseUrl}/api/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
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
      title: "VideosBatch API smoke",
      logline: "Linear workflow API contract",
      style: "test",
      targetDurationSec: 120,
      shotCount: 0
    })
  });

  try {
    let workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/start`, {
      method: "POST",
      body: JSON.stringify({ projectId: "P001", lessonText: "完整教案：观察物体。" })
    });
    assert.equal(workflow.currentStage, "INTRO_GENERATION");
    assert.equal(workflow.stages.LESSON_INPUT.status, "ready");

    const fetched = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch`);
    assert.equal(fetched.stages.LESSON_INPUT.artifact.projectId, "P001");

    workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/run-next`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(workflow.stages.INTRO_GENERATION.status, "ready");
    assert.equal(workflow.currentStage, "STORY_EXPANSION");

    workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/run-all`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(workflow.currentStage, "STORY_SELECTION");
    assert.equal(workflow.stages.STORY_EXPANSION.status, "ready");

    workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/stages/STORY_SELECTION/artifact`, {
      method: "PUT",
      body: JSON.stringify({ artifact: { selectedStoryId: "story-1" } })
    });
    assert.equal(workflow.selectedStoryId, "story-1");
    assert.equal(workflow.currentStage, "ASSET_PROMPT_GENERATION");

    workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/run-all`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(workflow.completed, true);
    assert.equal(workflow.stages.STITCH.status, "ready");

    workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/stages/INTRO_GENERATION/artifact`, {
      method: "PUT",
      body: JSON.stringify({ artifact: { candidates: [{ id: "A1", title: "edited" }] } })
    });
    assert.equal(workflow.stages.INTRO_GENERATION.status, "ready");
    assert.equal(workflow.stages.STORY_EXPANSION.status, "stale");
    assert.ok(workflow.stages.STORY_EXPANSION.artifact, "editing upstream must keep old downstream artifacts");

    workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/restart-from/STORY_EXPANSION`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(workflow.currentStage, "STORY_EXPANSION");
    assert.equal(workflow.completed, false);
  } finally {
    await request<{ ok: true }>(`/api/sessions/${session.id}`, { method: "DELETE" }).catch(() => undefined);
  }
});

console.log("VideosBatch workflow API smoke passed");
