import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

/**
 * Local .env hygiene guard.
 *
 * `smoke:secrets` scans files git would actually ship and deliberately skips
 * ignored ones, so it cannot see `.env` at all. That is the right default for
 * a CI check: the real `.env` on a workstation legitimately holds provider
 * keys. But it leaves one failure mode uncovered -- an accidental credential
 * in a file that is *about* to be tracked, or a real value accidentally
 * pasted into `.env.example`, which is tracked and public.
 *
 * This script closes that gap without ever printing a secret value. It runs
 * locally and is intentionally not part of verify:offline, because a
 * freshly cloned checkout has no keys and would fail the "filled" branch.
 *
 * Checks, in order of severity:
 *   1. A tracked env template carrying a real-looking value (FAIL).
 *   2. `.env` not present (WARN, expected on a fresh clone).
 *   3. `.env` not ignored by git (FAIL -- it would be committed).
 *   4. No keys filled -- fine, but report so fake mode is never mistaken
 *      for a configured environment.
 */

const repoRoot = process.cwd();
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

type Level = "fail" | "warn" | "ok";
type Line = { level: Level; message: string };

const report: Line[] = [];
const failures: string[] = [];

function record(level: Level, message: string) {
  report.push({ level, message });
  if (level === "fail") failures.push(message);
}

/** A value is a placeholder when it is empty or clearly instructional. */
function isPlaceholderValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (/^(<.*>|\.\.\.|x{3,}|\*{3,})$/.test(trimmed)) return true;
  return [
    "your-",
    "your_",
    "changeme",
    "change-me",
    "placeholder",
    "example",
    "dummy",
    "replace",
    "todo",
    "<",
  ].some((hint) => lower.includes(hint));
}

/** Collect KEY=VALUE pairs from env text, ignoring comments. */
function parseEnv(text: string) {
  const entries: Array<{ key: string; value: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    entries.push({
      key: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
    });
  }
  return entries;
}

const secretLike = /(API_KEY|_KEY|TOKEN|SECRET|PASSWORD|PASSWD|ACCESS_KEY|APPID|APP_ID)/i;
/** Values that look like an actual issued credential rather than config. */
function looksLikeRealCredential(value: string) {
  if (isPlaceholderValue(value)) return false;
  // Provider keys are long and/or prefixed; plain hostnames, regions, model
  // ids and durations share the *_KEY suffix space in this file, so require
  // both a length floor and a credential-ish shape.
  if (value.length < 24) return false;
  return /^(sk-|ak-|ghp_|AKIA|AKLT|AIza)/.test(value) || /^[A-Za-z0-9_\-+/=]{32,}$/.test(value);
}

// 1. Tracked templates must never carry a real value.
let templateFindings = 0;
for (const template of [".env.example", "deploy/.env.production.example"]) {
  if (!existsSync(template)) continue;
  const { readFileSync } = await import("node:fs");
  const filled = parseEnv(readFileSync(template, "utf8"))
    .filter(({ key, value }) => secretLike.test(key) && looksLikeRealCredential(value));
  for (const { key } of filled) {
    templateFindings += 1;
    record("fail", `${template} carries a real-looking value for ${key}; templates must stay empty`);
  }
}
if (templateFindings === 0) {
  record("ok", "tracked env templates carry no real credentials");
}

// 2. Is there a .env at all?
const hasEnv = existsSync(".env");
if (!hasEnv) {
  record("warn", "no .env found; expected on a fresh clone and safe for fake mode");
} else {
  // 3. It must be ignored by git.
  let ignored = false;
  try {
    ignored = git(["check-ignore", ".env"]).length > 0;
  } catch {
    ignored = false;
  }
  if (!ignored) {
    record("fail", ".env is NOT ignored by git; add it to .gitignore before committing anything");
  } else {
    record("ok", ".env is ignored by git");
  }

  // Never committed?
  try {
    const history = git(["log", "--oneline", "--all", "--", ".env"]);
    if (history) {
      record("fail", ".env exists in git history; rotate every credential it ever held");
    } else {
      record("ok", ".env has never been committed");
    }
  } catch {
    record("warn", "could not read git history for .env");
  }

  // 4. Report how many keys are armed, without printing values.
  const { readFileSync } = await import("node:fs");
  const stat = statSync(".env");
  const entries = parseEnv(readFileSync(".env", "utf8"));
  const armed = entries.filter(({ key, value }) => secretLike.test(key) && looksLikeRealCredential(value));
  const modeSwitch = (name: string) =>
    entries.find((entry) => entry.key === name)?.value?.trim().toLowerCase() ?? "(unset)";
  const executorMode = modeSwitch("VIDEOSBATCH_EXECUTOR_MODE");
  const mediaMode = modeSwitch("VIDEOSBATCH_MEDIA_MODE");
  const ttsProvider = modeSwitch("VIDEOSBATCH_TTS_PROVIDER");

  record(
    "ok",
    `.env holds ${armed.length} credential-shaped value(s) for keys: ${armed.map((entry) => entry.key).join(", ") || "(none)"}`,
  );
  const allOff = executorMode === "fake" && mediaMode === "fake" && (ttsProvider === "fake" || ttsProvider === "(unset)");
  const modeSummary = `executor=${executorMode}, media=${mediaMode}, tts=${ttsProvider}`;
  if (armed.length > 0 && allOff) {
    record("ok", `provider calls are switched off (${modeSummary}); the stored keys are dormant`);
  } else if (armed.length > 0) {
    record("warn", `credentials are present and provider calls are live (${modeSummary}); confirm this is intended`);
  }
  // TTS is billed per character, so an armed switch deserves an explicit call-out
  // even when the visual pipeline is still on the free fake path.
  if (ttsProvider === "minimax") {
    const hasMinimaxKey = armed.some((entry) => entry.key === "MINIMAX_API_KEY");
    if (hasMinimaxKey) {
      record("warn", "VIDEOSBATCH_TTS_PROVIDER=minimax will bill real character-based TTS on the next AUDIO_DELIVERY run");
    } else {
      record("fail", "VIDEOSBATCH_TTS_PROVIDER=minimax is set but MINIMAX_API_KEY is missing; startup will throw");
    }
  }
  record("ok", `.env size ${stat.size} bytes`);
}

const label: Record<Level, string> = { fail: "FAIL", warn: "WARN", ok: "ok  " };
for (const line of report) console.log(`[${label[line.level]}] ${line.message}`);

if (failures.length > 0) {
  console.error(`\nenv hygiene failed with ${failures.length} blocking issue(s)`);
  process.exit(1);
}
console.log("\nenv hygiene passed (no blocking issues)");
