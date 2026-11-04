/** ONLY native C038 entry point. Never imported by browser or app routes. */
import "server-only";
import { request as nativeRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { validateLiveResponse, BOUNDS } from "./protocol";
import { consumeGrant, verifyCandidate, storePublication, writeFailure, type Grant } from "./state";
import { verifyPreflight, preflightProof, type EnvironmentReader } from "./preflight";
import { startExchange, TransportFailure, type RequestFactory } from "./transport";
import { DiagnosticFailure, LocalIoFailure, OutcomeSchema, type ResponseFacts, type Stage } from "./diagnostics";
import type { SavedResult } from "@/lib/muse-c038-contract";
const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
async function execute(read: EnvironmentReader, factory: RequestFactory, mode: SavedResult["mode"], verify: (s: string) => string, signal?: AbortSignal) {
  let stage: Stage = "CONFIGURATION", root: string | undefined, grant: Grant | undefined, manifest: string | undefined;
  let ownReservation = false, requestStarted = false;
  const facts: ResponseFacts = { responseBytes: 0, bodyComplete: false };
  const fail = (code: string, ioCode?: LocalIoFailure["ioCode"]) => {
    const diagnostic = { mode, stage, code, requestStarted, ...facts, ...(ioCode ? { ioCode } : {}) };
    let auditSaved = false;
    if (ownReservation && root && grant && manifest) {
      try {
        writeFailure(root, OutcomeSchema.parse({ version: "c038-outcome-v1", ok: false, ...diagnostic,
          authorizationId: grant.authorizationId, candidateManifestSha256: manifest, requestSha256: grant.requestSha256,
          evidenceId: grant.evidenceId, generatedAt: new Date().toISOString() }));
        auditSaved = true;
      } catch (error) {
        return { ok: false as const, code: "FAILURE_DIAGNOSTIC_STORAGE_FAILED", stage: "RESULT_STORAGE" as const,
          diagnostic, auditSaved: false, auditIoCode: error instanceof LocalIoFailure ? error.ioCode : "OTHER",
          message: "Failure diagnostic unavailable; no publication approval, retry or fallback was issued." };
      }
    }
    return { ok: false as const, code, stage, diagnostic, auditSaved,
      message: "Muse execution unavailable; no publication approval, retry or fallback was issued." };
  };
  try {
    const verified = await verifyPreflight(read, verify, signal);
    ({ root, grant, manifest } = verified);
    const { p, request, expires } = verified;
    stage = "CONFIGURATION";
    const credential = read("MODEL_API_KEY"); // BOTH preflights precede delivery/read
    if (!credential || !/^[\x21-\x7e]{16,4096}$/.test(credential)) return fail("NOT_CONFIGURED");
    stage = "RESERVATION"; consumeGrant(root, grant, manifest); ownReservation = true;
    stage = "AUTHORIZATION";
    if (signal?.aborted || Date.now() >= expires) return fail("AUTHORIZATION_REJECTED");
    stage = "TRANSPORT";
    const controller = signal ?? new AbortController().signal;
    const exchange = startExchange((options, callback) => { requestStarted = true; return factory(options, callback); },
      { body: request.body, expectedBody: request.body, credential, signal: controller, timeoutMs: Math.min(BOUNDS.timeoutMs, expires - Date.now()), facts });
    let raw: string;
    try { raw = await exchange.result; } finally { await exchange.stopped; }
    if (controller.aborted) return fail("CANCELLED");
    stage = "PROVIDER_RESPONSE";
    let validated;
    try { validated = validateLiveResponse(raw, p, credential, facts); }
    finally { raw = ""; } // Retain no raw reasoning reference during publication.
    stage = "RESULT_STORAGE";
    const result: SavedResult = { version: "c038-result-v1", mode, binding: p.binding, requestSha256: request.requestSha256,
      candidateManifestSha256: manifest, authorizationId: grant.authorizationId, generatedAt: new Date().toISOString(), ruleId: p.finding.ruleId, ...validated };
    const outcome = OutcomeSchema.parse({ version: "c038-outcome-v1", mode, ok: true, stage: "COMPLETE", code: "RESULT_SAVED",
      authorizationId: grant.authorizationId, candidateManifestSha256: manifest, requestSha256: request.requestSha256,
      evidenceId: p.binding.evidenceId, generatedAt: new Date().toISOString(), requestStarted, ...facts });
    const publication = storePublication(root, result, outcome);
    // This is the only publication approval. No filesystem work follows it.
    return { ok: true as const, code: "RESULT_SAVED", stage: "COMPLETE" as const, mode, ...publication,
      evidenceId: p.binding.evidenceId, requestSha256: request.requestSha256,
      message: "Durable result verified. A trusted operator must explicitly configure this local success seal in the keyless preview." };
  } catch (error) {
    if (error instanceof LocalIoFailure && error.stage === "RESERVATION" && error.created) ownReservation = true;
    if (error instanceof DiagnosticFailure) { stage = error.stage; return fail(error.code, error instanceof LocalIoFailure ? error.ioCode : undefined); }
    if (error instanceof TransportFailure) { stage = "TRANSPORT"; return fail(error.code); }
    return fail(`${stage}_REJECTED`);
  }
}
export async function runCredentialFreePreflight(signal?: AbortSignal) {
  try { return preflightProof(await verifyPreflight(n => process.env[n], s => verifyCandidate(ROOT, s), signal)); }
  catch (error) { return { ok: false as const, code: error instanceof DiagnosticFailure ? error.code : "PREFLIGHT_REJECTED",
    stage: error instanceof DiagnosticFailure ? error.stage : "AUTHORIZATION" }; }
}
export function runAuthorizedOperator(signal?: AbortSignal) {
  return execute(n => process.env[n], nativeRequest, "provider-response", s => verifyCandidate(ROOT, s), signal);
}
/** Injected transports can only produce offline-mock bundles and pins. */
export function createOfflineOperatorForTests(read: EnvironmentReader, factory: RequestFactory, verify: (s: string) => string) {
  return (signal?: AbortSignal) => execute(read, factory, "offline-mock", verify, signal);
}
