import "server-only";
import { z } from "zod";
import type { LedgerCampaign, LedgerChallenge, LedgerCounters, LedgerReservation, LedgerTransaction,
  SerializableLedgerStore } from "@/lib/public-muse-transactional-ledger";
import type { SqlClient, SqlClientFactory, SqlResult } from "@/lib/meta-direct-neon-driver";
import { META_CAMPAIGN, META_PROJECT, META_DATABASE, META_PRICE_POLICY, META_PRICE_EXPIRES_MS,
  META_RUNTIME_ROLE } from "@/lib/meta-direct-production-policy.mjs";
import { META_SCHEMA_SHA256 } from "@/lib/meta-direct-schema-proof.mjs";

const n = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), digest = z.string().regex(/^[a-f0-9]{64}$/);
const counters = z.object({ used: n, reserved: n, active: n }).strict();
const caps = z.object({ lifetime: n, money: n, concurrent: n }).strict();
const campaignSchema = counters.extend({ ...caps.shape, id: z.string(), version: z.string(), issuer: z.string(),
  audience: z.string(), enabled: z.boolean(), expiresAt: n, requestCost: n, operatorCaps: caps }).strict();
const challengeSchema = z.object({ hash: digest, subject: digest, issuer: z.string(), audience: z.string(),
  evidenceId: digest, version: z.string(), privacyVersion: z.string(), expiresAt: n, consumed: z.boolean() }).strict();
const reservationSchema = z.object({ id: digest, operationKey: digest, fencingToken: digest, subject: digest,
  evidenceId: digest, challengeHash: digest, tokenId: digest, version: z.string(), expiresAt: n, cost: n,
  state: z.enum(["reserved", "dispatched", "uncertain", "validated"]) }).strict();
const subjectSchema = z.string().regex(/^(?:[a-f0-9]{64}|preparation-lifetime|(?:preparation|dispatch)-minute-[0-9]{1,12})$/);
const TABLE = "vibeflow_meta_002";
export class FatalLedgerError extends Error { constructor() { super("META_LEDGER_FATAL"); } }
const ack = (r: SqlResult, command: string, count?: number) => {
  if (!r || r.command !== command || count !== undefined && r.rowCount !== count) throw new FatalLedgerError();
  return r;
};
/** Each transaction owns one real Client. Campaign row is the first row lock.
 * All child access is campaign-scoped and serialized behind that lock, including
 * reads of absent keys. This common mutex prevents child lock-order deadlocks
 * in both inherited algorithms (which visit child kinds in different orders).
 * No error is translated to PreDispatchConflict; even 40001 is fatal here. */
