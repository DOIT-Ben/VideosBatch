import type { Request } from "express";

/** Shared local review is a development convenience, never proxy authentication. */
export function allowLocalSessionReview(req: Pick<Request, "header" | "socket">, env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === "production") return false;
  if (["forwarded", "x-forwarded-host", "x-forwarded-for", "x-forwarded-proto"].some((name) => req.header(name) !== undefined)) return false;
  const peer = req.socket.remoteAddress;
  if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") return false;
  const isLocal = (host: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host.toLowerCase());
  try {
    const host = req.header("host");
    if (!host || !isLocal(new URL(`http://${host}`).hostname)) return false;
    const configured = (env.APP_PUBLIC_URL || env.SEEREEL_PUBLIC_URL || env.REELYAI_PUBLIC_URL || "").trim();
    if (configured && !isLocal(new URL(configured).hostname)) return false;
    return true;
  } catch {
    return false;
  }
}
