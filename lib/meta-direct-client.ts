import { META_LIMITS as L, META_PRIVACY, MetaPreparedSchema, MetaResultSchema, parseMetaAnalysis, type MetaResult } from "@/lib/meta-direct-contract";
import { evidenceId, type PublicMuseBinding } from "@/lib/public-muse-contract";
import { sha256SyncHex } from "@/lib/sha256-sync";
export type MetaState = { busy: boolean; consent: boolean; prepared: { challenge: string; expiresAt: number } | null;
  result: MetaResult | null; message: string };
export const initialMetaState = (): MetaState => ({ busy: false, consent: false, prepared: null, result: null,
  message: "Public status not yet checked; candidate defaults to NOT CONFIGURED. Verify the selected finding to check availability. No Meta request has been sent." });
const errors: Record<string, string> = {
  NOT_CONFIGURED: "NOT CONFIGURED — durable shared quota and qualified cost protection have not been provisioned. No Meta request was sent.",
  QUOTA_UNAVAILABLE: "Shared quota is unavailable or exhausted. No explanation is available.",
  QUOTA_OR_CONSENT_REJECTED: "Consent expired, was already used, or shared quota is exhausted. Verify again before a new request.",
  META_INCOMPLETE: "Meta returned an incomplete response. No explanation is shown; there is no automatic retry.",
  META_TIMEOUT: "Meta exceeded the deadline. The request may still be charged. There is no automatic retry.",
  META_OUTPUT_INVALID: "Meta output failed validation. No explanation is shown.",
};
/** No I/O on render/selection. Parent disposes on exact evidence/import change. */
export function createMetaController(binding: PublicMuseBinding, onState: (state: MetaState) => void,
  fetchFn: typeof fetch = (...args) => fetch(...args), now = Date.now) {
  let state = initialMetaState(), generation = 0, active: AbortController | null = null, disposed = false;
  const emit = (s: MetaState) => { state = s; if (!disposed) onState(s); };
  async function send(action: "prepare" | "explain") {
    if (disposed || state.busy || action === "explain" && (!state.consent || !state.prepared || state.prepared.expiresAt <= now())) return;
    const prepared = state.prepared, currentGeneration = ++generation, ctrl = new AbortController(); active = ctrl;
    emit({ ...initialMetaState(), busy: true, message: action === "prepare" ? "Verifying immutable public source; no Meta inference…" : "Request pending. Sending bounded sanitized evidence to Meta…" });
    let abortListener = () => undefined as void, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const aborted = new Promise<never>((_, reject) => { abortListener = () => reject(new Error("CANCELLED")); ctrl.signal.addEventListener("abort", abortListener, { once: true }); });
    const timer = setTimeout(() => ctrl.abort(), L.routeDeadlineMs + 2000);
    const current = () => !disposed && currentGeneration === generation && !ctrl.signal.aborted;
    try {
      const work = (async () => {
        const response = await fetchFn("/api/meta-direct", { method: "POST", credentials: "omit", cache: "no-store", redirect: "error",
          referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, signal: ctrl.signal,
          body: JSON.stringify(action === "prepare" ? { action, binding } : { action, binding,
            challenge: prepared!.challenge, consentVersion: META_PRIVACY }) });
        if (!current()) { void response.body?.cancel().catch(() => undefined); throw new Error("CANCELLED"); }
        if (response.redirected || !response.body || !response.headers.get("content-type")?.startsWith("application/json")) throw new Error("INVALID");
        reader = response.body.getReader(); const chunks: Uint8Array[] = []; let count = 0;
        while (true) { const chunk = await Promise.race([reader.read(), aborted]); if (chunk.done) break;
          count += chunk.value.byteLength; if (count > L.responseBytes) throw new Error("INVALID"); chunks.push(chunk.value); }
        const bytes = new Uint8Array(count); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!response.ok) throw new Error(typeof raw?.code === "string" && Object.hasOwn(errors, raw.code) ? raw.code : "INVALID");
        return raw as unknown;
      })();
      const raw = await Promise.race([work, aborted]); if (!current()) return;
      if (action === "prepare") {
        const result = MetaPreparedSchema.parse(raw);
        if (result.evidenceId !== evidenceId(binding) || result.expiresAt <= now() || result.expiresAt > now() + L.challengeTtlMs) throw new Error("INVALID");
        emit({ ...initialMetaState(), prepared: result, message: "Public preparation available; source verified. Quota can change. Review the Meta Contributor disclosure and consent for this finding only." });
      } else {
        const result = MetaResultSchema.parse(raw); parseMetaAnalysis(result.analysis, binding);
        if (evidenceId(result.binding) !== evidenceId(binding) || result.facts.evidenceId !== evidenceId(binding) || result.facts.rule !== binding.rule ||
          result.context.startLine > binding.line || result.context.endLine < binding.line || result.context.endLine - result.context.startLine > 6 ||
          sha256SyncHex(result.context.text) !== result.context.sha256) throw new Error("INVALID");
        emit({ ...initialMetaState(), result, message: result.provenance.transport === "offline-mock" ?
          "OFFLINE MOCK — no genuine Meta inference occurred." : "Meta response completed. Provider analysis is unverified; E1 source checks passed." });
      }
    } catch (error) {
      if (!disposed && generation === currentGeneration) emit({ ...initialMetaState(), message: ctrl.signal.aborted ?
        "Cancelled or deadline exceeded. A dispatched request may still be charged." : errors[error instanceof Error ? error.message : ""] ?? "Request failed safely. No explanation is shown." });
    } finally { clearTimeout(timer); ctrl.signal.removeEventListener("abort", abortListener); ctrl.abort(); void reader?.cancel().catch(() => undefined); if (generation === currentGeneration) active = null; }
  }
  return { prepare: () => send("prepare"), explain: () => send("explain"),
    consent(value: boolean) { if (!disposed && !state.busy && state.prepared && state.prepared.expiresAt > now()) emit({ ...state, consent: value }); },
    cancel() { generation++; active?.abort(); active = null; emit({ ...initialMetaState(), message: "Cancelled and cleared. A dispatched request may still be charged." }); },
    dispose() { disposed = true; generation++; active?.abort(); active = null; state = initialMetaState(); }, getState: () => state };
}
