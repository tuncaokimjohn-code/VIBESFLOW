/**
 * E1 SourceSnapshot contract v5 — `e1-v5` (P3 Candidate 006).
 *
 * Changes vs e1-v2 (see finding matrix in evidence):
 * - CollectionPolicy extended to EVERY effective selection limit
 *   (metadata entries, transfer bytes, skipped entries, deadline,
 *   binary-probe window). Wire-level body caps are excluded by design
 *   (documented below) since they never affect selection.
 * - Manifest binds policy + complete flag + content + coverage.
 * - `validateMetaEntry` validates provider metadata BEFORE any sort,
 *   dereference, or read (Finding F).
 * - `locateByteOffset` strict locator: rejects negative, non-integer,
 *   past-EOF, and interior-of-character offsets (Finding H).
 * - P1 shape alignment kept (languages `ts|tsx`, lineCount + byte
 *   lineStartOffsets, canonical provenance, required commit).
 */
import { z } from "zod";
import { sourceGeometry } from "@/lib/source-lines";

export const E1_CONTRACT_VERSION = "e1-v5" as const;

export const E1_LIMITS = {
  /** Wire-level request-body cap. Excluded from identity: never selects files. */
  maxRequestBodyBytes: 64 * 1024,
  /** Maximum provider metadata entries enumerated. */
  maxMetadataEntries: 2000,
  /** Per-file byte cap. Files above this are skipped, never truncated. */
  maxFileBytes: 512 * 1024,
  /** Aggregate bytes actually transferred (read) across one intake. */
  maxTotalTransferredBytes: 16 * 1024 * 1024,
  /** Aggregate collected source bytes across one snapshot. */
  maxTotalBytes: 8 * 1024 * 1024,
  /** Maximum collected files per snapshot. */
  maxFiles: 500,
  /** Maximum skipped entries recorded per snapshot. */
  maxSkippedEntries: 2000,
  /** Maximum path depth (segments) accepted. */
  maxPathDepth: 20,
  /** Overall intake deadline (ms) unless overridden per call. */
  defaultDeadlineMs: 120_000,
  /** Bytes inspected for binary detection (NUL scan + UTF-8 validity). */
  binaryProbeBytes: 8192,
} as const;

export interface CollectionPolicy {
  version: typeof E1_CONTRACT_VERSION;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxDepth: number;
  maxMetadataEntries: number;
  maxTotalTransferredBytes: number;
  maxSkippedEntries: number;
  deadlineMs: number;
  binaryProbeBytes: number;
}

export function defaultPolicy(deadlineMs: number = E1_LIMITS.defaultDeadlineMs): CollectionPolicy {
  return {
    version: E1_CONTRACT_VERSION,
    maxFileBytes: E1_LIMITS.maxFileBytes,
    maxTotalBytes: E1_LIMITS.maxTotalBytes,
    maxFiles: E1_LIMITS.maxFiles,
    maxDepth: E1_LIMITS.maxPathDepth,
    maxMetadataEntries: E1_LIMITS.maxMetadataEntries,
    maxTotalTransferredBytes: E1_LIMITS.maxTotalTransferredBytes,
    maxSkippedEntries: E1_LIMITS.maxSkippedEntries,
    deadlineMs,
    binaryProbeBytes: E1_LIMITS.binaryProbeBytes,
  };
}

/** P1 language identifiers. TS/TSX only. */
const LANGUAGE_BY_EXT: Record<string, "ts" | "tsx"> = {
  ".ts": "ts",
  ".tsx": "tsx",
};

export const P3_SKIP_REASONS = [
  "unsupported-language",
  "binary",
  "oversized",
  "symlink",
  "submodule",
  "traversal-blocked",
  "depth-limit",
  "entry-limit",
  "size-limit",
  "timeout",
  "cancelled",
  "not-found",
  "other",
] as const;

export type P3SkipReason = (typeof P3_SKIP_REASONS)[number];

export type EntryKind = "file" | "symlink" | "submodule" | "other";

