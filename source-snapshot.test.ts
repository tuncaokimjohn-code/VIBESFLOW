/**
 * UNIT: v3 contract, byte-exact line geometry (H), strict locator (H),
 * metadata validation (F), policy-bound identity (D).
 */
import { describe, expect, it } from "vitest";
import {
  byteOffsetToCharIndex,
  bytesForCharIndex,
  defaultPolicy,
  derivedCoverage,
  isBinaryContent,
  languageForPath,
  lineColForByteOffset,
  canonicalSyntheticProvenance,
  locateByteOffset,
  manifestHashFor,
  policyHashFor,
  rejectUnsafePathForApi,
  sha256Hex,
  skippedPathFor,
  snapshotIdFor,
  splitSourceLines,
  validateMetaEntry,
  validateSnapshot,
  type SkippedFile,
  type SnapshotFile,
} from "@/lib/source-snapshot";

const enc = new TextEncoder();
const AT = "2026-10-28T00:00:00.000Z";

function file(overrides: Partial<SnapshotFile> & { path: string }): SnapshotFile {
  const bytes = overrides.bytes ?? 3;
  return {
    language: "ts",
    sha256: sha256Hex(enc.encode("abc")),
    lineCount: 1,
    lineStartOffsets: [0],
    ...overrides,
    bytes,
  } as SnapshotFile;
}

function validSnapshot(files: SnapshotFile[], skipped: SkippedFile[] = [], complete = true) {
  const policy = defaultPolicy();
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  const provenance = "https://github.com/acme/api";
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const manifestHash = manifestHashFor(files, skipped, policy, complete, files.length + skipped.length);
  const derived = derivedCoverage(files, skipped);
  return {
    contractVersion: "e1-v5" as const,
    sourceKind: "github" as const,
    snapshotId: snapshotIdFor("github", provenance, commit, manifestHash),
    canonicalProvenance: provenance,
    resolvedCommitIfGitHub: commit,
    manifestHash,
    files,
    skipped,
    coverage: {
      supportedLanguages: derived.supportedLanguages,
      unsupportedAreas: derived.unsupportedAreas,
      unsupportedAreasTruncated: derived.unsupportedAreasTruncated,
      metadataEntries: files.length + skipped.length,
      collected: files.length,
      skippedCount: skipped.length,
      totalBytes,
      complete,
      collectionPolicy: policy,
    },
    collectedAt: AT,
  };
}

describe("splitSourceLines — preserved byte mapping (Finding H)", () => {
  it("handles LF/CRLF/CR/LS/PS, multibyte, empty, trailing newline, BOM", () => {
    expect(splitSourceLines(enc.encode("ab\ncde\n"))).toMatchObject({ lineCount: 3, lineStartOffsets: [0, 3, 7] });
    expect(splitSourceLines(enc.encode("ab\r\ncd"))).toMatchObject({ lineCount: 2, lineStartOffsets: [0, 4] });
    expect(splitSourceLines(enc.encode("ab\rcd"))).toMatchObject({ lineCount: 2, lineStartOffsets: [0, 3] });
    expect(splitSourceLines(new Uint8Array(0))).toMatchObject({ lineCount: 1, lineStartOffsets: [0] });
    expect(splitSourceLines(enc.encode("é\nx"))).toMatchObject({ lineCount: 2, lineStartOffsets: [0, 3] });
    const bom = splitSourceLines(new Uint8Array([0xef, 0xbb, 0xbf, 0x78, 0x0a]));
    expect(bom.text.charCodeAt(0)).toBe(0xfeff);
    expect(bom).toMatchObject({ lineCount: 2, lineStartOffsets: [0, 5] });
  });
  it("splits actual U+2028/U+2029 separators written as escapes (Finding G)", () => {
    // Source text uses \uXXXX escapes (safe: no invisible literals), which
    // decode to the real separators at runtime.
    const text = "ab\u2028cd\u2029ef";
    expect(text.charCodeAt(2)).toBe(0x2028);
    expect(text.charCodeAt(5)).toBe(0x2029);
    const bytes = enc.encode(text);
    expect(bytes.length).toBe(2 + 3 + 2 + 3 + 2);
    expect(splitSourceLines(bytes)).toMatchObject({ lineCount: 3, lineStartOffsets: [0, 5, 10] });
  });
  it("throws on invalid UTF-8", () => {
    expect(() => splitSourceLines(new Uint8Array([0xff, 0xfe]))).toThrow();
  });
});

