import "server-only";
import { env } from "node:process";
import { randomBytes } from "node:crypto";
import { PublicMuseRequestSchema, PRIVACY_VERSION, PUBLIC_MUSE_MODEL, PUBLIC_MUSE_LIMITS as LIMITS,
  composeGroundedNarrative, evidenceId, type PublicMuseBinding } from "@/lib/public-muse-contract";
import { readRequestBody } from "@/lib/intake-api";
import { settleIndependently } from "@/lib/github-intake";
import { verifyPublicMuseSource } from "@/lib/public-muse-source-server";
import { runOfflineGateway, type OfflineGatewayTransport } from "@/lib/public-muse-gateway-server";
import type { GitHubApiFetch } from "@/lib/github-provider";

export function publicMuseResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store, private, max-age=0",
    "pragma": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}
const fail = (code: string, status: number) => publicMuseResponse({ ok: false, code }, status);

/** Production deliberately has NO network/credentials/adapter/store. An env flag
 * alone cannot authorize spend or bypass the unverified wire-contract gate. */
export async function publicMusePost(_req: Request): Promise<Response> {
  return env.VIBEFLOW_PUBLIC_MUSE_ENABLED !== "1" ? fail("DISABLED", 503) : fail("OPERATOR_AND_DURABLE_SPEND_CONTROLS_REQUIRED", 503);
}

export interface OfflineOperator { id: string; allowedSnapshots: ReadonlySet<string> }
/** Atomic operations; offline implementation lives ONLY in test-support.
 * Production needs durable, multi-instance hard spend reservation with no refund
 * after uncertain/cancelled calls, authenticated operators, and catalog/shape QA. */
export interface OfflineControlStore {
  takePreparation(subject: string): boolean;
  issue(subject: string, evidenceId: string, challenge: string, expiresAt: number): void;
  consumeAndReserve(subject: string, evidenceId: string, challenge: string): "ok" | "consent" | "quota";
}
export interface OfflineMuseDependencies {
  mode: "offline-test";
  origin: string;
  authenticate(req: Request): Promise<OfflineOperator | null>;
  controls: OfflineControlStore;
  githubFetch: GitHubApiFetch;
  gateway: OfflineGatewayTransport;
  now?: () => number;
}

/** Explicit test harness; cannot emit a result labeled real. Not used by route. */
export function createOfflinePublicMusePost(deps: OfflineMuseDependencies) {
  let busy = false;
  return async (req: Request): Promise<Response> => {
    if (deps.mode !== "offline-test") return fail("DISABLED", 503);
    if (req.method !== "POST" || req.headers.get("origin") !== deps.origin || req.url !== `${deps.origin}/api/public-muse` ||
      req.headers.has("cookie") || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers.get("content-type") ?? "")) return fail("REQUEST_REJECTED", 400);
    try {
      req.signal.throwIfAborted();
      const operator = await settleIndependently(deps.authenticate(req), { signal: req.signal, deadlineMs: LIMITS.bodyDeadlineMs });
      if (!operator) return fail("OPERATOR_REQUIRED", 401);
      if (busy) return fail("CONCURRENCY_LIMIT", 429);
      busy = true;
      const ctrl = new AbortController();
      const signal = AbortSignal.any([req.signal, ctrl.signal]);
      let gatewayPending = false, workDone = false;
      // Keep concurrency occupied until underlying work actually settles. A
      // non-cooperative transport cannot regain a slot merely by timing out.
      const work = (async () => {
        const bounded = await readRequestBody(new Request(req, { signal }), LIMITS.requestBytes, LIMITS.bodyDeadlineMs);
        if (!bounded.ok) return fail("REQUEST_REJECTED", 400);
        const parsed = PublicMuseRequestSchema.safeParse(JSON.parse(bounded.text));
        if (!parsed.success) return fail("REQUEST_REJECTED", 400);
        const body = parsed.data, b: PublicMuseBinding = body.binding;
        if (!operator.allowedSnapshots.has(`${b.owner}/${b.repo}@${b.commit}`)) return fail("SNAPSHOT_NOT_ALLOWED", 403);
        const id = evidenceId(b);
        if (body.action === "prepare") {
          if (!deps.controls.takePreparation(operator.id)) return fail("RATE_LIMIT", 429);
        } else {
          const reservation = deps.controls.consumeAndReserve(operator.id, id, body.challenge);
          if (reservation !== "ok") return fail(reservation === "quota" ? "QUOTA_LIMIT" : "CONSENT_REQUIRED", reservation === "quota" ? 429 : 403);
        }
        const facts = await verifyPublicMuseSource(b, deps.githubFetch, signal);
        signal.throwIfAborted();
        if (body.action === "prepare") {
          const challenge = randomBytes(32).toString("hex"), expiresAt = (deps.now ?? Date.now)() + LIMITS.challengeTtlMs;
          deps.controls.issue(operator.id, id, challenge, expiresAt);
          return publicMuseResponse({ ok: true, stage: "prepared", evidenceId: id, challenge, expiresAt, privacyVersion: PRIVACY_VERSION, mock: true });
        }
        gatewayPending = true;
        const output = await runOfflineGateway(b, deps.gateway, signal, () => {
          gatewayPending = false;
          if (workDone) busy = false;
        });
        signal.throwIfAborted();
        return publicMuseResponse({ ok: true, stage: "explained", binding: b, output,
          narrative: composeGroundedNarrative(b, facts), mock: true,
          provenance: { gateway: "Vercel AI Gateway", requestedModel: PUBLIC_MUSE_MODEL, returnedModel: PUBLIC_MUSE_MODEL,
            requestedReasoning: "medium", reasoningVerified: false, liveVerified: false, transport: "offline-mock" } });
      })();
      // Source failures and adapter errors are deliberately opaque: no upstream
      // messages, body, source, URLs, prompts, credentials or causes are logged.
      const finished = () => { workDone = true; if (!gatewayPending) busy = false; };
      void work.then(finished, finished);
      try {
        return await settleIndependently(work, { signal: req.signal, deadlineMs: LIMITS.deadlineMs, onDeadline: () => ctrl.abort() });
      } finally { ctrl.abort(); }
    } catch {
      return fail(req.signal.aborted ? "CANCELLED" : "VERIFICATION_OR_GATEWAY_FAILED", req.signal.aborted ? 499 : 422);
    }
  };
}
