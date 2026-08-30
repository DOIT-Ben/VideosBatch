import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { once } from "node:events";

const appPort = 5187;
const appBase = `http://127.0.0.1:${appPort}`;
let providerRequests = 0;

const provider = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/responses") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  providerRequests += 1;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  assert.equal(req.headers.authorization, "Bearer integration-test-key");
  assert.equal(body.model, "integration-test-model");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.name, "videosbatch_course_intro_candidates");

  const ids = ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"];
  const artifact = {
    candidates: ids.map((id, index) => ({
      id,
      name: `导入${id}`,
      creativeType: index < 3 ? "数学史与知识由来" : index < 6 ? "历史需求与古今应用" : "创意故事与现代情境",
      body: "学生从一个熟悉却容易误判的现象出发，通过观察、比较和讨论逐渐发现原先的直觉并不可靠。新的证据不断出现，推动大家寻找更严谨的数学方法。本段只建立问题、冲突与必要背景，不提前给出本课最终结论。".repeat(3).slice(0, 230),
      endingQuestion: "怎样才能作出更可靠的判断？",
      truthfulnessCategory: "完全虚构的故事化情境",
      truthfulnessNote: "本测试只验证真实 Provider 接线，不代表正式生成内容。"
    })),
    recommendations: [
      { id: "A-01", reason: "知识联系自然，问题明确，适合课堂和视频表达。" },
      { id: "B-01", reason: "情境有真实需求，容易建立数学学习动机。" },
      { id: "C-01", reason: "认知冲突直观，学生代入感和视觉可行性较高。" }
    ]
  };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    id: "resp_server_integration",
    model: "integration-test-model",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(artifact) }] }]
  }));
});

provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const providerAddress = provider.address();
if (!providerAddress || typeof providerAddress === "string") throw new Error("mock provider did not expose a port");

let child: ChildProcess | undefined;
let cookie = "";
function rememberCookie(headers: Headers) {
  const raw = headers.get("set-cookie");
  if (raw) cookie = raw.split(";")[0];
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${appBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init?.headers || {})
    }
  });
  rememberCookie(response.headers);
  if (!response.ok) throw new Error(`${init?.method || "GET"} ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function waitForApp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${appBase}/api/healthz`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("SeeReel server did not become ready in real text mode");
}
function terminate(processHandle?: ChildProcess) {
  if (!processHandle?.pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(processHandle.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-processHandle.pid, "SIGTERM");
  } catch {
    processHandle.kill("SIGTERM");
  }
}

try {
  child = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(appPort),
      VIDEOSBATCH_EXECUTOR_MODE: "llm",
      VIDEOSBATCH_LLM_PROVIDER: "openai-responses",
      VIDEOSBATCH_LLM_API_KEY: "integration-test-key",
      VIDEOSBATCH_LLM_BASE_URL: `http://127.0.0.1:${providerAddress.port}/v1`,
      VIDEOSBATCH_LLM_MODEL: "integration-test-model",
      VIDEOSBATCH_LLM_TIMEOUT_MS: "5000"
    },
    detached: process.platform !== "win32",
    // Windows resolves npm via npm.cmd; shell:true keeps spawn portable across platforms.
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  await waitForApp();

  const session = await request<{ id: string }>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title: "Real text server smoke", logline: "", style: "test", targetDurationSec: 120, shotCount: 0 })
  });
  try {
    let workflow = await request<any>(`/api/sessions/${session.id}/videosbatch/start`, {
      method: "POST",
      body: JSON.stringify({ projectId: "P001", lessonText: "完整教案：观察物体。" })
    });
    assert.equal(workflow.currentStage, "COURSE_INTRO_CANDIDATES");

    workflow = await request<any>(`/api/sessions/${session.id}/videosbatch/run-next`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(providerRequests, 1, "server llm mode must make exactly one provider request for the first text stage");
    assert.equal(workflow.stages.COURSE_INTRO_CANDIDATES.status, "ready");
    assert.equal(workflow.stages.COURSE_INTRO_CANDIDATES.artifact.candidates.length, 9);
    assert.equal(workflow.currentStage, "COURSE_INTRO_SELECTION", "server must stop at the canonical intro-selection gate after real text generation");
  } finally {
    await request(`/api/sessions/${session.id}`, { method: "DELETE" }).catch(() => undefined);
  }
} finally {
  terminate(child);
  provider.close();
  await once(provider, "close");
}

console.log("VideosBatch real text server smoke passed");
