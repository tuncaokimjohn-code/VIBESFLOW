import "server-only";
import { z } from "zod";
import { BindingSchema, PUBLIC_MUSE_MODEL, PRIVACY_VERSION, PUBLIC_MUSE_LIMITS,
  VerifiedFactsSchema, evidenceId, validModelOutput, type PublicMuseBinding, type VerifiedFacts, type ModelOutput } from "@/lib/public-muse-contract";
import { sha256SyncHex } from "@/lib/sha256-sync";
import { settleIndependently } from "@/lib/github-intake";

/** Design contracts only. NO production implementation or route wiring exists.
 * The authenticator must verify signature, fixed issuer/audience/algorithm,
 * expiry, replay/revocation and CSRF/session binding server-side. Browser fields,
 * decoded unsigned JWT claims and the presence of an Authorization header are
 * never identities. Shape validation below is not cryptographic authentication. */
const IdentitySchema = z.object({ subject: z.string().min(1).max(128), issuer: z.string().min(1).max(256),
  audience: z.string().min(1).max(128), issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
}).strict();
export type VerifiedOperatorIdentity = z.infer<typeof IdentitySchema>;
export interface ProductionOperatorAuthenticator {
  verify(req: Request, signal: AbortSignal): Promise<VerifiedOperatorIdentity | null>;
}
export interface ServerOperatorPolicy {
  issuer: string; audience: string;
  /** Exact identities and owner/repo@immutable-commit strings, server-owned. */
  operators: ReadonlyArray<{ subject: string; snapshots: readonly string[] }>;
}
export function createServerOperatorAuthorizer(auth: ProductionOperatorAuthenticator, policy: ServerOperatorPolicy) {
  // Copy config so mutation of an adapter/caller's Set cannot expand authority.
  const issuer = policy.issuer, audience = policy.audience;
  const operators = new Map<string, ReadonlySet<string>>();
  for (const operator of policy.operators) {
    if (!operator.subject || operators.has(operator.subject) || operator.snapshots.some(s =>
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(s))) throw new Error("POLICY_REJECTED");
    operators.set(operator.subject, new Set(operator.snapshots));
  }
  return async (req: Request, binding: PublicMuseBinding, signal: AbortSignal, now = Date.now()) => {
    signal.throwIfAborted();
    const b = BindingSchema.parse(binding);
    const principal = IdentitySchema.safeParse(await settleIndependently(auth.verify(req, signal), {
      signal, deadlineMs: PUBLIC_MUSE_LIMITS.bodyDeadlineMs,
    }));
    signal.throwIfAborted();
    if (!principal.success || !Number.isSafeInteger(now) || principal.data.issuer !== issuer || principal.data.audience !== audience ||
      principal.data.issuedAt > now || principal.data.expiresAt <= now || principal.data.expiresAt <= principal.data.issuedAt ||
      !operators.get(principal.data.subject)?.has(`${b.owner}/${b.repo}@${b.commit}`)) throw new Error("OPERATOR_REJECTED");
    return principal.data.subject;
  };
}

export interface SpendReservationRequest {
  subject: string; evidenceId: string; challengeHash: string; privacyVersion: typeof PRIVACY_VERSION;
  /** Server-generated stable key; never a client key permitting a fresh retry. */
  operationKey: string;
}
export interface SpendReservation { id: string; fencingToken: string; operationKey: string }
export type ReservationDecision = { kind: "created"; reservation: SpendReservation } |
  { kind: "existing" | "denied" };
/** A future backend MUST enforce each method in durable serializable transactions
 * shared by all instances. No in-memory implementation is provided here.
 * reserveOnce atomically burns consent, enforces rates/concurrency, reserves the
 * worst-case verified price/token cost and increments lifetime invocation count.
 * Unique operation/challenge keys prevent replay, including across restarts.
 * Configuration, prices, caps and allowlists belong to the server/store, not req.
 * Unknown outcomes never refund money/count or release uncertain concurrency.
 * dispatchOnce persists a fenced one-time intent BEFORE the network attempt;
 * a crash on either side is quarantined and NEVER automatically re-dispatched. */
export interface DurableMuseSpendPort {
  reserveOnce(request: SpendReservationRequest, signal: AbortSignal): Promise<ReservationDecision>;
  dispatchOnce(reservation: SpendReservation, signal: AbortSignal): Promise<boolean>;
  recordOutcome(reservation: SpendReservation, outcome: "validated" | "uncertain"): Promise<void>;
}
/** Qualification must separately establish catalog support, exact returned model,
 * actual medium reasoning and bounded JSON/usage. No URL, credentials, defaults,
 * fallback, retries or SDK are supplied by these interfaces. */
