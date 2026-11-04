/**
 * P1 compatibility adapter (P3 Candidate 003, Finding C).
 *
 * PRODUCTION PORTABILITY: this module is fully self-contained — it imports
 * nothing outside Candidate 003. The P1 shape it targets is replicated here
 * as a local structural validator (`P1SnapshotSchema`) mirroring the frozen
 * P1 constraints; conformance with the REAL frozen P1 contract is proven by
 * the test suite, which imports `p1_candidates/RUNTIME_IMPORT_FIX_010`
 * read-only (test-time only, never production). Frozen P1 is never modified.
 *
 * Lossless where possible, explicit where not:
 * - files transfer exactly (path/language/bytes/sha256/lineCount/offsets).
 * - provenance, snapshot identity stem, commit, and manifest MEANING are
 *   preserved; the adapted manifest is RECOMPUTED over the adapted form so
 *   it authenticates the transformed data (never a copied P3 hash), while
 *   the original P3 manifest is returned alongside for traceability.
 * - skip reasons outside P1's closed enum map explicitly AND emit warnings
 *   (never silent discarding). Synthetic snapshots are adapter-ineligible.
 */
import { z } from "zod";
import { sha256Text, SourceSnapshotSchema, type P3SkipReason, type SourceSnapshot as P3Snapshot } from "@/lib/source-snapshot";

/**
 * Frozen-P1 path rule replica (mirrors P1 `isSafeRelativePath`): relative
 * POSIX, no escapes. Kept in sync by cross-validation tests against the real
 * P1 validator — production never imports P1.
 */
export function isP1SafeRelativePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return false;
  if (p.includes("\\")) return false;
  if (p.indexOf("\x00") !== -1) return false;
  if (p.startsWith("/") || p.startsWith("./")) return false;
  if (/^\s|\s$/.test(p)) return false;
  const parts = p.split("/");
  for (const seg of parts) {
    if (seg === "" || seg === "." || seg === "..") return false;
    for (let i = 0; i < seg.length; i++) {
      const code = seg.charCodeAt(i);
      if (code < 32 || code === 127) return false;
    }
  }
  return true;
}

const P1FileSchema = z
  .object({
    path: z.string().refine(isP1SafeRelativePath, "file.path must be a safe relative POSIX path"),
    language: z.enum(["ts", "tsx"]),
    bytes: z.number().int().min(0),
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
    lineCount: z.number().int().min(1),
    lineStartOffsets: z.array(z.number().int().min(0)),
  })
  .superRefine((f, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
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

const P1SkipReasonSchema = z.enum([
  "unsupported-language",
  "binary",
  "oversized",
  "symlink",
  "traversal-blocked",
  "depth-limit",
  "entry-limit",
  "timeout",
  "other",
]);

export type P1SkipReason = z.infer<typeof P1SkipReasonSchema>;

const P1SnapshotSchema = z
  .object({
    sourceKind: z.enum(["github", "zip"]),
    snapshotId: z.string().min(1).max(128),
    canonicalProvenance: z.string().min(1).max(512),
    resolvedCommitIfGitHub: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    manifestHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
    files: z.array(P1FileSchema),
    skipped: z.array(z.object({ path: z.string().min(1).max(512), reason: P1SkipReasonSchema })),
    coverage: z.object({
      supportedLanguages: z
        .array(z.string())
        .min(1)
        .refine((langs) => langs.every((l) => (["ts", "tsx"] as readonly string[]).includes(l)), {
          message: "snapshot.coverage.supportedLanguages must be a non-empty subset of [ts, tsx]",
        }),
      unsupportedAreas: z.array(z.string().min(1).max(256)),
    }),
    collectedAt: z.string().datetime(),
  })
  .superRefine((s, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (s.sourceKind === "github") {
      // Mirror frozen P1 exactly: canonical shape AND no `.git` suffix.
      // Incompatible provenance is rejected, never silently rewritten —
      // stripping `.git` would change repository identity.
      if (
        !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.canonicalProvenance) ||
        s.canonicalProvenance.endsWith(".git")
      ) {
        issue("snapshot.canonicalProvenance must be canonical https://github.com/<owner>/<repo>");
      }
      if (s.resolvedCommitIfGitHub === undefined) {
        issue("snapshot.resolvedCommitIfGitHub must be a full 40-char commit SHA");
      }
    } else {
      // Mirror frozen P1 ZIP rules exactly (Finding B, 009): a commit must
      // be absent for zip snapshots, and zip provenance must start with
      // "zip:". This changes nothing about intake scope — the adapter
      // boundary still accepts github snapshots only; the replica simply
      // stops being looser than P1 on zip-shaped inputs.
      if (s.resolvedCommitIfGitHub !== undefined) {
        issue("snapshot.resolvedCommitIfGitHub must be absent for zip snapshots");
      }
      if (!s.canonicalProvenance.startsWith("zip:")) {
        issue('snapshot.canonicalProvenance for zip must start with "zip:"');
      }
    }
    if (s.files.length + s.skipped.length < 1) {
      issue("snapshot must contain at least one file or one skipped entry");
    }
    const seen = new Set<string>();
    s.files.forEach((f) => {
      if (seen.has(f.path)) issue("files path is duplicated: " + f.path);
      seen.add(f.path);
    });
  });

export type P1Snapshot = z.infer<typeof P1SnapshotSchema>;

/** Validate an unknown value against the local P1-shape replica. */
export function validateP1Shape(input: unknown): { valid: boolean; errors: string[] } {
  const parsed = P1SnapshotSchema.safeParse(input);
  if (parsed.success) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: parsed.error.issues.map((i) => `p1.${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`),
  };
}

