/**
 * SIMULATED: bounded streaming v3 intake (Findings A/D/F).
 * Mock providers only. No network access. Real GitHub integration NOT RUN.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildSyntheticSnapshot,
  defaultLimits,
  readBoundedStream,
  rejectUnsafePath,
  runGitHubIntake,
  settleIteratorCleanup,
  type GitHubSourceProvider,
} from "@/lib/github-intake";

const enc = new TextEncoder();
const SHA = "0123456789abcdef0123456789abcdef01234567";
const AT = "2026-10-28T00:00:00.000Z";

function chunked(data: Uint8Array, size = 4): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
  })();
}

function provider(overrides: Partial<GitHubSourceProvider> = {}): GitHubSourceProvider {
  const files = new Map<string, Uint8Array>([
    ["src/index.ts", enc.encode("export const x = 1;\n")],
    ["src/app.tsx", enc.encode("export function App() { return null; }\n")],
  ]);
  return {
    resolveRef: async () => ({ sha: SHA }),
    listEntries: async function* (_o, _r, _s, signal) {
      for (const [path, bytes] of files) {
        signal.throwIfAborted();
        yield { path, size: bytes.length, kind: "file" as const };
      }
    },
    openFile: async function* (_o, _r, _s, path, signal) {
      signal.throwIfAborted();
      const b = files.get(path);
      if (b === undefined) throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
      yield* chunked(b);
    },
    ...overrides,
  };
}

describe("runGitHubIntake v3 — happy path", () => {
  it("builds a canonical snapshot pinned to the resolved SHA", async () => {
    const r = await runGitHubIntake("acme", "api", null, provider(), { collectedAt: AT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.snapshot;
    expect(s.contractVersion).toBe("e1-v5");
    expect(s.resolvedCommitIfGitHub).toBe(SHA);
    expect(s.canonicalProvenance).toBe("https://github.com/acme/api");
    expect(s.coverage).toMatchObject({ collected: 2, skippedCount: 0, complete: true });
    expect(s.files.map((f) => f.path)).toEqual(["src/app.tsx", "src/index.ts"]);
    expect(s.files[1]).toMatchObject({ language: "ts", bytes: 20, lineCount: 2, lineStartOffsets: [0, 20] });
  });
  it("is deterministic and order-independent", async () => {
    const fwd = provider();
    const a = await runGitHubIntake("acme", "api", null, fwd, { collectedAt: AT });
    const rev = provider({
      listEntries: async function* (o, r, s2, signal) {
        const all: Array<{ path: string; size: number; kind: "file" }> = [];
        for await (const e of fwd.listEntries(o, r, s2, signal)) all.push({ path: e.path, size: e.size, kind: "file" });
        yield* all.reverse();
      },
    });
    const b = await runGitHubIntake("acme", "api", null, rev, { collectedAt: AT });
    expect(a).toEqual(b);
  });
  it("fails closed on duplicate paths (no partial for corrupt listings)", () => {
    return expect(
      runGitHubIntake("acme", "api", null, provider({
        listEntries: async function* () {
          yield { path: "src/a.ts", size: 3, kind: "file" as const };
          yield { path: "src/a.ts", size: 4, kind: "file" as const };
        },
      }))
    ).resolves.toMatchObject({ ok: false, code: "DUPLICATE_PATH" });
  });
  it("rejects null/invalid metadata entries as MALFORMED (Finding F)", async () => {
    const bad = provider({ listEntries: async function* () { yield null as never; } });
    expect(await runGitHubIntake("acme", "api", null, bad)).toMatchObject({ ok: false, code: "MALFORMED" });
    const wrongType = provider({
      listEntries: async function* () { yield { path: "a.ts", size: "big", kind: "file" } as never; },
    });
    expect(await runGitHubIntake("acme", "api", null, wrongType)).toMatchObject({ ok: false, code: "MALFORMED" });
  });
});

describe("runGitHubIntake v3 — pre-read bounds (Finding A)", () => {
  it("stops enumeration at the metadata cap without reading bodies", async () => {
    const read = vi.fn(async function* () { yield new Uint8Array(0); });
    const flood = provider({
      listEntries: async function* () {
        for (let i = 0; i < 2001; i++) yield { path: `f${i}.ts`, size: 1, kind: "file" as const };
      },
      openFile: read,
    });
    const r = await runGitHubIntake("acme", "api", null, flood);
    expect(r).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    expect(read).not.toHaveBeenCalled();
  });
  it("skips declared-oversize files WITHOUT opening them", async () => {
    const open = vi.fn(async function* () { yield new Uint8Array(0); });
    const p = provider({
      listEntries: async function* () { yield { path: "src/huge.ts", size: 600 * 1024, kind: "file" as const }; },
      openFile: open,
    });
    const r = await runGitHubIntake("acme", "api", null, p, { collectedAt: AT });
    expect(r.ok).toBe(true);
    expect(open).not.toHaveBeenCalled();
    if (!r.ok) return;
    expect(r.snapshot.skipped).toMatchObject([{ path: "src/huge.ts", reason: "oversized" }]);
  });
  it("a giant single-chunk buffer cannot bypass the per-file cap", async () => {
    const p = provider({
      listEntries: async function* () { yield { path: "src/a.ts", size: 3, kind: "file" as const }; },
      openFile: async function* () { yield new Uint8Array(600 * 1024); },
    });
    const r = await runGitHubIntake("acme", "api", null, p, { collectedAt: AT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.files).toHaveLength(0);
    expect(r.snapshot.skipped).toMatchObject([{ path: "src/a.ts", reason: "oversized" }]);
  });
  it("fails closed when the aggregate transfer cap is exceeded (Finding A)", async () => {
    const p = provider({
      listEntries: async function* () {
        yield { path: "src/a.ts", size: 5, kind: "file" as const };
        yield { path: "src/b.ts", size: 5, kind: "file" as const };
      },
      openFile: async function* (_o, _r, _s, _p, _sig) { yield enc.encode("real\n"); },
    });
    const r = await runGitHubIntake("acme", "api", null, p, {
      collectedAt: AT,
      // Consistent policy: file cap 5 fits both totals; transfer cap 8 trips
      // on the second 5-byte file (5 + 5 > 8).
      limits: { ...defaultLimits(), maxFileBytes: 5, maxTotalTransferredBytes: 8 },
    });
    // 5 + 5 > 8: the second file's consumed bytes breach the cap → error
    // with partial (first file preserved with the real SHA), never a silent
    // skip and never a subtraction.
    expect(r).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    if (r.ok) return;
    expect(r.partial?.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(r.partial?.resolvedCommitIfGitHub).toBe(SHA);
    expect(r.partial?.coverage.complete).toBe(false);
  });
  it("repeated oversized files accumulate and trip the transfer cap (Finding A)", async () => {
    const p = provider({
      listEntries: async function* () {
        for (let i = 0; i < 6; i++) yield { path: `src/big${i}.ts`, size: 3, kind: "file" as const };
      },
      // Declared 3 bytes, actually yields 600 KiB single chunks.
      openFile: async function* () { yield new Uint8Array(600 * 1024); },
    });
    const r = await runGitHubIntake("acme", "api", null, p, {
      collectedAt: AT,
      limits: { ...defaultLimits(), maxTotalTransferredBytes: 1024 * 1024 },
    });
    // Each 600 KiB consumed chunk counts: after two, the 1 MiB cap breaks.
    expect(r).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    if (r.ok) return;
    expect(r.partial?.skipped.filter((s) => s.reason === "oversized")).toHaveLength(1);
  });
  it("enforces the file-count cap deterministically (Finding G)", async () => {
    const metas = Array.from({ length: 505 }, (_, i) => ({ path: `src/f${i}.ts`, size: 2, kind: "file" as const }));
    const p = provider({
      listEntries: async function* () { yield* metas; },
      openFile: async function* () { yield enc.encode("x\n"); },
    });
    const r = await runGitHubIntake("acme", "api", null, p, { collectedAt: AT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.coverage.collected).toBe(500);
    expect(r.snapshot.coverage.complete).toBe(false);
    expect(r.snapshot.skipped.filter((s) => s.reason === "entry-limit")).toHaveLength(5);
    // Canonical order: the first 500 sorted paths are collected.
    expect(r.snapshot.files[0]?.path).toBe("src/f0.ts");
  });
  it("enforces the collected-byte cap with rollback but no transfer subtraction (Finding G)", async () => {
    const p = provider({
      listEntries: async function* () {
        yield { path: "src/a.ts", size: 5, kind: "file" as const };
        yield { path: "src/b.ts", size: 5, kind: "file" as const };
      },
      openFile: async function* (_o, _r, _s, _p, _sig) { yield enc.encode("real\n"); },
    });
    const r = await runGitHubIntake("acme", "api", null, p, {
      collectedAt: AT,
      limits: { ...defaultLimits(), maxFileBytes: 5, maxTotalBytes: 8 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(r.snapshot.skipped).toMatchObject([{ path: "src/b.ts", reason: "size-limit" }]);
    expect(r.snapshot.coverage).toMatchObject({ collected: 1, totalBytes: 5, complete: false });
  });
  it("caps skipped entries instead of dropping coverage silently (Finding G)", async () => {
    const metas = Array.from({ length: 10 }, (_, i) => ({ path: `src/f${i}.js`, size: 1, kind: "file" as const }));
    const r = await runGitHubIntake("acme", "api", null, provider({
      listEntries: async function* () { yield* metas; },
    }), {
      collectedAt: AT,
      limits: { ...defaultLimits(), maxSkippedEntries: 3 },
    });
    expect(r).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    if (r.ok) return;
    expect(r.partial?.skipped).toHaveLength(3);
  });
  it("non-bytes chunks are MALFORMED, not stored", async () => {
    const p = provider({
      listEntries: async function* () { yield { path: "src/a.ts", size: 3, kind: "file" as const }; },
      openFile: async function* () { yield "text" as never; },
    });
    expect(await runGitHubIntake("acme", "api", null, p)).toMatchObject({ ok: false, code: "MALFORMED" });
  });
});

describe("runGitHubIntake v3 — modes, symlinks, submodules, unsafe paths (F)", () => {
  it("classifies gitlink/symlink modes without reading bodies", async () => {
    const open = vi.fn(async function* () { yield new Uint8Array(0); });
    const p = provider({
      listEntries: async function* () {
        yield { path: "link.ts", size: 10, kind: "symlink" as const };
        yield { path: "link2.ts", size: 10, kind: "file" as const, mode: "120000" };
        yield { path: "vendor/lib", size: 0, kind: "file" as const, mode: "160000" };
        yield { path: "vendor/explicit", size: 0, kind: "submodule" as const };
        yield { path: "../evil.ts", size: 3, kind: "file" as const };
        yield { path: "ctrl\x01.ts", size: 3, kind: "file" as const };
      },
      openFile: open,
    });
    const r = await runGitHubIntake("acme", "api", null, p, { collectedAt: AT });
    expect(r.ok).toBe(true);
    expect(open).not.toHaveBeenCalled();
    if (!r.ok) return;
    // Finding C (006): syntax-unsafe paths ("../evil.ts", control-char
    // names) are NEVER itemized in skipped[] — recording them would embed
    // traversal/control sequences in the snapshot. They stay counted in
    // metadataEntries (6 enumerated, 4 recorded), preserving scope.
    expect(Object.fromEntries(r.snapshot.skipped.map((s) => [s.path, s.reason]))).toEqual({
      "link.ts": "symlink",
      "link2.ts": "symlink",
      "vendor/explicit": "submodule",
      "vendor/lib": "submodule",
    });
    expect(r.snapshot.coverage.metadataEntries).toBe(6);
    expect(r.snapshot.coverage.skippedCount).toBe(4);
  });
});

describe("runGitHubIntake v3 — partials preserve the real commit (D)", () => {
  it("mid-list provider failure returns error + partial with the real SHA", async () => {
    const p = provider({
      openFile: async function* (_o, _r, _s, path, signal) {
        signal.throwIfAborted();
        if (path === "src/index.ts") throw Object.assign(new Error("boom"), { code: "SOME_IO" });
        yield enc.encode("ok\n");
      },
    });
    const r = await runGitHubIntake("acme", "api", null, p, { collectedAt: AT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("PROVIDER_UNAVAILABLE");
    expect(r.partial?.resolvedCommitIfGitHub).toBe(SHA);
    expect(r.partial?.coverage.complete).toBe(false);
    const full = await runGitHubIntake("acme", "api", null, provider(), { collectedAt: AT });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    // Partial and complete collections have different identities.
    expect(r.partial?.manifestHash).not.toBe(full.snapshot.manifestHash);
    expect(r.partial?.snapshotId).not.toBe(full.snapshot.snapshotId);
  });
  it("no partial exists before resolution; failures there carry no SHA", async () => {
    const p = provider({ resolveRef: async () => { throw Object.assign(new Error("x"), { code: "NOT_FOUND" }); } });
    const r = await runGitHubIntake("m", "x", null, p);
    expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
    if (r.ok) return;
    expect("partial" in r ? r.partial : undefined).toBeUndefined();
  });
});

describe("runGitHubIntake v3 — non-cooperative provider (B)", () => {
  it("settles TIMEOUT for a hanging enumeration that ignores abort", async () => {
    const hanging = provider({
      listEntries: async function* () {
        await new Promise(() => {}); // never yields, ignores abort
        yield { path: "never.ts", size: 1, kind: "file" as const };
      },
    });
    const start = Date.now();
    const r = await runGitHubIntake("acme", "api", null, hanging, { deadlineMs: 50 });
    expect(Date.now() - start).toBeLessThan(30_000);
    expect(r).toMatchObject({ ok: false, code: "TIMEOUT" });
  }, 30_000);
  it("user abort during a slow stream yields CANCELLED", async () => {
    const c = new AbortController();
    const slow = provider({
      openFile: async function* (_o, _r, _s, _p, signal) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        signal.throwIfAborted();
        yield enc.encode("x\n");
      },
    });
    const pending = runGitHubIntake("acme", "api", null, slow, { signal: c.signal, deadlineMs: 20_000 });
    c.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, code: "CANCELLED" });
  }, 30_000);
});

describe("runGitHubIntake v3 — thrown reads still count bytes (Finding A)", () => {
  it("yield-then-throw failures are counted, then mapped (no evasion)", async () => {
    const p = provider({
      listEntries: async function* () {
        yield { path: "src/0-good.ts", size: 3, kind: "file" as const };
        yield { path: "src/app.tsx", size: 20, kind: "file" as const };
      },
      openFile: async function* (_o, _r, _s, path, signal) {
        signal.throwIfAborted();
        if (path === "src/0-good.ts") {
          yield enc.encode("ok\n");
          return;
        }
        yield enc.encode("0123456789"); // 10 bytes pulled, then boom
        throw Object.assign(new Error("mid-stream io failure"), { code: "SOME_IO" });
      },
    });
    const r = await runGitHubIntake("acme", "api", null, p, { collectedAt: AT });
    // Mapped as a provider failure (not MALFORMED), with real-SHA partial
    // preserving the already-collected file.
    expect(r).toMatchObject({ ok: false, code: "PROVIDER_UNAVAILABLE" });
    if (r.ok) return;
    expect(r.partial?.files.map((f) => f.path)).toEqual(["src/0-good.ts"]);
    expect(r.partial?.resolvedCommitIfGitHub).toBe(SHA);
    expect(r.partial?.coverage.complete).toBe(false);
  });
  it("NOT_FOUND after partial transfer counts, then skips; repeats trip the cap", async () => {
    let calls = 0;
    const p = provider({
      listEntries: async function* () {
        yield { path: "src/0-good.ts", size: 3, kind: "file" as const };
        yield { path: "src/a.ts", size: 5, kind: "file" as const };
        yield { path: "src/b.ts", size: 5, kind: "file" as const };
      },
      openFile: async function* (_o, _r, _s, path, signal) {
        calls++;
        signal.throwIfAborted();
        if (path === "src/0-good.ts") {
          yield enc.encode("ok\n");
          return;
        }
        yield enc.encode("0123456789"); // 10 bytes pulled, then gone
        throw Object.assign(new Error("vanished"), { code: "NOT_FOUND" });
      },
    });
    const r = await runGitHubIntake("acme", "api", null, p, {
      collectedAt: AT,
      limits: { ...defaultLimits(), maxFileBytes: 64, maxTotalTransferredBytes: 20 },
    });
    // good(3) + a(10) + b(10) = 23 > 20: the second NOT_FOUND trips
    // LIMIT_EXCEEDED, with the first NOT_FOUND skip honestly recorded.
    expect(r).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    expect(calls).toBe(3);
    if (r.ok) return;
    expect(r.partial?.skipped).toMatchObject([{ path: "src/a.ts", reason: "not-found" }]);
    expect(r.partial?.resolvedCommitIfGitHub).toBe(SHA);
  });
  it("repeated failed reads never reset the aggregate (no subtraction)", async () => {
    const p = provider({
      listEntries: async function* () {
        yield { path: "src/a.ts", size: 5, kind: "file" as const };
        yield { path: "src/b.ts", size: 5, kind: "file" as const };
      },
      openFile: async function* () {
        yield enc.encode("0123456789"); // 10 bytes, then an over-cap chunk
        yield new Uint8Array(100);
      },
    });
    const r = await runGitHubIntake("acme", "api", null, p, {
      collectedAt: AT,
      // Per-read: 10 + 100 = 110 consumed, truncated (cap 64). Aggregate 200:
      // file 1 counts 110 and skips; file 2 would reach 220 and trips.
      // The trip proves file 1's bytes were never subtracted or reset.
      limits: { ...defaultLimits(), maxFileBytes: 64, maxTotalTransferredBytes: 200 },
    });
    expect(r).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    if (r.ok) return;
    expect(r.partial?.skipped.filter((s) => s.reason === "oversized")).toHaveLength(1);
    expect(r.partial?.resolvedCommitIfGitHub).toBe(SHA);
  });
});

describe("runGitHubIntake v3 — Finding A corrections (006, superseded by 007 where noted)", () => {
  it("oversized chunk + throwing cleanup: consumed survives, cleanup attempted but powerless (007 contract)", async () => {
    let cleanupCalls = 0;
    const evil: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let n = 0;
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            n++;
            if (n === 1) return { done: false, value: enc.encode("ab\n") };
            // Refused oversized chunk: received (counts) but never stored.
            return { done: false, value: new Uint8Array(1000) };
          },
          async return(): Promise<IteratorResult<Uint8Array>> {
            cleanupCalls++;
            throw new Error("teardown explosion");
          },
        };
      },
    };
    const p = provider({
      listEntries: async function* () {
        yield { path: "src/a.ts", size: 4, kind: "file" as const };
      },
      openFile: () => evil,
    });
    const r = await runGitHubIntake("acme", "api", null, p, {
      collectedAt: AT,
      limits: { ...defaultLimits(), maxFileBytes: 64, maxTotalTransferredBytes: 10_000 },
    });
    // Truncated-skip, not a cleanup error; the refused 1000-byte chunk was
    // counted (transferred would exceed caps on repeat — proven below).
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.snapshot.skipped).toMatchObject([{ path: "src/a.ts", reason: "oversized" }]);
    // 007 contract: cleanup IS attempted exactly once on early termination,
    // but the throwing teardown cannot touch the decided outcome.
    expect(cleanupCalls).toBe(1);
    // Repeat the same provider: 3 + 1000 counted twice = 2006 > 1500 trips.
    const r2 = await runGitHubIntake("acme", "api", null, provider({
      listEntries: async function* () {
        yield { path: "src/a.ts", size: 4, kind: "file" as const };
        yield { path: "src/b.ts", size: 4, kind: "file" as const };
      },
      openFile: () => evil,
    }), {
      collectedAt: AT,
      limits: { ...defaultLimits(), maxFileBytes: 64, maxTotalTransferredBytes: 1500 },
    });
    expect(r2).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
  });
  it("non-Error thrown values map to typed errors without crashing", async () => {
    // A leading good file guarantees a non-empty partial either way.
    const entries = async function* () {
      yield { path: "src/0-good.ts", size: 3, kind: "file" as const };
      yield { path: "src/a.ts", size: 4, kind: "file" as const };
    };
    const pString = provider({
      listEntries: entries,
      openFile: async function* (_o, _r, _s, path, signal) {
        signal.throwIfAborted();
        if (path === "src/0-good.ts") {
          yield enc.encode("ok\n");
          return;
        }
        yield enc.encode("ab\n");
        throw "plain-string-failure";
      },
    });
    const r1 = await runGitHubIntake("acme", "api", null, pString, { collectedAt: AT });
    expect(r1).toMatchObject({ ok: false, code: "PROVIDER_UNAVAILABLE" });
    if (!r1.ok) {
      expect(r1.partial?.resolvedCommitIfGitHub).toBe(SHA);
      expect(r1.partial?.files.map((f) => f.path)).toEqual(["src/0-good.ts"]);
    }
    // A thrown coded OBJECT keeps its code (NOT_FOUND -> skip, counted).
    const pCoded = provider({
      listEntries: entries,
      openFile: async function* (_o, _r, _s, path, signal) {
        signal.throwIfAborted();
        if (path === "src/0-good.ts") {
          yield enc.encode("ok\n");
          return;
        }
        yield enc.encode("ab\n");
        throw { code: "NOT_FOUND" };
      },
    });
    const r2 = await runGitHubIntake("acme", "api", null, pCoded, { collectedAt: AT });
    expect(r2).toMatchObject({ ok: true });
    if (!r2.ok) return;
    expect(r2.snapshot.skipped).toMatchObject([{ path: "src/a.ts", reason: "not-found" }]);
  });
  it("aggregate exhaustion is exact: cap reached then one more byte trips", async () => {
    const ten = enc.encode("0123456789"); // 10 raw bytes; intake stores bytes, never parses content
    const p = provider({
      listEntries: async function* () {
        yield { path: "src/a.ts", size: 10, kind: "file" as const };
        yield { path: "src/b.ts", size: 10, kind: "file" as const };
      },
      openFile: async function* (_o, _r, _s, _p, signal) {
        signal.throwIfAborted();
        yield ten;
      },
    });
    // Per-file 64: each file consumes 10. Aggregate 10: file 1 fits exactly,
    // file 2's first chunk exceeds the remaining allowance and trips.
    const r = await runGitHubIntake("acme", "api", null, p, {
      collectedAt: AT,
      limits: { ...defaultLimits(), maxFileBytes: 64, maxTotalTransferredBytes: 10 },
    });
    expect(r).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    if (!r.ok) expect(r.partial?.resolvedCommitIfGitHub).toBe(SHA);
  });
  it("late iterator rejection after full content still counts and preserves commit", async () => {
    const p = provider({
      listEntries: async function* () {
        yield { path: "src/0-good.ts", size: 3, kind: "file" as const };
        yield { path: "src/a.ts", size: 3, kind: "file" as const };
      },
      openFile: async function* (_o, _r, _s, path, signal) {
        signal.throwIfAborted();
        if (path === "src/0-good.ts") {
          yield enc.encode("ok\n");
          return;
        }
        yield enc.encode("ok\n"); // full 3 bytes pulled, then late failure
        throw Object.assign(new Error("late close failure"), { code: "SOME_IO" });
      },
    });
    const r = await runGitHubIntake("acme", "api", null, p, { collectedAt: AT });
    expect(r).toMatchObject({ ok: false, code: "PROVIDER_UNAVAILABLE" });
    if (!r.ok) {
      expect(r.partial?.resolvedCommitIfGitHub).toBe(SHA);
      expect(r.partial?.coverage.complete).toBe(false);
    }
  });
});

describe("readBoundedStream — iterator cleanup attempts (Finding A, 007)", () => {
  function trackedIterable(behavior: {
    chunks: Uint8Array[];
    cleanup?: () => Promise<unknown>;
  }): { iterable: AsyncIterable<Uint8Array>; calls: { return: number } } {
    const calls = { return: 0 };
    let i = 0;
    const iterable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            if (i < behavior.chunks.length) {
              return { done: false, value: behavior.chunks[i++] };
            }
            return { done: true, value: undefined };
          },
          async return(): Promise<IteratorResult<Uint8Array>> {
            calls.return++;
            if (behavior.cleanup) await behavior.cleanup();
            return { done: true, value: undefined };
          },
        };
      },
    };
    return { iterable, calls };
  }
  it("attempts cleanup on oversized truncation; outcome and bytes intact", async () => {
    const { iterable, calls } = trackedIterable({ chunks: [new Uint8Array(1000)] });
    const out = await readBoundedStream(iterable, 64, 10_000);
    expect(calls.return).toBe(1);
    expect(out).toMatchObject({ ok: true, truncated: true, consumed: 1000 });
  });
  it("synchronous cleanup throw cannot touch the outcome", async () => {
    let calls = 0;
    const iterable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            return { done: false, value: new Uint8Array(500) };
          },
          return(): Promise<IteratorResult<Uint8Array>> {
            calls++;
            throw new Error("sync teardown explosion");
          },
        };
      },
    };
    const out = await readBoundedStream(iterable, 64, 10_000);
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: true, truncated: true, consumed: 500 });
  });
  it("asynchronous cleanup rejection is observed, never unhandled, outcome intact", async () => {
    const { iterable, calls } = trackedIterable({
      chunks: [new Uint8Array(500)],
      cleanup: () => Promise.reject(new Error("async teardown explosion")),
    });
    const out = await readBoundedStream(iterable, 64, 10_000);
    expect(calls.return).toBe(1);
    expect(out).toMatchObject({ ok: true, truncated: true, consumed: 500 });
    // Let the rejected cleanup settle: suite passing proves no unhandled rejection.
    await new Promise((r) => setTimeout(r, 50));
    expect(out).toMatchObject({ consumed: 500 });
  });
  it("never-settling cleanup does not delay settlement", async () => {
    const { iterable } = trackedIterable({
      chunks: [new Uint8Array(500)],
      cleanup: () => new Promise<unknown>(() => {}),
    });
    const start = Date.now();
    const out = await readBoundedStream(iterable, 64, 10_000);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(out).toMatchObject({ ok: true, truncated: true, consumed: 500 });
  });
  it("normal completion needs no cleanup; iterators without return() work", async () => {
    const plain: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let n = 0;
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            n++;
            return n === 1
              ? { done: false, value: enc.encode("ok\n") }
              : { done: true, value: undefined };
          },
        };
      },
    };
    const out = await readBoundedStream(plain, 64, 10_000);
    expect(out).toMatchObject({ ok: true, truncated: false, consumed: 3 });
    expect(settleIteratorCleanup(plain[Symbol.asyncIterator]())).toBeUndefined();
  });
});

describe("runGitHubIntake — authoritative deadline recheck (Finding B, 007)", () => {
  it("completion just before expiry still succeeds", async () => {
    const p = provider({
      openFile: async function* (_o, _r, _s, path, signal) {
        signal.throwIfAborted();
        await new Promise((r) => setTimeout(r, 20));
        yield enc.encode("ok\n");
        void path;
      },
    });
    const r = await runGitHubIntake("acme", "api", null, p, { collectedAt: AT, deadlineMs: 5000 });
    expect(r).toMatchObject({ ok: true });
  });
  it("non-cooperative completion after inner expiry returns TIMEOUT, not success", async () => {
    // Provider ignores the abort signal and yields AFTER the 100 ms inner
    // deadline (but inside the outer +1 s backstop): without the recheck
    // this would wrongly settle success.
    const p = provider({
      listEntries: async function* () {
        yield { path: "src/a.ts", size: 3, kind: "file" as const };
      },
      openFile: async function* () {
        await new Promise((r) => setTimeout(r, 300));
        yield enc.encode("ok\n");
      },
    });
    const start = Date.now();
    const r = await runGitHubIntake("acme", "api", null, p, { collectedAt: AT, deadlineMs: 100 });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(r).toMatchObject({ ok: false, code: "TIMEOUT" });
    if (!r.ok) {
      // The late file WAS pulled before the recheck: truthful partial with
      // the collected file plus the real commit, marked incomplete.
      expect(r.partial?.resolvedCommitIfGitHub).toBe(SHA);
      expect(r.partial?.files.map((f) => f.path)).toEqual(["src/a.ts"]);
      expect(r.partial?.coverage.complete).toBe(false);
    }
  }, 15000);
  it("delayed final-file completion preserves partial files plus commit", async () => {
    const p = provider({
      listEntries: async function* () {
        yield { path: "src/0-good.ts", size: 3, kind: "file" as const };
        yield { path: "src/late.ts", size: 3, kind: "file" as const };
      },
      openFile: async function* (_o, _r, _s, path) {
        if (path === "src/0-good.ts") {
          yield enc.encode("ok\n");
          return;
        }
        await new Promise((r) => setTimeout(r, 300)); // ignores abort, late
        yield enc.encode("ok\n");
      },
    });
    const r = await runGitHubIntake("acme", "api", null, p, { collectedAt: AT, deadlineMs: 100 });
    expect(r).toMatchObject({ ok: false, code: "TIMEOUT" });
    if (!r.ok) {
      // Both files were pulled before the recheck fired: the partial
      // honestly contains everything collected, plus the real commit,
      // marked incomplete — success itself was correctly refused.
      expect(r.partial?.resolvedCommitIfGitHub).toBe(SHA);
      expect(r.partial?.files.map((f) => f.path)).toEqual(["src/0-good.ts", "src/late.ts"]);
      expect(r.partial?.coverage.complete).toBe(false);
    }
  }, 15000);
});

describe("rejectUnsafePath", () => {
  it("accepts normal nested paths; rejects traversal/control/depth", () => {
    expect(rejectUnsafePath("src/api/orders.ts", 20)).toBeNull();
    expect(rejectUnsafePath("../x.ts", 20)).toBe("traversal");
    expect(rejectUnsafePath("/x.ts", 20)).toBe("absolute-or-separator");
    expect(rejectUnsafePath("a\\b.ts", 20)).toBe("absolute-or-separator");
    expect(rejectUnsafePath("a//b.ts", 20)).toBe("traversal");
    expect(rejectUnsafePath("a\x7f.ts", 20)).toBe("control-chars");
    expect(rejectUnsafePath("a/b.ts", 1)).toBe("max-depth");
  });
});

describe("buildSyntheticSnapshot", () => {
  it("labels synthetic and never resolves a GitHub commit", () => {
    const s = buildSyntheticSnapshot("demo", "demo", null, [], [{ path: "a.js", reason: "unsupported-language" }], AT);
    expect(s.sourceKind).toBe("synthetic");
    expect(s.resolvedCommitIfGitHub).toBeNull();
    expect(s.coverage).toMatchObject({ collected: 0, skippedCount: 1, complete: true });
  });
});
