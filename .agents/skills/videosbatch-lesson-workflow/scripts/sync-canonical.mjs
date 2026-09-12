#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const source = path.resolve(String(args.source || path.resolve(process.cwd(), "specs", "videosbatch-workflow-canonical.md")));
const text = await readFile(source, "utf8");
const specId = "VIDEOSBATCH_WORKFLOW_CANONICAL";
const versionMatch = text.match(/^Canonical Version:\s*`([^`]+)`/mu);
if (!text.includes(`Spec ID: \`${specId}\``) || !versionMatch) fail("source canonical spec 缺少 Spec ID 或 Canonical Version");
const sha256 = createHash("sha256").update(text).digest("hex").toUpperCase();
const canonicalDir = path.join(skillRoot, "canonical");
const cliCanonicalDir = path.join(skillRoot, "cli", "canonical");
await mkdir(canonicalDir, { recursive: true });
await mkdir(cliCanonicalDir, { recursive: true });
await writeFile(path.join(canonicalDir, "videosbatch-workflow-canonical.md"), text, "utf8");
await writeFile(path.join(cliCanonicalDir, "videosbatch-workflow-canonical.md"), text, "utf8");
const manifest = { schemaVersion: 1, specId, canonicalVersion: versionMatch[1], sourcePath: path.relative(process.cwd(), source).replaceAll("\\", "/"), sourceSha256: sha256, snapshotPath: "canonical/videosbatch-workflow-canonical.md", snapshotSha256: sha256, generatedAt: new Date().toISOString().slice(0, 10), role: "standalone-distribution-snapshot", note: "仓库开发时以 specs/ 源文件为源；脱离仓库运行时使用此已指纹化快照。" };
await writeFile(path.join(canonicalDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(path.join(cliCanonicalDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
for (const name of ["01-intake-intro.md", "02-story-asset-plan.md", "03-assets-confirmation.md", "04-screenplay-storyboard.md", "05-execution-delivery.md", "planner.md", "stage-execution.md"]) {
  await mkdir(path.join(skillRoot, "cli", "prompts"), { recursive: true });
  await copyFile(path.join(skillRoot, "prompts", name), path.join(skillRoot, "cli", "prompts", name));
}
await mkdir(path.join(skillRoot, "cli", "scripts"), { recursive: true });
await copyFile(path.join(skillRoot, "scripts", "build-stage-prompt.mjs"), path.join(skillRoot, "cli", "scripts", "build-stage-prompt.mjs"));
console.log(JSON.stringify({ source, specId, canonicalVersion: versionMatch[1], sha256, skillSnapshot: path.join(canonicalDir, "videosbatch-workflow-canonical.md"), cliSnapshot: path.join(cliCanonicalDir, "videosbatch-workflow-canonical.md") }, null, 2));

function parseArgs(argv) { const result = {}; for (let index = 0; index < argv.length; index += 1) { const token = argv[index]; if (!token.startsWith("--") || !argv[index + 1]) fail(`参数无效：${token}`); result[token.slice(2)] = argv[index + 1]; index += 1; } return result; }
function fail(message) { console.error(`sync-canonical: ${message}`); process.exit(2); }
