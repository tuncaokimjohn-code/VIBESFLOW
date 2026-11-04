/** Pure client/server evidence identity. This is integrity metadata, not authority. */
import { z } from "zod";
import { sha256SyncHex } from "@/lib/sha256-sync";
import type { SecurityFinding } from "@/lib/security-findings";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const EvidenceBindingSchema = z.strictObject({
  evidenceId: hash, findingId: z.string().min(1).max(512),
  snapshotId: z.string().min(1).max(160), path: z.string().min(1).max(512),
  line: z.number().int().positive(), column: z.number().int().positive(),
  quote: z.string().min(1).max(300), fileSha256: hash,
});
export type EvidenceBinding = z.infer<typeof EvidenceBindingSchema>;
export const OFFLINE_MOCK_LABEL = "OFFLINE MOCK — NO MUSE CALL";

export function bindFinding(f: SecurityFinding): EvidenceBinding {
  const data = { findingId: f.id, snapshotId: f.snapshotId, path: f.path,
    line: f.line, column: f.column, quote: f.quote, fileSha256: f.fileSha256 };
  return { evidenceId: sha256SyncHex(JSON.stringify(data)), ...data };
}
export function sameBinding(a: EvidenceBinding, b: EvidenceBinding): boolean {
  return (Object.keys(b) as Array<keyof EvidenceBinding>).every(key => a[key] === b[key]);
}