export interface FileMeta {
  path: string;
  /** Provider-declared byte size. UNTRUSTED: only gates pre-read skips. */
  size: number;
  kind?: EntryKind;
  /** Provider file mode (git "120000" symlink, "160000" gitlink). */
  mode?: string;
}

/**
 * Validate one provider metadata entry BEFORE sorting, dereferencing, or
 * reading (Finding F). Nulls, wrong types, and schema-violating shapes
 * become typed intake errors, never exceptions or silent entries.
 */
export function validateMetaEntry(entry: unknown): { ok: true; meta: FileMeta } | { ok: false; error: string } {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { ok: false, error: "metadata entry must be an object" };
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.path !== "string" || e.path.length === 0 || e.path.length > 512) {
    return { ok: false, error: "metadata entry path must be a 1-512 char string" };
  }
  if (typeof e.size !== "number" || !Number.isFinite(e.size) || e.size < 0 || Math.floor(e.size) !== e.size) {
    return { ok: false, error: `metadata entry size must be a non-negative integer: ${e.path}` };
  }
  if (e.kind !== undefined && e.kind !== "file" && e.kind !== "symlink" && e.kind !== "submodule" && e.kind !== "other") {
    return { ok: false, error: `metadata entry kind is unsupported: ${e.path}` };
  }
  if (e.mode !== undefined && typeof e.mode !== "string") {
    return { ok: false, error: `metadata entry mode must be a string: ${e.path}` };
  }
  return { ok: true, meta: { path: e.path, size: e.size, kind: e.kind as EntryKind | undefined, mode: e.mode as string | undefined } };
}

/**
 * Snapshot-safe path for skipped entries: schema requires 1-512 chars, so
 * empty originals get an explicit placeholder (never silently dropped).
 */
export function skippedPathFor(path: string): string {
  if (path.length === 0) return "(empty-path)";
  return path.length > 512 ? path.slice(0, 512) : path;
}

const SnapshotFileSchema = z
  .object({
    path: z.string().min(1).max(512),
    language: z.enum(["ts", "tsx"]),
    bytes: z.number().int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    lineCount: z.number().int().min(1),
    lineStartOffsets: z.array(z.number().int().min(0)),
  })
  .strict()
  .superRefine((f, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (rejectUnsafePathForApi(f.path) !== null) {
      issue("file.path must be a safe relative path");
    }
    const lower = f.path.toLowerCase();
    const extOk =
      f.language === "tsx" ? lower.endsWith(".tsx") : lower.endsWith(".ts") && !lower.endsWith(".tsx");
    if (!extOk) {
      issue("file.language must match the path extension");
    }
    if (f.lineStartOffsets.length !== f.lineCount) {
      issue("file.lineStartOffsets length must equal lineCount");
      return;
    }
    if (f.lineStartOffsets[0] !== 0) issue("file.lineStartOffsets must start at 0");
    for (const offset of f.lineStartOffsets) {
      if (offset > f.bytes) {
        issue("file.lineStartOffsets must not exceed file.bytes");
        break;
      }
    }
    for (let i = 1; i < f.lineStartOffsets.length; i++) {
      if ((f.lineStartOffsets[i] as number) <= (f.lineStartOffsets[i - 1] as number)) {
        issue("file.lineStartOffsets must be strictly increasing");
        break;
      }
    }
  });

const SkippedFileSchema = z
  .object({
    path: z.string().min(1).max(512),
    reason: z.enum(P3_SKIP_REASONS),
  })
  .strict()
  .superRefine((s, ctx) => {
    // Safe syntax for skipped entries (Finding C): traversal, absolute,
    // separators, and controls are rejected — but depth is EXEMPT, so a
    // legitimate depth-limit skip records its real over-deep path.
    if (rejectUnsafePathSyntax(s.path) !== null) {
      ctx.addIssue({ code: "custom", message: "skipped.path must be a safe relative path" });
    }
  });

