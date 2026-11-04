/** Public-import boundary only. Never shares the protected /api/explain contract. */
import { z } from "zod";
import { rejectUnsafePathForApi } from "@/lib/source-snapshot-contract";
import { sha256SyncHex } from "@/lib/sha256-sync";
import type { SecurityFinding } from "@/lib/security-findings";

export const PUBLIC_MUSE_MODEL = "meta/muse-spark-1.3-contributor" as const;
export const PRIVACY_VERSION = "public-muse-sanitized-v1" as const;
export const PUBLIC_MUSE_LIMITS = Object.freeze({
  requestBytes: 4096, gatewayBytes: 8192, inputBytes: 2048,
  maxInputTokens: 4096, maxOutputTokens: 384, deadlineMs: 15_000,
  gatewayDeadlineMs: 5000, bodyDeadlineMs: 2000, challengeTtlMs: 60_000,
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/).refine(s => s !== "." && s !== "..");
export const RuleSchema = z.enum(["VF-SEC-001", "VF-SEC-002", "VF-SEC-003"]);
export const BindingSchema = z.object({
  owner: name, repo: name, commit: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.string().min(1).max(512).refine(p => !p.includes("%") && !rejectUnsafePathForApi(p)),
  rule: RuleSchema, fileSha256: digest, quoteSha256: digest,
  line: z.number().int().min(1).max(65_536), column: z.number().int().min(1).max(524_288),
  charOffset: z.number().int().min(0).max(524_288), endCharOffset: z.number().int().min(1).max(524_288),
  byteOffset: z.number().int().min(0).max(524_288), endByteOffset: z.number().int().min(1).max(524_288),
}).strict();
export type PublicMuseBinding = z.infer<typeof BindingSchema>;
export function bindingFor(owner: string, repo: string, f: SecurityFinding): PublicMuseBinding {
  return BindingSchema.parse({ owner, repo, commit: f.commit, path: f.path, rule: f.ruleId,
    fileSha256: f.fileSha256, quoteSha256: sha256SyncHex(f.quote), line: f.line, column: f.column,
    charOffset: f.charOffset, endCharOffset: f.endCharOffset, byteOffset: f.byteOffset, endByteOffset: f.endByteOffset });
}
export function evidenceId(b: PublicMuseBinding): string {
  // Parse fixes property order and rejects extensions before hashing.
  return sha256SyncHex(JSON.stringify(BindingSchema.parse(b)));
}
export const PublicMuseRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare"), binding: BindingSchema }).strict(),
  z.object({ action: z.literal("explain"), binding: BindingSchema,
    challenge: z.string().regex(/^[a-f0-9]{64}$/), consentVersion: z.literal(PRIVACY_VERSION) }).strict(),
]);

// The model may select only these bounded claims. No arbitrary prose, links,
// HTML, source text, or assertions about exploitability can reach the UI.
export const ALLOWED_CLAIMS = {
  "VF-SEC-001": [
    "A credential-like name is assigned a non-placeholder literal in the parsed source.",
    "This may be a test value; credential validity and exposure are unconfirmed.",
    "Review whether a secret manager is appropriate; rotate only if a real credential was exposed.",
  ],
  "VF-SEC-002": [
    "Dynamic SQL-shaped string content reaches a database-named receiver in the parsed source.",
    "Input trust, library identity and sanitizer effectiveness are unconfirmed.",
    "Review parameterized queries with bound values for this location.",
  ],
  "VF-SEC-003": [
    "A dynamic value reaches dangerouslySetInnerHTML in the parsed source.",
    "Input trust and sanitizer effectiveness are unconfirmed.",
    "Review escaped React children or a vetted HTML sanitizer for this location.",
  ],
} as const;
export const ModelOutputSchema = z.object({ evidenceId: digest, rule: RuleSchema,
  assessment: z.literal("potential"), claims: z.array(z.string().max(180)).min(2).max(3),
  citations: z.tuple([z.literal("E1")]),
}).strict();
export type ModelOutput = z.infer<typeof ModelOutputSchema>;
export function validModelOutput(raw: unknown, b: PublicMuseBinding): ModelOutput | null {
  const p = ModelOutputSchema.safeParse(raw);
  if (!p.success || p.data.evidenceId !== evidenceId(b) || p.data.rule !== b.rule ||
    new Set(p.data.claims).size !== p.data.claims.length ||
    !p.data.claims.includes(ALLOWED_CLAIMS[b.rule][0]) || !p.data.claims.includes(ALLOWED_CLAIMS[b.rule][1]) ||
    !p.data.claims.every(c => (ALLOWED_CLAIMS[b.rule] as readonly string[]).includes(c))) return null;
  return p.data;
}
/** Server derives this record only after source verification and re-detection.
 * These counts describe captured TS/TSX and architecture gaps, never all security
 * behavior. No identifiers, source, quotes, literals or untrusted text belong here. */
const count = z.number().int().min(0).max(50_000);
export const VerifiedFactsSchema = z.object({
  evidenceId: digest, rule: RuleSchema, findingVerified: z.literal(true),
  intakeComplete: z.literal(true), detectorScanComplete: z.literal(true),
  collectedFiles: z.number().int().min(1).max(100), skippedEntries: count,
  unsupportedForms: count, unsupportedModules: count, unresolvedEdges: count,
  architectureCoverage: z.enum(["complete", "partial"]),
  repositorySecurityCoverage: z.literal("partial"),
}).strict().refine(f => f.architectureCoverage === "partial" ||
  f.skippedEntries + f.unsupportedForms + f.unsupportedModules + f.unresolvedEdges === 0);
