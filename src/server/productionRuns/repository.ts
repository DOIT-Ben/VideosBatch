import { randomUUID } from "node:crypto";
import type { ProductionRun, RunEvent, RunMode } from "../../shared/productionRuns";
import { terminalRun } from "../../shared/productionRuns";
import { ProjectionJournal } from "./projectionJournal";
import { acquireProductionWriter } from "./writerLock";

export interface WorkItem {
  id: string; runId: string; stageId: string; inputHash: string;
  status: "running" | "succeeded" | "failed"; resultHash?: string;
  resumeKnown?: boolean;
}

/** Small control transactions only; generated content lives in hashed files. */
export class RunRepository {
  readonly journal: ProjectionJournal;
  private readonly releaseWriter: () => void;
  constructor(directory: string) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 16)) throw new Error("Production runs require Node >=22.16");
    this.releaseWriter = acquireProductionWriter(directory);
    try { this.journal = new ProjectionJournal(directory); }
    catch (error) { this.releaseWriter(); throw error; }
    this.journal.db.exec(`
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, sessionId TEXT NOT NULL, requestKey TEXT NOT NULL, requestHash TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(ownerId,sessionId,requestKey));
      CREATE TABLE IF NOT EXISTS run_requests(ownerId TEXT NOT NULL, sessionId TEXT NOT NULL, requestKey TEXT NOT NULL, runId TEXT NOT NULL, mode TEXT NOT NULL, PRIMARY KEY(ownerId,sessionId,requestKey));
      CREATE TABLE IF NOT EXISTS run_controls(runId TEXT NOT NULL, requestId TEXT NOT NULL, command TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(runId,requestId));
      CREATE TABLE IF NOT EXISTS work_items(id TEXT PRIMARY KEY, runId TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, itemId TEXT NOT NULL, state TEXT NOT NULL, startedAt TEXT NOT NULL, finishedAt TEXT);
      CREATE TABLE IF NOT EXISTS run_events(ownerId TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(ownerId,sequence));
      CREATE INDEX IF NOT EXISTS runs_session ON runs(sessionId);
      CREATE INDEX IF NOT EXISTS items_run ON work_items(runId);
    `);
  }
  get(id: string): ProductionRun | undefined {
    const row = this.journal.db.prepare("SELECT body FROM runs WHERE id=?").get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  list(sessionId?: string): ProductionRun[] {
    const rows = sessionId ? this.journal.db.prepare("SELECT body FROM runs WHERE sessionId=? ORDER BY rowid DESC").all(sessionId)
      : this.journal.db.prepare("SELECT body FROM runs ORDER BY rowid").all();
    return rows.map(row => JSON.parse(String(row.body)));
  }
  create(input: { ownerId: string; sessionId: string; requestKey: string; mode: RunMode; inputVersion: string; stageId: string }) {
    return this.journal.transaction(() => {
      const alias = this.journal.db.prepare("SELECT runId,mode FROM run_requests WHERE ownerId=? AND sessionId=? AND requestKey=?")
        .get(input.ownerId, input.sessionId, input.requestKey);
      if (alias) {
        if (alias.mode !== input.mode) throw Object.assign(new Error("请求标识已用于不同操作"), { status: 409 });
        return this.get(String(alias.runId))!;
      }
      const row = this.journal.db.prepare("SELECT body,requestHash FROM runs WHERE ownerId=? AND sessionId=? AND requestKey=?")
        .get(input.ownerId, input.sessionId, input.requestKey);
      // A request key pins its original input; a retransmission may arrive after
      // execution changed the current version. Mode still cannot be changed.
      if (row) {
        const run = JSON.parse(String(row.body)) as ProductionRun;
        if (run.mode !== input.mode) throw Object.assign(new Error("请求标识已用于不同操作"), { status: 409 });
        return run;
      }
      const active = this.list(input.sessionId).find(run => !terminalRun(run.status));
      if (active) {
        if (active.mode !== input.mode) throw Object.assign(new Error("项目已有不同执行计划，请先完成或停止该计划"), { status: 409 });
        this.alias(input, active.id);
        return active;
      }
      this.checkCapacity(input.ownerId);
      const time = new Date().toISOString();
      const run: ProductionRun = { id: `run_${randomUUID()}`, ownerId: input.ownerId, sessionId: input.sessionId, mode: input.mode,
        inputVersion: input.inputVersion, stageId: input.stageId, status: "queued", priority: 0, completedItems: 0, createdAt: time, updatedAt: time };
      this.journal.db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?)")
        .run(run.id, run.ownerId, run.sessionId, input.requestKey, input.inputVersion, JSON.stringify(run));
      this.alias(input, run.id);
      this.emit(run);
      return run;
    });
  }
  private alias(input: { ownerId: string; sessionId: string; requestKey: string; mode: RunMode }, id: string) {
    this.journal.db.prepare("INSERT INTO run_requests VALUES(?,?,?,?,?)").run(input.ownerId, input.sessionId, input.requestKey, id, input.mode);
  }
  update(id: string, patch: Partial<ProductionRun>) {
    return this.journal.transaction(() => {
      const run = this.get(id); if (!run) throw new Error("RUN_NOT_FOUND");
      const next = { ...run, ...patch, id: run.id, ownerId: run.ownerId, sessionId: run.sessionId, updatedAt: new Date().toISOString() };
      this.journal.db.prepare("UPDATE runs SET body=? WHERE id=?").run(JSON.stringify(next), id);
      this.emit(next); return next;
    });
  }
  private emit(run: ProductionRun) {
    const row = this.journal.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM run_events WHERE ownerId=?").get(run.ownerId)!;
    this.journal.db.prepare("INSERT INTO run_events VALUES(?,?,?)").run(run.ownerId, Number(row.next), JSON.stringify(run));
    this.journal.db.prepare("DELETE FROM run_events WHERE ownerId=? AND sequence<=?").run(run.ownerId, Number(row.next) - 10000);
  }
  controlResult(runId: string, requestId: string, command: string): ProductionRun | undefined {
    const row = this.journal.db.prepare("SELECT command,result FROM run_controls WHERE runId=? AND requestId=?").get(runId, requestId);
    if (!row) return undefined;
    if (row.command !== command) throw Object.assign(new Error("请求标识已用于不同控制操作"), { status: 409 });
    return JSON.parse(String(row.result));
  }
  applyControl(id: string, requestId: string, command: string, patch: Partial<ProductionRun>) {
    return this.journal.transaction(() => {
      const saved = this.controlResult(id, requestId, command); if (saved) return saved;
      const run = this.get(id); if (!run) throw new Error("RUN_NOT_FOUND");
      if (patch.status === "queued" && !["queued", "running"].includes(run.status)) this.checkCapacity(run.ownerId);
      const next = { ...run, ...patch, updatedAt: new Date().toISOString() };
      this.journal.db.prepare("UPDATE runs SET body=? WHERE id=?").run(JSON.stringify(next), id); this.emit(next);
      this.journal.db.prepare("INSERT INTO run_controls VALUES(?,?,?,?)").run(id, requestId, command, JSON.stringify(next));
      return next;
    });
  }
  private checkCapacity(ownerId: string) {
    const queue = this.list().filter(run => ["queued", "running", "pause_requested", "cancel_requested"].includes(run.status));
    if (queue.length >= 100 || queue.filter(run => run.ownerId === ownerId).length >= 50) throw Object.assign(new Error("任务队列已满，请等待已有任务完成"), { status: 429 });
  }
  events(ownerId: string, after: number): RunEvent[] {
    return this.journal.db.prepare("SELECT sequence,body FROM run_events WHERE ownerId=? AND sequence>? ORDER BY sequence LIMIT 200")
      .all(ownerId, after).map(row => ({ sequence: Number(row.sequence), run: JSON.parse(String(row.body)) }));
  }
  cursor(ownerId: string) { return Number(this.journal.db.prepare("SELECT COALESCE(MAX(sequence),0) AS cursor FROM run_events WHERE ownerId=?").get(ownerId)!.cursor); }
  oldestCursor(ownerId: string) { return Number(this.journal.db.prepare("SELECT COALESCE(MIN(sequence),1) AS cursor FROM run_events WHERE ownerId=?").get(ownerId)!.cursor); }
  begin(run: ProductionRun, stageId: string, input: unknown) {
    const inputHash = this.journal.writeResult(input);
    const item: WorkItem = { id: `item_${randomUUID()}`, runId: run.id, stageId, inputHash, status: "running" };
    this.journal.transaction(() => {
      this.journal.db.prepare("INSERT INTO work_items VALUES(?,?,?)").run(item.id, run.id, JSON.stringify(item));
      this.journal.db.prepare("INSERT INTO attempts VALUES(?,?,?,?,NULL)").run(`attempt_${randomUUID()}`, item.id, "running", new Date().toISOString());
    });
    return item;
  }
  items(runId: string): WorkItem[] { return this.journal.db.prepare("SELECT body FROM work_items WHERE runId=? ORDER BY rowid").all(runId).map(row => JSON.parse(String(row.body))); }
  saveItem(item: WorkItem) { this.journal.db.prepare("UPDATE work_items SET body=? WHERE id=?").run(JSON.stringify(item), item.id); }
  result(item: WorkItem, value: unknown) { item.resultHash = this.journal.writeResult(value); this.saveItem(item); }
  finish(item: WorkItem, status: "succeeded" | "failed") {
    item.status = status;
    this.journal.transaction(() => {
      this.saveItem(item);
      this.journal.db.prepare("UPDATE attempts SET state=?,finishedAt=? WHERE itemId=? AND finishedAt IS NULL").run(status, new Date().toISOString(), item.id);
    });
  }
  close() { this.journal.close(); this.releaseWriter(); }
}
