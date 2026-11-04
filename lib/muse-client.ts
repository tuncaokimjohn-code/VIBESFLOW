/**
 * Client-side P6 response handling (C004-02): monotonic request
 * generations plus RUNTIME validation of server responses. A response
 * is never accepted on a type assertion, and citations are only ever
 * displayed as verified after this validation binds them to the
 * active finding.
 */
import { z } from "zod";
import type { ExplanationOutcome } from "@/lib/muse-contract";
import { EvidenceBindingSchema, OFFLINE_MOCK_LABEL, sameBinding, type EvidenceBinding } from "@/lib/muse-binding";
import { REAL_MUSE_LABEL, ReceiptSchema } from "@/lib/muse-c034-contract";

const SuccessSchema = z.strictObject({
    ok: z.literal(true),
    explanation: z.string().min(1).max(8_000),
    citations: z.array(z.strictObject({
      findingId: z.string().min(1), path: z.string().min(1),
      line: z.number().int().positive(), column: z.number().int().positive(),
      quote: z.string().min(1).max(300),
    })).min(1).max(8),
    verified: z.literal(true),
    providerLabel: z.string().min(1).max(120),
    potential: z.literal(true),
  });
export const ExplanationResponseSchema = z.union([
  SuccessSchema,
  SuccessSchema.extend({ mode: z.literal("provider-response"), mock: z.literal(false),
    providerLabel: z.literal(REAL_MUSE_LABEL), binding: EvidenceBindingSchema,
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/), generatedAt: z.iso.datetime(), receipt: ReceiptSchema,
  }),
  SuccessSchema.extend({ mode: z.literal("offline-mock"), mock: z.literal(true),
    providerLabel: z.literal(OFFLINE_MOCK_LABEL), binding: EvidenceBindingSchema,
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
  }),
]);

/** Parse + bind a response to the active finding. Null = do not publish. */
export function parseExplanationResponse(payload: unknown, activeFindingId: string, binding?: EvidenceBinding): ExplanationOutcome | null {
  const checked = ExplanationResponseSchema.safeParse(payload);
  if (!checked.success) return null;
  const data = checked.data as ExplanationOutcome;
  if (data.ok && data.citations.some((c) => c.findingId !== activeFindingId)) return null;
  if (data.ok && binding) {
    if (!("mock" in data) || !sameBinding(data.binding, binding) || data.citations.length !== 1) return null;
    const c = data.citations[0];
    if (c.path !== binding.path || c.line !== binding.line || c.column !== binding.column || c.quote !== binding.quote) return null;
  }
  return data;
}

/** Monotonic generation guard: only the latest generation may publish. */
export function createGenerationGuard() {
  let generation = 0;
  return {
    next(): number { return ++generation; },
    invalidate(): void { generation++; },
    isCurrent(token: number): boolean { return token === generation; },
    current(): number { return generation; },
  };
}
