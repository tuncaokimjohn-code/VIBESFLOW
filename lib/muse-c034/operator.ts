/** The ONLY native Muse entry point. Never imported by app routes/components.
 * Approval means a trusted OS operator supplied a protected, exact grant after
 * independent QA and Chief approval. It is not identity verification of Chief.
 */
import "server-only";
import { request as nativeRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { preparedFindings } from "./fixture";
import { buildLiveRequest, validateLiveResponse, BOUNDS } from "./protocol";
import { GrantSchema, readPrivateJson, consumeGrant, verifyCandidate, writeResult } from "./state";
import { startExchange, TransportFailure, type RequestFactory } from "./transport";
import type { SavedResult } from "@/lib/muse-c034-contract";
const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
type EnvironmentReader = (name: string) => string | undefined;
const failure = (code: string) => ({ ok: false as const, code, message: "Local Muse execution unavailable; no retry or fallback was performed." });
const unsafeEnvironment = ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_SYSTEM_CA", "NODE_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
async function execute(readEnv: EnvironmentReader, factory: RequestFactory, mode: SavedResult["mode"],
  verify: (expected: string) => string, signal?: AbortSignal) {
  if (readEnv("C034_LIVE_ENABLED") !== "1") return failure("NOT_CONFIGURED");
  const root = readEnv("C034_STATE_DIR"), approved = readEnv("C034_QA_APPROVED_MANIFEST_SHA256");
  if (!root || !approved || unsafeEnvironment.some(name => readEnv(name) !== undefined)) return failure("NOT_CONFIGURED");
  if (signal?.aborted) return failure("CANCELLED");
  try {
    const grant = GrantSchema.parse(readPrivateJson(root, "approval.json", 8192));
    const now = Date.now(), issued = Date.parse(grant.issuedAt), expires = Date.parse(grant.expiresAt);
    if (issued > now || expires <= now || expires - issued > 600_000 || grant.qaManifestSha256 !== approved) return failure("AUTHORIZATION_REJECTED");
    const manifest = verify(approved);
    const p = (await preparedFindings(signal)).find(x => x.binding.evidenceId === grant.evidenceId);
    if (!p) return failure("EVIDENCE_INVALID");
    const request = buildLiveRequest(p);
    if (request.requestSha256 !== grant.requestSha256 || signal?.aborted || Date.now() >= expires) return failure("AUTHORIZATION_REJECTED");
    // Key values are consulted only after local authorization and exact request
    // verification. No dotenv/config files, arguments, browser input or logs.
    const credential = readEnv("MODEL_API_KEY");
    if (!credential || !/^[\x21-\x7e]{16,4096}$/.test(credential)) return failure("NOT_CONFIGURED");
    consumeGrant(root, grant, manifest); // exclusive fsynced, nonrefundable before network
    // Filesystem reservation or key delivery may cross the grant deadline.
    if (signal?.aborted || Date.now() >= expires) return failure("AUTHORIZATION_REJECTED");
    const controller = signal ?? new AbortController().signal;
    const remaining = Math.min(BOUNDS.timeoutMs, expires - Date.now());
    const exchange = startExchange(factory, { body: request.body, expectedBody: request.body, credential, signal: controller, timeoutMs: remaining });
    let raw: string;
    try { raw = await exchange.result; } finally { await exchange.stopped; }
    if (controller.aborted) return failure("CANCELLED");
    const validated = validateLiveResponse(raw, p, credential);
    const result: SavedResult = { version: "c034-result-v1", mode, binding: p.binding, requestSha256: request.requestSha256,
      candidateManifestSha256: manifest, authorizationId: grant.authorizationId, generatedAt: new Date().toISOString(), ruleId: p.finding.ruleId, ...validated };
    writeResult(root, result);
    // Never return raw response JSON, reasoning, headers, key or error strings.
    return { ok: true as const, mode, evidenceId: p.binding.evidenceId, requestSha256: request.requestSha256 };
  } catch (error) { return failure(error instanceof TransportFailure ? error.code : "EXECUTION_REJECTED"); }
}
export function runAuthorizedOperator(signal?: AbortSignal) {
  return execute(name => process.env[name], nativeRequest, "provider-response", expected => verifyCandidate(ROOT, expected), signal);
}
/** Trusted offline seam. A mocked transport can NEVER publish a real result. */
export function createOfflineOperatorForTests(readEnv: EnvironmentReader, factory: RequestFactory, verify: (s: string) => string) {
  return (signal?: AbortSignal) => execute(readEnv, factory, "offline-mock", verify, signal);
}