describe("locateByteOffset — strict locator (Finding H)", () => {
  const text = "ab\ncde\n"; // bytes 7
  const offsets = [0, 3, 7];
  it("locates exact boundaries: 0-based bytes, 1-based line, 0-based TS chars", () => {
    expect(locateByteOffset(text, offsets, 0, 7)).toEqual({ ok: true, line: 1, character: 0 });
    expect(locateByteOffset(text, offsets, 4, 7)).toEqual({ ok: true, line: 2, character: 1 });
    expect(locateByteOffset(text, offsets, 7, 7)).toEqual({ ok: true, line: 3, character: 0 });
  });
  it("rejects negative, non-integer, past-EOF offsets", () => {
    expect(locateByteOffset(text, offsets, -1, 7)).toMatchObject({ ok: false, code: "NEGATIVE" });
    expect(locateByteOffset(text, offsets, 1.5, 7)).toMatchObject({ ok: false, code: "NON_INTEGER" });
    expect(locateByteOffset(text, offsets, 8, 7)).toMatchObject({ ok: false, code: "PAST_EOF" });
  });
  it("rejects interior-of-character offsets", () => {
    const t2 = "é\nx"; // bytes C3 A9 0A 78
    expect(locateByteOffset(t2, [0, 3], 1, 4)).toMatchObject({ ok: false, code: "INTERIOR" });
    expect(locateByteOffset(t2, [0, 3], 2, 4)).toEqual({ ok: true, line: 1, character: 1 });
  });
  it("byte/char helpers round-trip", () => {
    expect(bytesForCharIndex("é\nx", 1)).toBe(2);
    expect(byteOffsetToCharIndex("é\nx", 2)).toBe(1);
    expect(lineColForByteOffset(text, offsets, 4)).toEqual({ line: 2, character: 1 });
  });
});

describe("validateMetaEntry + skippedPathFor (Finding F)", () => {
  it("accepts well-formed entries", () => {
    expect(validateMetaEntry({ path: "src/a.ts", size: 10, kind: "file" })).toMatchObject({
      ok: true, meta: { path: "src/a.ts", size: 10, kind: "file" },
    });
    expect(validateMetaEntry({ path: "x", size: 0 })).toMatchObject({ ok: true });
  });
  it("rejects null, arrays, non-objects, missing/invalid fields", () => {
    expect(validateMetaEntry(null).ok).toBe(false);
    expect(validateMetaEntry([]).ok).toBe(false);
    expect(validateMetaEntry("x").ok).toBe(false);
    expect(validateMetaEntry({}).ok).toBe(false);
    expect(validateMetaEntry({ path: "", size: 1 }).ok).toBe(false);
    expect(validateMetaEntry({ path: "a.ts", size: -1 }).ok).toBe(false);
    expect(validateMetaEntry({ path: "a.ts", size: 1.5 }).ok).toBe(false);
    expect(validateMetaEntry({ path: "a.ts", size: NaN }).ok).toBe(false);
    expect(validateMetaEntry({ path: "a.ts", size: 1, kind: "weird" }).ok).toBe(false);
    expect(validateMetaEntry({ path: "a.ts", size: 1, mode: 120000 }).ok).toBe(false);
  });
  it("skipped paths stay schema-compatible", () => {
    expect(skippedPathFor("")).toBe("(empty-path)");
    expect(skippedPathFor("a".repeat(600))).toHaveLength(512);
    expect(skippedPathFor("src/a.ts")).toBe("src/a.ts");
  });
});

