import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-store-save-"));
process.chdir(tmp);

try {
  const { CinemaStore } = await import("../src/server/store");
  const store = new CinemaStore();
  await store.load();
  const internal = store as any;
  internal.data.sessions.push({
    id: "ses_save_a",
    title: "first mutation",
    logline: "",
    style: "test",
    language: "zh",
    targetDurationSec: 90,
    tokenUsageEvents: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  let release!: () => void;
  internal.writeQueue = new Promise<void>((resolve) => { release = resolve; });
  const pending = store.save();
  // This mutation happens while the earlier write is waiting. The queued
  // writer must serialize the latest in-memory state, not its stale snapshot.
  internal.data.sessions.push({
    id: "ses_save_b",
    title: "second mutation",
    logline: "",
    style: "test",
    language: "zh",
    targetDurationSec: 90,
    tokenUsageEvents: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  release();
  await pending;

  const reloaded = new CinemaStore();
  await reloaded.load();
  assert.deepEqual(reloaded.snapshot().sessions.map((session) => session.id).sort(), ["ses_save_a", "ses_save_b"]);
  console.log("VideosBatch concurrent store save smoke passed");
} finally {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
}
