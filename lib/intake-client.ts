/** Browser receipt validation: native SHA-256, shared strict contracts, no intake implementation. */
import {
  createSourceSnapshotSchema, canonicalManifestInput, snapshotIdentityInput,
  areaForDigest, validateSnapshotBindings,
} from "@/lib/source-snapshot-contract";
import { createIntakeApiResponseSchema, malformedIntakeResponse, type IntakeApiResponse } from "@/lib/intake-contract";
export { receiptMatchesRequest } from "@/lib/intake-contract";
export type { SourceSnapshot } from "@/lib/source-snapshot-contract";

export async function sha256Text(text: string): Promise<string> {
  // Missing/rejecting Web Crypto is a validation failure, never a hash bypass.
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export const browserSnapshotSchema = createSourceSnapshotSchema(async (s, ctx) => {
  const [manifestHash, identityHash, areas] = await Promise.all([
    sha256Text(canonicalManifestInput(s.files, s.skipped, s.coverage.collectionPolicy, s.coverage.complete, s.coverage.metadataEntries)),
    sha256Text(snapshotIdentityInput(s.sourceKind, s.canonicalProvenance, s.resolvedCommitIfGitHub, s.manifestHash)),
    Promise.all(s.skipped.map(async sk => areaForDigest(sk.path, sk.path.length <= 256 ? "" : await sha256Text(sk.path)))),
  ]);
  validateSnapshotBindings(s, ctx, { manifestHash, identityHash, areas });
});
const responseSchema = createIntakeApiResponseSchema(browserSnapshotSchema);

/** Await cryptographic validation before using any receipt or displaying success. */
export async function parseIntakeResponse(payload: unknown): Promise<IntakeApiResponse> {
  try {
    const parsed = await responseSchema.safeParseAsync(payload);
    return parsed.success ? parsed.data : malformedIntakeResponse();
  } catch {
    return malformedIntakeResponse();
  }
}
