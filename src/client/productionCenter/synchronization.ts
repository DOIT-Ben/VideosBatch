import type { RunPacket, ProductionRun } from "../../shared/productionRuns";
import type { Session, Shot } from "../../shared/types";

export function managedExecutionSessions(runs: Iterable<ProductionRun>) {
  return [...new Set([...runs].filter(run => run.stageId === "EXECUTION" && ["queued", "running", "pause_requested", "cancel_requested"].includes(run.status)).map(run => run.sessionId))].sort().join(",");
}
export function engineTracksShot(shot: Shot, sessions: Session[], managed: string) {
  if (!managed.split(",").includes(shot.sessionId)) return false;
  const artifact = sessions.find(session => session.id === shot.sessionId)?.videosBatchWorkflow?.stages.FINAL_STORYBOARD?.artifact;
  return Boolean(artifact?.segments?.some((segment: any) => segment.nativeShotId === shot.id));
}

/** Failed reads remain pending independently from the committed event cursor. */
export class ViewSyncQueue<T> {
  private pending = new Map<string, { version: number; failures: number; after: number }>();
  private active = new Set<string>();
  private stopped = false;
  constructor(private read: (id: string) => Promise<T>, private apply: (id: string, value: T) => void,
    private visible = () => true, private now = Date.now, private retryBase = 500) {}
  mark(id: string) { const old = this.pending.get(id); this.pending.set(id, { version: (old?.version || 0) + 1, failures: old?.failures || 0, after: old?.after || 0 }); }
  pump() {
    if (this.stopped || !this.visible()) return;
    for (const [id, state] of this.pending) {
      if (this.active.size >= 4) break;
      if (this.active.has(id) || state.after > this.now()) continue;
      this.active.add(id);
      void this.read(id).then(value => {
        if (this.stopped) return;
        if (this.pending.get(id)?.version === state.version) { this.pending.delete(id); this.apply(id, value); }
      }).catch(() => {
        const current = this.pending.get(id);
        if (current) { current.failures++; current.after = this.now() + Math.min(15000, this.retryBase * 2 ** Math.min(current.failures - 1, 5)); }
      }).finally(() => { this.active.delete(id); });
    }
  }
  stop() { this.stopped = true; this.pending.clear(); }
}

/** A stream that stays open without bytes is not a healthy connection. */
export async function readRunStream(body: ReadableStream<Uint8Array>, signal: AbortSignal, packet: (packet: RunPacket) => void, activity: () => void, idleMs = 35000) {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("EVENT_HEARTBEAT_TIMEOUT")), idleMs); })]).finally(() => clearTimeout(timer));
      if (part.done) break;
      activity(); buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error("EVENT_TOO_LARGE");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const message = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (message.startsWith("data: ")) packet(JSON.parse(message.slice(6)));
      }
    }
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); }
}
