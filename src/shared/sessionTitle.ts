/**
 * Auto-generated session titles.
 *
 * The store used to call every new session "unnamed session N", which left a list of them
 * impossible to tell apart. Sessions are now named after the moment they were created, and any
 * title still shaped like the old scheme is re-derived from its `createdAt` — that input never
 * changes, so the result is stable across boots and a user's own title is never touched.
 *
 * Shared by the store and the client so the optimistic row and the persisted one agree.
 */

/** Titles the store generated itself, from before sessions had readable names. */
export const AUTO_SESSION_TITLE = /^un(?:n)?amed session\s+\d+$/i;

function sessionTitleStamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function autoSessionTitle(createdAt: string | undefined, now: Date = new Date()) {
  const parsed = createdAt ? new Date(createdAt) : now;
  return `课程视频 · ${sessionTitleStamp(Number.isNaN(parsed.getTime()) ? now : parsed)}`;
}

/** A user-typed title always wins; only an empty or store-generated one is replaced. */
export function normalizeSessionTitle(title: string | undefined, createdAt: string | undefined) {
  const trimmed = title?.trim();
  if (trimmed && !AUTO_SESSION_TITLE.test(trimmed)) return trimmed;
  return autoSessionTitle(createdAt);
}
