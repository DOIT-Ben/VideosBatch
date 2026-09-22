import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import path from "node:path";

export interface ProjectionIntent {
  operationId: string;
  ownerId: string;
  sessionId: string;
  expectedVersion: string;
  resultHash: string;
  applied: number;
}

export const bytesHash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

/** Control-store primitive. The caller remains the only CinemaStore writer.
 * apply must persist operationId atomically WITH the result; a repeated apply
 * must check that marker before checking expectedVersion. */
export class ProjectionJournal {
  readonly db: DatabaseSync;
  readonly resultsDir: string;

  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.resultsDir = path.join(directory, "results");
    mkdirSync(this.resultsDir, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, "control.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS projections (
        operationId TEXT PRIMARY KEY, ownerId TEXT NOT NULL, sessionId TEXT NOT NULL,
        expectedVersion TEXT NOT NULL, resultHash TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0
      );`);
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  writeResult(value: unknown): string {
    const bytes = JSON.stringify(value);
    if (bytes === undefined) throw new Error("RESULT_REQUIRED");
    const hash = bytesHash(bytes);
    const target = path.join(this.resultsDir, `${hash}.json`);
    const tmp = `${target}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, "wx");
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, target);
    return hash;
  }

  record(input: Omit<ProjectionIntent, "applied">) {
    const existing = this.get(input.operationId);
    if (existing) {
      for (const key of ["ownerId", "sessionId", "expectedVersion", "resultHash"] as const) {
        if (existing[key] !== input[key]) throw new Error("PROJECTION_IDEMPOTENCY_CONFLICT");
      }
      return existing;
    }
    // Validate before committing a reference; recovery also rechecks integrity.
    this.readResult(input.resultHash);
    this.db.prepare("INSERT INTO projections(operationId,ownerId,sessionId,expectedVersion,resultHash) VALUES(?,?,?,?,?)")
      .run(input.operationId, input.ownerId, input.sessionId, input.expectedVersion, input.resultHash);
    return this.get(input.operationId)!;
  }

  get(operationId: string): ProjectionIntent | undefined {
    return this.db.prepare("SELECT * FROM projections WHERE operationId=?").get(operationId) as unknown as ProjectionIntent | undefined;
  }

  pending(): ProjectionIntent[] {
    return this.db.prepare("SELECT * FROM projections WHERE applied=0 ORDER BY rowid").all() as unknown as ProjectionIntent[];
  }

  readResult(hash: string): unknown {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("INVALID_RESULT_HASH");
    const bytes = readFileSync(path.join(this.resultsDir, `${hash}.json`), "utf8");
    if (bytesHash(bytes) !== hash) throw new Error("RESULT_INTEGRITY_FAILED");
    return JSON.parse(bytes);
  }

  async project(operationId: string, apply: (intent: ProjectionIntent, value: unknown) => Promise<void>) {
    const intent = this.get(operationId);
    if (!intent) throw new Error("PROJECTION_NOT_FOUND");
    if (intent.applied) return;
    await apply(intent, this.readResult(intent.resultHash));
    this.db.prepare("UPDATE projections SET applied=1 WHERE operationId=?").run(operationId);
  }

  /** Control DB only. Full backup requires quiescing the unique writer and
   * copying CinemaStore plus the referenced result files in the same window. */
  async backupControlTo(destination: string) { await backup(this.db, destination); }
  close() { this.db.close(); }
}
