import "server-only";
import { PublicGitHubRestProvider } from "@/lib/github-public-server";
import { buildRepoUrl, type GitHubApiFetch } from "@/lib/github-provider";
import { runGitHubToAst } from "@/lib/github-ast-server";
import { detectSecurityFindings } from "@/lib/security-findings";
import { sha256Text } from "@/lib/source-snapshot";
import { verifyFindingMembership } from "@/lib/safer-comparison";
import { analysisStatus } from "@/lib/github-ast-contract";
import { BindingSchema, VerifiedFactsSchema, bindingFor, evidenceId, type PublicMuseBinding, type VerifiedFacts } from "@/lib/public-muse-contract";

/** Explicit anonymous public visibility check, including when ref is already pinned.
 * No runtime GitHub credential reader and no authenticated retry path. */
class AnonymousPublicProvider extends PublicGitHubRestProvider {
  constructor(fetchFn: GitHubApiFetch) {
    super({ fetchFn, readPublicToken: () => undefined, requestTimeoutMs: 3000, maxTreeEntries: 200 });
  }
  override async resolveRef(owner: string, repo: string, ref: string | null, signal: AbortSignal) {
    const meta = await this.getJson(buildRepoUrl(owner, repo), signal, "Public visibility");
    if (!meta || typeof meta !== "object" || !("full_name" in meta) || meta.full_name !== `${owner}/${repo}`) throw new Error("SOURCE_REJECTED");
    const pinned = await super.resolveRef(owner, repo, ref, signal);
    if (pinned.sha !== ref) throw new Error("SOURCE_REJECTED");
    return pinned;
  }
}

/** Re-fetch and redetect on BOTH prepare and explain. Nothing from the client
 * establishes membership. All source stays local to this call and is discarded. */
export async function verifyPublicMuseSource(binding: PublicMuseBinding, fetchFn: GitHubApiFetch, signal: AbortSignal): Promise<VerifiedFacts> {
  return (await verifyPublicMuseSourceEvidence(binding, fetchFn, signal)).facts;
}

const verifiedEvidence = new WeakSet<object>();
export interface VerifiedPublicMuseEvidence {
  readonly binding: PublicMuseBinding;
  readonly facts: VerifiedFacts;
  readonly source: string;
}
export function isVerifiedPublicMuseEvidence(value: VerifiedPublicMuseEvidence): boolean {
  return verifiedEvidence.has(value);
}
/** Server-only source capture, branded only after the same immutable checks.
 * Raw text must pass the separate context sanitizer before provider dispatch. */
export async function verifyPublicMuseSourceEvidence(binding: PublicMuseBinding, fetchFn: GitHubApiFetch, signal: AbortSignal): Promise<VerifiedPublicMuseEvidence> {
  const b = BindingSchema.parse(binding);
  const anonymous: GitHubApiFetch = async (url, init) => {
    const response = await fetchFn(url, {
      ...init, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    } as typeof init);
    if (response.headers.get("set-cookie") !== null) throw new Error("SOURCE_REJECTED");
    return response;
  };
  const source = await runGitHubToAst({ owner: b.owner, repo: b.repo, ref: b.commit,
    provider: new AnonymousPublicProvider(anonymous), signal });
  // Intake completeness is mandatory. Architecture support is a different
  // boundary: unmodeled exports/imports cannot invalidate independently parsed
  // detector evidence elsewhere. Malformed files still fail scanComplete below.
  if (!source.ok || !source.evidenceVerified || !source.shapeOk || source.snapshot.resolvedCommitIfGitHub !== b.commit ||
    !source.snapshot.coverage.complete) throw new Error("SOURCE_REJECTED");
  const scan = await detectSecurityFindings(source.snapshot, source.contents, sha256Text, { signal });
  if (!scan.ok || !scan.scanComplete || scan.findingLimitReached || scan.malformedFiles.length) throw new Error("SOURCE_REJECTED");
  const matches = scan.findings.filter(f => evidenceId(bindingFor(b.owner, b.repo, f)) === evidenceId(b));
  if (matches.length !== 1 || !verifyFindingMembership(matches[0], {
    snapshotId: source.snapshot.snapshotId, commit: b.commit, files: source.snapshot.files,
    contents: source.contents, verified: true,
  }).ok) throw new Error("SOURCE_REJECTED");
  signal.throwIfAborted();
  const facts = Object.freeze(VerifiedFactsSchema.parse({ evidenceId: evidenceId(b), rule: b.rule, findingVerified: true,
    intakeComplete: true, detectorScanComplete: true, collectedFiles: source.snapshot.files.length,
    skippedEntries: source.snapshot.skipped.length, unsupportedForms: source.graph.unsupportedForms.length,
    unsupportedModules: source.graph.unsupportedModules.length, unresolvedEdges: source.graph.unresolved.length,
    architectureCoverage: analysisStatus(source.snapshot, source.graph), repositorySecurityCoverage: "partial" }));
  const result = Object.freeze({ binding: Object.freeze(b), facts, source: source.contents.get(b.path)! });
  verifiedEvidence.add(result);
  return result;
}
