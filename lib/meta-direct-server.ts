import "server-only";
import { META_LIMITS as L, META_PRIVACY, MetaRequestSchema, MetaResultSchema } from "@/lib/meta-direct-contract";
import { evidenceId } from "@/lib/public-muse-contract";
import { verifyPublicMuseSourceEvidence } from "@/lib/public-muse-source-server";
import { createMetaDirectAdapter, metaDirectBody, MetaDirectError } from "@/lib/meta-direct-adapter";
import { createMetaJudgeLedger } from "@/lib/meta-direct-ledger";
import type { SerializableLedgerStore, LedgerReservation } from "@/lib/public-muse-transactional-ledger";
import type { GitHubApiFetch } from "@/lib/github-provider";
import { readRequestBody } from "@/lib/intake-api";
import { strictJson } from "@/lib/public-muse-runtime-guards";
import { settleIndependently } from "@/lib/github-intake";
import type { VerifiedPublicMuseEvidence } from "@/lib/public-muse-source-server";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const fail = (code: string, status: number) => Response.json({ ok: false, code }, { status, headers });
export interface MetaDirectDependencies {
  origin: string; githubFetch: GitHubApiFetch; adapter: ReturnType<typeof createMetaDirectAdapter>;
  store: SerializableLedgerStore; campaignId: string;
  qualifyInput?: (evidence: VerifiedPublicMuseEvidence, signal: AbortSignal) => Promise<void>;
  deployment: { mode: "offline-preview" } | { mode: "production"; costQualification: "operator-qualified-meta-direct-v1" };
}
/** Trusted server composition only. Browser/env flags cannot select adapters,
 * transport labels, campaign, price, origin or storage. Runtime composition is
 * isolated in meta-direct-production, with mandatory production input preflight. */
export function createMetaDirectPost(deps: MetaDirectDependencies | null) {
  if (!deps || !deps.store || !["offline-preview", "production"].includes(deps.deployment.mode) ||
    deps.deployment.mode === "production" && (deps.deployment.costQualification !== "operator-qualified-meta-direct-v1" || typeof deps.qualifyInput !== "function"))
    return async (_req: Request) => fail("NOT_CONFIGURED", 503);
  const { origin, githubFetch, adapter } = deps, mode = deps.deployment.mode;
  if (new URL(origin).origin !== origin || !/^https:\/\//.test(origin) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)) throw new Error("META_ORIGIN_REJECTED");
  const ledger = createMetaJudgeLedger(deps.store, deps.campaignId);
  return async (req: Request) => {
    if (req.method !== "POST" || req.url !== `${origin}/api/meta-direct` || req.headers.get("origin") !== origin ||
      req.headers.has("host") && req.headers.get("host") !== new URL(origin).host ||
      req.headers.get("content-type") !== "application/json" || req.headers.get("sec-fetch-site") === "cross-site") return fail("REQUEST_REJECTED", 403);
    const ctrl = new AbortController(), signal = AbortSignal.any([req.signal, ctrl.signal]);
    let reservation: LedgerReservation | null = null, deadline = false;
    const work = (async () => {
      const body = await readRequestBody(req, L.requestBytes, 2000); signal.throwIfAborted();
      if (!body.ok) return fail("REQUEST_REJECTED", 400);
      const parsed = MetaRequestSchema.safeParse(strictJson(body.text));
      if (!parsed.success) return fail("REQUEST_REJECTED", 400);
      const intent = parsed.data, id = evidenceId(intent.binding);
      if (intent.action === "prepare") {
        if (!await ledger.admitPreparation(signal)) return fail("QUOTA_UNAVAILABLE", 429);
        await verifyPublicMuseSourceEvidence(intent.binding, githubFetch, signal); signal.throwIfAborted();
        const issued = await ledger.issue(id, signal); signal.throwIfAborted();
        return Response.json({ ok: true, stage: "prepared", evidenceId: id, ...issued, privacyVersion: META_PRIVACY }, { headers });
      }
      reservation = await ledger.reserve(id, intent.challenge, intent.consentVersion, signal); signal.throwIfAborted();
      if (!reservation) return fail("QUOTA_OR_CONSENT_REJECTED", 429);
      // Re-fetch, re-detect and validate AGAIN after reservation and consent.
      const verified = await verifyPublicMuseSourceEvidence(intent.binding, githubFetch, signal); signal.throwIfAborted();
      metaDirectBody(verified); // Fail closed on extraction/input limits BEFORE dispatch permission.
      if (deps.qualifyInput) { await deps.qualifyInput(verified, signal); signal.throwIfAborted(); }
      if (!await ledger.dispatch(reservation, signal)) return fail("QUOTA_UNAVAILABLE", 503);
      signal.throwIfAborted();
      const receipt = await adapter.invokeOnce(verified, signal); signal.throwIfAborted();
      const result = MetaResultSchema.parse({ ok: true, stage: "explained", binding: verified.binding, facts: verified.facts,
        analysis: receipt.analysis, context: receipt.context, provenance: { provider: "Meta Direct Responses API", model: receipt.model,
          status: "completed", reasoningRequested: "medium", reasoningVerified: false,
          transport: mode === "offline-preview" ? "offline-mock" : "meta-direct", inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens } });
      if (!await ledger.outcome(reservation, true, signal)) return fail("QUOTA_UNAVAILABLE", 503);
      signal.throwIfAborted();
      return Response.json(result, { headers });
    })();
    try { return await settleIndependently(work, { signal: req.signal, deadlineMs: L.routeDeadlineMs,
      onDeadline: () => { deadline = true; ctrl.abort(); } }); }
    catch (error) {
      if (reservation) {
        const cleanup = new AbortController(), timer = setTimeout(() => cleanup.abort(), 1000);
        void ledger.outcome(reservation, false, cleanup.signal).catch(() => undefined).finally(() => clearTimeout(timer));
      }
      return fail(req.signal.aborted ? "CANCELLED" : deadline ? "DEADLINE" : error instanceof MetaDirectError ? error.code : "SOURCE_OR_QUOTA_REJECTED",
        req.signal.aborted ? 499 : deadline ? 504 : 422);
    } finally { ctrl.abort(); }
  };
}
/** Compatibility export for explicitly disabled/offline callers. The actual
 * production route uses the separate, gated server-only composition. */
export const metaDirectPost = createMetaDirectPost(null);
