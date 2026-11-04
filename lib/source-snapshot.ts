/** Server compatibility entry: Node SHA-256 and synchronous strict validation. */
import { createHash } from "node:crypto";
import {
  createSourceSnapshotSchema, canonicalManifestInput, snapshotIdentityInput,
  areaForDigest, derivedCoverageForAreas, validateSnapshotBindings,
  type SourceSnapshot, type SnapshotFile, type SkippedFile, type CollectionPolicy,
} from "@/lib/source-snapshot-contract";
export * from "@/lib/source-snapshot-contract";

/** Short binding of the collection policy: different policy => different id. */
export function policyHashFor(policy: CollectionPolicy): string {
  return sha256Text(`e1-policy:${JSON.stringify(policy)}`).slice(0, 8);
}

/**
 * Deterministic coverage-area rendering (Finding C): skipped paths may be
 * up to 512 chars but `unsupportedAreas` entries cap at 256. Overlong paths
 * are explicitly truncated with a digest disambiguator — never dropped
 * (coverage loss) and never crashing validation. Long paths sharing a
 * retained prefix AND length still differ by digest; exact paths always
 * remain in `skipped`.
 */
export function areaFor(path: string): string {
  return areaForDigest(path, path.length <= 256 ? "" : sha256Hex(new TextEncoder().encode(path)));
}

/** Expected derived coverage for a file/skipped set (single source of truth). */
export function derivedCoverage(
  files: Array<{ language: "ts" | "tsx" }>,
  skipped: Array<{ path: string }>
): {
  supportedLanguages: Array<"ts" | "tsx">;
  unsupportedAreas: string[];
  unsupportedAreasTruncated: boolean;
} {
  return derivedCoverageForAreas(files, skipped.map(s => areaFor(s.path)));
}

/**
 * Collision-resistant snapshot identity (Finding D): the FULL manifest
 * digest bound to the required provenance/commit inputs — never an
 * abbreviated prefix claimed unique on its own. 7 + 64 = 71 chars, well
 * within P1's 128-char snapshot-ID contract.
 */
export function snapshotIdFor(
  sourceKind: "github" | "synthetic",
  canonicalProvenance: string,
  resolvedCommitIfGitHub: string | null,
  manifestHash: string
): string {
  return `${sourceKind}-${sha256Text(snapshotIdentityInput(sourceKind, canonicalProvenance, resolvedCommitIfGitHub, manifestHash))}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Deterministic manifest hash bound to policy + completeness + enumeration
 * + content. Different limits, different completeness, different enumeration
 * scope, or different partial coverage of the same commit all produce
 * different manifests.
 */
export function manifestHashFor(
  files: SnapshotFile[],
  skipped: SkippedFile[],
  policy: CollectionPolicy,
  complete: boolean,
  metadataEntries: number | null
): string {
  return sha256Text(canonicalManifestInput(files, skipped, policy, complete, metadataEntries));
}

/** Validate a snapshot against the v5 contract. Throws ZodError on failure. */
export function validateSnapshot(snapshot: unknown): SourceSnapshot {
  return SourceSnapshotSchema.parse(snapshot);
}

export const SourceSnapshotSchema = createSourceSnapshotSchema((s, ctx) => {
  validateSnapshotBindings(s, ctx, {
    manifestHash: manifestHashFor(s.files, s.skipped, s.coverage.collectionPolicy, s.coverage.complete, s.coverage.metadataEntries),
    identityHash: sha256Text(snapshotIdentityInput(s.sourceKind, s.canonicalProvenance, s.resolvedCommitIfGitHub, s.manifestHash)),
    areas: s.skipped.map(sk => areaFor(sk.path)),
  });
});
