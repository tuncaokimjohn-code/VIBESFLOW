/** ONLY native C035 entry point. No app route/component imports this module. */
import "server-only";
import { request as nativeRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { preparedFindings } from "./fixture";
import { buildLiveRequest, validateLiveResponse, BOUNDS } from "./protocol";
import { GrantSchema, readPrivateJson, consumeGrant, verifyCandidate, writeResult, writeOutcome, type Grant } from "./state";
import { startExchange, TransportFailure, type RequestFactory } from "./transport";
import { DiagnosticFailure, LocalIoFailure, OutcomeSchema, type ResponseFacts, type Stage } from "./diagnostics";
import type { SavedResult } from "@/lib/muse-c035-contract";
const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
type EnvironmentReader = (name: string) => string | undefined;
const unsafeEnvironment = ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_SYSTEM_CA", "NODE_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
async function execute(readEnv: EnvironmentReader, factory: RequestFactory, mode: SavedResult["mode"],
  verify: (expected: string) => string, signal?: AbortSignal) {
  let stage: Stage = "CONFIGURATION", root: string | undefined, approved: string | undefined, grant: Grant | undefined;
  let manifest: string | undefined, ownReservation = false, requestStarted = false;
  const facts: ResponseFacts = { responseBytes: 0, bodyComplete: false };
  const finish = (ok: boolean, code: string, ioCode?: LocalIoFailure["ioCode"]) => {
    const diagnostic = { mode, stage, code, requestStarted, ...facts, ...(ioCode ? { ioCode } : {}) };
    let auditSaved = false;
    if (ownReservation && root && grant && manifest) {
      try {
        const outcome = OutcomeSchema.parse({ version: "c035-outcome-v1", ok, ...diagnostic, authorizationId: grant.authorizationId,
          candidateManifestSha256: manifest, requestSha256: grant.requestSha256, evidenceId: grant.evidenceId, generatedAt: new Date().toISOString() });
        writeOutcome(root, outcome); auditSaved = true;
      } catch (error) {
        return { ok: false as const, code: "OUTCOME_STORAGE_FAILED", stage: "RESULT_STORAGE" as const, diagnostic,
          auditSaved: false, auditIoCode: error instanceof LocalIoFailure ? error.ioCode : "OTHER",
          message: "Outcome storage failed; inspect sanitized primary diagnostic. No retry or fallback was performed." };
      }
    }
    return { ok, code, stage, mode, evidenceId: grant?.evidenceId, requestSha256: grant?.requestSha256, diagnostic, auditSaved,
      message: ok ? "Validated authorized result saved." : "Muse execution unavailable; no retry or fallback was performed." };
  };
  try {
    if (readEnv("C035_LIVE_ENABLED") !== "1") return finish(false, "NOT_CONFIGURED");
    root = readEnv("C035_STATE_DIR"); approved = readEnv("C035_QA_APPROVED_MANIFEST_SHA256");
    if (!root || !approved || unsafeEnvironment.some(name => readEnv(name) !== undefined)) return finish(false, "UNSAFE_OR_MISSING_CONFIGURATION");
    if (signal?.aborted) return finish(false, "CANCELLED");
    stage = "AUTHORIZATION";
    const grantCheck = GrantSchema.safeParse(readPrivateJson(root, "approval.json", 8192));
    if (!grantCheck.success) return finish(false, "GRANT_SCHEMA_INVALID");
    grant = grantCheck.data;
    const now = Date.now(), issued = Date.parse(grant.issuedAt), expires = Date.parse(grant.expiresAt);
    if (issued > now || expires <= now || expires - issued > 600_000 || grant.qaManifestSha256 !== approved) return finish(false, "AUTHORIZATION_REJECTED");
    stage = "CANDIDATE_INTEGRITY"; manifest = verify(approved);
    stage = "EVIDENCE";
    const p = (await preparedFindings(signal)).find(x => x.binding.evidenceId === grant!.evidenceId);
    if (!p) return finish(false, "EVIDENCE_INVALID");
    const request = buildLiveRequest(p);
    stage = "AUTHORIZATION";
    if (request.requestSha256 !== grant.requestSha256 || signal?.aborted || Date.now() >= expires) return finish(false, "AUTHORIZATION_REJECTED");
    stage = "CONFIGURATION";
    const credential = readEnv("MODEL_API_KEY"); // only after authorization/integrity/evidence
    if (!credential || !/^[\x21-\x7e]{16,4096}$/.test(credential)) return finish(false, "NOT_CONFIGURED");
    stage = "RESERVATION";
    consumeGrant(root, grant, manifest); ownReservation = true;
    stage = "AUTHORIZATION";
    if (signal?.aborted || Date.now() >= expires) return finish(false, "AUTHORIZATION_REJECTED");
    stage = "TRANSPORT";
    const controller = signal ?? new AbortController().signal;
    const exchange = startExchange((options, callback) => { requestStarted = true; return factory(options, callback); },
      { body: request.body, expectedBody: request.body, credential, signal: controller, timeoutMs: Math.min(BOUNDS.timeoutMs, expires - Date.now()), facts });
    let raw: string;
    try { raw = await exchange.result; } finally { await exchange.stopped; }
    if (controller.aborted) return finish(false, "CANCELLED");
    stage = "PROVIDER_RESPONSE";
    const validated = validateLiveResponse(raw, p, credential, facts);
    stage = "RESULT_STORAGE";
    const result: SavedResult = { version: "c035-result-v1", mode, binding: p.binding, requestSha256: request.requestSha256,
      candidateManifestSha256: manifest, authorizationId: grant.authorizationId, generatedAt: new Date().toISOString(), ruleId: p.finding.ruleId, ...validated };
    writeResult(root, result);
    stage = "COMPLETE"; return finish(true, "RESULT_SAVED");
  } catch (error) {
    if (error instanceof LocalIoFailure && error.stage === "RESERVATION" && error.created) ownReservation = true;
    if (error instanceof DiagnosticFailure) { stage = error.stage; return finish(false, error.code, error instanceof LocalIoFailure ? error.ioCode : undefined); }
    if (error instanceof TransportFailure) { stage = "TRANSPORT"; return finish(false, error.code); }
    return finish(false, `${stage}_REJECTED`);
  }
}
export function runAuthorizedOperator(signal?: AbortSignal) {
  return execute(name => process.env[name], nativeRequest, "provider-response", expected => verifyCandidate(ROOT, expected), signal);
}
/** Injected transports ALWAYS produce offline-mock records/outcomes. */
export function createOfflineOperatorForTests(readEnv: EnvironmentReader, factory: RequestFactory, verify: (s: string) => string) {
  return (signal?: AbortSignal) => execute(readEnv, factory, "offline-mock", verify, signal);
}
