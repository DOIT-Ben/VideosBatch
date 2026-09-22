import type { ProductionRun, RunCursor, RunPacket } from "../../shared/productionRuns";
export function sameCursor(a?: RunCursor, b?: RunCursor) {
  return Boolean(a && b && a.scope === b.scope && Object.keys(a.offsets).length === Object.keys(b.offsets).length
    && Object.keys(a.offsets).every(key => a.offsets[key] === b.offsets[key]));
}
export class ProductionRunStore {
  runs = new Map<string, ProductionRun>();
  latestBySession = new Map<string, ProductionRun>();
  revision = 0;
  cursor?: RunCursor;
  connection: "connecting" | "connected" | "recovering" = "connecting";
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  notify = () => this.listeners.forEach(listener => listener());
  setConnection(value: typeof this.connection) { if (value !== this.connection) { this.connection = value; this.notify(); } }
  apply(packet: RunPacket): string[] | false {
    if (sameCursor(packet.cursor, this.cursor) && packet.kind === "delta") return [];
    if (packet.kind === "delta" && !sameCursor(packet.previous, this.cursor)) return false;
    const changed = new Set<string>();
    if (packet.kind === "snapshot") {
      const incoming = new Map(packet.runs.map(run => [run.id, run]));
      for (const run of this.runs.values()) if (!incoming.has(run.id)) changed.add(run.sessionId);
      for (const [id, run] of incoming) {
        const old = this.runs.get(id);
        if (old && JSON.stringify(old) === JSON.stringify(run)) incoming.set(id, old);
        else changed.add(run.sessionId);
      }
      this.runs = incoming;
    } else for (const { run } of packet.events) { this.runs.set(run.id, run); changed.add(run.sessionId); }
    this.cursor = packet.cursor;
    for (const sessionId of changed) this.latestBySession.delete(sessionId);
    for (const run of this.runs.values()) if (changed.has(run.sessionId)) {
      const previous = this.latestBySession.get(run.sessionId);
      if (!previous || previous.createdAt <= run.createdAt) this.latestBySession.set(run.sessionId, run);
    }
    this.revision++;
    this.notify();
    return [...changed];
  }
  latest(sessionId: string) { return this.latestBySession.get(sessionId); }
}
export const productionRuns = new ProductionRunStore();
