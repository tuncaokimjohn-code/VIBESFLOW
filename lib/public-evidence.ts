/** C014 offline projection. Never render detector excerpts/context or trust URLs from source. */
import type { GitHubAstSuccess } from "@/lib/github-ast-contract";
import type { SecurityFinding } from "@/lib/security-findings";
import { verifyFindingMembership } from "@/lib/safer-comparison";
import { rejectUnsafePathForApi } from "@/lib/source-snapshot-contract";
import { sourceLines } from "@/lib/source-lines";

const rules = {
  "VF-SEC-001": "Potential hardcoded credential",
  "VF-SEC-002": "Potential dynamic SQL construction",
  "VF-SEC-003": "Potential dynamic HTML",
} as const;
// Small genuine slice: only these exact anchor tokens can be disclosed. No
// arbitrary identifiers, literal values, comments or neighboring lines are shown.
const publicAnchors = new Set(["apiKey", "api_key", "password", "secret", "accessToken", "authToken", "db", "database", "pool", "connection", "conn", "client", "sql", "prisma", "knex", "html", "input", "content"]);
const privatePath = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]|(?:AKIA[0-9A-Z]{12,}|gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+|sk-[a-z0-9_-]{12,}|(?:synthetic|canary|password|secret|token|api[_-]?key)[=_-][a-z0-9_-]{8,})/i;
export type PublicEvidence =
  | { status: "verified"; rule: string; title: string; path: string | null; line: number; endLine: number; column: number; quote: string; quoteStatus: "exact" | "masked"; href: string | null; sha256: string; commit: string; snapshotId: string }
  | { status: "unavailable" | "invalid" | "unsupported"; message: string };

export function publicFindingEvidence(live: GitHubAstSuccess, finding: SecurityFinding): PublicEvidence {
  try {
    if (!Object.hasOwn(rules, finding.ruleId)) return { status: "unsupported", message: "Unsupported rule; no source citation is available." };
    const s = live.snapshot;
    if (!s.files.some(f => f.path === finding.path) || !Object.hasOwn(live.contents, finding.path))
      return { status: "unavailable", message: "Source evidence unavailable in the returned snapshot." };
    const commit = s.resolvedCommitIfGitHub;
    if (live.synthetic !== false || live.evidenceVerified !== true || live.shapeOk !== true || s.sourceKind !== "github" ||
        !commit || !/^[a-f0-9]{40}$/.test(commit) ||
        s.canonicalProvenance !== `https://github.com/${live.requested.owner}/${live.requested.repo}` ||
        !/^[a-z0-9_.-]+$/i.test(live.requested.owner) || !/^[a-z0-9_.-]+$/i.test(live.requested.repo) ||
        live.graph.snapshotId !== s.snapshotId || live.graph.resolvedCommitIfGitHub !== commit ||
        live.graph.canonicalProvenance !== s.canonicalProvenance || rejectUnsafePathForApi(finding.path) ||
        !verifyFindingMembership(finding, { snapshotId: s.snapshotId, commit, files: s.files, contents: live.contents, verified: true }).ok)
      return { status: "invalid", message: "Evidence validation failed; source quote and link withheld." };
    const source = live.contents[finding.path];
    const endLine = sourceLines(source.slice(0, finding.endCharOffset)).length;
    const path = privatePath.test(finding.path) ? null : finding.path;
    const exact = publicAnchors.has(finding.quote);
    return { status: "verified", rule: finding.ruleId, title: rules[finding.ruleId], path,
      line: finding.line, endLine, column: finding.column, sha256: finding.fileSha256, commit, snapshotId: s.snapshotId,
      quote: exact ? source.slice(finding.charOffset, finding.endCharOffset) : "[MASKED — private or unsupported anchor text]",
      quoteStatus: exact ? "exact" : "masked",
      href: path ? `${s.canonicalProvenance}/blob/${commit}/${path.split("/").map(p => encodeURIComponent(p).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/")}#L${finding.line}-L${endLine}` : null };
  } catch { return { status: "invalid", message: "Evidence validation failed; source quote and link withheld." }; }
}