export interface ProductionGatewayPort {
  invokeOnce(request: { model: typeof PUBLIC_MUSE_MODEL; reasoning: "medium"; stream: false;
    maxInputTokens: typeof PUBLIC_MUSE_LIMITS.maxInputTokens; maxOutputTokens: typeof PUBLIC_MUSE_LIMITS.maxOutputTokens;
    evidenceId: string; rule: PublicMuseBinding["rule"]; reservationId: string }, signal: AbortSignal): Promise<{
      returnedModel: string; requestedReasoning: "medium";
      usage: { inputTokens: number; outputTokens: number }; output: unknown;
    }>;
}
const PortReceiptSchema = z.object({ returnedModel: z.literal(PUBLIC_MUSE_MODEL), requestedReasoning: z.literal("medium"),
  usage: z.object({ inputTokens: z.number().int().min(1).max(PUBLIC_MUSE_LIMITS.maxInputTokens),
    outputTokens: z.number().int().min(1).max(PUBLIC_MUSE_LIMITS.maxOutputTokens) }).strict(), output: z.unknown(),
}).strict();

/** Executable OFFLINE contract exercise, not a production orchestration factory.
 * Ports must be test doubles. The actual route never imports/calls this helper.
 * Re-detection is required even after consent. A reservation is never refunded,
 * even if verification, cancellation, dispatch or outcome persistence fails. */
export async function exerciseDurableDispatchOffline(args: {
  mode: "offline-test"; binding: PublicMuseBinding; subject: string; challenge: string;
  ledger: DurableMuseSpendPort; gateway: ProductionGatewayPort;
  verifySource(signal: AbortSignal): Promise<VerifiedFacts>;
  signal: AbortSignal;
}): Promise<ModelOutput> {
  if (args.mode !== "offline-test") throw new Error("DISABLED");
  const b = BindingSchema.parse(args.binding);
  if (!/^[a-f0-9]{64}$/.test(args.challenge) || !args.subject || args.subject.length > 128) throw new Error("RESERVATION_REJECTED");
  const id = evidenceId(b), challengeHash = sha256SyncHex(args.challenge);
  const operationKey = sha256SyncHex(JSON.stringify([args.subject, id, challengeHash, PRIVACY_VERSION]));
  const ctrl = new AbortController(), signal = AbortSignal.any([args.signal, ctrl.signal]);
  let reservation: SpendReservation | undefined;
  const work = (async () => {
    signal.throwIfAborted();
    const decision = await args.ledger.reserveOnce({ subject: args.subject, evidenceId: id, challengeHash,
      privacyVersion: PRIVACY_VERSION, operationKey }, signal);
    if (decision.kind !== "created" || decision.reservation.operationKey !== operationKey) throw new Error("RESERVATION_REJECTED");
    reservation = decision.reservation;
    signal.throwIfAborted();
    const facts = VerifiedFactsSchema.parse(await args.verifySource(signal));
    if (facts.evidenceId !== id || facts.rule !== b.rule) throw new Error("SOURCE_REJECTED");
    signal.throwIfAborted();
    if (!await args.ledger.dispatchOnce(reservation, signal)) throw new Error("DISPATCH_REJECTED");
    signal.throwIfAborted();
    // No automatic retry, fallback or idempotency claim about the provider.
    const receipt = PortReceiptSchema.parse(await args.gateway.invokeOnce({ model: PUBLIC_MUSE_MODEL, reasoning: "medium", stream: false,
      maxInputTokens: PUBLIC_MUSE_LIMITS.maxInputTokens, maxOutputTokens: PUBLIC_MUSE_LIMITS.maxOutputTokens,
      evidenceId: id, rule: b.rule, reservationId: reservation.id }, signal));
    signal.throwIfAborted();
    // The gateway port cannot bypass independent local validation.
    const valid = validModelOutput(receipt.output, b);
    if (!valid) throw new Error("GATEWAY_REJECTED");
    await args.ledger.recordOutcome(reservation, "validated");
    signal.throwIfAborted();
    return valid;
  })();
  try {
    return await settleIndependently(work, { signal: args.signal, deadlineMs: PUBLIC_MUSE_LIMITS.deadlineMs, onDeadline: () => ctrl.abort() });
  } catch {
    // Best effort only: unknown/failed outcome persistence still leaves the
    // original durable reservation charged and quarantined. Never wait forever.
    if (reservation) void args.ledger.recordOutcome(reservation, "uncertain").catch(() => undefined);
    throw new Error("OFFLINE_DISPATCH_FAILED");
  } finally { ctrl.abort(); }
}
