/** Synthetic in-memory source only. No GitHub requests, private benchmarks or source execution.
 * Produces a fully typed, E1-schema-validated mock GitHub snapshot, including its
 * manifest, identity, policy and coverage. This models the detector's upstream trust.
 */
import {
  defaultPolicy, derivedCoverage, manifestHashFor, sha256Text, snapshotIdFor, SourceSnapshotSchema,
  type SourceSnapshot, type SnapshotFile,
} from "@/lib/source-snapshot";
import { sourceGeometry } from "@/lib/source-lines";
export function securityFixture(input: Record<string, string>, commit = "a".repeat(40)): SourceSnapshot {
  const files: SnapshotFile[] = Object.entries(input).map(([path, text]) => ({
    path, language: path.toLowerCase().endsWith(".tsx") ? "tsx" : "ts", bytes: new TextEncoder().encode(text).length,
    sha256: sha256Text(text), ...sourceGeometry(text),
  }));
  const policy = defaultPolicy(), canonicalProvenance = "https://github.com/example/offline-fixture";
  const manifestHash = manifestHashFor(files, [], policy, true, files.length);
  const snapshot: SourceSnapshot = {
    contractVersion: "e1-v5", sourceKind: "github", canonicalProvenance, resolvedCommitIfGitHub: commit,
    manifestHash, snapshotId: snapshotIdFor("github", canonicalProvenance, commit, manifestHash), files, skipped: [],
    coverage: { ...derivedCoverage(files, []), metadataEntries: files.length, collected: files.length,
      skippedCount: 0, totalBytes: files.reduce((n, f) => n + f.bytes, 0), complete: true, collectionPolicy: policy },
    collectedAt: "2026-10-01T00:00:00.000Z", // Fixed synthetic metadata, not a run timestamp.
  };
  return SourceSnapshotSchema.parse(snapshot);
}
