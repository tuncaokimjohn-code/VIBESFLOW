/** Adapted from C032 src/client.ts: one nonrefundable attempt, no retries.
 * Transport injection is for trusted offline tests ONLY; there is no live path.
 */
import "server-only";
import { buildRequest, LIMITS, sha256, type BoundContract } from "./contract";
import { failed, SafeFailure } from "./errors";
import { validateResponse } from "./validate";
export interface OfflineTransport {
  readonly kind: "offline-mock";
  send(request: { body: string; signal: AbortSignal; timeoutMs: number }): Promise<string>;
}
export function createOneAttemptClient(transport: OfflineTransport, contract: BoundContract) {
  let consumed = false;
  let stopped: Promise<void> = Promise.resolve();
  return {
    /** Abort is cooperative. Callers retain capacity until the raw work settles. */
    whenStopped: () => stopped,
    async explain(options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
      if (transport.kind !== "offline-mock") return failed("LIVE_DISABLED");
      const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.timeoutMs) return failed("INVALID_LIMITS");
      if (options.signal?.aborted) return failed("CANCELLED");
      if (consumed) return failed("ATTEMPT_CONSUMED");
      consumed = true;
      const deadline = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      let onAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new SafeFailure(options.signal?.aborted ? "CANCELLED" : "TIMEOUT")); });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const body = JSON.stringify(buildRequest(contract));
        const work = Promise.resolve().then(() => {
          if (signal.aborted) throw new SafeFailure("CANCELLED");
          return transport.send({ body, signal, timeoutMs });
        });
        stopped = work.then(() => undefined, () => undefined);
        const raw = await Promise.race([work, aborted]);
        if (signal.aborted) throw new SafeFailure(options.signal?.aborted ? "CANCELLED" : "TIMEOUT");
        if (typeof raw !== "string") throw new SafeFailure("PROTOCOL_ERROR");
        return { ok: true as const, requestSha256: sha256(body), explanation: validateResponse(raw, contract) };
      } catch (error) {
        return failed(options.signal?.aborted ? "CANCELLED" : deadline.signal.aborted ? "TIMEOUT" : error instanceof SafeFailure ? error.code : "NETWORK_ERROR");
      } finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
    },
  };
}
