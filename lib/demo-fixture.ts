/**
 * P8 C001 offline VibeShop demo fixture (VIBESHOP_DEMO_001).
 *
 * Controlled LOCAL fixture staged from the public VibeShop git checkout at
 * pinned commit 0d3a613f70dbb9df83c3dab57b671a2432bbb28c (46 git-tracked
 * *.ts/*.tsx files only). This is NEVER presented as a fetched GitHub
 * repository: sourceKind is "synthetic", resolvedCommitIfGitHub is null,
 * and the pinned public commit travels only as fixture metadata.
 *
 * Display safety: demo surfaces withhold raw source paths (opaque
 * Module-* tokens) and all excerpt/quote text. Raw provenance stays in
 * memory and in the JSON evidence report only — never in rendered markup.
 */
import {
  canonicalManifestInput, defaultPolicy, derivedCoverageForAreas, languageForPath,
  snapshotIdentityInput, type CollectionPolicy, type SnapshotFile, type SourceSnapshot,
} from "@/lib/source-snapshot-contract";
import { sourceGeometry } from "@/lib/source-lines";
import { sha256SyncHex } from "@/lib/sha256-sync";
import { graphToken } from "@/lib/graph-presentation";
import type { SecurityFinding } from "@/lib/security-findings";
import manifest from "@/fixture/vibeshop-manifest.json";
import contents from "@/fixture/vibeshop-contents.json";

/** Pinned public VibeShop commit the staged bytes were copied from. Fixture metadata only. */
export const FIXTURE_PINNED_COMMIT = "0d3a613f70dbb9df83c3dab57b671a2432bbb28c";
/** Honest synthetic provenance: a controlled local fixture, not a GitHub fetch. */
export const FIXTURE_PROVENANCE = "synthetic:controlled-local-fixture-vibeshop";
export const FIXTURE_LABEL = "Controlled local VibeShop fixture (offline)";
export const FIXTURE_COLLECTED_AT = "2026-11-01T00:00:00.000Z"; // Fixed fixture metadata, not a run timestamp.

export const NOT_FETCHED_NOTE =
  "NOT fetched from GitHub in this demo. No network was used: the 46 TypeScript sources below were staged " +
  "once from the public VibeShop checkout at its pinned commit and are bundled with this page.";
export const FIXTURE_VS_GITHUB_NOTE =
  "Fixture, not a live repository: snapshot sourceKind is synthetic, no GitHub resolution was performed, " +
  "and nothing here proves anything about the current upstream repository.";
export const MUSE_STATUS_NOTE =
  "Browser provider: null. Muse execution is operator-only. NOT CONFIGURED until a separately authorized local execution saves a validated result. " +
  "The browser retrieves that exact result without making a new provider call. Offline mocks are never published as real results.";
export const POTENTIAL_FINDINGS_NOTE =
  "Potential findings only (P5 heuristics) — not confirmed vulnerabilities. Ownership and admin " +
  "authorization are not analyzed.";

export interface FixtureManifestFile { path: string; bytes: number; sha256: string }
export interface FixtureManifest {
  fixture: string; pinnedCommit: string; scope: string;
  fileCount: number; totalBytes: number; files: FixtureManifestFile[];
}
export function fixtureManifest(): FixtureManifest {
  return manifest as FixtureManifest;
}
export function fixtureContents(): Record<string, string> {
  return contents as Record<string, string>;
}

/** Opaque display identity for a fixture path. Raw paths never reach demo markup. */
export function demoOpaqueFileId(path: string): string {
  return graphToken("Module", path);
}

/** Short file identity for demo metadata (hash prefix only, no source text). */
export function demoFileShaShort(finding: SecurityFinding): string {
  return finding.fileSha256.slice(0, 12);
}

/**
 * Render-safe finding card: location geometry + provenance metadata WITHOUT
 * the raw path, excerpt, quote, or anchor text. The raw finding object
 * retains full provenance in memory for detection/evidence only.
 */
export interface DemoFindingCard {
  id: string; ruleId: string; title: string; severity: string;
  line: number; column: number; fileToken: string; fileShaShort: string;
  snapshotId: string; commitLabel: string; limitations: string; recommendation: string;
}
export function demoFindingCard(f: SecurityFinding, index: number): DemoFindingCard {
  return {
    // Path-free demo identity: the raw P5 finding id embeds its source
    // path, so it must never reach demo markup. Selection state keeps
    // using the raw id in memory only (React keys, never rendered).
    id: `demo-${f.ruleId}-L${f.line}C${f.column}-${index}`,
    ruleId: f.ruleId, title: f.title, severity: f.severity,
    line: f.line, column: f.column, fileToken: demoOpaqueFileId(f.path),
    fileShaShort: demoFileShaShort(f), snapshotId: f.snapshotId,
    commitLabel: f.commit ?? `fixture@${FIXTURE_PINNED_COMMIT.slice(0, 12)}`,
    limitations: f.limitations, recommendation: f.recommendation,
  };
}

/**
 * Deterministic E1-valid synthetic snapshot over the staged fixture bytes.
 * Mirrors the P5 securityFixture construction (same contract functions),
 * bound to the fixture provenance. Throws when contents disagree with the
 * staged manifest (fail closed: no snapshot on tampered input).
 */
export const DEMO_SNAPSHOT_FAILURE = "Fixture snapshot unavailable; validation failed.";

/** Never expose exception details, including property getter failures. */
export function buildDemoSnapshot(input: Record<string, string>): SourceSnapshot {
  try {
    return buildValidatedDemoSnapshot(input);
  } catch {
    throw new Error(DEMO_SNAPSHOT_FAILURE);
  }
}

function buildValidatedDemoSnapshot(input: Record<string, string>): SourceSnapshot {
  const entries = Object.entries(input);
  if (entries.length !== (manifest as FixtureManifest).fileCount) {
    throw new Error(DEMO_SNAPSHOT_FAILURE);
  }
  const byPath = new Map((manifest as FixtureManifest).files.map((f) => [f.path, f]));
  const files: SnapshotFile[] = entries.map(([path, text]) => {
    const expected = byPath.get(path);
    const language = languageForPath(path);
    if (!expected || language === null) throw new Error(DEMO_SNAPSHOT_FAILURE);
    const bytes = new TextEncoder().encode(text).length;
    if (bytes !== expected.bytes || sha256SyncHex(text) !== expected.sha256) {
      throw new Error(DEMO_SNAPSHOT_FAILURE);
    }
    return { path, language, bytes, sha256: expected.sha256, ...sourceGeometry(text) };
  });
  const policy: CollectionPolicy = defaultPolicy();
  const manifestHash = sha256SyncHex(canonicalManifestInput(files, [], policy, true, files.length));
  const snapshotId = `synthetic-${sha256SyncHex(snapshotIdentityInput("synthetic", FIXTURE_PROVENANCE, null, manifestHash))}`;
  return {
    contractVersion: "e1-v5", sourceKind: "synthetic", canonicalProvenance: FIXTURE_PROVENANCE,
    resolvedCommitIfGitHub: null, manifestHash, snapshotId, files, skipped: [],
    coverage: {
      ...derivedCoverageForAreas(files, []), metadataEntries: files.length, collected: files.length,
      skippedCount: 0, totalBytes: files.reduce((n, f) => n + f.bytes, 0),
      complete: true, collectionPolicy: policy,
    },
    collectedAt: FIXTURE_COLLECTED_AT,
  } as SourceSnapshot;
}