export type VerifiedFacts = z.infer<typeof VerifiedFactsSchema>;

const NARRATIVE_RULES = {
  "VF-SEC-001": {
    observation: "a credential-like name is assigned a non-placeholder string literal of at least eight characters",
    significance: "If this value authenticates a real service, distributing source can distribute access. A synthetic or test value can match the same heuristic.",
    review: ["Check privately whether the value is synthetic or authenticates a service; do not paste it into an explanation request.",
      "For a real credential, use server-side secret storage. Rotate and review source history only if actual exposure is established."],
    uncertainty: "The detector does not validate credentials, reachability, permissions or exposure. It does not contact the named service.",
  },
  "VF-SEC-002": {
    observation: "SQL-shaped text with dynamic content reaches a database-named receiver",
    significance: "If an untrusted value becomes executable SQL text, it can change query meaning. Receiver names and SQL-shaped text alone do not establish a database library or injection.",
    review: ["Trace the dynamic value to its origin and confirm the actual query API and its binding semantics.",
      "Keep SQL structure constant and pass values through that API's parameter binding; check escaping and query tests at this location."],
    uncertainty: "Only bounded earlier same-block const aliases are followed (at most four hops); no cross-function or cross-module taint analysis, input-trust or sanitizer proof is performed.",
  },
  "VF-SEC-003": {
    observation: "a dynamic __html value reaches React's dangerouslySetInnerHTML attribute",
    significance: "This attribute interprets HTML rather than escaped text. Untrusted unsanitized HTML can introduce script-capable markup; the static pattern alone does not prove that condition.",
    review: ["Trace the HTML value to its origin and inspect any sanitizer and configuration; do not assume a function name proves sanitization.",
      "Use escaped React children for plain text. If HTML is required, apply a vetted HTML sanitizer and test malicious markup at this boundary."],
    uncertainty: "Only inline objects and bounded earlier same-block const aliases are inspected. Input trust, sanitizer effectiveness and runtime behavior remain unconfirmed.",
  },
} as const;
export const GroundedNarrativeSchema = z.object({
  origin: z.literal("deterministic-verified-facts"), modelRole: z.literal("offline-claim-selection-only"),
  facts: VerifiedFactsSchema, summary: z.string().max(400), significance: z.string().max(400),
  review: z.tuple([z.string().max(400), z.string().max(400)]),
  limitations: z.tuple([z.string().max(500), z.string().max(500), z.string().max(500)]),
  citations: z.tuple([z.literal("E1")]),
}).strict();
/** No free-form model prose is accepted. Every sentence comes from validated
 * rule/geometry/counts plus fixed bounded templates. E1 binds to the enclosing
 * result.binding, including immutable commit, hashes and all anchor geometry. */
export function composeGroundedNarrative(binding: PublicMuseBinding, rawFacts: VerifiedFacts): z.infer<typeof GroundedNarrativeSchema> {
  const b = BindingSchema.parse(binding), facts = VerifiedFactsSchema.parse(rawFacts);
  if (facts.evidenceId !== evidenceId(b) || facts.rule !== b.rule) throw new Error("NARRATIVE_BINDING_REJECTED");
  const rule = NARRATIVE_RULES[b.rule];
  return GroundedNarrativeSchema.parse({
    origin: "deterministic-verified-facts", modelRole: "offline-claim-selection-only", facts,
    summary: `Potential static finding at line ${b.line}, column ${b.column}: ${rule.observation}. [E1]`,
    significance: rule.significance, review: [...rule.review],
    limitations: [rule.uncertainty,
      `Complete bounded intake and detector traversal covered ${facts.collectedFiles} collected TS/TSX file(s). Architecture coverage: ${facts.architectureCoverage}; ${facts.unsupportedForms} unsupported form(s), ${facts.unsupportedModules} unsupported module(s), ${facts.unresolvedEdges} unresolved edge(s), ${facts.skippedEntries} skipped entry/entries.`,
      "E1 verifies this selected static pattern only. Unsupported/skipped source and other security behavior remain outside coverage. Ownership/IDOR and admin authorization are not implemented. No whole-repository safety, exploitability, precision or recall claim follows."],
    citations: ["E1"],
  });
}
export const PreparedSchema = z.object({ ok: z.literal(true), stage: z.literal("prepared"),
  evidenceId: digest, challenge: digest, expiresAt: z.number().int(),
  privacyVersion: z.literal(PRIVACY_VERSION), mock: z.literal(true),
}).strict();
export const ResultSchema = z.object({ ok: z.literal(true), stage: z.literal("explained"),
  binding: BindingSchema, output: ModelOutputSchema, narrative: GroundedNarrativeSchema,
  provenance: z.object({ gateway: z.literal("Vercel AI Gateway"), requestedModel: z.literal(PUBLIC_MUSE_MODEL),
    returnedModel: z.literal(PUBLIC_MUSE_MODEL), requestedReasoning: z.literal("medium"),
    reasoningVerified: z.literal(false), liveVerified: z.literal(false), transport: z.literal("offline-mock"),
  }).strict(), mock: z.literal(true),
}).strict();
export type PublicMuseResult = z.infer<typeof ResultSchema>;
export function parsePublicMuseResult(raw: unknown, b: PublicMuseBinding): PublicMuseResult | null {
  const p = ResultSchema.safeParse(raw);
  if (!p.success || evidenceId(p.data.binding) !== evidenceId(b) || !validModelOutput(p.data.output, b)) return null;
  try {
    return JSON.stringify(p.data.narrative) === JSON.stringify(composeGroundedNarrative(b, p.data.narrative.facts)) ? p.data : null;
  } catch { return null; }
}
