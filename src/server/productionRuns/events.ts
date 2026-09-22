import type { Application, Request } from "express";
import type { CinemaStore } from "../store";
import type { RunCursor, RunPacket } from "../../shared/productionRuns";
import type { ProductionEngine } from "./engine";
import { contentHash } from "../videosBatchWorkflow/canonicalStoryboard";

/** A single authenticated connection multiplexes owner streams. Scope changes
 * require a snapshot; the vector acknowledges filtered/deleted sessions too. */
export function registerRunEvents(app: Application, store: CinemaStore, engine: ProductionEngine, authorize: (session: { ownerUserId?: string }, req: Request) => boolean) {
  const repository = engine.repository;
  const scopeFor = (req: Request) => {
    const sessions = store.snapshot().sessions.filter(session => { try { return authorize(session, req); } catch { return false; } });
    return { ids: new Set(sessions.map(session => session.id)), owners: [...new Set(sessions.map(session => session.ownerUserId || "legacy"))].sort(),
      hash: contentHash(sessions.map(session => [session.id, session.ownerUserId || "legacy"]).sort()) };
  };
  const snapshot = (req: Request): RunPacket => repository.journal.transaction(() => {
    const scope = scopeFor(req);
    return { kind: "snapshot", cursor: { scope: scope.hash, offsets: Object.fromEntries(scope.owners.map(owner => [owner, repository.cursor(owner)])) },
      runs: repository.list().filter(run => scope.ids.has(run.sessionId)) };
  });
  const next = (req: Request, cursor?: RunCursor): RunPacket | undefined => {
    const scope = scopeFor(req);
    if (!cursor || cursor.scope !== scope.hash || !cursor.offsets || Object.keys(cursor.offsets).sort().join() !== scope.owners.join()
      || scope.owners.some(owner => !Number.isSafeInteger(cursor.offsets[owner]) || cursor.offsets[owner] < repository.oldestCursor(owner) - 1 || cursor.offsets[owner] > repository.cursor(owner))) return snapshot(req);
    const offsets = { ...cursor.offsets };
    const events = scope.owners.flatMap(owner => {
      const events = repository.events(owner, offsets[owner]);
      if (events.length) offsets[owner] = events.at(-1)!.sequence;
      return events.filter(event => scope.ids.has(event.run.sessionId));
    });
    if (scope.owners.every(owner => offsets[owner] === cursor.offsets[owner])) return undefined;
    return { kind: "delta", previous: cursor, cursor: { scope: scope.hash, offsets }, events };
  };
  app.get("/api/production/snapshot", async (req, res) => { await engine.ready; res.setHeader("Cache-Control", "no-store"); res.json(snapshot(req)); });
  app.get("/api/production/events", async (req, res) => {
    await engine.ready;
    let cursor: RunCursor | undefined;
    try { if (typeof req.query.cursor === "string" && req.query.cursor.length < 64000) cursor = JSON.parse(req.query.cursor); } catch { /* full resync */ }
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(": connected\n\n");
    let closed = false;
    const send = () => {
      if (closed) return;
      try {
        const packet = next(req, cursor);
        if (!packet) return;
        cursor = packet.cursor;
        if (!res.write(`data: ${JSON.stringify(packet)}\n\n`)) res.end();
      } catch { res.end(); }
    };
    send();
    const timer = setInterval(send, 200);
    const heartbeat = setInterval(() => { if (!closed && !res.write(": heartbeat\n\n")) res.end(); }, 15000);
    const expiry = setTimeout(() => res.end(), 5 * 60 * 1000);
    res.on("close", () => { closed = true; clearInterval(timer); clearInterval(heartbeat); clearTimeout(expiry); });
  });
}
