import { z } from "zod";
import { BindingSchema, VerifiedFactsSchema, evidenceId, type PublicMuseBinding } from "@/lib/public-muse-contract";
export const META_MODEL = "muse-spark-1.3-contributor" as const;
export const META_PRIVACY = "meta-direct-bounded-source-v1" as const;
export const META_LIMITS = Object.freeze({ requestBytes: 4096, contextBytes: 2400, inputBytes: 4096,
  providerRequestBytes: 8192, responseBytes: 32768, outputBytes: 12000, maxInputTokens: 4096,
  maxOutputTokens: 2048, providerDeadlineMs: 20_000, routeDeadlineMs: 30_000, challengeTtlMs: 60_000 });
export const META_CAPS = Object.freeze({ requests: 10, microUsd: 1_000_000, requestMicroUsd: 100_000,
  concurrent: 2, perMinute: 6, preparations: 60 });
export const MetaRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare"), binding: BindingSchema }).strict(),
  z.object({ action: z.literal("explain"), binding: BindingSchema, challenge: z.string().regex(/^[a-f0-9]{64}$/),
    consentVersion: z.literal(META_PRIVACY) }).strict(),
]);
const prose = z.string().min(12).max(1800).refine(s =>
  !/[<>\x00-\x08\x0b-\x1f\x7f]|https?:|www\.|\[(?!E1\])|\b(?:confirmed|guaranteed|critical|exploitable)\b|\b\S+\.(?:tsx?|jsx?|py):?\d*\b|\bline\s+\d+/i.test(s));
export const MetaAnalysisSchema = z.object({ evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
  rule: BindingSchema.shape.rule, assessment: z.literal("potential"), summary: prose,
  reasoning: prose, review: z.array(prose).min(1).max(3), limitations: prose,
  citations: z.tuple([z.literal("E1")]) }).strict();
export type MetaAnalysis = z.infer<typeof MetaAnalysisSchema>;
export function parseMetaAnalysis(raw: unknown, b: PublicMuseBinding): MetaAnalysis {
  const result = MetaAnalysisSchema.parse(raw);
  if (result.evidenceId !== evidenceId(b) || result.rule !== b.rule || !/\bpotential\b/i.test(result.summary) ||
    !/\b(?:unconfirmed|unknown|cannot|not proven|does not prove)\b/i.test(result.limitations)) throw new Error("INVALID_OUTPUT");
  return result;
}
export const MetaPreparedSchema = z.object({ ok: z.literal(true), stage: z.literal("prepared"),
  evidenceId: z.string(), challenge: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int(),
  privacyVersion: z.literal(META_PRIVACY) }).strict();
export const MetaResultSchema = z.object({ ok: z.literal(true), stage: z.literal("explained"),
  binding: BindingSchema, facts: VerifiedFactsSchema, analysis: MetaAnalysisSchema,
  context: z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive(),
    text: z.string().max(META_LIMITS.contextBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  provenance: z.object({ provider: z.literal("Meta Direct Responses API"), model: z.literal(META_MODEL),
    status: z.literal("completed"), reasoningRequested: z.literal("medium"), reasoningVerified: z.literal(false),
    transport: z.enum(["offline-mock", "meta-direct"]),
    inputTokens: z.number().int().positive().max(META_LIMITS.maxInputTokens),
    outputTokens: z.number().int().positive().max(META_LIMITS.maxOutputTokens) }).strict(),
}).strict();
export type MetaResult = z.infer<typeof MetaResultSchema>;
