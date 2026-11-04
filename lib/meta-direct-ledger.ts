import "server-only";
import { randomBytes } from "node:crypto";
import { sha256SyncHex as hash } from "@/lib/sha256-sync";
import { META_CAPS as C, META_PRIVACY, META_LIMITS } from "@/lib/meta-direct-contract";
import type { SerializableLedgerStore, LedgerCampaign, LedgerReservation, LedgerTransaction } from "@/lib/public-muse-transactional-ledger";
export const META_POLICY = "meta-direct-bounded-source-v1";
const safe = (n: number) => Number.isSafeInteger(n) && n >= 0;
export function validMetaCampaign(c: LedgerCampaign | null, now: number): c is LedgerCampaign {
  return !!c && c.enabled && safe(now) && safe(c.expiresAt) && c.expiresAt > now && c.version === META_POLICY &&
    c.issuer === "meta-direct-anonymous" && c.audience === "public-judge" &&
    [c.used, c.active, c.reserved, c.lifetime, c.money, c.concurrent, c.requestCost].every(safe) &&
    c.lifetime > 0 && c.lifetime <= C.requests && c.money > 0 && c.money <= C.microUsd &&
    c.concurrent > 0 && c.concurrent <= C.concurrent && c.requestCost === C.requestMicroUsd &&
    c.used <= c.lifetime && c.active <= c.concurrent && c.active <= c.used && c.reserved <= c.money && c.reserved === c.used * c.requestCost;
}
/** Anonymous one-time challenges replace operator HMAC. Shared store semantics
 * are inherited; the Neon driver is a separate server-only module. Every method is one
 * transaction, with NO retry on missing/ambiguous commit acknowledgement. */
export function createMetaJudgeLedger(store: SerializableLedgerStore | null, id: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("META_LEDGER_CONFIG");
  const tx = <T>(work: (db: LedgerTransaction) => Promise<T>, signal: AbortSignal) => {
    if (!store) throw new Error("META_LEDGER_UNAVAILABLE");
    return store.transaction(work, signal);
  };
  return {
    async admitPreparation(signal: AbortSignal): Promise<boolean> {
      return tx<boolean>(async db => {
        const c = await db.lockCampaign(id), now = await db.nowMs(); if (!validMetaCampaign(c, now) || c.used >= c.lifetime || c.active >= c.concurrent || c.reserved > c.money - c.requestCost) return false;
        const lifetime = await db.account("preparation-lifetime"), minute = await db.account(`preparation-minute-${Math.floor(now / 60_000)}`);
        if (![lifetime.used, minute.used].every(safe) || lifetime.used >= C.preparations || minute.used >= C.perMinute) return false;
        lifetime.used++; minute.used++; await db.putAccount("preparation-lifetime", lifetime); await db.putAccount(`preparation-minute-${Math.floor(now / 60_000)}`, minute); return true;
      }, signal);
    },
    async issue(evidenceId: string, signal: AbortSignal) {
      const nonce = randomBytes(32).toString("hex"), digest = hash(nonce);
      return tx<{ challenge: string; expiresAt: number }>(async db => {
        const c = await db.lockCampaign(id), now = await db.nowMs();
        if (!validMetaCampaign(c, now) || !/^[a-f0-9]{64}$/.test(evidenceId) || await db.challenge(digest)) throw new Error("META_LEDGER_DENIED");
        const expiresAt = Math.min(now + META_LIMITS.challengeTtlMs, c.expiresAt);
        await db.putChallenge({ hash: digest, subject: digest, issuer: c.issuer, audience: c.audience,
          evidenceId, version: META_POLICY, privacyVersion: META_PRIVACY, expiresAt, consumed: false });
        return { challenge: nonce, expiresAt };
      }, signal);
    },
    async reserve(evidenceId: string, nonce: string, consent: typeof META_PRIVACY, signal: AbortSignal) {
      if (consent !== META_PRIVACY || !/^[a-f0-9]{64}$/.test(nonce)) return null;
      const digest = hash(nonce), key = hash(JSON.stringify([id, digest, META_POLICY]));
      return tx<LedgerReservation | null>(async db => {
        const c = await db.lockCampaign(id), now = await db.nowMs(), challenge = await db.challenge(digest);
        if (!validMetaCampaign(c, now) || !challenge || challenge.consumed || challenge.version !== META_POLICY || challenge.privacyVersion !== META_PRIVACY || challenge.issuer !== c.issuer ||
          challenge.audience !== c.audience || challenge.expiresAt <= now || challenge.evidenceId !== evidenceId || await db.reservation(key)) return null;
        challenge.consumed = true; await db.putChallenge(challenge);
        const minuteId = `dispatch-minute-${Math.floor(now / 60_000)}`, minute = await db.account(minuteId);
        if (!safe(minute.used) || minute.used >= C.perMinute || c.used >= c.lifetime || c.active >= c.concurrent || c.reserved > c.money - c.requestCost) return null;
        c.used++; c.active++; c.reserved += c.requestCost; minute.used++;
        const reservation: LedgerReservation = { id: key, operationKey: key, fencingToken: hash(randomBytes(32).toString("hex")),
          subject: digest, evidenceId, challengeHash: digest, tokenId: digest, version: META_POLICY,
          expiresAt: challenge.expiresAt, cost: c.requestCost, state: "reserved" };
        await db.putCampaign(c); await db.putAccount(minuteId, minute); await db.putReservation(reservation); return reservation;
      }, signal);
    },
    async dispatch(r: LedgerReservation, signal: AbortSignal): Promise<boolean> {
      return tx<boolean>(async db => {
        const c = await db.lockCampaign(id), now = await db.nowMs(), saved = await db.reservation(r.operationKey);
        if (!validMetaCampaign(c, now) || !saved || saved.fencingToken !== r.fencingToken || saved.state !== "reserved" || saved.expiresAt <= now || saved.version !== META_POLICY) return false;
        saved.state = "dispatched"; await db.putReservation(saved); return true;
      }, signal);
    },
    async outcome(r: LedgerReservation, validated: boolean, signal: AbortSignal): Promise<boolean> {
      return tx<boolean>(async db => {
        const c = await db.lockCampaign(id), saved = await db.reservation(r.operationKey);
        if (!c || !saved || saved.fencingToken !== r.fencingToken || !["reserved", "dispatched"].includes(saved.state) ||
          !safe(c.active) || c.active < 1 || (validated && saved.state !== "dispatched")) return false;
        saved.state = validated ? "validated" : "uncertain";
        if (validated) c.active--; // No count/money refunds. Unknown slots remain occupied.
        await db.putCampaign(c); await db.putReservation(saved); return true;
      }, signal);
    },
  };
}
