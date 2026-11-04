/**
 * Intake API wire contract (P3 Candidate 004, Finding F).
 *
 * Strict validation:
 * - Request: `IntakeRequestSchema.strict()` — unknown keys rejected — after
 *   an incremental bounded body read (never fully buffered when oversized;
 *   Content-Length never trusted).
 * - Response: the snapshot is validated with a STRICT SourceSnapshot
 *   passthrough (required fields never stripped; forged hashes, invalid
 *   languages, mismatched counts/totals/identity, invalid provenance or
 *   policy rejected), plus wire-level invariants the domain schema does
 *   not cover: `synthetic: true` only with an actual synthetic snapshot,
 *   and snapshot paths must be intake-safe.
 * - `readBoundedBody` accepts an optional abort signal with bounded,
 *   non-awaited cleanup: `reader.cancel()` is never awaited indefinitely.
 * - No `as` casts on untrusted data anywhere on this path.
 */
import { settleIndependently } from "@/lib/github-intake";
import { SourceSnapshotSchema } from "@/lib/source-snapshot";
import { createIntakeApiResponseSchema, type IntakeApiResponse } from "@/lib/intake-contract";
export * from "@/lib/intake-contract";
export const IntakeApiResponseSchema = createIntakeApiResponseSchema(SourceSnapshotSchema);

/**
 * Bounded request-body read for routes (Finding B): incremental consumption
 * with a hard cap, the caller's abort signal, and an independently settling
 * deadline. Rejections attach before any already-aborted exit inside
 * `settleIndependently`, so late outcomes stay observed. Throws DOMException
 * on user abort, Error with code TIMEOUT on deadline — mapping to typed
 * errors is the route's job. Never awaits a non-cooperative cancel.
 */
export type BoundedBodyResult =
  | { ok: true; text: string }
  | { ok: false; code: "LIMIT_EXCEEDED" | "MALFORMED" | "CANCELLED" };

export function readRequestBody(req: Request, maxBytes: number, deadlineMs: number): Promise<BoundedBodyResult> {
  // Separate reader controller (Finding B): the boundary watches
  // req.signal for the outcome, while cleanup aborts ONLY the reader
  // controller. Routing cleanup through the boundary's own signal would
  // trip its abort listener and convert TIMEOUT into CANCELLED — the two
  // signals must stay distinct. On timeout the boundary calls onDeadline
  // synchronously before settling TIMEOUT, so the hanging reader gets a
  // bounded cancel attempt (fired, never awaited) without changing the
  // outcome. Settling never forcibly terminates transport work.
  const readerCtrl = new AbortController();
  const forward = (): void => {
    try {
      readerCtrl.abort();
    } catch {
      // ignore synchronous abort errors
    }
  };
  if (req.signal.aborted) {
    forward();
  } else {
    req.signal.addEventListener("abort", forward, { once: true });
  }
  const cleanup = (): void => {
    req.signal.removeEventListener("abort", forward);
  };
  return settleIndependently(readBoundedBody(req.body, maxBytes, { signal: readerCtrl.signal }), {
    deadlineMs,
    signal: req.signal,
    timeoutCode: "TIMEOUT",
    onDeadline: forward,
  }).then(
    (v) => {
      cleanup();
      return v;
    },
    (e: unknown) => {
      cleanup();
      forward(); // idempotent: guarantees a cancel attempt even if the timer lost a race
      throw e;
    }
  );
}

/** Parse an untrusted API payload. Returns typed failure on any mismatch. */
export function parseIntakeResponse(payload: unknown): IntakeApiResponse | { ok: false; code: "MALFORMED"; message: string } {
  const parsed = IntakeApiResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, code: "MALFORMED", message: "Intake service returned an unrecognized response." };
  }
  return parsed.data;
}

/**
 * Incrementally read a request body with a hard byte cap (Finding A/F).
 * Chunks accumulate only up to maxBytes+1. Oversized bodies are rejected
 * before JSON parsing; a lying Content-Length cannot smuggle a bigger body.
 * Cleanup is bounded: `reader.cancel()` is fired without awaiting it, so a
 * non-cooperative stream cannot stall rejection.
 */
export function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  opts?: { signal?: AbortSignal }
): Promise<
  { ok: true; text: string } | { ok: false; code: "LIMIT_EXCEEDED" | "MALFORMED" | "CANCELLED" }
> {
  if (body === null) return Promise.resolve({ ok: false, code: "MALFORMED" as const });
  if (opts?.signal?.aborted) return Promise.resolve({ ok: false, code: "CANCELLED" as const });
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<{ ok: false; code: "CANCELLED" }>((resolve) => {
    if (!opts?.signal) return;
    onAbort = () => {
      // Bounded cleanup: fire cancel, never await it.
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // ignore synchronous cancel errors
      }
      resolve({ ok: false, code: "CANCELLED" as const });
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });
  });
  type Pumped = { ok: true; text: string } | { ok: false; code: "LIMIT_EXCEEDED" | "MALFORMED" | "CANCELLED" };
  const readPump: Promise<Pumped> = (async (): Promise<Pumped> => {
    try {
      for (;;) {
        if (opts?.signal?.aborted) return { ok: false, code: "CANCELLED" as const };
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          try {
            void reader.cancel().catch(() => undefined);
          } catch {
            // ignore
          }
          return { ok: false, code: "MALFORMED" as const };
        }
        const room = maxBytes + 1 - total;
        if (value.length >= room) {
          try {
            void reader.cancel().catch(() => undefined);
          } catch {
            // ignore
          }
          return { ok: false, code: "LIMIT_EXCEEDED" as const };
        }
        chunks.push(value);
        total += value.length;
      }
    } catch {
      return { ok: false, code: "MALFORMED" as const };
    } finally {
      reader.releaseLock();
      if (onAbort && opts?.signal) opts.signal.removeEventListener("abort", onAbort);
    }
    // An abort racing a final successful read must settle CANCELLED, never
    // a truncated-body success: re-check after the loop.
    if (opts?.signal?.aborted) return { ok: false, code: "CANCELLED" as const };
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    try {
      return { ok: true as const, text: new TextDecoder("utf-8", { fatal: true }).decode(out) };
    } catch {
      return { ok: false, code: "MALFORMED" as const };
    }
  })();
  if (!opts?.signal) return readPump;
  return Promise.race([readPump, abortPromise]);
}
