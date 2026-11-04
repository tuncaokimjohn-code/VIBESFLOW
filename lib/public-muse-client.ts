import { PreparedSchema, PRIVACY_VERSION, evidenceId, parsePublicMuseResult,
  type PublicMuseBinding, type PublicMuseResult } from "@/lib/public-muse-contract";

export type PublicMuseState = { busy: boolean; consent: boolean;
  prepared: { challenge: string; expiresAt: number } | null; result: PublicMuseResult | null; message: string };
export const initialPublicMuseState = (): PublicMuseState => ({ busy: false, consent: false,
  prepared: null, result: null, message: "Live gateway disabled. No request has been sent." });

/** Directly used by the panel; construction/selection never initiates I/O. */
export function createPublicMuseController(b: PublicMuseBinding, onState: (s: PublicMuseState) => void,
  fetchFn: typeof fetch = (...args) => fetch(...args), now: () => number = Date.now) {
  let state = initialPublicMuseState(), sequence = 0, active: AbortController | null = null;
  const emit = (s: PublicMuseState) => { state = s; onState(s); };
  const reset = (message: string) => { sequence++; active?.abort(); active = null; emit({ ...initialPublicMuseState(), message }); };
  async function send(action: "prepare" | "explain") {
    if (state.busy || (action === "explain" && (!state.consent || !state.prepared || state.prepared.expiresAt <= now()))) return;
    const prepared = state.prepared;
    const controller = new AbortController(); active = controller;
    const generation = ++sequence;
    emit({ ...state, busy: true, consent: false, prepared: null, result: null, message: "Verifying request…" });
    let abortListener: () => void = () => undefined;
    const abort = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error("cancelled"));
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), 20_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const current = () => generation === sequence && !controller.signal.aborted;
    try {
      const work = (async () => {
        const response = await fetchFn("/api/public-muse", { method: "POST", credentials: "omit",
          cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
          headers: { "content-type": "application/json" }, signal: controller.signal,
          body: JSON.stringify(action === "prepare" ? { action, binding: b } : {
            action, binding: b, challenge: prepared!.challenge, consentVersion: PRIVACY_VERSION,
          }) });
        if (!current()) { void response.body?.cancel().catch(() => undefined); throw new Error("cancelled"); }
        if (!response.ok || response.redirected || !response.body || !response.headers.get("content-type")?.startsWith("application/json")) throw new Error("unavailable");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let count = 0;
        while (true) {
          const chunk = await Promise.race([reader.read(), abort]);
          if (chunk.done) break;
          count += chunk.value.byteLength;
          if (count > 16_384) throw new Error("oversized");
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(count); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      })();
      const raw = await Promise.race([work, abort]);
      if (!current()) return;
      if (action === "prepare") {
        const p = PreparedSchema.safeParse(raw);
        if (!p.success || p.data.evidenceId !== evidenceId(b) || p.data.expiresAt <= now() || p.data.expiresAt > now() + 60_000) throw new Error("invalid");
        emit({ ...initialPublicMuseState(), prepared: p.data, message: "Verified offline candidate. Review privacy and consent for this finding only." });
      } else {
        const result = parsePublicMuseResult(raw, b);
        if (!result) throw new Error("invalid");
        emit({ ...initialPublicMuseState(), result, message: "OFFLINE MOCK — no genuine Muse inference occurred." });
      }
    } catch {
      if (generation === sequence) emit({ ...initialPublicMuseState(), message: "Unavailable, cancelled or rejected. Live gateway remains disabled; no explanation is claimed." });
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener("abort", abortListener);
      controller.abort();
      try { void reader?.cancel().catch(() => undefined); } catch { /* Best effort, never await cleanup. */ }
      if (generation === sequence) active = null;
    }
  }
  return {
    prepare: () => send("prepare"), explain: () => send("explain"),
    consent(value: boolean) { if (!state.busy && state.prepared) emit({ ...state, consent: value }); },
    cancel: () => reset("Cancelled. An upstream request already accepted may still incur usage."),
    dispose: () => { sequence++; active?.abort(); active = null; },
    getState: () => state,
  };
}
