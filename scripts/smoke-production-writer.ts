import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { acquireProductionWriter } from "../src/server/productionRuns/writerLock";

const [mode, directory] = process.argv.slice(2);
if (mode) {
  try {
    const release = acquireProductionWriter(directory);
    if (mode === "hold") { console.log("locked"); setInterval(() => {}, 1000); }
    else { release(); process.exit(0); }
  } catch { process.exit(71); }
} else {
  const directory = mkdtempSync(path.join(os.tmpdir(), "videosbatch-writer-"));
  const args = ["--import", "tsx", fileURLToPath(import.meta.url)];
  const holder = spawn(process.execPath, [...args, "hold", directory], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const timeout = setTimeout(() => holder.kill("SIGKILL"), 15_000);
  try {
    await once(holder.stdout, "data");
    const contender = spawnSync(process.execPath, [...args, "probe", directory], { timeout: 5000, windowsHide: true });
    assert.equal(contender.status, 71, "second process must not become a writer");
    const exited = once(holder, "exit"); holder.kill("SIGKILL"); await exited;
    const resumed = spawnSync(process.execPath, [...args, "probe", directory], { timeout: 5000, windowsHide: true });
    assert.equal(resumed.status, 0, "OS must release lock even without process cleanup");
    console.log("production writer passed: concurrent process rejected, SIGKILL releases lock");
  } finally { clearTimeout(timeout); if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL"); }
}
