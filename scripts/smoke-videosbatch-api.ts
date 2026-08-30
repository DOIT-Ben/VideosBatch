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
  selectedIntroId?: string;
  selectionMode?: string;
  selectionReason?: string;
  introLocked: boolean;
  completed?: boolean;
  stages: Record<string, WorkflowStageState>;
};

type Session = { id: string };

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
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
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
      title: "VideosBatch canonical API smoke",
      logline: "Canonical workflow API contract",
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
    assert.equal(workflow.currentStage, "COURSE_INTRO_CANDIDATES");
    assert.equal(workflow.introLocked, false);
    assert.equal(workflow.stages.LESSON_INPUT.status, "ready");

    const fetched = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch`);
    assert.equal(fetched.stages.LESSON_INPUT.artifact.projectId, "P001");

    workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/run-all`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(workflow.currentStage, "COURSE_INTRO_SELECTION", "run-all must stop at intro confirmation");
    assert.equal(workflow.stages.COURSE_INTRO_CANDIDATES.status, "ready");
    assert.equal(workflow.stages.COURSE_INTRO_CANDIDATES.artifact.candidates.length, 9);
    assert.equal(workflow.stages.COURSE_INTRO_CANDIDATES.artifact.recommendations.length, 3);
    assert.equal(workflow.stages.STORY_SCRIPT.status, "pending");

    workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/stages/COURSE_INTRO_SELECTION/artifact`, {
      method: "PUT",
      body: JSON.stringify({
        artifact: {
          selectedIntroId: "A-01",
          selectionMode: "user_selected",
          selectionReason: "用户确认该方案最适合课堂导入",
          locked: true
        }
      })
    });
    assert.equal(workflow.selectedIntroId, "A-01");
    assert.equal(workflow.introLocked, true);
    assert.equal(workflow.currentStage, "STORY_SCRIPT");

    workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/run-all`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(workflow.currentStage, "ASSET_CONFIRMATION", "run-all must stop at asset confirmation");
    assert.equal(workflow.stages.STORY_SCRIPT.status, "ready");
    assert.equal(workflow.stages.ASSET_PLAN.status, "ready");
    assert.equal(workflow.stages.ASSET_CANDIDATES.status, "ready");
    assert.equal(workflow.stages.SCREENPLAY.status, "pending");

    const candidateItems = workflow.stages.ASSET_CANDIDATES.artifact.items;
    workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/stages/ASSET_CONFIRMATION/artifact`, {
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

    workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/run-all`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(workflow.completed, true);
    assert.equal(workflow.stages.SCREENPLAY.artifact.targetDurationSeconds, 120);
    assert.equal(workflow.stages.FINAL_STORYBOARD.artifact.segments.length, 12);
    assert.equal(workflow.stages.COPYABLE_PROMPT.status, "ready");
    assert.equal(workflow.stages.QUOTE.status, "ready");
    assert.equal(workflow.stages.EXECUTION.status, "ready");
    assert.equal(workflow.stages.STITCH.status, "ready");

    workflow = await request<WorkflowState>(`/api/sessions/${session.id}/videosbatch/restart-from/COURSE_INTRO_SELECTION`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(workflow.currentStage, "COURSE_INTRO_SELECTION");
    assert.equal(workflow.completed, false);
    assert.equal(workflow.introLocked, false);
    assert.equal(workflow.selectedIntroId, undefined);
    assert.equal(workflow.stages.STORY_SCRIPT.status, "stale");
    assert.ok(workflow.stages.STORY_SCRIPT.artifact, "upstream restart must preserve stale downstream artifacts for inspection");
  } finally {
    await request<{ ok: true }>(`/api/sessions/${session.id}`, { method: "DELETE" }).catch(() => undefined);
  }
});

console.log("VideosBatch canonical workflow API smoke passed");
