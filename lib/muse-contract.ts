/**
 * P6 E5/E6 shared contracts (pure; no provider, Node, or network imports).
 * A real Muse provider connection is NOT VERIFIED in this candidate:
 * no official SDK or provider documentation is available locally, so no
 * endpoint/auth contract is invented here. Only an injected provider
 * interface exists; production wiring supplies none.
 */
export const MUSE_LIMITS = Object.freeze({
  maxExcerptChars: 2_000,
  maxExplanationChars: 8_000,
  maxCitations: 8,
  timeoutMs: 15_000,
  maxConcurrent: 2,
});

export interface MuseCitation {
  findingId: string;
  path: string;
  line: number;
  column: number;
  quote: string;
}

export interface MuseProviderRequest {
  system: string;
  prompt: string;
  signal: AbortSignal;
}

export interface MuseProviderResponse {
  text: string;
  citations: MuseCitation[];
  refused?: boolean;
}

/** Offline injected provider boundary; production wiring supplies none.
 * explain must settle ONLY after all underlying work/resources have stopped.
 * Abort/timeout alone does not release the server's concurrency reservation.
 * Free-form prose is not trusted: C024 accepts only the rule's fixed,
 * conservative explanation together with its exact source citation.
 */
export interface MuseProvider {
  readonly label: string;
  explain(request: MuseProviderRequest): Promise<MuseProviderResponse>;
}

export type ExplanationSuccess = { ok: true; explanation: string; citations: MuseCitation[]; verified: true; providerLabel: string; potential: true };
export type ExplanationOutcome =
  | ExplanationSuccess
  | import("@/lib/muse-c034-contract").RealMuseSuccess
  | (ExplanationSuccess & { mode: "offline-mock"; mock: true; binding: import("@/lib/muse-binding").EvidenceBinding; requestSha256: string })
  | { ok: false; code: "CONSENT_REQUIRED" | "PROVIDER_NOT_CONFIGURED" | "PROVIDER_UNAVAILABLE" | "PROVIDER_REFUSED" | "TIMEOUT" | "CANCELLED" | "EVIDENCE_INVALID" | "LIMIT_EXCEEDED" | "VALIDATION"; message: string };
