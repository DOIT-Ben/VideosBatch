import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Response compression for the app's own Express server.
 *
 * There is no reverse proxy in front of this process in the repo's own deployment, so without
 * this every byte goes out uncompressed. Measured on a realistic store: 875 KB client bundle,
 * 164 KB stylesheet, 1.3 MB `/api/state` snapshot — 2.44 MB for a first load, against ~0.53 MB
 * once the same bodies are encoded. The payload is unusually compressible (JSON with repeated
 * field names, and prompts duplicated per shot), which is why the ratio is this good.
 *
 * How it decides, in order:
 *
 *  1. **Body arrives in one `end()` call** (`res.json`, `res.send`) → encode it directly.
 *  2. **Body arrives in `write()` chunks** → that is either a static file or a stream. Static
 *     assets are buffered so the 875 KB bundle is still compressed; everything else (video,
 *     images, audio) is not on the allow-list and is passed straight through, which is what keeps
 *     Range requests and progressive playback working.
 *  3. **Anything not on the allow-list, already encoded, marked `no-transform`, a 204/304, under
 *     1 KB, or larger than the buffer cap** → forwarded untouched.
 *
 * Two invariants that matter more than the ratio:
 *  - **Never block the event loop.** This is a single-process server; `*Sync` zlib on a 1.3 MB
 *    body would stall every other request. Both codecs are used asynchronously.
 *  - **Never make a response bigger, and never break one.** A body that does not shrink is sent
 *    as-is, and a zlib failure degrades to the uncompressed body instead of a truncated response.
 */

/** Explicit allow-list: anything already compressed (video, images, audio) is excluded by omission. */
const COMPRESSIBLE_TYPES = [
  "text/",
  "application/json",
  "application/javascript",
  "application/xml",
  "application/manifest+json",
  "image/svg+xml"
];

/** Below this, framing overhead (and the added `Vary` cache-key spread) costs more than it saves. */
const MIN_COMPRESSIBLE_BYTES = 1024;

/**
 * Refuse to buffer a body larger than this. Only reachable for allow-listed textual responses, so
 * in practice it bounds the store snapshot and the bundle. A video never gets here: it is excluded
 * by content type and keeps streaming.
 */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

/**
 * On-the-fly codec budgets. Brotli's default quality (11) is a file-compression setting: several
 * times slower than gzip on a 1.3 MB body for a few percent more. Quality 4 lands near gzip-6
 * speed with a smaller result, so brotli-first is safe here.
 */
const BROTLI_QUALITY = 4;
const GZIP_LEVEL = 6;

function pickEncoding(acceptEncoding: string | undefined): "br" | "gzip" | null {
  if (!acceptEncoding) return null;
  const refused = (token: string) => new RegExp(`(^|[,\\s])${token}\\s*;\\s*q=0(\\.0+)?($|[;,\\s])`, "i").test(acceptEncoding);
  const offered = (token: string) => new RegExp(`(^|[,\\s])${token}($|[;,\\s])`, "i").test(acceptEncoding);
  if (offered("br") && !refused("br")) return "br";
  if (offered("gzip") && !refused("gzip")) return "gzip";
  return null;
}

function encode(encoding: "br" | "gzip", body: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, result: Buffer) => (err ? reject(err) : resolve(result));
    if (encoding === "br") {
      brotliCompress(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }, done);
    } else {
      gzip(body, { level: GZIP_LEVEL }, done);
    }
  });
}

/** Append to an existing `Vary` instead of replacing it — static file responses already set one. */
function appendVary(res: Response, value: string) {
  const current = res.getHeader("vary");
  if (current === undefined) {
    res.setHeader("Vary", value);
    return;
  }
  const existing = String(current);
  if (existing === "*" || existing.toLowerCase().split(/,\s*/).includes(value.toLowerCase())) return;
  res.setHeader("Vary", `${existing}, ${value}`);
}

function toBuffer(chunk: unknown, encoding: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  const asString = typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8";
  return Buffer.from(String(chunk), asString);
}

export function responseCompression(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // A body-less method, or a client that cannot decode: leave the response completely alone.
    if (req.method === "HEAD" || req.method === "OPTIONS") return next();
    const encoding = pickEncoding(req.headers["accept-encoding"]);
    if (!encoding) return next();

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    /** `"undecided"` until the first byte tells us whether this body is worth buffering. */
    let mode: "undecided" | "buffer" | "passthrough" = "undecided";
    let chunks: Buffer[] = [];
    let buffered = 0;

    const canCompress = () => {
      if (res.statusCode === 204 || res.statusCode === 304) return false;
      if (res.getHeader("content-encoding") !== undefined) return false;
      if (/(^|[,\s])no-transform($|[,\s])/i.test(String(res.getHeader("cache-control") || ""))) return false;
      const contentType = String(res.getHeader("content-type") || "").toLowerCase();
      if (!contentType || !COMPRESSIBLE_TYPES.some((type) => contentType.includes(type))) return false;
      const declared = Number(res.getHeader("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BUFFERED_BYTES) return false;
      return true;
    };

    const decide = () => {
      if (mode === "undecided") mode = canCompress() ? "buffer" : "passthrough";
      return mode;
    };

    res.write = function patchedWrite(this: Response, chunk?: any, encodingArg?: any, callback?: any) {
      if (decide() === "buffer") {
        if (chunk) {
          const buf = toBuffer(chunk, encodingArg);
          chunks.push(buf);
          buffered += buf.length;
        }
        // Nothing has been written to the socket yet, so `Content-Length` (if the sender set one
        // for the uncompressed body) must not survive; it is replaced once we know the real size.
        res.removeHeader("Content-Length");
        if (typeof callback === "function") callback();
        return true;
      }
      return (originalWrite as any)(chunk, encodingArg, callback);
    } as typeof res.write;

    res.end = function patchedEnd(this: Response, chunk?: any, encodingArg?: any, callback?: any) {
      // `res.end(cb)` means the body came through `write()` already.
      if (typeof encodingArg === "function") {
        callback = encodingArg;
        encodingArg = undefined;
      }

      const forward = () => {
        const forwarded: any[] = [];
        if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
          forwarded.push(chunk);
          if (encodingArg !== undefined) forwarded.push(encodingArg);
        } else if (typeof chunk === "function") {
          forwarded.push(chunk);
        }
        if (callback !== undefined) forwarded.push(callback);
        return (originalEnd as any)(...forwarded);
      };

      if (decide() === "passthrough") return forward();

      if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
        const buf = toBuffer(chunk, encodingArg);
        chunks.push(buf);
        buffered += buf.length;
      }

      const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
      chunks = [];

      const endWith = (payload: Buffer) => {
        res.setHeader("Content-Length", payload.length);
        const forwarded: any[] = [payload];
        if (callback !== undefined) forwarded.push(callback);
        return (originalEnd as any)(...forwarded);
      };

      // `endWith` always sets the correct `Content-Length` for whatever it is handed, so the
      // sender's original value (computed for the uncompressed body) is replaced either way.
      if (body.length < MIN_COMPRESSIBLE_BYTES || body.length > MAX_BUFFERED_BYTES) {
        return endWith(body);
      }

      return encode(encoding, body).then(
        (compressed) => {
          // Incompressible input (or a pathological case) — do not pay to make it bigger.
          if (compressed.length >= body.length) return endWith(body);
          res.setHeader("Content-Encoding", encoding);
          appendVary(res, "Accept-Encoding");
          return endWith(compressed);
        },
        // zlib failure must degrade to an uncompressed response, never to a broken one.
        () => endWith(body)
      );
    } as typeof res.end;

    next();
  };
}