const CollectionPolicySchema = z.strictObject({
  version: z.literal(E1_CONTRACT_VERSION),
  maxFileBytes: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
  maxFiles: z.number().int().positive(),
  maxDepth: z.number().int().positive(),
  maxMetadataEntries: z.number().int().positive(),
  maxTotalTransferredBytes: z.number().int().positive(),
  maxSkippedEntries: z.number().int().positive(),
  deadlineMs: z.number().int().positive(),
  binaryProbeBytes: z.number().int().positive(),
  // NOTE (Finding C deliberation): no static cross-limit contradiction rule.
  // A small transfer cap with a large file cap is NOT contradictory — caps
  // compose dynamically (only small files get admitted). Consistency is
  // enforced per-snapshot instead: collected/skipped/depth/totals are
  // validated against the effective policy in the snapshot superRefine
  // below, so an inconsistent COLLECTION is rejected even though no static
  // policy pair is declared contradictory.
});

const SourceSnapshotShapeSchema = z
  .object({
    contractVersion: z.literal(E1_CONTRACT_VERSION),
    sourceKind: z.enum(["github", "synthetic"]),
    snapshotId: z.string().min(1).max(128),
    canonicalProvenance: z.string().min(1).max(512),
    resolvedCommitIfGitHub: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
    files: z.array(SnapshotFileSchema),
    skipped: z.array(SkippedFileSchema),
    coverage: z
      .object({
        supportedLanguages: z.array(z.enum(["ts", "tsx"])),
        unsupportedAreas: z.array(z.string().min(1).max(256)),
        // The 100-entry areas list is a SUMMARY, never exhaustive:
        // unsupportedAreasTruncated is true when skipped paths exceed it.
        unsupportedAreasTruncated: z.boolean(),
        // Provider enumeration count. Null when there was no provider
        // enumeration (synthetic receipts). Never claim unobserved counts.
        metadataEntries: z.number().int().nonnegative().nullable(),
        collected: z.number().int().nonnegative(),
        skippedCount: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
        complete: z.boolean(),
        collectionPolicy: CollectionPolicySchema,
      })
      .strict(),
    collectedAt: z.string().datetime(),
  });

