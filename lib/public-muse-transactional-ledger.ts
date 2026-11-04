import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { PRIVACY_VERSION, evidenceId } from "@/lib/public-muse-contract";
import { authDigest, isAuthenticatedOperation, type AuthenticatedOperation } from "@/lib/public-muse-operator-auth";
import { settleIndependently } from "@/lib/github-intake";

export interface LedgerCaps { lifetime: number; money: number; concurrent: number }
export interface LedgerCounters { used: number; reserved: number; active: number }
export interface LedgerCampaign extends LedgerCaps, LedgerCounters {
  id: string; version: string; issuer: string; audience: string; enabled: boolean; expiresAt: number;
  /** Integer micro-USD worst-case reservation. A configured number is not proof
   * of a provider cost bound; qualification remains an independent gate. */
  requestCost: number; operatorCaps: LedgerCaps;
}
export interface LedgerChallenge { hash: string; subject: string; issuer: string; audience: string; evidenceId: string;
  version: string; privacyVersion: string; expiresAt: number; consumed: boolean }
export interface LedgerReservation { id: string; operationKey: string; fencingToken: string; subject: string;
  evidenceId: string; challengeHash: string; tokenId: string; version: string; expiresAt: number;
  cost: number; state: "reserved" | "dispatched" | "uncertain" | "validated" }
export interface LedgerTransaction {
  /** Database clock, not client time. Lock the campaign FIRST on every write,
   * then account/challenge/reservation in this order across all instances. */
  nowMs(): Promise<number>;
  lockCampaign(id: string): Promise<LedgerCampaign | null>;
  putCampaign(campaign: LedgerCampaign): Promise<void>;
  account(subject: string): Promise<LedgerCounters>;
  putAccount(subject: string, counters: LedgerCounters): Promise<void>;
  challenge(hash: string): Promise<LedgerChallenge | null>;
  putChallenge(challenge: LedgerChallenge): Promise<void>;
  reservation(operationKey: string): Promise<LedgerReservation | null>;
  tokenUsed(tokenId: string): Promise<boolean>;
  putReservation(reservation: LedgerReservation): Promise<void>;
}
/** Implement using a REAL durable database: serializable BEGIN/COMMIT, rollback
 * on callback failure/cancellation, durable acknowledged commits, unique keys,
 * all methods scoped to the locked campaign. Never return success before COMMIT.
 * Missing/ambiguous acknowledgements MUST throw. No driver/default store exists. */
export interface SerializableLedgerStore {
  transaction<T>(work: (tx: LedgerTransaction) => Promise<T>, signal: AbortSignal): Promise<T>;
}
/** Only a database serialization/deadlock error with DEFINITE rollback may be
 * translated to this class. Never translate connection/commit-ack loss to it. */
export class PreDispatchConflict extends Error { readonly definitelyRolledBack = true; }
export type LedgerDecision = { kind: "created"; reservation: LedgerReservation } | { kind: "existing" | "denied" };
const safe = (v: number) => Number.isSafeInteger(v) && v >= 0;
function validCounters(v: LedgerCounters) { return [v.used, v.reserved, v.active].every(safe); }
function validCaps(v: LedgerCaps) { return [v.lifetime, v.money, v.concurrent].every(n => safe(n) && n > 0); }
function room(c: LedgerCounters, cap: LedgerCaps, cost: number) {
  return validCounters(c) && validCaps(cap) && c.used < cap.lifetime && c.active < cap.concurrent &&
    cost <= cap.money && c.reserved <= cap.money - cost && safe(c.used + 1) && safe(c.active + 1) && safe(c.reserved + cost);
}
function validCampaign(c: LedgerCampaign | null, now: number): c is LedgerCampaign {
  return !!c && safe(now) && c.enabled && safe(c.expiresAt) && c.expiresAt > now && validCounters(c) && validCaps(c) && validCaps(c.operatorCaps) &&
    safe(c.requestCost) && c.requestCost > 0;
}
const same = (a: string, b: string) => timingSafeEqual(Buffer.from(authDigest(a), "hex"), Buffer.from(authDigest(b), "hex"));
export function durableOperationKey(campaign: string, op: AuthenticatedOperation) {
  return authDigest(JSON.stringify([campaign, op.subject, op.evidenceId, op.challengeHash, op.privacyVersion, op.policyVersion]));
}
function owns(r: LedgerReservation | null, supplied: LedgerReservation): r is LedgerReservation {
  return !!r && same(r.id, supplied.id) && same(r.fencingToken, supplied.fencingToken) && same(r.operationKey, supplied.operationKey);
}

/** Executable database-independent transaction algorithm. The interface alone
 * cannot prove durability. Only test-support implements a JS database MODEL.
 * No activation factory or network orchestration is exported. */
