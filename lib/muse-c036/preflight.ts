/** Shared credential-free checks, used by BOTH launcher preflight and dispatch. */
import "server-only";
import { preparedFindings } from "./fixture";
import { buildLiveRequest } from "./protocol";
import { GrantSchema, readPrivateJson, assertUnusedState } from "./state";
import { DiagnosticFailure } from "./diagnostics";
export type EnvironmentReader = (name: string) => string | undefined;
const unsafe = ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_SYSTEM_CA", "NODE_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
export async function verifyPreflight(read: EnvironmentReader, verify: (expected: string) => string, signal?: AbortSignal) {
  if (read("C036_LIVE_ENABLED") !== "1") throw new DiagnosticFailure("CONFIGURATION", "NOT_CONFIGURED");
  const root = read("C036_STATE_DIR"), approved = read("C036_QA_APPROVED_MANIFEST_SHA256");
  if (!root || !approved || unsafe.some(n => read(n) !== undefined)) throw new DiagnosticFailure("CONFIGURATION", "UNSAFE_OR_MISSING_CONFIGURATION");
  if (signal?.aborted) throw new DiagnosticFailure("AUTHORIZATION", "CANCELLED");
  let grant;
  try { grant = GrantSchema.parse(readPrivateJson(root, "approval.json", 8192)); }
  catch { throw new DiagnosticFailure("AUTHORIZATION", "GRANT_INVALID"); }
  const now = Date.now(), issued = Date.parse(grant.issuedAt), expires = Date.parse(grant.expiresAt);
  if (issued > now || expires <= now || expires - issued > 600_000 || grant.qaManifestSha256 !== approved)
    throw new DiagnosticFailure("AUTHORIZATION", "AUTHORIZATION_REJECTED");
  assertUnusedState(root);
  let manifest;
  try { manifest = verify(approved); }
  catch { throw new DiagnosticFailure("CANDIDATE_INTEGRITY", "CANDIDATE_INTEGRITY_REJECTED"); }
  let p;
  try { p = (await preparedFindings(signal)).find(x => x.binding.evidenceId === grant.evidenceId); }
  catch { throw new DiagnosticFailure("EVIDENCE", "EVIDENCE_REJECTED"); }
  if (!p) throw new DiagnosticFailure("EVIDENCE", "EVIDENCE_INVALID");
  const request = buildLiveRequest(p);
  if (request.requestSha256 !== grant.requestSha256 || signal?.aborted || Date.now() >= expires)
    throw new DiagnosticFailure("AUTHORIZATION", "AUTHORIZATION_REJECTED");
  return { root, grant, manifest, p, request, expires };
}
export const preflightProof = (p: Awaited<ReturnType<typeof verifyPreflight>>) => ({
  ok: true as const, code: "PREFLIGHT_PASSED" as const, version: "c036-preflight-v1" as const,
  authorizationId: p.grant.authorizationId, candidateManifestSha256: p.manifest,
  requestSha256: p.request.requestSha256, evidenceId: p.p.binding.evidenceId,
});
