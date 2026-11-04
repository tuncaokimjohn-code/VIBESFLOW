import "server-only";
import { createMetaDirectPost } from "@/lib/meta-direct-server";
import { createMetaDirectAdapter, type MetaFetch } from "@/lib/meta-direct-adapter";
import { createMetaInputQualifier, type MetaCountFetch } from "@/lib/meta-direct-cost";
import { createNeonLedgerStore } from "@/lib/meta-direct-neon-store";
import { loadNeonClientFactory, type SqlClientFactory } from "@/lib/meta-direct-neon-driver";
import { validMetaCampaign } from "@/lib/meta-direct-ledger";
import { META_CAMPAIGN, META_DEPLOYMENT_GATE, META_PRICE_POLICY, exactHttpsOrigin, approvedNeonHost,
  validDatabaseUrl } from "@/lib/meta-direct-production-policy.mjs";
import type { GitHubApiFetch } from "@/lib/github-provider";

const disabled = createMetaDirectPost(null);
type ReadEnv = (name: string) => string | undefined;
/** Short-circuits before secret lookup unless ALL non-secret gates are exact.
 * Never enumerates env, opens dotenv, prints errors or accepts client config. */
export function productionConfig(read: ReadEnv) {
  if (read("NODE_ENV") !== "production" || read("VIBEFLOW_META_DIRECT_GATE") !== META_DEPLOYMENT_GATE ||
    read("VERCEL_ENV") && read("VERCEL_ENV") !== "production" ||
    read("VIBEFLOW_META_DIRECT_CAMPAIGN") !== META_CAMPAIGN ||
    read("VIBEFLOW_META_DIRECT_COST_QUALIFICATION") !== META_PRICE_POLICY) return null;
  const origin = read("VIBEFLOW_META_DIRECT_ORIGIN"), host = read("VIBEFLOW_META_DIRECT_NEON_HOST");
  if (!exactHttpsOrigin(origin) || !approvedNeonHost(host)) return null;
  const databaseUrl = read("DATABASE_URL"), key = read("MODEL_API_KEY");
  if (!validDatabaseUrl(databaseUrl, host) || !key || !/^[\x21-\x7e]{16,4096}$/.test(key)) return null;
  return { origin: origin!, host: host!, databaseUrl: databaseUrl!, key };
}
/** All injected factories are server-owned offline test seams, never browser
 * inputs. Every request rechecks DB identity, seeded policy and DB-time expiry;
 * there is no positive readiness cache, timer renewal, migration or auto-seed. */
export function createProductionMetaPost(deps: { readEnv?: ReadEnv; driver?: (url: string) => SqlClientFactory;
  metaFetch?: MetaFetch; countFetch?: MetaCountFetch; githubFetch?: GitHubApiFetch } = {}) {
  return async (req: Request): Promise<Response> => {
    let config: ReturnType<typeof productionConfig>;
    try { config = productionConfig(deps.readEnv ?? (name => process.env[name])); }
    catch { return disabled(req); }
    if (!config) return disabled(req);
    const { origin, host, databaseUrl, key } = config;
    // Do not trust forwarded host/proto to establish the allowed origin.
    if (req.url !== `${origin}/api/meta-direct` || req.method !== "POST" || req.headers.get("origin") !== origin ||
      req.headers.get("host") !== new URL(origin).host ||
      req.headers.has("x-forwarded-host") && req.headers.get("x-forwarded-host") !== new URL(origin).host ||
      req.headers.has("x-forwarded-proto") && req.headers.get("x-forwarded-proto") !== "https")
      return Response.json({ ok: false, code: "REQUEST_REJECTED" }, { status: 403, headers: { "cache-control": "no-store" } });
    try {
      const store = createNeonLedgerStore((deps.driver ?? loadNeonClientFactory)(databaseUrl), { origin, host });
      const ready = await store.transaction(async tx => {
        const c = await tx.lockCampaign(META_CAMPAIGN), now = await tx.nowMs();
        return validMetaCampaign(c, now);
      }, req.signal);
      if (!ready) return disabled(req);
      const credentials = async (signal: AbortSignal) => { signal.throwIfAborted(); return key; };
      const adapter = createMetaDirectAdapter({ credentials, fetch: deps.metaFetch ?? ((url, init) => fetch(url, init)) });
      const qualifyInput = createMetaInputQualifier(deps.countFetch ?? ((url, init) => fetch(url, init)), credentials);
      const githubFetch: GitHubApiFetch = deps.githubFetch ?? ((url, init) => fetch(url, { ...init, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" }));
      return await createMetaDirectPost({ origin, githubFetch, adapter, store, campaignId: META_CAMPAIGN,
        qualifyInput, deployment: { mode: "production", costQualification: "operator-qualified-meta-direct-v1" } })(req);
    } catch { return disabled(req); }
  };
}
// No configuration/key reads, driver loading or I/O at module import/build time.
export const productionMetaDirectPost = createProductionMetaPost();
/** Public health deliberately reveals no env/key/DB/quota diagnostics. A POST
 * preparation verifies source + readiness without a generation request. */
export const metaDirectHealth = async () => disabled(new Request("https://disabled.invalid"));