describe("nested strict invariants, one guard at a time (Finding C)", () => {
  // Mutate exactly one aspect of a valid snapshot, then recompute the
  // manifest + identity bindings so failure proves the INTENDED guard —
  // never an unrelated hash mismatch.
  const mutateValid = (mut: (s: ReturnType<typeof validSnapshot>) => void): unknown => {
    const base = validSnapshot([file({ path: "a.ts" })]);
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    mut(clone);
    clone.manifestHash = manifestHashFor(clone.files, clone.skipped, clone.coverage.collectionPolicy, clone.coverage.complete, clone.coverage.metadataEntries);
    clone.snapshotId = snapshotIdFor(clone.sourceKind, clone.canonicalProvenance, clone.resolvedCommitIfGitHub, clone.manifestHash);
    return clone;
  };
  const expectGuard = (v: unknown, part: string): void => {
    try {
      validateSnapshot(v);
    } catch (err) {
      expect(String(err)).toContain(part);
      return;
    }
    expect.unreachable(`expected guard to fire: ${part}`);
  };
  it("rejects unknown keys in nested file/skipped/coverage/policy objects", () => {
    expectGuard(mutateValid((s) => { (s.files[0] as Record<string, unknown>).extra = 1; }), "file");
    expectGuard(
      mutateValid((s) => {
        s.skipped.push({ path: "b.js", reason: "unsupported-language" });
        (s.skipped[0] as Record<string, unknown>).extra = 1;
        s.coverage.skippedCount = 1;
      }),
      "skipped"
    );
    expectGuard(
      mutateValid((s) => { (s.coverage as Record<string, unknown>).extra = 1; }),
      "coverage"
    );
    expectGuard(
      mutateValid((s) => { ((s.coverage.collectionPolicy as unknown) as Record<string, unknown>).extra = 1; }),
      "collectionPolicy"
    );
  });
  it("rejects extension-language mismatch", () => {
    expectGuard(
      mutateValid((s) => { s.files[0].language = "tsx"; }),
      "language"
    );
  });
  it("rejects unsafe collected file paths", () => {
    expectGuard(
      mutateValid((s) => { s.files[0].path = "../evil.ts"; }),
      "safe relative"
    );
  });
  it("rejects duplicate skipped paths and collected/skipped overlap", () => {
    expectGuard(
      mutateValid((s) => {
        s.skipped.push({ path: "b.js", reason: "unsupported-language" });
        s.skipped.push({ path: "b.js", reason: "binary" } as unknown as (typeof s.skipped)[number]);
        s.coverage.skippedCount = 2;
      }),
      "duplicated"
    );
    expectGuard(
      mutateValid((s) => {
        s.skipped.push({ path: "a.ts", reason: "unsupported-language" });
        s.coverage.skippedCount = 1;
      }),
      "both collected and skipped"
    );
  });
  it("rejects collections that exceed the effective policy", () => {
    expectGuard(
      mutateValid((s) => { s.coverage.collectionPolicy.maxFiles = 0 as unknown as number; }),
      "maxFiles"
    );
    const big = { ...file({ path: "big.ts" }), bytes: 600000, sha256: sha256Hex(enc.encode("z")) };
    expectGuard(
      mutateValid((s) => {
        s.files.push(big as (typeof s.files)[number]);
        s.coverage.collected = 2;
        s.coverage.totalBytes += 600000;
        s.coverage.collectionPolicy.maxFiles = 1;
      }),
      "maxFiles"
    );
  });
  it("rejects non-positive policy bounds; tight-but-legal policies pass", () => {
    expectGuard(
      mutateValid((s) => {
        s.coverage.collectionPolicy.maxFiles = 0;
      }),
      "maxFiles"
    );
    // Tight but legal: a small transfer cap with a large file cap composes
    // dynamically (only small files admitted) — not a contradiction.
    const tight = mutateValid((s) => {
      s.coverage.collectionPolicy.maxTotalTransferredBytes = 64;
    });
    expect(() => validateSnapshot(tight)).not.toThrow();
  });
  it("rejects derived-coverage forgery", () => {
    expectGuard(
      mutateValid((s) => { s.coverage.supportedLanguages = []; }),
      "supportedLanguages"
    );
    expectGuard(
      mutateValid((s) => {
        s.skipped.push({ path: "b.js", reason: "unsupported-language" });
        s.coverage.skippedCount = 1;
        s.coverage.unsupportedAreas = [];
      }),
      "unsupportedAreas"
    );
  });
  it("rejects forged identity bindings", () => {
    const s = validSnapshot([file({ path: "a.ts" })]);
    expect(() => validateSnapshot({ ...s, snapshotId: `github-${"1".repeat(64)}` })).toThrow(/snapshotId/);
    expect(() => validateSnapshot({ ...s, manifestHash: "2".repeat(64) })).toThrow(/manifestHash/);
  });
  it("truncates overlong skipped paths in areas deterministically (Finding C)", () => {
    const long = `src/${"d".repeat(300)}.ts`;
    expect(long.length).toBeGreaterThan(256);
    const s = validSnapshot([], [{ path: long, reason: "unsupported-language" }]);
    expect(() => validateSnapshot(s)).not.toThrow();
    const areas = (validateSnapshot(s).coverage.unsupportedAreas as string[]);
    expect(areas).toHaveLength(1);
    expect((areas[0] as string).length).toBeLessThanOrEqual(256);
    expect(areas[0]).toContain(`[${long.length}]`);
    // Exact path preserved in skipped.
    expect(validateSnapshot(s).skipped[0]?.path).toBe(long);
  });
});

