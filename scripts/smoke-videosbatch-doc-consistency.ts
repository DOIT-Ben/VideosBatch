import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const canonicalRel = "specs/videosbatch-workflow-canonical.md";
const archiveRel = "docs/archive/videosbatch-design";
const failures: string[] = [];

function absolute(relativePath: string) {
  const resolved = path.resolve(root, relativePath);
  const rootWithSeparator = `${path.resolve(root)}${path.sep}`;
  if (resolved !== path.resolve(root) && !resolved.startsWith(rootWithSeparator)) {
    throw new Error(`path escapes repository: ${relativePath}`);
  }
  return resolved;
}

function fail(message: string) {
  failures.push(message);
}

function requireFile(relativePath: string) {
  const file = absolute(relativePath);
  if (!existsSync(file) || !statSync(file).isFile()) {
    fail(`missing file: ${relativePath}`);
  }
  return file;
}

function sha256(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

function normalize(relativePath: string) {
  return relativePath.replaceAll(path.sep, "/");
}

const canonicalFile = requireFile(canonicalRel);
if (canonicalFile) {
  const canonical = readFileSync(canonicalFile, "utf8");
  for (const required of [
    "Spec ID: `VIDEOSBATCH_WORKFLOW_CANONICAL`",
    "## Phase 1 Governance Plan",
    "## 0. Canonical Pipeline Index",
    "## Canonical Prompt Materials",
    "## 6. Canonical Transport Schemas",
    "## 7. Canonical Business Gates",
    "## 8. Provider、重试与失败隔离",
    "## Acceptance Criteria"
  ]) {
    if (!canonical.includes(required)) fail(`${canonicalRel}: missing ${required}`);
  }
}

const manifestFile = requireFile(`${archiveRel}/manifest.json`);
let manifest: {
  canonicalReplacement?: string;
  entries?: Array<{
    originalPath: string;
    archivePath: string;
    bytes: number;
    sha256: string;
    sourceBytes?: number;
    sourceSha256?: string;
    archiveNormalization?: string;
    sourceStatus?: string;
  }>;
};
try {
  manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as typeof manifest;
} catch (error) {
  fail(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  manifest = {};
}

if (manifest.canonicalReplacement !== canonicalRel) {
  fail(`manifest canonicalReplacement must be ${canonicalRel}`);
}

const entries = manifest.entries ?? [];
if (entries.length !== 8) fail(`manifest expected 8 entries, found ${entries.length}`);

const expectedOriginals = new Set([
  "docs/视频制作工作流完整步骤.md",
  "docs/superpowers/plans/2026-08-29-videosbatch-guided-studio-v2.md",
  "docs/superpowers/plans/2026-08-29-videosbatch-product-ui-foundation.md",
  "docs/superpowers/plans/2026-08-29-videosbatch-visual-consolidation.md",
  "docs/superpowers/specs/2026-08-29-videosbatch-guided-studio-v2-design.md",
  "docs/superpowers/specs/2026-08-29-videosbatch-product-ui-design.md",
  "docs/superpowers/specs/2026-08-29-videosbatch-visual-consolidation-design.md",
  ".agents/skills/videosbatch-lesson-workflow/SKILL.md"
]);
const upstreamOriginal = "docs/视频制作工作流完整步骤.md";
const upstreamSourceBytes = 60400;
const upstreamSourceSha256 = "8A794F875E117A9301150EBDEAF7E9B614EA2BDE18514652F8FEB729001E24B4";

for (const entry of entries) {
  const original = normalize(entry.originalPath);
  const archive = normalize(entry.archivePath);
  if (!expectedOriginals.delete(original)) fail(`unexpected or duplicate manifest originalPath: ${original}`);

  let archivedFile: string;
  try {
    archivedFile = requireFile(entry.archivePath);
  } catch (error) {
    fail(`invalid archive path ${entry.archivePath}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  const actualBytes = statSync(archivedFile).size;
  const actualHash = sha256(archivedFile);
  if (actualBytes !== entry.bytes) fail(`${archive}: byte count mismatch for ${archive}`);
  if (actualHash !== entry.sha256.toUpperCase()) fail(`${archive}: SHA-256 mismatch`);

  const hasSourceEvidence = entry.sourceBytes !== undefined || entry.sourceSha256 !== undefined;
  if (hasSourceEvidence) {
    if (!Number.isInteger(entry.sourceBytes) || (entry.sourceBytes as number) <= 0) {
      fail(`${archive}: sourceBytes must be a positive integer`);
    }
    if (!entry.sourceSha256 || !/^[0-9A-F]{64}$/i.test(entry.sourceSha256)) {
      fail(`${archive}: sourceSha256 must be a 64-character hexadecimal digest`);
    }
    if (entry.sourceBytes !== entry.bytes && !entry.archiveNormalization) {
      fail(`${archive}: archiveNormalization is required when source and archive byte counts differ`);
    }
  }
  if (original === upstreamOriginal) {
    if (entry.sourceBytes !== upstreamSourceBytes) fail(`${archive}: upstream sourceBytes evidence changed`);
    if (entry.sourceSha256?.toUpperCase() !== upstreamSourceSha256) fail(`${archive}: upstream sourceSha256 evidence changed`);
  }

  const sourceFile = absolute(entry.originalPath);
  if (entry.sourceStatus === "replaced-by-derived-entry") {
    if (!existsSync(sourceFile) || !statSync(sourceFile).isFile()) fail(`derived source entry missing: ${original}`);
  } else if (existsSync(sourceFile)) {
    fail(`archived source still exists at active path: ${original}`);
  }
}

for (const missing of expectedOriginals) fail(`manifest missing originalPath: ${missing}`);

const activeOldPaths = [
  "docs/视频制作工作流完整步骤.md",
  "docs/superpowers/plans/2026-08-29-videosbatch-guided-studio-v2.md",
  "docs/superpowers/plans/2026-08-29-videosbatch-product-ui-foundation.md",
  "docs/superpowers/plans/2026-08-29-videosbatch-visual-consolidation.md",
  "docs/superpowers/specs/2026-08-29-videosbatch-guided-studio-v2-design.md",
  "docs/superpowers/specs/2026-08-29-videosbatch-product-ui-design.md",
  "docs/superpowers/specs/2026-08-29-videosbatch-visual-consolidation-design.md"
];
for (const oldPath of activeOldPaths) {
  if (existsSync(absolute(oldPath))) fail(`old active path still exists: ${oldPath}`);
}

const derivedSkill = requireFile(".agents/skills/videosbatch-lesson-workflow/SKILL.md");
if (derivedSkill) {
  const skill = readFileSync(derivedSkill, "utf8");
  if (!skill.includes(canonicalRel)) fail("derived VideosBatch skill does not link canonical spec");
  if (skill.includes("COURSE_VIDEO_WORKFLOW_CANONICAL") || skill.includes("f5a1c78")) {
    fail("derived VideosBatch skill still carries superseded source identity");
  }
  if (skill.includes("### COURSE_INTRO_CANDIDATES") || skill.includes("### FINAL_STORYBOARD")) {
    fail("derived VideosBatch skill still defines duplicate stage sections");
  }
}

const linkedFiles: Array<[string, string]> = [
  ["AGENTS.md", canonicalRel],
  ["UPSTREAM_SEEREEL.md", canonicalRel],
  ["docs/seereel-injection-map.md", canonicalRel],
  ["docs/videosbatch-runtime-facts.md", canonicalRel],
  ["docs/agent-workflow.md", canonicalRel],
  ["docs/workflow-ui-feature-map.md", canonicalRel],
  ["specs/README.md", canonicalRel],
  ["specs/generation-workflow.md", canonicalRel],
  ["specs/ui-system.md", canonicalRel],
  ["docs/archive/videosbatch-design/README.md", canonicalRel]
];
for (const [file, link] of linkedFiles) {
  const target = requireFile(file);
  if (target) {
    const source = readFileSync(target, "utf8");
    const fileDirectory = path.posix.dirname(normalize(file));
    const relativeLink = path.posix.relative(fileDirectory, link).replaceAll("\\", "/");
    const linkCandidates = new Set([link, relativeLink, `./${relativeLink}`]);
    if (![...linkCandidates].some((candidate) => source.includes(candidate))) {
      fail(`${file} does not link ${link} (accepted relative form: ${relativeLink})`);
    }
  }
}

const activeTextExtensions = new Set([".md", ".ts", ".tsx", ".mjs", ".yml", ".yaml", ".json"]);
const skipDirectories = new Set([".git", "node_modules", "dist", "data", "archive"]);
function collectActiveTextFiles(relativeDirectory: string): string[] {
  const directory = absolute(relativeDirectory);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    if (skipDirectories.has(name)) continue;
    const child = path.join(directory, name);
    const childRelative = normalize(path.relative(root, child));
    const info = statSync(child);
    if (info.isDirectory()) files.push(...collectActiveTextFiles(childRelative));
    else if (activeTextExtensions.has(path.extname(name).toLowerCase())) files.push(childRelative);
  }
  return files;
}

for (const file of collectActiveTextFiles(".")) {
  if (file === canonicalRel || file === "scripts/smoke-videosbatch-doc-consistency.ts") continue;
  const source = readFileSync(absolute(file), "utf8");
  for (const forbidden of [
    "docs/superpowers/plans/2026-08-28-videosbatch-phase1-linear-workflow.md",
    "docs/superpowers/plans/2026-08-29-videosbatch-guided-studio-v2.md",
    "docs/superpowers/plans/2026-08-29-videosbatch-product-ui-foundation.md",
    "docs/superpowers/plans/2026-08-29-videosbatch-visual-consolidation.md",
    "docs/superpowers/specs/2026-08-29-videosbatch-guided-studio-v2-design.md",
    "docs/superpowers/specs/2026-08-29-videosbatch-product-ui-design.md",
    "docs/superpowers/specs/2026-08-29-videosbatch-visual-consolidation-design.md",
    "COURSE_VIDEO_WORKFLOW_CANONICAL",
    "f5a1c78bd14bd2889c1eb7949e9a5983ea4b48e0"
  ]) {
    if (source.includes(forbidden)) fail(`${file} contains superseded reference: ${forbidden}`);
  }
}

if (failures.length > 0) {
  console.error(`VideosBatch document consistency smoke failed (${failures.length} issue(s))`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("VideosBatch document consistency smoke passed (canonical source, archive manifest, and active references)");