export function createSourceSnapshotSchema(checkBindings: (s: SourceSnapshot, ctx: z.RefinementCtx) => void | Promise<void>) {
  return SourceSnapshotShapeSchema.superRefine((s, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (s.sourceKind === "github") {
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.canonicalProvenance)) {
        issue("snapshot.canonicalProvenance must be canonical https://github.com/<owner>/<repo>");
      }
      if (s.resolvedCommitIfGitHub === null) {
        issue("snapshot.resolvedCommitIfGitHub must be a full 40-char commit SHA for github snapshots");
      }
    } else {
      if (s.resolvedCommitIfGitHub !== null) {
        issue("snapshot.resolvedCommitIfGitHub must be null for synthetic snapshots");
      }
      if (!s.canonicalProvenance.startsWith("synthetic:")) {
        issue('snapshot.canonicalProvenance for synthetic must start with "synthetic:"');
      }
    }
    if (s.files.length + s.skipped.length < 1) issue("snapshot must contain at least one file or one skipped entry");
    const seen = new Set<string>();
    for (const f of s.files) {
      if (seen.has(f.path)) issue("files path is duplicated: " + f.path);
      seen.add(f.path);
    }
    // Skipped paths must be unique and disjoint from collected paths.
    const seenSkipped = new Set<string>();
    for (const sk of s.skipped) {
      if (seenSkipped.has(sk.path)) issue("skipped path is duplicated: " + sk.path.slice(0, 64));
      seenSkipped.add(sk.path);
      if (seen.has(sk.path)) issue("path is both collected and skipped: " + sk.path.slice(0, 64));
    }
    // Effective-policy bounds: the collection must fit the policy it claims.
    const policy = s.coverage.collectionPolicy;
    const totalBytes = s.files.reduce((n, f) => n + f.bytes, 0);
    if (s.files.length > policy.maxFiles) issue("files.length exceeds collectionPolicy.maxFiles");
    for (const f of s.files) {
      if (f.bytes > policy.maxFileBytes) {
        issue(`file exceeds collectionPolicy.maxFileBytes: ${f.path.slice(0, 64)}`);
      }
    }
    if (totalBytes > policy.maxTotalBytes) issue("collected bytes exceed collectionPolicy.maxTotalBytes");
    if (totalBytes > policy.maxTotalTransferredBytes) {
      issue("collected bytes exceed collectionPolicy.maxTotalTransferredBytes");
    }
    if (s.skipped.length > policy.maxSkippedEntries) {
      issue("skipped.length exceeds collectionPolicy.maxSkippedEntries");
    }
    if (s.coverage.metadataEntries !== null) {
      if (s.files.length + s.skipped.length > s.coverage.metadataEntries) {
        issue("collected + skipped entries exceed recorded metadataEntries");
      }
      if (s.coverage.metadataEntries > policy.maxMetadataEntries) {
        issue("metadataEntries exceeds collectionPolicy.maxMetadataEntries");
      }
    }
    // Depth applies to COLLECTED paths only. Skipped paths are exempt by
    // design: a legitimate depth-limit skip records an over-deep path, and
    // rejecting it would destroy the honest coverage record. Skipped paths
    // still satisfy the schema's own 1–512 char bounds. Traversal and
    // unsafe syntax are never permitted in collected files (file rule).
    for (const f of s.files) {
      if (f.path.split("/").length > policy.maxDepth) {
        issue("collected path exceeds collectionPolicy.maxDepth: " + f.path.slice(0, 64));
        break;
      }
    }
    // metadataEntries is an OBSERVED input (not derived): validated above
    // by the files+skipped ≤ metadataEntries and policy-cap bounds.
    if (s.coverage.collected !== s.files.length) issue("coverage.collected must equal files.length");
    if (s.coverage.skippedCount !== s.skipped.length) issue("coverage.skippedCount must equal skipped.length");
    if (s.coverage.totalBytes !== totalBytes) {
      issue("coverage.totalBytes must equal the sum of file bytes");
    }
  }).superRefine(checkBindings);
}

export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;
export type SkippedFile = z.infer<typeof SkippedFileSchema>;
export type SourceSnapshot = z.infer<typeof SourceSnapshotShapeSchema>;

/**
 * Canonical synthetic provenance (Finding D): deterministic, unambiguous,
 * shared by parser, builder, API, and client. Slashes separate the fixed
 * segments (owner/repo cannot contain them), and the ref tail is either
 * `default` (null ref — default-resolution intent) or `ref/<ref>` (a branch
 * literally named "default" becomes `ref/default`, never colliding).
 * `a-b/c@…` and `a/b-c@…` can never produce the same string.
 */
export function canonicalSyntheticProvenance(owner: string, repo: string, ref: string | null): string {
  const tail = ref === null ? "default" : `ref/${ref}`;
  return `synthetic:github.com/${owner}/${repo}@${tail}`;
}

/**
 * Wire-level path guard for API payloads (Finding F): same rule family as
 * the intake collector (traversal, absolute, separators, control chars,
 * depth, blank segments), fixed to E1 limits. Forged response payloads
 * carrying unsafe paths are rejected before use.
 */
export function rejectUnsafePathForApi(path: string): string | null {
  const syntax = rejectUnsafePathSyntax(path);
  if (syntax !== null) return syntax;
  if (path.split("/").length > E1_LIMITS.maxPathDepth) return "max-depth";
  return null;
}

/**
 * Syntax-only path guard (Finding C): traversal, absolute, separators,
 * control chars, blank/dot segments, and length — but NO depth cap. Used
 * for skipped entries, which may legitimately record over-deep paths
 * (depth-limit skips) while still proving safe syntax. Collected files
 * keep the full guard including depth.
 */
