/** Pure browser/server contracts. No credentials, filesystem or network code. */
import { z } from "zod";
import { EvidenceBindingSchema, type EvidenceBinding } from "@/lib/muse-binding";
export const REAL_MUSE_LABEL = "REAL MUSE — AUTHORIZED LOCAL RESULT";
export const C034_MODEL = "muse-spark-1.3-contributor";
export const C034_CLAIMS = {
  "VF-SEC-001": {
    observation: ["The synthetic source assigns a non-placeholder string literal to a credential-like name.", "A credential-like name has a non-placeholder literal assignment in this synthetic fixture."],
    risk: ["This is a potential hardcoded-credential pattern; validity, exposure and usability are unconfirmed.", "A real credential in this pattern could be exposed through source; this synthetic value is not verified as a credential."],
    remediation: ["Use a server-side secret store or environment variable; rotate the value only if it is a real exposed credential.", "Keep real credentials outside source and review whether rotation is necessary if an actual exposure occurred."],
  },
  "VF-SEC-002": {
    observation: ["SQL-shaped text with dynamic string content reaches a database-named receiver in the synthetic fixture.", "The synthetic detector observes dynamic string content flowing into a SQL-shaped query on a database-named receiver."],
    risk: ["This is a potential SQL injection pattern; library identity, input trust and exploitability are unconfirmed.", "Query manipulation may be possible if the dynamic value is untrusted; sanitizer effectiveness and exploitability are unconfirmed."],
    remediation: ["Use parameterized queries with bound values and verify the actual database driver's placeholder syntax.", "Keep values separate from SQL text using bound parameters; review the database driver and remaining dynamic SQL."],
  },
  "VF-SEC-003": {
    observation: ["A dynamic value is supplied to dangerouslySetInnerHTML in the synthetic fixture.", "The synthetic detector observes dynamic dangerouslySetInnerHTML content."],
    risk: ["This is a potential XSS pattern; input trust, sanitizer effectiveness and exploitability are unconfirmed.", "HTML injection may be possible if the value is untrusted and insufficiently sanitized; actual exploitability is unconfirmed."],
    remediation: ["Prefer escaped React children, or review a vetted sanitizer before inserting HTML.", "Render text through React escaping where possible; otherwise review and test a vetted HTML sanitizer."],
  },
} as const;
export type SupportedRule = keyof typeof C034_CLAIMS;
export const C034_LIMITATION = "Controlled synthetic fixture only. Static observations do not confirm a vulnerability or validate a fix.";
export const ClaimsSchema = z.strictObject({ observation: z.string().max(512), risk: z.string().max(512),
  remediation: z.string().max(512), limitations: z.literal(C034_LIMITATION) });
export type Claims = z.infer<typeof ClaimsSchema>;
export function validateClaims(value: unknown, rule: SupportedRule): Claims {
  const c = ClaimsSchema.parse(value), allowed = C034_CLAIMS[rule];
  for (const k of ["observation", "risk", "remediation"] as const)
    if (!(allowed[k] as readonly string[]).includes(c[k])) throw new Error("Unsupported provider claim");
  return c;
}
export const explanationText = (c: Claims) => `${c.observation}\n\n${c.risk}\n\n${c.remediation}\n\n${c.limitations}`;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ReceiptSchema = z.strictObject({ responseId: z.string().regex(/^resp_[A-Za-z0-9_-]{1,120}$/),
  model: z.literal(C034_MODEL), requestedEffort: z.literal("medium"),
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(2400), totalTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reasoningTokens: z.number().int().nonnegative().max(2400).nullable(),
}).refine(r => r.totalTokens === r.inputTokens + r.outputTokens && (r.reasoningTokens === null || r.reasoningTokens <= r.outputTokens));
export const SavedResultSchema = z.strictObject({ version: z.literal("c034-result-v1"),
  mode: z.enum(["provider-response", "offline-mock"]), binding: EvidenceBindingSchema,
  requestSha256: hash, candidateManifestSha256: hash, authorizationId: z.string().regex(/^[a-f0-9]{32}$/),
  generatedAt: z.iso.datetime(), ruleId: z.enum(["VF-SEC-001", "VF-SEC-002", "VF-SEC-003"]),
  claims: ClaimsSchema, receipt: ReceiptSchema,
});
export type SavedResult = z.infer<typeof SavedResultSchema>;
export type RealMuseSuccess = { ok: true; explanation: string; citations: Array<{ findingId: string; path: string; line: number; column: number; quote: string }>;
  verified: true; potential: true; providerLabel: typeof REAL_MUSE_LABEL; mode: "provider-response"; mock: false;
  binding: EvidenceBinding; requestSha256: string; generatedAt: string; receipt: z.infer<typeof ReceiptSchema> };
