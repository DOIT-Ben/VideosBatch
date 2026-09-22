import { useEffect, useRef, useSyncExternalStore } from "react";
import { api, accessHeaders } from "../api";
import type { RunPacket } from "../../shared/productionRuns";
import { productionRuns } from "./runStore";
import { managedExecutionSessions, readRunStream, ViewSyncQueue } from "./synchronization";

/** fetch-based SSE keeps the existing access header out of URLs. One reader,
 * one bounded repaint queue, and only the latest session read is applied. */
export function useRunEvents(onView: (sessionId: string, view: Awaited<ReturnType<typeof api.productionView>>) => void) {
  const callback = useRef(onView); callback.current = onView;
  useEffect(() => {
    let stopped = false; let attempt = 0; let frame = 0; let retry: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    const views = new ViewSyncQueue(api.productionView, (id, view) => callback.current(id, view), () => document.visibilityState === "visible");
    const packets: RunPacket[] = [];
    const flush = () => {
      if (stopped) return;
      frame = 0;
      for (const packet of packets.splice(0)) {
        const changed = productionRuns.apply(packet);
        if (changed === false) { productionRuns.cursor = undefined; controller.abort(); return; }
        changed.forEach(id => views.mark(id));
      }
      views.pump();
    };
    const enqueue = (packet: RunPacket) => {
      packets.push(packet);
      if (packets.length > 100) { packets.length = 0; productionRuns.cursor = undefined; controller.abort(); return; }
      if (!frame) frame = document.visibilityState === "visible" ? requestAnimationFrame(flush) : window.setTimeout(flush, 200);
    };
    const connect = async () => {
      if (stopped) return;
      controller = new AbortController();
      try {
        if (!productionRuns.cursor) { const snapshot = await api.productionSnapshot(); if (stopped) return; enqueue(snapshot); flush(); }
        const response = await fetch(`/api/production/events?cursor=${encodeURIComponent(JSON.stringify(productionRuns.cursor))}`, { headers: accessHeaders(), signal: controller.signal });
        if (!response.ok || !response.body) throw new Error("EVENT_CONNECTION_FAILED");
        await readRunStream(response.body, controller.signal, enqueue, () => { productionRuns.setConnection("connected"); attempt = 0; });
      } catch { /* reconnect from committed cursor, never replay a mutation */ }
      finally {
        controller.abort();
        if (!stopped) {
          productionRuns.setConnection("recovering");
          retry = setTimeout(connect, Math.min(15000, 500 * 2 ** Math.min(attempt++, 5)) + Math.random() * 300);
        }
      }
    };
    const visible = () => { if (document.visibilityState === "visible") { views.pump(); controller?.abort(); } };
    document.addEventListener("visibilitychange", visible);
    let polling = false;
    const connected = () => productionRuns.connection === "connected";
    const fallback = setInterval(async () => {
      if (stopped || polling || connected() || document.visibilityState === "hidden") return;
      polling = true;
      try { const snapshot = await api.productionSnapshot(); if (!stopped && !connected()) enqueue(snapshot); }
      catch { /* continue bounded retries */ }
      finally { polling = false; }
    }, 5000);
    void connect();
    const retryViews = setInterval(() => views.pump(), 250);
    return () => { stopped = true; views.stop(); clearInterval(retryViews); controller?.abort(); clearTimeout(retry); clearInterval(fallback); cancelAnimationFrame(frame); clearTimeout(frame); document.removeEventListener("visibilitychange", visible); };
  }, []);
}
export const useProductionRun = (sessionId: string) => useSyncExternalStore(productionRuns.subscribe, () => productionRuns.latest(sessionId), () => undefined);
export const useRunConnection = () => useSyncExternalStore(productionRuns.subscribe, () => productionRuns.connection, () => "connecting" as const);
export const useManagedExecutionSessions = () => useSyncExternalStore(productionRuns.subscribe, () => managedExecutionSessions(productionRuns.runs.values()), () => "");
