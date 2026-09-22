import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const locks = new Map<string, { count: number; release: () => void }>();

/** A separate SQLite connection holds an exclusive file lock for this process.
 * OS process death releases it: no PID reuse, stale-file deletion or takeover race.
 * This is a local-host single writer lock, not a distributed lease. */
export function acquireProductionWriter(directory: string): () => void {
  const resolved = path.resolve(directory);
  const existing = locks.get(resolved);
  if (existing) { existing.count++; return () => releaseReference(resolved); }
  mkdirSync(resolved, { recursive: true });
  const db = new DatabaseSync(path.join(resolved, "writer.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    db.close();
    throw new Error("PRODUCTION_WRITER_ALREADY_RUNNING");
  }
  const release = () => { db.exec("ROLLBACK"); db.close(); };
  process.once("exit", release);
  locks.set(resolved, { count: 1, release });
  return () => releaseReference(resolved);
}

function releaseReference(directory: string) {
  const lock = locks.get(directory); if (!lock || --lock.count > 0) return;
  lock.release(); process.removeListener("exit", lock.release); locks.delete(directory);
}
