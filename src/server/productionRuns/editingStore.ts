import type { ProjectionJournal } from "./projectionJournal";
import type { ServerDraft, EditOperation } from "../../shared/editing";
import { VIDEOS_BATCH_STAGE_ORDER, type VideosBatchStageId } from "../../shared/videosBatchWorkflow";
import { contentHash } from "../videosBatchWorkflow/canonicalStoryboard";
export const editFailure = (message: string, code = "EDIT_CONFLICT", status = 409) => Object.assign(new Error(message), { status, code });

export class EditingStore {
  constructor(private journal: ProjectionJournal) {
    journal.db.exec(`CREATE TABLE IF NOT EXISTS editing_drafts(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS edit_operations(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, body TEXT NOT NULL);`);
  }
  drafts(sessionId: string): ServerDraft[] { return this.journal.db.prepare("SELECT body FROM editing_drafts WHERE sessionId=? ORDER BY rowid DESC").all(sessionId).map(row => JSON.parse(String(row.body))); }
  draft(id: string): ServerDraft | undefined { const row = this.journal.db.prepare("SELECT body FROM editing_drafts WHERE id=?").get(id); return row ? JSON.parse(String(row.body)) : undefined; }
  sync(input: Omit<ServerDraft, "active" | "leaseUntil" | "updatedAt">) {
    return this.journal.transaction(() => {
      const previous = this.draft(input.id);
      if (previous && (previous.ownerId !== input.ownerId || previous.sessionId !== input.sessionId || previous.stageId !== input.stageId)) throw editFailure("草稿不存在", "DRAFT_NOT_FOUND", 404);
      if (previous && previous.instanceId !== input.instanceId && previous.leaseUntil > Date.now()) throw editFailure("这份草稿正在另一页面编辑，请创建独立副本。", "DRAFT_IN_USE");
      if (previous && !previous.active && input.clientVersion <= previous.clientVersion) throw editFailure("草稿已发布或丢弃，请开始新的修改。", "DRAFT_CLOSED");
      if (previous && (input.clientVersion < previous.clientVersion || (input.clientVersion === previous.clientVersion && contentHash([input.value, input.baseRevision, input.baseSignature]) !== contentHash([previous.value, previous.baseRevision, previous.baseSignature])))) throw editFailure("服务端草稿已有更新，本机内容已保留。", "DRAFT_VERSION_CONFLICT");
      const next: ServerDraft = { ...input, active: true, leaseUntil: Date.now() + 45000, updatedAt: new Date().toISOString() };
      this.writeDraft(next); return next;
    });
  }
  private writeDraft(draft: ServerDraft) { this.journal.db.prepare("INSERT INTO editing_drafts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(draft.id, draft.sessionId, JSON.stringify(draft)); }
  release(id: string, instanceId: string, clientVersion: number, discard = false) {
    const draft = this.draft(id);
    if (!draft || draft.instanceId !== instanceId) throw editFailure("不能释放其他页面的编辑占用。", "DRAFT_INSTANCE_CONFLICT");
    if (!Number.isSafeInteger(clientVersion) || (discard ? draft.clientVersion > clientVersion : draft.clientVersion !== clientVersion)) throw editFailure("草稿已有新修改，已保留占用。", "DRAFT_VERSION_CONFLICT");
    // Closing version N also closes this instance's older acknowledged draft.
    // Retain N as a tombstone so delayed PUT <= N cannot reopen the hold.
    this.writeDraft({ ...draft, clientVersion: discard ? clientVersion : draft.clientVersion, leaseUntil: 0, active: discard ? false : draft.active });
  }
  published(id: string, instanceId: string, clientVersion: number) {
    const draft = this.draft(id);
    if (draft?.instanceId === instanceId && draft.clientVersion === clientVersion) this.writeDraft({ ...draft, active: false, leaseUntil: 0 });
  }
  blocked(sessionId: string, stageId: VideosBatchStageId) {
    return this.drafts(sessionId).some(draft => draft.active && VIDEOS_BATCH_STAGE_ORDER.indexOf(draft.stageId) <= VIDEOS_BATCH_STAGE_ORDER.indexOf(stageId))
      || this.operations(sessionId).some(operation => operation.state === "prepared");
  }
  operation(id: string): EditOperation | undefined { const row = this.journal.db.prepare("SELECT body FROM edit_operations WHERE id=?").get(id); return row ? JSON.parse(String(row.body)) : undefined; }
  operations(sessionId?: string): EditOperation[] {
    const rows = sessionId ? this.journal.db.prepare("SELECT body FROM edit_operations WHERE sessionId=? ORDER BY rowid").all(sessionId) : this.journal.db.prepare("SELECT body FROM edit_operations ORDER BY rowid").all();
    return rows.map(row => JSON.parse(String(row.body)));
  }
  saveOperation(operation: EditOperation) { this.journal.db.prepare("INSERT INTO edit_operations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(operation.id, operation.sessionId, JSON.stringify(operation)); }
}
