/** Read-only result retrieval. This import graph has NO live adapter/key reader. */
import "server-only";
import { prepareBrowserEvidence } from "./fixture";
import { buildLiveRequest } from "./protocol";
import { readResult } from "./state";
import { sameBinding } from "@/lib/muse-binding";
import { REAL_MUSE_LABEL, explanationText, validateClaims, type RealMuseSuccess } from "@/lib/muse-c036-contract";
import type { ExplanationOutcome } from "@/lib/muse-contract";
const unavailable = (): ExplanationOutcome => ({ ok: false, code: "PROVIDER_NOT_CONFIGURED",
  message: "NOT CONFIGURED: no validated operator-authorized Muse result is available for this selected synthetic evidence. Browser requests never trigger inference." });
export function createSavedResultReader(readDirectory: () => string | undefined, readPublicationApproval: () => string | undefined = () => undefined) {
  return async (body: unknown, signal?: AbortSignal): Promise<ExplanationOutcome> => {
    if (signal?.aborted) return { ok: false, code: "CANCELLED", message: "Retrieval cancelled." };
    if (!body || typeof body !== "object" || (body as { consent?: unknown }).consent !== true)
      return { ok: false, code: "CONSENT_REQUIRED", message: "Approve retrieval for this selected finding." };
    const directory = readDirectory(), publicationApproval = readPublicationApproval();
    if (!directory || !publicationApproval || !/^c036\.[a-f0-9]{64}\.[A-Za-z0-9_-]{86}$/.test(publicationApproval)) return unavailable();
    try {
      const prepared = await prepareBrowserEvidence(body, signal);
      const result = readResult(directory, prepared.binding.evidenceId, publicationApproval);
      if (!sameBinding(result.binding, prepared.binding) || result.ruleId !== prepared.finding.ruleId
        || result.requestSha256 !== buildLiveRequest(prepared).requestSha256 || signal?.aborted) return unavailable();
      const claims = validateClaims(result.claims, prepared.finding.ruleId);
      const { findingId, path, line, column, quote } = prepared.binding;
      const response: RealMuseSuccess = { ok: true, explanation: explanationText(claims), citations: [{ findingId, path, line, column, quote }],
        verified: true, potential: true, providerLabel: REAL_MUSE_LABEL, mode: "provider-response", mock: false,
        binding: prepared.binding, requestSha256: result.requestSha256, generatedAt: result.generatedAt, receipt: result.receipt };
      return response;
    } catch { return unavailable(); } // No path, source, exception or configuration disclosure.
  };
}
export const retrieveOperatorExplanation = createSavedResultReader(() => process.env.C036_STATE_DIR, () => process.env.C036_PUBLICATION_APPROVAL);
