import type { EditRequest } from "../../shared/editing";
export type DraftRecord<T> = { base: string; value: T; id?: string; draftId?: string; clientVersion?: number; baseRevision?: number; pendingRequest?: EditRequest; saved?: boolean };
export const draftKey = (sessionId: string, stage: string) => `videosbatch:edit-draft:${sessionId}:${stage}`;
export const draftSignature = (value: unknown) => JSON.stringify(value) ?? "undefined";

export function readDraft<T>(storage: Pick<Storage, "getItem"> | undefined, key: string): DraftRecord<T> | undefined {
  if (!storage || !key) return undefined;
  try {
    const value = JSON.parse(storage.getItem(key) || "null");
    return value && typeof value.base === "string" && Object.hasOwn(value, "value") ? value : undefined;
  } catch { return undefined; }
}

export function writeDraft<T>(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, key: string, record?: DraftRecord<T>) {
  if (!storage || !key) return false;
  try {
    if (record) storage.setItem(key, JSON.stringify(record));
    else storage.removeItem(key);
    return true;
  } catch { return false; }
}

/** A late save response owns only the record that was actually submitted. */
export function savedDraftStillCurrent<T>(submitted: DraftRecord<T>, current: DraftRecord<T> | undefined, persisted: DraftRecord<T> | undefined) {
  return draftSignature(submitted) === draftSignature(current)
    && (!persisted || draftSignature(submitted) === draftSignature(persisted));
}
