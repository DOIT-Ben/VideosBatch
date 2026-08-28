import { strict as assert } from "node:assert";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();

const forbidden = [
  ["INTRO", "GENERATION"],
  ["STORY", "EXPANSION"],
  ["STORY", "SELECTION"],
  ["ASSET", "PROMPT", "GENERATION"],
  ["ASSET", "GENERATION"],
  ["SCREENPLAY", "GENERATION"],
  ["STORYBOARD", "GENERATION"],
  ["REFERENCE", "BINDING"],
  ["VIDEO", "GENERATION"]
].map((parts) => parts.join("_"));

const exactFiles = [
  "src/shared/videosBatchWorkflow.ts",
  ".agents/skills/videosbatch-lesson-workflow/SKILL.md",
  "docs/seereel-injection-map.md"
];
const directories = [
  "src/server/videosBatchWorkflow",
  "src/client/videosBatchWorkflow"
];

async function collectFiles(directory: string): Promise<string[]> {
  const absolute = path.join(root, directory);
  const entries = await readdir(absolute);
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.join(directory, entry);
    const info = await stat(path.join(root, relative));
    if (info.isDirectory()) files.push(...await collectFiles(relative));
    else if (/\.(?:ts|tsx|js|jsx|md)$/.test(entry)) files.push(relative);
  }
  return files;
}

const scripts = (await readdir(path.join(root, "scripts")))
  .filter((name) => /^smoke-videosbatch-.*\.ts$/.test(name) && name !== path.basename(import.meta.filename))
  .map((name) => path.join("scripts", name));

const files = [
  ...exactFiles,
  ...scripts,
  ...(await Promise.all(directories.map(collectFiles))).flat()
];

const violations: string[] = [];
for (const file of files) {
  const source = await readFile(path.join(root, file), "utf8");
  for (const token of forbidden) {
    if (source.includes(token)) violations.push(`${file}: ${token}`);
  }
}

assert.deepEqual(
  violations,
  [],
  `VideosBatch current working tree contains superseded workflow vocabulary:\n${violations.join("\n")}`
);

console.log(`VideosBatch no-legacy-contract smoke passed (${files.length} canonical files scanned)`);
