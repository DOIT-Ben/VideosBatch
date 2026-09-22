import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, renameSync, copyFileSync, readdirSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectionJournal } from "../src/server/productionRuns/projectionJournal";

// Process exits (not caught exceptions) exercise actual SQLite WAL recovery.
const [mode, dir, boundary] = process.argv.slice(2);
const operationId = "fixture-operation";
if (mode === "child") {
  const journal = new ProjectionJournal(dir);
  const hash = journal.writeResult({ lesson: "saved text" });
  if (boundary === "result") process.exit(73);
  journal.transaction(() => journal.record({ operationId, ownerId: "a", sessionId: "s", expectedVersion: "0", resultHash: hash }));
  if (boundary === "intent") process.exit(73);
  await journal.project(operationId, async (intent, value) => {
    const file = path.join(dir, "fixture.json");
    let state = { revision: 0, operations: [] as string[], artifact: null as unknown };
    try { state = JSON.parse(readFileSync(file, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (state.operations.includes(intent.operationId)) return;
    assert.equal(String(state.revision), intent.expectedVersion);
    writeFileSync(file + ".tmp", JSON.stringify({ revision: 1, operations: [intent.operationId], artifact: value }));
    renameSync(file + ".tmp", file);
    if (boundary === "projection") process.exit(73);
  });
  if (boundary === "ack") process.exit(73);
  journal.close();
} else {
  const root = mkdtempSync(path.join(os.tmpdir(), "videosbatch-storage-"));
  for (const point of ["result", "intent", "projection", "ack"]) {
    const directory = path.join(root, point);
    const run = (fault: string) => spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "child", directory, fault], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    const crashed = run(point); assert.equal(crashed.status, 73, crashed.stderr);
    let journal = new ProjectionJournal(directory);
    assert.equal(journal.get(operationId)?.applied || 0, point === "ack" ? 1 : 0);
    journal.close();
    const recovered = run("recover"); assert.equal(recovered.status, 0, recovered.stderr);
    const repeated = run("recover"); assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(directory, "fixture.json"), "utf8")).revision, 1);
    journal = new ProjectionJournal(directory);
    assert.equal(journal.pending().length, 0);
    const saved = journal.get(operationId)!;
    assert.throws(() => journal.transaction(() => journal.record({ ...saved, ownerId: "b" })), /CONFLICT/);
    assert.throws(() => journal.transaction(() => { journal.db.exec("DELETE FROM projections"); throw new Error("rollback"); }));
    assert.ok(journal.get(operationId));
    const restore = path.join(directory, "restore"); mkdirSync(path.join(restore, "results"), { recursive: true });
    // No writer is active: copy all three stores in this quiescent window.
    await journal.backupControlTo(path.join(restore, "control.sqlite"));
    copyFileSync(path.join(directory, "fixture.json"), path.join(restore, "fixture.json"));
    for (const file of readdirSync(journal.resultsDir)) if (file.endsWith(".json")) copyFileSync(path.join(journal.resultsDir, file), path.join(restore, "results", file));
    const restored = new ProjectionJournal(restore);
    assert.deepEqual(restored.readResult(saved.resultHash), { lesson: "saved text" });
    assert.equal(restored.get(operationId)?.applied, 1);
    const restoredState = JSON.parse(readFileSync(path.join(restore, "fixture.json"), "utf8"));
    assert.deepEqual(restoredState, { revision: 1, operations: [operationId], artifact: { lesson: "saved text" } });
    await restored.project(operationId, async () => { assert.fail("acknowledged result must not publish twice"); });
    assert.deepEqual(JSON.parse(readFileSync(path.join(restore, "fixture.json"), "utf8")), restoredState);
    writeFileSync(path.join(restored.resultsDir, saved.resultHash + ".json"), "{}");
    assert.throws(() => restored.readResult(saved.resultHash), /INTEGRITY/);
    assert.throws(() => restored.readResult("../../escape"), /INVALID/);
    restored.close(); journal.close();
  }
  console.log(`production storage passed: 4 process-crash boundaries, replay, rollback, backup/restore, corruption; synthetic evidence: ${root}`);
}