describe("manifest binding and snapshot invariants (Findings B/D)", () => {
  it("binds policy, completeness, and coverage", () => {
    const p = defaultPolicy();
    const f = [file({ path: "a.ts" })];
    const base = manifestHashFor(f, [], p, true, f.length);
    expect(manifestHashFor(f, [], { ...p, maxFiles: 10 }, true, f.length)).not.toBe(base);
    expect(manifestHashFor(f, [], p, false, f.length)).not.toBe(base);
    expect(manifestHashFor(f, [{ path: "b.ts", reason: "oversized" }], p, false, f.length + 1)).not.toBe(base);
    // deadlineMs is an effective limit: part of identity.
    expect(manifestHashFor(f, [], defaultPolicy(60_000), true, f.length)).not.toBe(manifestHashFor(f, [], defaultPolicy(30_000), true, f.length));
  });
  it("accepts a consistent snapshot; rejects tampering", () => {
    expect(() => validateSnapshot(validSnapshot([file({ path: "a.ts" })]))).not.toThrow();
    const s = validSnapshot([file({ path: "a.ts" })]);
    expect(() => validateSnapshot({ ...s, manifestHash: "0".repeat(64) })).toThrow();
    expect(() => validateSnapshot({ ...s, coverage: { ...s.coverage, complete: false } })).toThrow();
    expect(() => validateSnapshot({ ...s, coverage: { ...s.coverage, collected: 99 } })).toThrow();
    expect(() => validateSnapshot(validSnapshot([file({ path: "a.ts" }), file({ path: "a.ts" })]))).toThrow();
    expect(() => validateSnapshot({ ...s, resolvedCommitIfGitHub: null })).toThrow();
  });
  it("rejects wrong versions and non-canonical provenance", () => {
    const s = validSnapshot([file({ path: "a.ts" })]);
    expect(() => validateSnapshot({ ...s, contractVersion: "e1-v2" })).toThrow();
    expect(() => validateSnapshot({ ...s, canonicalProvenance: "github.com/acme/api@abc" })).toThrow();
  });
  it("policy hash distinguishes effective policies", () => {
    expect(policyHashFor(defaultPolicy())).toHaveLength(8);
    expect(policyHashFor(defaultPolicy())).toBe(policyHashFor(defaultPolicy()));
  });
  it("language/binary gates use P1 identifiers", () => {
    expect(languageForPath("src/a.ts")).toBe("ts");
    expect(languageForPath("src/B.TSX")).toBe("tsx");
    expect(languageForPath("src/a.js")).toBeNull();
    expect(isBinaryContent(new Uint8Array([0x41, 0x00]))).toBe(true);
    expect(isBinaryContent(enc.encode("const x = 1;\n"))).toBe(false);
  });
  // Local rebind helper: mutate exactly one aspect of a valid snapshot,
  // then recompute manifest + identity so failure proves the INTENDED
  // guard — never an unrelated hash mismatch.
  const rebind = (mut: (s: ReturnType<typeof validSnapshot>) => void): unknown => {
    const clone = JSON.parse(JSON.stringify(validSnapshot([file({ path: "a.ts" })]))) as ReturnType<typeof validSnapshot>;
    mut(clone);
    clone.manifestHash = manifestHashFor(clone.files, clone.skipped, clone.coverage.collectionPolicy, clone.coverage.complete, clone.coverage.metadataEntries);
    clone.snapshotId = snapshotIdFor(clone.sourceKind, clone.canonicalProvenance, clone.resolvedCommitIfGitHub, clone.manifestHash);
    return clone;
  };
  const expectReboundGuard = (v: unknown, part: string): void => {
    try {
      validateSnapshot(v);
    } catch (err) {
      expect(String(err)).toContain(part);
      return;
    }
    expect.unreachable(`expected guard to fire: ${part}`);
  };
  it("rejects files larger than maxFileBytes (Finding C)", () => {
    expectReboundGuard(
      rebind((s) => {
        s.files[0]!.bytes = s.coverage.collectionPolicy.maxFileBytes + 1;
        s.coverage.totalBytes += s.coverage.collectionPolicy.maxFileBytes + 1 - 3;
      }),
      "maxFileBytes"
    );
  });
  it("rejects metadataEntries beyond maxMetadataEntries (Finding C)", () => {
    expectReboundGuard(
      rebind((s) => {
        s.coverage.metadataEntries = s.coverage.collectionPolicy.maxMetadataEntries + 1;
      }),
      "metadataEntries"
    );
  });
  it("rejects files+skipped exceeding recorded metadataEntries (Finding C)", () => {
    expectReboundGuard(
      rebind((s) => {
        s.coverage.metadataEntries = 0;
      }),
      "metadataEntries"
    );
  });
  it("permits depth-limit skips with exact paths (Finding C)", () => {
    const policy = defaultPolicy();
    const deep = `${"a/".repeat(policy.maxDepth)}g.ts`; // one segment beyond the cap
    expect(deep.split("/").length).toBe(policy.maxDepth + 1);
    const s = validSnapshot([], [{ path: deep, reason: "depth-limit" as const }]);
    expect(() => validateSnapshot(s)).not.toThrow();
    expect(validateSnapshot(s).skipped[0]?.path).toBe(deep);
    // Traversal is still rejected even when labeled depth-limit.
    expect(() =>
      validateSnapshot({
        ...s,
        skipped: [{ path: "../evil.ts", reason: "depth-limit" }],
      })
    ).toThrow();
  });
  it("flags >100 unsupported areas as truncated and keeps the binding (Finding C)", () => {
    const skipped = Array.from({ length: 105 }, (_, i) => ({ path: `vendor/${i}.min.js`, reason: "unsupported-language" as const }));
    const s = validSnapshot([], skipped);
    const v = validateSnapshot(s);
    expect(v.coverage.unsupportedAreasTruncated).toBe(true);
    expect(v.coverage.unsupportedAreas).toHaveLength(100);
    const few = validSnapshot([], skipped.slice(0, 3));
    expect(validateSnapshot(few).coverage.unsupportedAreasTruncated).toBe(false);
    expect(validateSnapshot(few).coverage.unsupportedAreas).toHaveLength(3);
  });
  it("disambiguates long paths with identical prefixes and lengths (Finding C)", () => {
    const prefix = `src/${"d".repeat(250)}`;
    const a = `${prefix}-a.ts`;
    const b = `${prefix}-b.ts`;
    expect(a.length).toBe(b.length);
    const sa = validSnapshot([], [{ path: a, reason: "unsupported-language" }]);
    const sb = validSnapshot([], [{ path: b, reason: "unsupported-language" }]);
    const la = validateSnapshot(sa).coverage.unsupportedAreas[0] as string;
    const lb = validateSnapshot(sb).coverage.unsupportedAreas[0] as string;
    expect(la.length).toBeLessThanOrEqual(256);
    expect(lb.length).toBeLessThanOrEqual(256);
    expect(la).not.toBe(lb); // digest tail separates same-prefix collisions
    expect(validateSnapshot(sa).skipped[0]?.path).toBe(a); // exact path kept
  });
});

describe("canonicalSyntheticProvenance (Finding D)", () => {
  it("binds owner, repo, and exact ref deterministically", () => {
    expect(canonicalSyntheticProvenance("a", "b", null)).toBe(canonicalSyntheticProvenance("a", "b", null));
    expect(canonicalSyntheticProvenance("a", "b", "main")).toContain("ref/main");
  });
  it("never collides `a-b/c` with `a/b-c`", () => {
    expect(canonicalSyntheticProvenance("a-b", "c", null)).not.toBe(canonicalSyntheticProvenance("a", "b-c", null));
  });
  it("never collides null ref with a branch literally named `default`", () => {
    expect(canonicalSyntheticProvenance("a", "b", null)).not.toBe(canonicalSyntheticProvenance("a", "b", "default"));
  });
  it("distinguishes refs and keeps hierarchy", () => {
    expect(canonicalSyntheticProvenance("a", "b", "main")).not.toBe(canonicalSyntheticProvenance("a", "b", "feature/x"));
  });
});