export function rejectUnsafePathSyntax(path: string): string | null {
  if (path.length === 0 || path.length > 512) return "path-length";
  if (path.startsWith("/") || path.includes("\\")) return "absolute-or-separator";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control-chars";
  for (const seg of path.split("/")) {
    if (seg.length === 0 || seg === "." || seg === "..") return "traversal";
  }
  return null;
}

/**
 * Split exact source bytes into line geometry (offsets are BYTE offsets
 * into the hashed bytes). Terminators: LF, CRLF, CR, U+2028, U+2029.
 * BOM preserved via ignoreBOM; empty file = one empty line; trailing
 * terminator opens a final empty line at EOF.
 */
export function splitSourceLines(bytes: Uint8Array): {
  text: string;
  lineCount: number;
  lineStartOffsets: number[];
} {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return { text, ...sourceGeometry(text) };
}

/** True when the extension is a supported source language. */
export function languageForPath(path: string): "ts" | "tsx" | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return LANGUAGE_BY_EXT[path.slice(dot).toLowerCase()] ?? null;
}

/**
 * Binary probe: NUL byte in the head window, or bytes that fail strict
 * UTF-8 decode. Conservative — undecodable input is skipped, never coerced.
 */
export function isBinaryContent(bytes: Uint8Array, probeBytes: number = E1_LIMITS.binaryProbeBytes): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, probeBytes));
  for (const b of head) {
    if (b === 0x00) return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return true;
  }
  return false;
}

/** UTF-8 byte length of the first `charIndex` UTF-16 code units of text. */
export function bytesForCharIndex(text: string, charIndex: number): number {
  return new TextEncoder().encode(text.slice(0, Math.max(0, charIndex))).length;
}

/**
 * Convert a byte offset to a UTF-16 character index (TypeScript's native
 * position unit). Offsets are byte-exact; characters are TS-exact.
 */
export function byteOffsetToCharIndex(text: string, byteOffset: number): number {
  const enc = new TextEncoder();
  let bytes = 0;
  let i = 0;
  while (i < text.length && bytes < byteOffset) {
    const ch = String.fromCodePoint(text.codePointAt(i) as number);
    bytes += enc.encode(ch).length;
    i += ch.length;
  }
  return i;
}

/**
 * Strict byte-offset locator (Finding H).
 *
 * Coordinates: offsets are 0-based BYTES into the file; `line` is 1-based;
 * `character` is a 0-based UTF-16 code-unit offset within the line (the
 * TypeScript convention), NOT a byte offset and NOT a character count.
 *
 * Rejects: negative, non-integer, past-EOF offsets, and offsets landing
 * inside a multibyte character (INTERIOR) — a citation must point at a
 * real character boundary.
 */
export type OffsetLocation =
  | { ok: true; line: number; character: number }
  | { ok: false; code: "NEGATIVE" | "NON_INTEGER" | "PAST_EOF" | "INTERIOR" };

export function locateByteOffset(
  text: string,
  lineStartOffsets: number[],
  byteOffset: number,
  totalBytes: number
): OffsetLocation {
  if (!Number.isInteger(byteOffset)) return { ok: false, code: "NON_INTEGER" };
  if (byteOffset < 0) return { ok: false, code: "NEGATIVE" };
  if (byteOffset > totalBytes) return { ok: false, code: "PAST_EOF" };
  const charIndex = byteOffsetToCharIndex(text, byteOffset);
  if (bytesForCharIndex(text, charIndex) !== byteOffset) {
    return { ok: false, code: "INTERIOR" };
  }
  let line = 1;
  for (let i = 0; i < lineStartOffsets.length; i++) {
    if ((lineStartOffsets[i] as number) <= byteOffset) line = i + 1;
    else break;
  }
  const lineStartChar = byteOffsetToCharIndex(text, lineStartOffsets[line - 1] as number);
  return { ok: true, line, character: charIndex - lineStartChar };
}