export function createNeonLedgerStore(factory: SqlClientFactory, binding: { origin: string; host: string }): SerializableLedgerStore {
  return { async transaction<T>(work: (tx: LedgerTransaction) => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let client: SqlClient | undefined, begun = false, committing = false, closed = false, failed = false;
    let campaignId: string | null = null, locked: LedgerCampaign | null = null, alive = true;
    const close = () => { if (!closed && client) { closed = true; void client.end().catch(() => undefined); } };
    const ctrl = new AbortController(), combined = AbortSignal.any([signal, ctrl.signal]);
    let rejectAbort!: (e: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => { failed = true; close(); rejectAbort(new FatalLedgerError()); };
    combined.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const check = () => { if (!alive || failed || combined.aborted) throw new FatalLedgerError(); };
    const query = async (sql: string, values?: unknown[]) => {
      check(); const r = await client!.query(sql, values); check(); return r;
    };
    const scoped = () => { check(); if (!campaignId || !locked) throw new FatalLedgerError(); return campaignId; };
    const selected = (r: SqlResult) => { ack(r, "SELECT"); if (r.rowCount !== r.rows.length || r.rows.length > 1) throw new FatalLedgerError(); return r.rows[0]?.value; };
    const run = (async () => {
      client = factory(); client.on("error", () => { failed = true; close(); rejectAbort(new FatalLedgerError()); });
      await client.connect(); check();
      ack(await query("BEGIN ISOLATION LEVEL SERIALIZABLE"), "BEGIN"); begun = true;
      ack(await query("SET LOCAL synchronous_commit = on"), "SET");
      ack(await query("SET LOCAL statement_timeout = '1200ms'"), "SET");
      ack(await query("SET LOCAL lock_timeout = '1000ms'"), "SET");
      ack(await query("SET LOCAL idle_in_transaction_session_timeout = '2000ms'"), "SET");
      const tx: LedgerTransaction = {
        lockCampaign: async id => {
          check(); if (campaignId || id !== META_CAMPAIGN) throw new FatalLedgerError();
          const r = await query(`SELECT to_jsonb(c) AS value FROM ${TABLE}.campaign c WHERE id = $1 FOR UPDATE`, [id]);
          const row = selected(r); if (!row) return null;
          const c = row as Record<string, unknown>;
          if (c.project_id !== META_PROJECT || c.database_name !== META_DATABASE || c.approved_origin !== binding.origin ||
            c.approved_host !== binding.host || c.price_policy !== META_PRICE_POLICY || c.price_expires_ms !== META_PRICE_EXPIRES_MS)
            throw new FatalLedgerError();
          // Catalog identity and role checks run on this same transaction/session.
          const identity = await query(`SELECT current_database() AS db, current_setting('server_version_num')::integer AS version,
            pg_has_role(current_user, $1, 'MEMBER') AS runtime,
            (SELECT pg_has_role(current_user, relowner, 'MEMBER') FROM pg_class WHERE oid = '${TABLE}.campaign'::regclass) AS owner,
            has_table_privilege(current_user, '${TABLE}.campaign', 'INSERT,DELETE,TRUNCATE') AS unsafe,
            (SELECT schema_sha256 FROM ${TABLE}.installation WHERE singleton) AS schema_sha256`, [META_RUNTIME_ROLE]);
          ack(identity, "SELECT", 1); const who = identity.rows[0];
          if (who.db !== META_DATABASE || typeof who.version !== "number" || who.version < 180000 || who.version >= 190000 ||
            who.runtime !== true || who.owner !== false || who.unsafe !== false || who.schema_sha256 !== META_SCHEMA_SHA256) throw new FatalLedgerError();
          locked = campaignSchema.parse(c.ledger); campaignId = id;
          // Prelock all existing bounded child keys in the interface's mandated
          // account -> challenge -> reservation order. Absent keys remain under
          // the campaign mutex; every later method must hold that same mutex.
          for (const [table, key] of [["account", "subject"], ["challenge", "hash"], ["reservation", "operation_key"]]) {
            const children = ack(await query(`SELECT ${key} FROM ${TABLE}.${table} WHERE campaign_id = $1 ORDER BY ${key} FOR UPDATE`, [id]), "SELECT");
            if (children.rowCount !== children.rows.length) throw new FatalLedgerError();
          }
          return structuredClone(locked);
        },
        nowMs: async () => {
          scoped(); const r = await query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS value");
          const value = selected(r); if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new FatalLedgerError();
          const now = n.parse(Number(value)); if (now >= META_PRICE_EXPIRES_MS) throw new FatalLedgerError(); return now;
        },
        putCampaign: async c => {
          const id = scoped(), parsed = campaignSchema.parse(c);
          const { used: _u, reserved: _r, active: _a, ...fixed } = parsed;
          const { used: _ou, reserved: _or, active: _oa, ...oldFixed } = locked!;
          if (JSON.stringify(fixed) !== JSON.stringify(oldFixed)) throw new FatalLedgerError();
          ack(await query(`UPDATE ${TABLE}.campaign SET ledger = $2::jsonb WHERE id = $1`,
            [id, JSON.stringify(parsed)]), "UPDATE", 1);
          locked = structuredClone(parsed);
        },
        account: async subject => {
          const id = scoped(); subjectSchema.parse(subject);
          const value = selected(await query(`SELECT jsonb_build_object('used', used, 'reserved', reserved, 'active', active) AS value
            FROM ${TABLE}.account WHERE campaign_id = $1 AND subject = $2 FOR UPDATE`, [id, subject]));
          return value === undefined ? { used: 0, reserved: 0, active: 0 } : counters.parse(value);
        },
        putAccount: async (subject, v: LedgerCounters) => {
          const id = scoped(); subjectSchema.parse(subject); const c = counters.parse(v);
          const values = [id, subject, c.used, c.reserved, c.active];
          const updated = ack(await query(`UPDATE ${TABLE}.account SET used = $3, reserved = $4, active = $5 WHERE campaign_id = $1 AND subject = $2`, values), "UPDATE");
          if (updated.rowCount === 0) ack(await query(`INSERT INTO ${TABLE}.account (campaign_id, subject, used, reserved, active) VALUES ($1,$2,$3,$4,$5)`, values), "INSERT", 1);
          else if (updated.rowCount !== 1) throw new FatalLedgerError();
        },
        challenge: async hash => {
          const id = scoped(); digest.parse(hash);
          const value = selected(await query(`SELECT data AS value FROM ${TABLE}.challenge WHERE campaign_id = $1 AND hash = $2 FOR UPDATE`, [id, hash]));
          return value === undefined ? null : challengeSchema.parse(value);
        },
        putChallenge: async (challenge: LedgerChallenge) => {
          const id = scoped(), c = challengeSchema.parse(challenge);
          // Invalidate an earlier subject challenge before the partial UNIQUE index.
          ack(await query(`UPDATE ${TABLE}.challenge SET data = jsonb_set(data, '{consumed}', 'true')
            WHERE campaign_id = $1 AND subject = $2 AND hash <> $3 AND NOT consumed`, [id, c.subject, c.hash]), "UPDATE");
          const updated = ack(await query(`UPDATE ${TABLE}.challenge SET data = $3::jsonb WHERE campaign_id = $1 AND hash = $2`, [id, c.hash, JSON.stringify(c)]), "UPDATE");
          if (updated.rowCount === 0) ack(await query(`INSERT INTO ${TABLE}.challenge (campaign_id, data) VALUES ($1,$2::jsonb)`, [id, JSON.stringify(c)]), "INSERT", 1);
          else if (updated.rowCount !== 1) throw new FatalLedgerError();
        },
        reservation: async key => {
          const id = scoped(); digest.parse(key);
          const value = selected(await query(`SELECT data AS value FROM ${TABLE}.reservation WHERE campaign_id = $1 AND operation_key = $2 FOR UPDATE`, [id, key]));
          return value === undefined ? null : reservationSchema.parse(value);
        },
        tokenUsed: async tokenId => {
          const id = scoped(); digest.parse(tokenId);
          return selected(await query(`SELECT true AS value FROM ${TABLE}.reservation WHERE campaign_id = $1 AND token_id = $2 FOR UPDATE`, [id, tokenId])) === true;
        },
        putReservation: async (reservation: LedgerReservation) => {
          const id = scoped(), r = reservationSchema.parse(reservation);
          const updated = ack(await query(`UPDATE ${TABLE}.reservation SET data = $3::jsonb WHERE campaign_id = $1 AND operation_key = $2`, [id, r.operationKey, JSON.stringify(r)]), "UPDATE");
          if (updated.rowCount === 0) ack(await query(`INSERT INTO ${TABLE}.reservation (campaign_id, data) VALUES ($1,$2::jsonb)`, [id, JSON.stringify(r)]), "INSERT", 1);
          else if (updated.rowCount !== 1) throw new FatalLedgerError();
        },
      };
      const result = await work(tx); check(); if (!campaignId) throw new FatalLedgerError();
      committing = true;
      ack(await query("COMMIT"), "COMMIT"); check();
      return result;
    })();
    try { return await Promise.race([run, aborted]); }
    catch {
      // COMMIT sent/ack unknown: NEVER retry or reuse the connection. Aborted
      // sessions are closed (Postgres rolls back open transactions). A callback
      // failure with a healthy session gets an explicit bounded ROLLBACK.
      if (begun && !committing && !closed && !combined.aborted) {
        try { await Promise.race([client!.query("ROLLBACK"), aborted]); } catch { /* fatal regardless */ }
      }
      throw new FatalLedgerError();
    } finally { alive = false; clearTimeout(timer); combined.removeEventListener("abort", onAbort); close(); }
  } };
}