export function createTransactionalMuseLedger(store: SerializableLedgerStore | null, campaignId: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(campaignId)) throw new Error("LEDGER_CONFIG_REJECTED");
  async function transaction<T>(work: (tx: LedgerTransaction) => Promise<T>, signal: AbortSignal, retryBeforeDispatch: boolean): Promise<T> {
    if (!store) throw new Error("LEDGER_UNAVAILABLE");
    const ctrl = new AbortController(), combined = AbortSignal.any([signal, ctrl.signal]);
    const run = (async () => {
      for (let attempt = 0; ; attempt++) {
        combined.throwIfAborted();
        try {
          const result = await store.transaction(async tx => { combined.throwIfAborted(); const result = await work(tx); combined.throwIfAborted(); return result; }, combined);
          combined.throwIfAborted(); return result;
        } catch (error) {
          if (!(error instanceof PreDispatchConflict) || !retryBeforeDispatch || attempt >= 2 || combined.aborted) throw error;
        }
      }
    })();
    try { return await settleIndependently(run, { signal, deadlineMs: 2000, onDeadline: () => ctrl.abort() }); }
    finally { ctrl.abort(); }
  }
  return {
    /** Called only by trusted preparation AFTER auth/source verification; hash
     * comes from a server-generated 256-bit challenge, never from browser input.
     * One live challenge per subject is required of putChallenge (SQL unique key).
     * Replacing it invalidates the old one. Preparation rates need upstream auth
     * rate limiting before source/network work; route remains unwired. */
    async issueChallenge(op: AuthenticatedOperation, hash: string, signal: AbortSignal): Promise<boolean> {
      if (!isAuthenticatedOperation(op) || !/^[a-f0-9]{64}$/.test(hash)) return false;
      try { return await transaction(async tx => {
        const c = await tx.lockCampaign(campaignId), now = await tx.nowMs();
        if (!validCampaign(c, now) || c.version !== op.policyVersion || c.issuer !== op.issuer || c.audience !== op.audience || op.expiresAt <= now || await tx.challenge(hash)) return false;
        await tx.putChallenge({ hash, subject: op.subject, issuer: op.issuer, audience: op.audience, evidenceId: op.evidenceId,
          version: c.version, privacyVersion: PRIVACY_VERSION, expiresAt: Math.min(now + 60_000, op.expiresAt, c.expiresAt), consumed: false });
        return true;
      }, signal, true); } catch { return false; }
    },
    async reserveOnce(op: AuthenticatedOperation, signal: AbortSignal): Promise<LedgerDecision> {
      if (!isAuthenticatedOperation(op) || op.evidenceId !== evidenceId(op.binding)) return { kind: "denied" };
      try { return await transaction<LedgerDecision>(async tx => {
        const c = await tx.lockCampaign(campaignId), now = await tx.nowMs(), key = durableOperationKey(campaignId, op);
        if (!validCampaign(c, now) || c.version !== op.policyVersion || c.issuer !== op.issuer || c.audience !== op.audience || op.expiresAt <= now) return { kind: "denied" };
        if (await tx.reservation(key)) return { kind: "existing" };
        const account = await tx.account(op.subject), challenge = await tx.challenge(op.challengeHash);
        if (!challenge || challenge.consumed || challenge.subject !== op.subject || challenge.issuer !== c.issuer || challenge.audience !== c.audience) return { kind: "denied" };
        // Burn an owned challenge on stale/mismatched/over-cap attempts. A caller
        // cannot burn another operator's challenge. Transaction rollback undoes
        // every write on database failure, not on a committed denial.
        challenge.consumed = true; await tx.putChallenge(challenge);
        if (challenge.evidenceId !== op.evidenceId || challenge.version !== c.version || challenge.privacyVersion !== op.privacyVersion ||
          op.privacyVersion !== PRIVACY_VERSION || challenge.expiresAt <= now || await tx.tokenUsed(op.tokenId) ||
          !room(c, c, c.requestCost) || !room(account, c.operatorCaps, c.requestCost)) return { kind: "denied" };
        c.used++; c.reserved += c.requestCost; c.active++;
        account.used++; account.reserved += c.requestCost; account.active++;
        const reservation: LedgerReservation = { id: key, operationKey: key, fencingToken: randomBytes(32).toString("hex"),
          subject: op.subject, evidenceId: op.evidenceId, challengeHash: op.challengeHash, tokenId: op.tokenId, version: c.version,
          expiresAt: Math.min(challenge.expiresAt, op.expiresAt, c.expiresAt), cost: c.requestCost, state: "reserved" };
        await tx.putCampaign(c); await tx.putAccount(op.subject, account); await tx.putReservation(reservation);
        return { kind: "created", reservation };
      }, signal, true); } catch { return { kind: "denied" }; }
    },
    async dispatchOnce(supplied: LedgerReservation, signal: AbortSignal): Promise<boolean> {
      try { return await transaction(async tx => {
        const c = await tx.lockCampaign(campaignId), now = await tx.nowMs(), r = await tx.reservation(supplied.operationKey);
        if (!validCampaign(c, now) || !owns(r, supplied) || r.version !== c.version || r.expiresAt <= now || r.state !== "reserved") return false;
        r.state = "dispatched"; await tx.putReservation(r); return true;
      }, signal, false); } catch { return false; }
    },
    async recordOutcome(supplied: LedgerReservation, outcome: "validated" | "uncertain", signal: AbortSignal): Promise<boolean> {
      if (outcome !== "validated" && outcome !== "uncertain") return false;
      try { return await transaction(async tx => {
        const c = await tx.lockCampaign(campaignId), r = await tx.reservation(supplied.operationKey);
        if (!c || !validCounters(c) || !owns(r, supplied)) return false;
        if (r.state === outcome) return true;
        if (r.state === "validated" || r.state === "uncertain" || (outcome === "validated" && r.state !== "dispatched")) return false;
        const account = await tx.account(r.subject);
        if (!validCounters(account) || c.active < 1 || account.active < 1) return false;
        r.state = outcome;
        // No money/count refund, ever. Uncertain/reserved/dispatched slots never
        // expire or auto-release; only an acknowledged validated outcome frees one.
        if (outcome === "validated") { c.active--; account.active--; }
        await tx.putCampaign(c); await tx.putAccount(r.subject, account); await tx.putReservation(r); return true;
      }, signal, false); } catch { return false; }
    },
  };
}
