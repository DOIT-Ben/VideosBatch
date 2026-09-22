import type { Asset, Shot } from "../../shared/types";

export interface DependencyTask {
  id: string;
  dependencies: string[];
  inFlight?: boolean;
  execute: () => Promise<boolean>;
  blocked: (reason: "paused" | "dependency") => Promise<void>;
}

/** Completion order never determines output order. Failures block descendants,
 * not independent tasks; cycles/missing dependencies fail closed. */
export async function runDependencyTasks(tasks: DependencyTask[], concurrency = 1, shouldStop = () => false, externalReady = new Set<string>()) {
  const pending = new Map(tasks.map(task => [task.id, task]));
  if (pending.size !== tasks.length) throw new Error("DUPLICATE_WORK_ITEM");
  const active = new Map<string, Promise<void>>();
  const success = new Set(externalReady);
  const failed = new Set<string>();
  while (pending.size || active.size) {
    for (const [id, task] of pending) {
      if (active.size >= concurrency) break;
      if (shouldStop() && !task.inFlight) { pending.delete(id); failed.add(id); await task.blocked("paused"); continue; }
      if (!task.inFlight && task.dependencies.some(dep => failed.has(dep) || (!success.has(dep) && !pending.has(dep) && !active.has(dep)))) {
        pending.delete(id); failed.add(id); await task.blocked("dependency"); continue;
      }
      if (!task.inFlight && !task.dependencies.every(dep => success.has(dep))) continue;
      pending.delete(id);
      const operation = task.execute().then(ok => { (ok ? success : failed).add(id); }, async () => {
        failed.add(id); await task.blocked(shouldStop() ? "paused" : "dependency");
      })
        .finally(() => { active.delete(id); });
      active.set(id, operation);
    }
    if (active.size) await Promise.race(active.values());
    else if (pending.size) {
      for (const [id, task] of pending) { failed.add(id); await task.blocked("dependency"); }
      pending.clear();
    }
  }
}

export function shotDependencies(shot: Shot, shots: Shot[], assets: Asset[]) {
  const dependencies = new Set<string>();
  if (shot.referenceVideoFromShotId) dependencies.add(shot.referenceVideoFromShotId);
  if (shot.usePreviousShotClip) {
    const previous = shots.find(candidate => candidate.index === shot.index - 1);
    dependencies.add(previous?.id || "missing-previous-shot");
  }
  const frame = assets.find(asset => asset.id === shot.firstFrameAssetId && (asset.tags || []).some(tag => tag === "tailframe" || tag === "frame-anchor"));
  if (frame) {
    const source = frame.tags?.find(tag => tag.startsWith("source-shot:"))?.slice(12) || frame.ownerShotId;
    if (source) dependencies.add(source);
  }
  return [...dependencies];
}

interface Ticket { owner: string; session: string; provider: string; start: () => void }
export class WorkLimiter {
  private active: Ticket[] = [];
  private pending: Ticket[] = [];
  constructor(readonly global = 2, readonly owner = 2, readonly session = 2, readonly provider = 2) {}
  run<T>(scope: Omit<Ticket, "start">, operation: () => Promise<T>): Promise<T> {
    if (this.pending.length >= 100) return Promise.reject(new Error("WORK_QUEUE_FULL"));
    return new Promise((resolve, reject) => {
      const ticket: Ticket = { ...scope, start: () => {
        this.active.push(ticket);
        Promise.resolve().then(operation).then(resolve, reject).finally(() => {
          this.active = this.active.filter(item => item !== ticket); this.drain();
        });
      } };
      this.pending.push(ticket); this.drain();
    });
  }
  private drain() {
    for (const ticket of [...this.pending]) {
      if (this.active.length >= this.global) break;
      if (this.active.filter(item => item.owner === ticket.owner).length >= this.owner
        || this.active.filter(item => item.session === ticket.session).length >= this.session
        || this.active.filter(item => item.provider === ticket.provider).length >= this.provider) continue;
      this.pending = this.pending.filter(item => item !== ticket); ticket.start();
    }
  }
}
