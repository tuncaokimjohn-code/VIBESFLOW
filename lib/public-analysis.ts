/** Offline source scan boundary for the normal UI. No provider or fixture path. */
import type { GitHubAstSuccess } from "@/lib/github-ast-contract";
import { detectSecurityFindings, type DetectionResult } from "@/lib/security-findings";
import { sha256Text } from "@/lib/intake-client";
import { verifyFindingMembership } from "@/lib/safer-comparison";

export async function scanPublicAnalysis(live: GitHubAstSuccess, signal: AbortSignal): Promise<DetectionResult> {
  const result = await detectSecurityFindings(live.snapshot, new Map(Object.entries(live.contents)), sha256Text, { signal });
  if (!result.ok) return result;
  const trusted = { snapshotId: live.snapshot.snapshotId, commit: live.snapshot.resolvedCommitIfGitHub,
    files: live.snapshot.files, contents: live.contents, verified: true };
  // Independently bind every detector anchor to exact bytes, quote, line and hash.
  if (signal.aborted) return { ok: false, code: "CANCELLED", message: "Scan cancelled." };
  if (result.findings.some(f => !verifyFindingMembership(f, trusted).ok)) {
    return { ok: false, code: "EVIDENCE_INVALID", message: "Finding evidence failed validation." };
  }
  return result;
}
