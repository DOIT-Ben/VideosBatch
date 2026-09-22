import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const script = path.resolve("scripts/inline-entry-assets.mjs");
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-adr0003-build-"));
try {
  const dist = path.join(tmp, "dist/client");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), '<script type="module" crossorigin src="/assets/index-test.js"></script><link rel="stylesheet" crossorigin href="/assets/index-test.css">');
  await writeFile(path.join(dist, "assets/index-test.js"), 'import("./workspace-test.js");');
  await writeFile(path.join(dist, "assets/workspace-test.js"), 'export const ready = true;');
  await writeFile(path.join(dist, "assets/index-test.css"), "body { color: black; }");
  execFileSync(process.execPath, [script], { cwd: tmp });
  const html = await readFile(path.join(dist, "index.html"), "utf8");
  assert(html.includes('src="/assets/index-test.js"'), "module URL must remain the import base");
  assert(html.includes("<style data-inline-entry>"));
  assert.equal(new URL("./workspace-test.js", "https://example.test/assets/index-test.js").pathname, "/assets/workspace-test.js");
  execFileSync(process.execPath, [script], { cwd: tmp });
  assert.equal(await readFile(path.join(dist, "index.html"), "utf8"), html, "postprocessing is idempotent");
  console.log("ADR0003 build smoke passed: module URL retained, CSS inline, idempotent output");
} finally {
  if (path.dirname(tmp) !== os.tmpdir() || !path.basename(tmp).startsWith("videosbatch-adr0003-build-")) throw new Error("Unexpected temporary directory");
  await rm(tmp, { recursive: true });
}