/** Lenient 1-based {line, character} position (legacy convenience). */
export function lineColForByteOffset(
  text: string,
  lineStartOffsets: number[],
  byteOffset: number
): { line: number; character: number } {
  const located = locateByteOffset(text, lineStartOffsets, byteOffset, Number.POSITIVE_INFINITY);
  if (located.ok) return { line: located.line, character: located.character };
  let line = 1;
  for (let i = 0; i < lineStartOffsets.length; i++) {
    if ((lineStartOffsets[i] as number) <= byteOffset) line = i + 1;
    else break;
  }
  return { line, character: 0 };
}

/**
 * Canonical JSON for manifest binding (sorted files/skipped + policy +
 * completeness + recorded enumeration count). The enumeration count is an
 * identity-relevant field: the same content reached through different
 * enumeration scopes binds a different manifest.
 */
export function canonicalManifestInput(
  files: SnapshotFile[],
  skipped: SkippedFile[],
  policy: CollectionPolicy,
  complete: boolean,
  metadataEntries: number | null
): string {
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return JSON.stringify({
    v: E1_CONTRACT_VERSION,
    policy,
    complete,
    enumerated: metadataEntries,
    files: [...files].sort(byPath).map((f) => ({
      bytes: f.bytes,
      language: f.language,
      lineCount: f.lineCount,
      lineStartOffsets: f.lineStartOffsets,
      path: f.path,
      sha256: f.sha256,
    })),
    skipped: [...skipped].sort(byPath).map((s) => ({ path: s.path, reason: s.reason })),
  });
}


/** Hash inputs and comparisons shared verbatim by Node and Web Crypto adapters. */
export function snapshotIdentityInput(
  sourceKind: "github" | "synthetic", canonicalProvenance: string,
  resolvedCommitIfGitHub: string | null, manifestHash: string
): string {
  return sourceKind === "github"
    ? `${canonicalProvenance}|${resolvedCommitIfGitHub ?? ""}|${manifestHash}`
    : `${canonicalProvenance}|${manifestHash}`;
}

export function areaForDigest(path: string, digest: string): string {
  return path.length <= 256 ? path : `${path.slice(0, 200)}…${digest.slice(0, 16)}[${path.length}]`;
}

export function derivedCoverageForAreas(files: Array<{ language: "ts" | "tsx" }>, areas: string[]) {
  const languages = Array.from(new Set(files.map(f => f.language))).sort();
  const unique = Array.from(new Set(areas)).sort();
  return {
    supportedLanguages: languages.length > 0 ? languages : (["ts", "tsx"] as Array<"ts" | "tsx">),
    unsupportedAreas: unique.slice(0, 100),
    unsupportedAreasTruncated: unique.length > 100,
  };
}

export function validateSnapshotBindings(s: SourceSnapshot, ctx: z.RefinementCtx,
  digests: { manifestHash: string; identityHash: string; areas: string[] }): void {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  // Derived coverage must match: languages, areas, and the truncation
  // flag are computed, not free text.
  const expected = derivedCoverageForAreas(s.files, digests.areas);
  if (JSON.stringify([...s.coverage.supportedLanguages].sort()) !== JSON.stringify(expected.supportedLanguages)) {
    issue("coverage.supportedLanguages must equal the derived file languages");
  }
  if (JSON.stringify(s.coverage.unsupportedAreas) !== JSON.stringify(expected.unsupportedAreas)) {
    issue("coverage.unsupportedAreas must equal the derived skipped paths");
  }
  if (s.coverage.unsupportedAreasTruncated !== expected.unsupportedAreasTruncated) {
    issue("coverage.unsupportedAreasTruncated must equal the derived truncation flag");
  }
  // The manifest binds identity to policy + completeness + content: a
  // forged or stale manifestHash never validates.
  if (s.manifestHash !== digests.manifestHash) {
    issue("snapshot.manifestHash does not match policy-bound content");
  }
  // The snapshot ID must equal the expected binding — not merely satisfy
  // a length cap. Identity comparison uses this full digest downstream.
  if (
    s.snapshotId !==
    `${s.sourceKind}-${digests.identityHash}`
  ) {
    issue("snapshot.snapshotId does not match the provenance/commit/manifest binding");
  }
}
