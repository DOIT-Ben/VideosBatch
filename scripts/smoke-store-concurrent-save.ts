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

  // If the bytes cannot be quarantined *at all*, the store must refuse to come
  // up. Previously the rename failure was swallowed (`.catch(() => undefined)`)
  // and the process started with an empty snapshot anyway — the very next save()
  // then atomically overwrote the unreadable-but-intact file, i.e. the silent
  // total loss this whole branch exists to prevent (2026-09-16 review).
  //
  // Occupy the quarantine path with a non-empty directory so both `rename` and
  // the `copyFile` fallback fail portably (a file cannot replace a directory).
  const occupiedQuarantine = path.join(storeDir, "cinema-store.json.corrupt-1700000000000");
  await writeFile(storeFile, corruptBytes, "utf8");
  await mkdir(occupiedQuarantine, { recursive: true });
  await writeFile(path.join(occupiedQuarantine, "keep"), "occupied", "utf8");

  const realDateNow = Date.now;
  let refusal: Error | undefined;
  Date.now = () => 1700000000000;
  try {
    const refused = new CinemaStore();
    await refused.load();
  } catch (error) {
    refusal = error as Error;
  } finally {
    Date.now = realDateNow;
  }
  assert.ok(
    refusal,
    "an unreadable store that also cannot be quarantined must refuse to start, not silently load as empty"
  );
  assert.match(String(refusal?.message), /refusing to start/, "the refusal must explain why the process did not boot");
  assert.equal(
    await readFile(storeFile, "utf8"),
    corruptBytes,
    "a refused boot must leave the unreadable store untouched"
  );

  console.log("VideosBatch concurrent store save smoke passed");
} finally {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
}
