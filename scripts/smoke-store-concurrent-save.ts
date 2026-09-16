import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  // A store that exists but cannot be parsed must never be treated as "empty":
  // the next save would atomically overwrite it and every session would be gone
  // with no warning. The bytes must be quarantined instead.
  const storeDir = path.join(tmp, "data");
  const storeFile = path.join(storeDir, "cinema-store.json");
  await mkdir(storeDir, { recursive: true });
  const corruptBytes = "{ this is not json";
  await writeFile(storeFile, corruptBytes, "utf8");

  const salvaged = new CinemaStore();
  await salvaged.load();
  assert.equal(salvaged.snapshot().sessions.length, 0, "an unreadable store must load as empty");
  const quarantined = (await readdir(storeDir)).filter((name) => name.includes(".corrupt-"));
  assert.equal(quarantined.length, 1, "an unreadable store must be quarantined, not silently discarded");
  assert.equal(
    await readFile(path.join(storeDir, quarantined[0]), "utf8"),
    corruptBytes,
    "quarantine must preserve the original bytes for manual recovery"
  );

  console.log("VideosBatch concurrent store save smoke passed");
} finally {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
}
