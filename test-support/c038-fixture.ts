/** Invented private offline state. Never a real grant, key or provider receipt. */
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { preparedFindings } from "@/lib/muse-c038/fixture";
import { buildLiveRequest, validateLiveResponse } from "@/lib/muse-c038/protocol";
import { GrantSchema, writePrivateExclusive } from "@/lib/muse-c038/state";
import { createOfflineOperatorForTests } from "@/lib/muse-c038/operator";
import { OutcomeSchema } from "@/lib/muse-c038/diagnostics";
import { SavedResultSchema } from "@/lib/muse-c038-contract";
import { inventedC035Envelope, mockExchange, FAKE_KEY } from "./c035-mock";
export const findings = await preparedFindings();
export const sql = findings.find(p => p.finding.ruleId === "VF-SEC-002")!;
export const approved = "1".repeat(64);
const roots: string[] = [];
export function privateRoot() {
  const root = fs.mkdtempSync(path.join(os.homedir(), ".c038-offline-test-"));
  fs.chmodSync(root, 0o700); roots.push(root); return root;
}
export function cleanupRoots() {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(path.join(os.homedir(), ".c038-offline-test-"))) throw new Error("Not an offline test root");
    fs.rmSync(root, { recursive: true, force: true });
  }
}
export const browserBody = (p = sql) => ({ consent: true, findingId: p.finding.id, snapshot: p.snapshot, contents: p.contents, evidence: p.binding });
export function fakeGrant() {
  return GrantSchema.parse({ version: "c038-grant-v1", authorizationId: "a".repeat(32), qaManifestSha256: approved,
    requestSha256: buildLiveRequest(sql).requestSha256, evidenceId: sql.binding.evidenceId,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxAttempts: 1, financialAcknowledgement: "NO_PROVIDER_DOLLAR_CAP_VERIFIED" });
}
export function data(mode: "provider-response" | "offline-mock" = "provider-response") {
  const validated = validateLiveResponse(JSON.stringify(inventedC035Envelope(sql)), sql);
  const attempt = { authorizationId: "a".repeat(32), candidateManifestSha256: approved,
    requestSha256: buildLiveRequest(sql).requestSha256, evidenceId: sql.binding.evidenceId };
  const result = SavedResultSchema.parse({ version: "c038-result-v1", mode, binding: sql.binding,
    authorizationId: attempt.authorizationId, candidateManifestSha256: approved, requestSha256: attempt.requestSha256,
    generatedAt: new Date().toISOString(), ruleId: sql.finding.ruleId, ...validated });
  const outcome = OutcomeSchema.parse({ version: "c038-outcome-v1", mode, ok: true, stage: "COMPLETE", code: "RESULT_SAVED", ...attempt,
    generatedAt: result.generatedAt, requestStarted: true, httpStatus: 200, responseBytes: 1000, bodyComplete: true, receipt: validated.receipt });
  return { result, outcome, attempt };
}
export function setup(body = JSON.stringify(inventedC035Envelope(sql))) {
  const root = privateRoot(), grant = fakeGrant(); writePrivateExclusive(root, "approval.json", grant);
  const env: Record<string, string | undefined> = { C038_LIVE_ENABLED: "1", C038_STATE_DIR: root, C038_QA_APPROVED_MANIFEST_SHA256: approved, MODEL_API_KEY: FAKE_KEY };
  const reads: string[] = [];
  const http = mockExchange(r => { r.emit("data", Buffer.from(body)); r.emit("end"); });
  const run = createOfflineOperatorForTests(n => { reads.push(n); return env[n]; }, http.factory, s => s);
  return { root, grant, env, reads, http, run };
}
