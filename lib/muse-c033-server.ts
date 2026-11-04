/** C033 server-only integration boundary.
 * HTTP wiring always uses explainC033 (closed). Only trusted offline tests can
 * construct the injected handler. No flags, headers, URL or body select it.
 */
import "server-only";
import { z } from "zod";
import { buildDemoSnapshot, fixtureContents } from "@/lib/demo-fixture";
import { detectSecurityFindings } from "@/lib/security-findings";
import { SourceSnapshotSchema, sha256Text } from "@/lib/source-snapshot";
import { bindFinding, EvidenceBindingSchema, sameBinding, OFFLINE_MOCK_LABEL } from "@/lib/muse-binding";
import { buildPrompt, canonicalExplanation, explainFinding, validateCitations } from "@/lib/muse-server";
import type { ExplanationOutcome, MuseProvider } from "@/lib/muse-contract";
import type { BoundContract } from "@/lib/muse-c032/contract";
import { createOneAttemptClient, type OfflineTransport } from "@/lib/muse-c032/client";

export const LIVE_INFERENCE_ENABLED = false;
export function explainC033(body: unknown, signal?: AbortSignal): Promise<ExplanationOutcome> {
  // Browser consent has NO spending authority. No credential discovery, live
  // transport, environment switch or production mock selection exists here.
  return explainFinding(body, { provider: null }, signal);
}

const RequestSchema = z.strictObject({
  consent: z.literal(true), findingId: z.string().min(1).max(512),
  snapshot: SourceSnapshotSchema, contents: z.record(z.string(), z.string()),
  evidence: EvidenceBindingSchema,
});
const invalid = (): ExplanationOutcome => ({ ok: false, code: "EVIDENCE_INVALID",
  message: "Only the pinned synthetic fixture and its exact selected evidence are supported." });
const stable = (v: unknown): string => JSON.stringify(v, (_key, value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

/** NOT an HTTP route or live authorization mechanism. Trusted offline tests only.
 * The supplied transport is reviewed code, not a sandbox for arbitrary plugins.
 */
export function createOfflineIntegrationHandler(factory: (contract: BoundContract) => OfflineTransport,
  limits: { timeoutMs?: number; maxConcurrent?: number } = {}) {
  return async (body: unknown, signal?: AbortSignal): Promise<ExplanationOutcome> => {
    if (signal?.aborted) return { ok: false, code: "CANCELLED", message: "Offline request cancelled." };
    if (!body || typeof body !== "object" || (body as { consent?: unknown }).consent !== true)
      return { ok: false, code: "CONSENT_REQUIRED", message: "Explicit consent is required for this offline check." };
    try {
      const parsed = RequestSchema.safeParse(body);
      if (!parsed.success) return invalid();
      const b = parsed.data;
      // Reconstruct the SERVER-owned fixture, not an attacker supplied snapshot.
      const contents = { ...fixtureContents() };
      const snapshot = SourceSnapshotSchema.parse(buildDemoSnapshot(contents));
      if (stable(b.contents) !== stable(contents) || stable(b.snapshot) !== stable(snapshot)) return invalid();
      const source = new Map(Object.entries(contents));
      const detection = await detectSecurityFindings(snapshot, source, sha256Text, { signal });
      if (!detection.ok) return invalid();
      const finding = detection.findings.find(f => f.id === b.findingId);
      if (!finding || !sameBinding(b.evidence, bindFinding(finding))) return invalid();
      const binding = Object.freeze(bindFinding(finding));
      if (!validateCitations([{ findingId: finding.id, path: finding.path, line: finding.line,
        column: finding.column, quote: finding.quote }], finding, source)) return invalid();
      const contract = Object.freeze({ text: canonicalExplanation(finding.ruleId), binding, ruleId: finding.ruleId });
      const client = createOneAttemptClient(factory(contract), contract);
      const expectedPrompt = buildPrompt(finding, source);
      let requestSha256: string | undefined;
      const provider: MuseProvider = {
        label: OFFLINE_MOCK_LABEL,
        async explain(request) {
          if (request.system !== expectedPrompt.system || request.prompt !== expectedPrompt.prompt) throw new Error("Bound request mismatch");
          const result = await client.explain({ signal: request.signal, timeoutMs: limits.timeoutMs });
          // Keep C024 concurrency quarantine until raw transport has stopped,
          // even when the client has already returned a timeout/cancellation.
          await client.whenStopped();
          if (!result.ok) throw new Error("Offline response withheld");
          requestSha256 = result.requestSha256;
          const c = result.explanation.citations[0];
          return { text: result.explanation.text, citations: [{ findingId: c.findingId,
            path: c.path, line: c.line, column: c.column, quote: c.quote }] };
        },
      };
      const result = await explainFinding({ consent: true, findingId: finding.id, snapshot, contents },
        { provider, timeoutMs: limits.timeoutMs, maxConcurrent: limits.maxConcurrent }, signal);
      if (!result.ok) return result;
      if (!requestSha256) return invalid();
      return { ...result, mode: "offline-mock", mock: true, binding, requestSha256 };
    } catch {
      // Never reflect thrown transport text, source, configuration or secrets.
      return { ok: false, code: "PROVIDER_UNAVAILABLE", message: "Offline integration check unavailable; no output was published." };
    }
  };
}
