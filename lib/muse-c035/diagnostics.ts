/** Bounded operator-only diagnostics. Never copy exception messages or bodies. */
import "server-only";
import { z } from "zod";
import { ReceiptSchema } from "@/lib/muse-c034-contract";
export const StageSchema = z.enum(["CONFIGURATION", "AUTHORIZATION", "CANDIDATE_INTEGRITY", "EVIDENCE", "RESERVATION", "TRANSPORT", "PROVIDER_RESPONSE", "SCHEMA_VALIDATION", "RESULT_STORAGE", "COMPLETE"]);
export type Stage = z.infer<typeof StageSchema>;
export class DiagnosticFailure extends Error {
  constructor(readonly stage: Stage, readonly code: string) { super("Muse output withheld; no retry is permitted."); }
}
const IO_CODES = ["EACCES", "EPERM", "EIO", "ENOSPC", "EDQUOT", "EROFS", "EEXIST", "ENOENT", "ENOTDIR", "ELOOP", "EMFILE", "ENFILE", "EINVAL"] as const;
export const safeIoCode = (error: unknown): typeof IO_CODES[number] | "OTHER" => {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return IO_CODES.includes(code as typeof IO_CODES[number]) ? code as typeof IO_CODES[number] : "OTHER";
};
export class LocalIoFailure extends DiagnosticFailure {
  readonly ioCode;
  constructor(stage: Stage, operation: string, readonly created: boolean, error: unknown) {
    super(stage, `${stage}_${operation}_FAILED`); this.ioCode = safeIoCode(error);
  }
}
export const OutcomeSchema = z.strictObject({
  version: z.literal("c035-outcome-v1"), mode: z.enum(["provider-response", "offline-mock"]),
  ok: z.boolean(), stage: StageSchema, code: z.string().regex(/^[A-Z0-9_]{1,96}$/),
  ioCode: z.enum([...IO_CODES, "OTHER"]).optional(),
  authorizationId: z.string().regex(/^[a-f0-9]{32}$/),
  candidateManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/), evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.iso.datetime(), requestStarted: z.boolean(),
  httpStatus: z.number().int().min(100).max(599).optional(), responseBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  bodyComplete: z.boolean(), receipt: ReceiptSchema.optional(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;
export type ResponseFacts = { httpStatus?: number; responseBytes: number; bodyComplete: boolean; receipt?: z.infer<typeof ReceiptSchema> };
