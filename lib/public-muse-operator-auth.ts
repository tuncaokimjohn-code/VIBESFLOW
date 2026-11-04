import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { PublicMuseRequestSchema, PRIVACY_VERSION, evidenceId, type PublicMuseBinding } from "@/lib/public-muse-contract";
import { readRequestBody } from "@/lib/intake-api";
import { settleIndependently } from "@/lib/github-intake";
import { strictJson } from "@/lib/public-muse-runtime-guards";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const OperatorTokenClaims = z.object({ iss: z.string().min(1).max(256), aud: z.string().min(1).max(128),
  sub: z.string().min(1).max(128), iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
  jti: digest, evidenceId: digest, challengeHash: digest, bodySha256: digest,
  privacyVersion: z.literal(PRIVACY_VERSION), policyVersion: z.string().min(1).max(64),
  origin: z.string().max(256), path: z.literal("/api/public-muse"), method: z.literal("POST"), contentType: z.literal("application/json"),
}).strict();
const mark = Symbol("server-verified-operator");
export type AuthenticatedOperation = Readonly<{ [mark]: true; subject: string; issuer: string; audience: string;
  evidenceId: string; challengeHash: string; tokenId: string; policyVersion: string; expiresAt: number;
  privacyVersion: typeof PRIVACY_VERSION; binding: PublicMuseBinding }>;
export function isAuthenticatedOperation(value: AuthenticatedOperation): boolean { return value?.[mark] === true; }
export const authDigest = (s: string) => createHash("sha256").update(s).digest("hex");
const equal = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
export interface OperatorAuthConfig {
  issuer: string; audience: string; origin: string; policyVersion: string; keyIds: readonly string[];
  operators: ReadonlyArray<{ subject: string; snapshots: readonly string[] }>;
}
export type OperatorKeyProvider = (kid: string, signal: AbortSignal) => Promise<{
  secret: Uint8Array; notAfter: number;
} | null>;

/** Narrow HMAC capability verifier, NOT a login/session/identity provider.
 * Use only with a reviewed trusted issuer, securely delivered short-lived tokens,
 * independent high-entropy server-managed keys and secure rotation/revocation.
 * No key loader, env access or production provisioning is provided. Prefer the
 * established organizational auth provider for a deployed operator interface. */
export function createHmacOperatorAuthenticator(config: OperatorAuthConfig, loadKey: OperatorKeyProvider, clock = Date.now) {
  const issuer = config.issuer, audience = config.audience, origin = config.origin, version = config.policyVersion;
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || !issuer || issuer.length > 256 || !audience || audience.length > 128 ||
    !version || version.length > 64 || typeof loadKey !== "function" || !config.keyIds.length || config.keyIds.length > 4 ||
    config.keyIds.some(k => !/^[a-zA-Z0-9_-]{1,32}$/.test(k))) throw new Error("AUTH_CONFIG_REJECTED");
  const keyIds = new Set(config.keyIds), operators = new Map<string, Set<string>>();
  for (const op of config.operators) {
    if (!op.subject || op.subject.length > 128 || operators.has(op.subject) || op.snapshots.some(s =>
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(s))) throw new Error("AUTH_CONFIG_REJECTED");
    operators.set(op.subject, new Set(op.snapshots));
  }
  return { async authenticate(req: Request, signal: AbortSignal): Promise<AuthenticatedOperation | null> {
    const ctrl = new AbortController(), combined = AbortSignal.any([signal, req.signal, ctrl.signal]);
    const work = (async (): Promise<AuthenticatedOperation | null> => {
      combined.throwIfAborted();
      // Host/path/origin/method/type are all server-owned; forwarded headers do
      // not expand authority. No cookies or alternate/query routes are accepted.
      if (req.url !== `${origin}/api/public-muse` || req.method !== "POST" || req.headers.get("origin") !== origin ||
        req.headers.has("cookie") || req.headers.get("content-type") !== "application/json") return null;
      const header = req.headers.get("authorization") ?? "";
      if (header.length > 4096) return null;
      const parts = /^Bearer v1\.([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(header);
      if (!parts || !keyIds.has(parts[1])) return null;
      const [, kid, encoded, mac] = parts, bytes = Buffer.from(encoded, "base64url");
      if (bytes.length > 2048 || bytes.toString("base64url") !== encoded || Buffer.from(mac, "base64url").toString("base64url") !== mac) return null;
      const claims = OperatorTokenClaims.parse(strictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      const key = await loadKey(kid, combined);
      combined.throwIfAborted();
      const now = clock();
      if (!key || key.secret.byteLength < 32 || key.secret.byteLength > 64 || !Number.isSafeInteger(key.notAfter) || key.notAfter <= now) return null;
      const expected = createHmac("sha256", key.secret).update(`v1.${kid}.${encoded}`).digest();
      if (!timingSafeEqual(expected, Buffer.from(mac, "base64url"))) return null;
      if (!Number.isSafeInteger(now) || !equal(claims.iss, issuer) || !equal(claims.aud, audience) || !equal(claims.policyVersion, version) ||
        claims.iat > now || claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 60_000 || claims.exp > key.notAfter ||
        claims.origin !== origin) return null;
      const body = await readRequestBody(new Request(req, { signal: combined }), 4096, 2000);
      if (!body.ok) return null;
      const intent = PublicMuseRequestSchema.parse(strictJson(body.text));
      if (intent.action !== "explain" || !equal(claims.bodySha256, authDigest(JSON.stringify(intent))) ||
        !equal(claims.evidenceId, evidenceId(intent.binding)) || !equal(claims.challengeHash, authDigest(intent.challenge)) ||
        !operators.get(claims.sub)?.has(`${intent.binding.owner}/${intent.binding.repo}@${intent.binding.commit}`)) return null;
      combined.throwIfAborted();
      if (clock() >= claims.exp) return null;
      // Replay is NOT consumed here. The durable reserve transaction MUST check
      // this identity/token/challenge/version/expiry and burn it atomically.
      return Object.freeze({ [mark]: true as const, subject: claims.sub, issuer, audience, policyVersion: version,
        evidenceId: claims.evidenceId, challengeHash: claims.challengeHash, tokenId: claims.jti,
        expiresAt: claims.exp, privacyVersion: PRIVACY_VERSION, binding: Object.freeze(intent.binding) });
    })();
    try { return await settleIndependently(work, { signal: combined, deadlineMs: 2000, onDeadline: () => ctrl.abort() }); }
    catch { return null; }
    finally { ctrl.abort(); }
  } };
}