const REASON_MAP: Record<P3SkipReason, { reason: P1SkipReason; lossy: boolean }> = {
  "unsupported-language": { reason: "unsupported-language", lossy: false },
  binary: { reason: "binary", lossy: false },
  oversized: { reason: "oversized", lossy: false },
  symlink: { reason: "symlink", lossy: false },
  // No P1 equivalent: mapped explicitly and reported in warnings.
  submodule: { reason: "other", lossy: true },
  "traversal-blocked": { reason: "traversal-blocked", lossy: false },
  "depth-limit": { reason: "depth-limit", lossy: false },
  "entry-limit": { reason: "entry-limit", lossy: false },
  "size-limit": { reason: "other", lossy: true },
  timeout: { reason: "timeout", lossy: false },
  cancelled: { reason: "timeout", lossy: true },
  "not-found": { reason: "other", lossy: true },
  other: { reason: "other", lossy: false },
};

/** Adapter-bound manifest over the TRANSFORMED representation. */
export function adapterManifestHash(
  files: Array<{ path: string; bytes: number; language: string; lineCount: number; lineStartOffsets: number[]; sha256: string }>,
  skipped: Array<{ path: string; reason: string }>
): string {
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return sha256Text(
    JSON.stringify({
      v: "p1-adapter/e1-v5",
      files: [...files].sort(byPath),
      skipped: [...skipped].sort(byPath),
    })
  );
}

export type P1AdapterResult =
  | { ok: true; snapshot: P1Snapshot; warnings: string[]; p3ManifestHash: string }
  | { ok: false; errors: string[] };

/**
 * Adapt a P3 e1-v5 snapshot to the P1 shape. Validates P3 input first
 * (typed errors, never throws), then validates the adapted output against
 * the local P1-shape replica.
 */
export function toP1SourceSnapshot(input: unknown): P1AdapterResult {
  const parsed = SourceSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `p3.${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`),
    };
  }
  const s: P3Snapshot = parsed.data;
  if (s.contractVersion !== "e1-v5") {
    return { ok: false, errors: ['adapter: unsupported contractVersion (expected "e1-v5")'] };
  }
  if (s.sourceKind !== "github") {
    return { ok: false, errors: ["adapter: only github snapshots are P1-compatible (synthetic has no P1 kind)"] };
  }
  if (s.resolvedCommitIfGitHub === null) {
    return { ok: false, errors: ["adapter: github snapshots require a full 40-hex commit SHA"] };
  }
  const warnings: string[] = [];
  if (!s.coverage.complete) {
    warnings.push("adapter: source coverage is incomplete; P1 shape carries no completeness flag");
  }
  const skipped = s.skipped.map((sk) => {
    const mapped = REASON_MAP[sk.reason];
    if (mapped.lossy) warnings.push(`adapter: lossy skip-reason mapping ${sk.reason}->${mapped.reason} for ${sk.path}`);
    return { path: sk.path, reason: mapped.reason };
  });
  // Unsupported areas come from the P3 DERIVED coverage labels (Finding D,
  // 007), never raw skipped paths: raw paths run to 512 chars but frozen
  // P1 caps areas at 256. The derived labels are deterministic, already
  // ≤256, and digest-disambiguated. Exact skipped paths are preserved
  // verbatim in skipped[] (P1 allows 512 there); areas are summaries.
  // Truncation beyond 100 areas is disclosed here AND in warnings — the
  // adapter never claims a complete or lossless P1 representation.
  const unsupportedAreas = [...s.coverage.unsupportedAreas];
  if (s.coverage.unsupportedAreasTruncated) {
    warnings.push(
      `adapter: lossy areas mapping — P3 records ${s.skipped.length} skipped entries but P1 carries only the first 100 derived area summaries; exact paths preserved in skipped[]`
    );
  }
  const candidate = {
    sourceKind: "github" as const,
    snapshotId: s.snapshotId,
    canonicalProvenance: s.canonicalProvenance,
    resolvedCommitIfGitHub: s.resolvedCommitIfGitHub,
    manifestHash: adapterManifestHash(s.files, skipped),
    files: s.files.map((f) => ({
      path: f.path,
      language: f.language,
      bytes: f.bytes,
      sha256: f.sha256,
      lineCount: f.lineCount,
      lineStartOffsets: f.lineStartOffsets,
    })),
    skipped,
    coverage: {
      supportedLanguages:
        Array.from(new Set(s.files.map((f) => f.language))).sort().length > 0
          ? Array.from(new Set(s.files.map((f) => f.language))).sort()
          : ["ts", "tsx"],
      unsupportedAreas,
    },
    collectedAt: s.collectedAt,
  };
  const check = validateP1Shape(candidate);
  if (!check.valid) return { ok: false, errors: check.errors };
  return { ok: true, snapshot: candidate, warnings, p3ManifestHash: s.manifestHash };
}
