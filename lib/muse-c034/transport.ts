/** No default network factory: only the guarded local operator supplies one. */
import "server-only";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { rootCertificates, checkServerIdentity } from "node:tls";
import { BOUNDS, ENDPOINT } from "./protocol";
export type RequestFactory = (options: RequestOptions, callback: (r: IncomingMessage) => void) => ClientRequest;
export type TransportCode = "CANCELLED" | "TIMEOUT" | "NETWORK_ERROR" | "REDIRECT_DENIED" | "AUTH_REJECTED" | "RATE_LIMITED" | "HTTP_ERROR" | "PROTOCOL_ERROR" | "RESPONSE_TOO_LARGE";
export class TransportFailure extends Error {
  constructor(readonly code: TransportCode) { super("Muse request stopped; no retry is permitted."); }
}
export function startExchange(factory: RequestFactory, input: { body: string; expectedBody: string; credential: string; signal: AbortSignal; timeoutMs?: number }) {
  let stoppedResolve!: () => void;
  const stopped = new Promise<void>(resolve => { stoppedResolve = resolve; });
  const result = new Promise<string>((resolve, reject) => {
    const timeoutMs = input.timeoutMs ?? BOUNDS.timeoutMs;
    if (input.signal.aborted || input.body !== input.expectedBody || Buffer.byteLength(input.body) > BOUNDS.requestBytes
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BOUNDS.timeoutMs
      || !/^[\x21-\x7e]{16,4096}$/.test(input.credential)) {
      stoppedResolve(); reject(new TransportFailure(input.signal.aborted ? "CANCELLED" : "PROTOCOL_ERROR")); return;
    }
    let req: ClientRequest | undefined, response: IncomingMessage | undefined;
    let settled = false, factoryReturned = false, requestClosed = false, responseClosed = false, bytes = 0;
    const chunks: Buffer[] = [];
    const maybeStopped = () => {
      if (factoryReturned && (!req || requestClosed || req.closed) && (!response || responseClosed || response.closed)) stoppedResolve();
    };
    const cleanup = () => { clearTimeout(timer); input.signal.removeEventListener("abort", abort); chunks.length = 0; };
    const stop = (code: TransportCode) => {
      if (!settled) { settled = true; cleanup(); reject(new TransportFailure(code)); }
      response?.destroy(); req?.destroy(); maybeStopped();
    };
    const abort = () => stop("CANCELLED");
    const timer = setTimeout(() => stop("TIMEOUT"), timeoutMs);
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      const url = new URL(ENDPOINT);
      req = factory({ protocol: "https:", hostname: url.hostname, port: 443, path: url.pathname, method: "POST",
        agent: false, maxHeaderSize: 16_384, rejectUnauthorized: true, checkServerIdentity,
        servername: url.hostname, minVersion: "TLSv1.2", ca: [...rootCertificates],
        headers: { Authorization: `Bearer ${input.credential}`, "Content-Type": "application/json", Accept: "application/json",
          "Accept-Encoding": "identity", "Content-Length": Buffer.byteLength(input.body) } }, res => {
        response = res;
        res.on("close", () => { responseClosed = true; if (!settled) stop("NETWORK_ERROR"); maybeStopped(); });
        res.on("error", () => stop("NETWORK_ERROR")); res.on("aborted", () => stop("NETWORK_ERROR"));
        if (settled) { res.destroy(); return; }
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) { stop("REDIRECT_DENIED"); return; }
        if (status !== 200) { stop(status === 401 || status === 403 ? "AUTH_REJECTED" : status === 429 ? "RATE_LIMITED" : "HTTP_ERROR"); return; }
        if (!/^application\/json(?:\s*;\s*charset=["']?utf-8["']?)?\s*$/i.test(String(res.headers["content-type"] ?? ""))
          || res.headers["content-encoding"] != null && res.headers["content-encoding"] !== "identity") { stop("PROTOCOL_ERROR"); return; }
        const declared = res.headers["content-length"];
        if (declared != null && (!/^\d+$/.test(String(declared)) || Number(declared) > BOUNDS.responseBytes)) { stop("RESPONSE_TOO_LARGE"); return; }
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          if (!Buffer.isBuffer(chunk)) { stop("PROTOCOL_ERROR"); return; }
          bytes += chunk.length;
          if (bytes > BOUNDS.responseBytes) { stop("RESPONSE_TOO_LARGE"); return; }
          chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          if (settled) return;
          if (!res.complete || declared != null && bytes !== Number(declared)) { stop("PROTOCOL_ERROR"); return; }
          let raw: string;
          try { raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
          catch { stop("PROTOCOL_ERROR"); return; }
          settled = true; cleanup(); resolve(raw);
          res.destroy(); req?.destroy(); maybeStopped();
        });
      });
      factoryReturned = true;
      req.on("close", () => { requestClosed = true; if (!settled) stop("NETWORK_ERROR"); maybeStopped(); });
      req.on("error", () => stop("NETWORK_ERROR"));
      if (settled || input.signal.aborted) { stop("CANCELLED"); return; }
      req.end(input.body);
    } catch { factoryReturned = true; stop("NETWORK_ERROR"); }
  });
  return { result, stopped };
}
