/**
 * OFFLINE: real GitHub provider over a MOCKED HTTP transport.
 * No external network request is made here — the mock records every URL and
 * the suite asserts each one is an allowlisted https://api.github.com
 * request. Live GitHub retrieval is NOT tested (see LIMITATIONS.md).
 * Synthetic preview mode is untouched: existing suites never call this
 * provider.
 *
 * How "no live fetch" is actually shown (no overclaim): every test injects
 * its own mock fetchFn, so the provider under test can only call that mock —
 * the default built-in-fetch transport is never constructed in this suite.
 * Tests that additionally install stubGlobalFetch prove those paths never
 * touch global fetch at all. Tests without the stub rely on injection alone:
 * global fetch is simply never called because the provider only ever calls
 * its injected transport — the stub is a second lock on some doors, not the
 * only lock on any door.
 */
import { describe, expect, it, vi } from "vitest";
import {
  assertAllowlistedApiUrl,
  buildBlobUrl,
  buildCommitUrl,
  buildContentUrl,
  buildRepoUrl,
  buildTreeUrl,
  decodeBase64ToBytes,
  decodedBase64ByteLength,
  GITHUB_API_ALLOWLIST,
  GitHubRestProvider,
  isLfsPointer,
  isPinnedSha,
  MAX_FILE_BYTES,
  MAX_JSON_BYTES,
  rejectDotSegments,
  throwForStatus,
  toOwnedBytes,
  type GitHubApiFetch,
  type GitHubApiResponse,
} from "@/lib/github-provider";
import { runGitHubIntake } from "@/lib/github-intake";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const AT = "2026-10-28T00:00:00.000Z";
const enc = new TextEncoder();
const b64 = (s: string): string => btoa(s);

/**
 * Lazily-chunked stream body: chunks are produced one per pull() — nothing
 * is enqueued eagerly up front. `onPull` observes how many chunks the
 * provider actually pulls, so tests can prove the provider stops at the
 * byte cap instead of draining the stream.
 */
function streamBody(raw: string, chunkSize = 4096, onPull?: () => void): ReadableStream<Uint8Array> {
  const bytes = enc.encode(raw);
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (off >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(off + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(off, end));
      off = end;
    },
  });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): GitHubApiResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const raw = JSON.stringify(body);
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => raw,
    json: async () => body,
    body: streamBody(raw),
  };
}

/** Raw-text response (for oversized / malformed bodies); counts body reads. */
function rawResponse(
  status: number,
  raw: string,
  headers: Record<string, string> = {},
  tracker?: { texts: number; jsons: number },
  onPull?: () => void
): GitHubApiResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => {
      if (tracker) tracker.texts += 1;
      return raw;
    },
    json: async () => {
      if (tracker) tracker.jsons += 1;
      return JSON.parse(raw);
    },
    // Lazily pulled in small chunks: the provider must stop at the byte
    // cap instead of draining. text()/json() above only run if the
    // provider regresses to buffering — the tracker proves they never do.
    body: streamBody(raw, 4096, onPull),
  };
}

/** Drain an async file stream (openFile bodies run on first next()). */
async function drain(stream: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const chunk of stream) {
    if (chunk.length < 0) throw new Error("unreachable");
  }
}

/** Mock transport keyed by exact URL; records calls + inits for inspection. */
function mockTransport(routes: Record<string, GitHubApiResponse>, fallbackStatus = 500): {
  fetchFn: GitHubApiFetch;
  calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; redirect: string } }>;
} {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; redirect: string } }> = [];
  const fetchFn: GitHubApiFetch = async (url, init) => {
    calls.push({ url, init: { method: init.method, headers: init.headers, redirect: init.redirect } });
    return routes[url] ?? jsonResponse(fallbackStatus, { message: "unmocked" });
  };
  return { fetchFn, calls };
}

function stubGlobalFetch(): ReturnType<typeof vi.spyOn> {
  const stub = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("live network is forbidden in offline tests");
  });
  return stub;
}

/**
 * Planned oversized payload, generated lazily — nothing near the payload
 * size is ever allocated. The stream produces header + fill + footer one
 * chunk per pull() from a single small reusable fill buffer, so the harness
 * holds only ~2 chunks' worth of bytes no matter how large the planned total
 * is. `plannedTotal` (default 4x the JSON cap) is what the provider WOULD
 * read if it drained the stream; pull counts prove it stops at the cap and
 * leaves the planned remainder ungenerated. A planned-but-unpulled byte was
 * never allocated anywhere — neither provider-side nor harness-side — which
 * is strictly stronger than the 004-style "harness preallocates, provider
 * leaves unpulled" setup.
 */
const LAZY_PLAN_MULT = 4;
function lazyOversizedJsonResponse(
  opts: {
    chunkSize?: number;
    contentLength?: string | null; // null/undefined = header absent
    pulls?: { n: number };
    texts?: { n: number };
    cancels?: { n: number };
    rejectCancel?: boolean;
    fill?: number;
    header?: string;
    footer?: string;
  } = {}
): { res: GitHubApiResponse; plannedTotal: number; jsonCalls: () => number } {
  const chunkSize = opts.chunkSize ?? 4096;
  const header = enc.encode(opts.header ?? `{"sha":"${SHA}","pad":"`);
  const footer = enc.encode(opts.footer ?? `"}`);
  const plannedTotal = LAZY_PLAN_MULT * MAX_JSON_BYTES;
  const fillLen = plannedTotal - header.length - footer.length;
  const fillChunks = Math.ceil(fillLen / chunkSize);
  const fill = new Uint8Array(chunkSize).fill(opts.fill ?? 0x78); // one small reusable buffer
  const tail = fillLen % chunkSize;
  let emitted = 0;
  let jsons = 0;
  const lower: Record<string, string> = {};
  if (opts.contentLength !== undefined && opts.contentLength !== null) {
    lower["content-length"] = opts.contentLength;
  }
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.pulls) opts.pulls.n += 1;
      if (emitted === 0) {
        controller.enqueue(header);
      } else if (emitted <= fillChunks) {
        const last = emitted === fillChunks;
        // Re-enqueueing the same small buffer is intentional: it also
        // exercises the provider's owned-copy path (retained chunks must
        // not alias the transport's reusable buffer).
        controller.enqueue(last && tail !== 0 ? fill.slice(0, tail) : fill);
      } else if (emitted === fillChunks + 1) {
        controller.enqueue(footer);
      } else {
        controller.close();
        return;
      }
      emitted += 1;
    },
    cancel() {
      if (opts.cancels) opts.cancels.n += 1;
      if (opts.rejectCancel) return Promise.reject(new Error("uncooperative stream cancel"));
    },
  });
  const res: GitHubApiResponse = {
    status: 200,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => {
      if (opts.texts) opts.texts.n += 1;
      throw new Error("text() must never be called: provider streams under the cap");
    },
    json: async () => {
      jsons += 1;
      throw new Error("json() must never be called: provider streams under the cap");
    },
    body,
  };
  return { res, plannedTotal, jsonCalls: () => jsons };
}

describe("github-provider — request construction (offline)", () => {
  it("builds exact allowlisted api.github.com URLs", () => {
    expect(buildRepoUrl("acme", "api")).toBe("https://api.github.com/repos/acme/api");
    expect(buildCommitUrl("acme", "api", "main")).toBe("https://api.github.com/repos/acme/api/commits/main");
    expect(buildTreeUrl("acme", "api", SHA)).toBe(`https://api.github.com/repos/acme/api/git/trees/${SHA}?recursive=1`);
    expect(buildContentUrl("acme", "api", "src/a.ts", SHA)).toBe(
      `https://api.github.com/repos/acme/api/contents/src/a.ts?ref=${SHA}`
    );
    expect(buildBlobUrl("acme", "api", SHA)).toBe(`https://api.github.com/repos/acme/api/git/blobs/${SHA}`);
  });
  it("encodes path segments without allowing traversal", () => {
    const url = buildContentUrl("acme", "api", "src/my file.ts", SHA);
    expect(url).toContain("src/my%20file.ts");
    expect(() => buildContentUrl("acme", "api", "/abs.ts", SHA)).toThrow();
    expect(() => buildContentUrl("acme", "api", "a\\b.ts", SHA)).toThrow();
  });
  it("requires canonical owner/repo and pinned SHA for tree/file/blob", () => {
    expect(() => buildTreeUrl("acme!", "api", SHA)).toThrow();
    expect(() => buildTreeUrl("acme", "api", "main")).toThrow();
    expect(() => buildContentUrl("acme", "api", "a.ts", "abc")).toThrow();
    expect(() => buildBlobUrl("acme", "api", "not-a-sha")).toThrow();
    expect(() => buildCommitUrl("acme", "api", "../evil")).toThrow();
  });
  it("assertAllowlistedApiUrl rejects off-host, http, credentialed, port URLs", () => {
    expect(() => assertAllowlistedApiUrl("http://api.github.com/repos/a/b")).toThrow();
    expect(() => assertAllowlistedApiUrl("https://github.com/acme/api")).toThrow();
    expect(() => assertAllowlistedApiUrl("https://api.github.com.evil.example/x")).toThrow();
    expect(() => assertAllowlistedApiUrl("https://user:pass@api.github.com/x")).toThrow();
    expect(() => assertAllowlistedApiUrl("https://api.github.com:8443/x")).toThrow();
  });
  it("isPinnedSha accepts only full 40-hex", () => {
    expect(isPinnedSha(SHA)).toBe(true);
    expect(isPinnedSha(SHA.slice(0, 7))).toBe(false);
    expect(isPinnedSha("g".repeat(40))).toBe(false);
    expect(isPinnedSha("")).toBe(false);
  });
});

describe("github-provider — status mapping (offline)", () => {
  const h = { get: () => null };
  it("maps 404/401/403/429/422/500 to intake codes", () => {
    expect(() => throwForStatus(404, h, "X")).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => throwForStatus(401, h, "X")).toThrowError(expect.objectContaining({ code: "PRIVATE_OR_FORBIDDEN" }));
    expect(() => throwForStatus(403, h, "X")).toThrowError(expect.objectContaining({ code: "PRIVATE_OR_FORBIDDEN" }));
    expect(() => throwForStatus(429, h, "X")).toThrowError(expect.objectContaining({ code: "RATE_LIMITED" }));
    expect(() =>
      throwForStatus(403, { get: (n: string) => (n === "x-ratelimit-remaining" ? "0" : null) }, "X")
    ).toThrowError(expect.objectContaining({ code: "RATE_LIMITED" }));
    expect(() => throwForStatus(422, h, "X")).toThrowError(expect.objectContaining({ code: "REF_UNRESOLVED" }));
    expect(() => throwForStatus(500, h, "X")).toThrowError(expect.objectContaining({ code: "PROVIDER_UNAVAILABLE" }));
    expect(() => throwForStatus(200, h, "X")).not.toThrow();
  });
});

describe("github-provider — resolveRef (mocked transport)", () => {
  it("pins a named ref to a full SHA and never attaches credentials", async () => {
    const stub = stubGlobalFetch();
    try {
      const commitUrl = buildCommitUrl("acme", "api", "main");
      const { fetchFn, calls } = mockTransport({ [commitUrl]: jsonResponse(200, { sha: SHA }) });
      const provider = new GitHubRestProvider({ fetchFn });
      await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).resolves.toEqual({ sha: SHA });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(commitUrl);
      expect(calls[0]?.init.headers).not.toHaveProperty("Authorization");
      expect("authorization" in (calls[0]?.init.headers ?? {})).toBe(false);
    } finally {
      stub.mockRestore();
    }
  });
  it("resolves a null ref via default_branch, then pins it", async () => {
    const repoUrl = buildRepoUrl("acme", "api");
    const commitUrl = buildCommitUrl("acme", "api", "main");
    const { fetchFn, calls } = mockTransport({
      [repoUrl]: jsonResponse(200, { default_branch: "main" }),
      [commitUrl]: jsonResponse(200, { sha: SHA }),
    });
    const provider = new GitHubRestProvider({ fetchFn });
    await expect(provider.resolveRef("acme", "api", null, AbortSignal.timeout(5000))).resolves.toEqual({ sha: SHA });
    expect(calls.map((c) => c.url)).toEqual([repoUrl, commitUrl]);
  });
  it("rejects abbreviated SHAs from the API (never claims uniqueness)", async () => {
    const commitUrl = buildCommitUrl("acme", "api", "main");
    const { fetchFn } = mockTransport({ [commitUrl]: jsonResponse(200, { sha: SHA.slice(0, 7) }) });
    const provider = new GitHubRestProvider({ fetchFn });
    await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "REF_UNRESOLVED",
    });
  });
  it("maps 404 to NOT_FOUND and 403 to PRIVATE_OR_FORBIDDEN", async () => {
    const commitUrl = buildCommitUrl("acme", "api", "nope");
    const notFound = new GitHubRestProvider({
      fetchFn: mockTransport({ [commitUrl]: jsonResponse(404, { message: "Not Found" }) }).fetchFn,
    });
    await expect(notFound.resolveRef("acme", "api", "nope", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const forbidden = new GitHubRestProvider({
      fetchFn: mockTransport({ [commitUrl]: jsonResponse(403, { message: "Forbidden" }) }).fetchFn,
    });
    await expect(forbidden.resolveRef("acme", "api", "nope", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "PRIVATE_OR_FORBIDDEN",
    });
  });
});

describe("github-provider — bodies, symlinks, LFS, truncation (mocked)", () => {
  const treeUrl = buildTreeUrl("acme", "api", SHA);
  const fileUrl = (p: string): string => buildContentUrl("acme", "api", p, SHA);

  function providerWithTree(
    tree: unknown,
    files: Record<string, unknown> = {},
    opts: { truncated?: boolean } = {}
  ): { provider: GitHubRestProvider; calls: Array<{ url: string }> } {
    const routes: Record<string, GitHubApiResponse> = {
      [buildCommitUrl("acme", "api", "main")]: jsonResponse(200, { sha: SHA }),
      [treeUrl]: jsonResponse(200, { sha: SHA, tree, truncated: opts.truncated ?? false }),
    };
    for (const [path, body] of Object.entries(files)) routes[fileUrl(path)] = jsonResponse(200, body);
    const { fetchFn, calls } = mockTransport(routes);
    return { provider: new GitHubRestProvider({ fetchFn }), calls };
  }

  it("end-to-end pinned intake over the mock: github snapshot, sorted, real SHA", async () => {
    const stub = stubGlobalFetch();
    try {
      const src = "export const x = 1;\n";
      const app = "export function App() { return null; }\n";
      const { provider } = providerWithTree(
        [
          { path: "src/index.ts", mode: "100644", type: "blob", size: src.length, sha: SHA },
          { path: "src/app.tsx", mode: "100644", type: "blob", size: app.length, sha: SHA },
          { path: "README.md", mode: "100644", type: "blob", size: 5, sha: SHA },
          { path: "link.ts", mode: "120000", type: "blob", size: 8, sha: SHA },
          { path: "vendor/lib", mode: "160000", type: "commit", sha: SHA },
        ],
        {
          "src/index.ts": { type: "file", encoding: "base64", content: b64(src), size: src.length, sha: SHA },
          "src/app.tsx": { type: "file", encoding: "base64", content: b64(app), size: app.length, sha: SHA },
        }
      );
      const r = await runGitHubIntake("acme", "api", "main", provider, { collectedAt: AT });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.snapshot.sourceKind).toBe("github");
      expect(r.snapshot.resolvedCommitIfGitHub).toBe(SHA);
      expect(r.snapshot.canonicalProvenance).toBe("https://github.com/acme/api");
      expect(r.snapshot.files.map((f) => f.path)).toEqual(["src/app.tsx", "src/index.ts"]);
      expect(Object.fromEntries(r.snapshot.skipped.map((s) => [s.path, s.reason]))).toEqual({
        "README.md": "unsupported-language",
        "link.ts": "symlink",
        "vendor/lib": "submodule",
      });
    } finally {
      stub.mockRestore();
    }
  });
  it("refuses a truncated tree listing instead of minting complete:true", async () => {
    const { provider } = providerWithTree([{ path: "a.ts", mode: "100644", type: "blob", size: 3 }], {}, { truncated: true });
    const r = await runGitHubIntake("acme", "api", "main", provider, { collectedAt: AT });
    expect(r).toMatchObject({ ok: false, code: "PROVIDER_UNAVAILABLE" });
  });
  it("fails closed on LFS pointers at .ts paths (never presents pointer as source)", async () => {
    const good = "export const ok = 1;\n";
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n";
    const { provider } = providerWithTree(
      [
        { path: "src/0-good.ts", mode: "100644", type: "blob", size: good.length, sha: SHA },
        { path: "src/big.ts", mode: "100644", type: "blob", size: pointer.length, sha: SHA },
      ],
      {
        "src/0-good.ts": { type: "file", encoding: "base64", content: b64(good), size: good.length, sha: SHA },
        "src/big.ts": { type: "file", encoding: "base64", content: b64(pointer), size: pointer.length, sha: SHA },
      }
    );
    const r = await runGitHubIntake("acme", "api", "main", provider, { collectedAt: AT });
    expect(r).toMatchObject({ ok: false, code: "PROVIDER_UNAVAILABLE" });
    if (!r.ok) {
      // Partial preserves the already-collected file with the real SHA;
      // the pointer itself is never collected as source.
      expect(r.partial?.resolvedCommitIfGitHub).toBe(SHA);
      expect(r.partial?.files.map((f) => f.path)).toEqual(["src/0-good.ts"]);
    }
  });
  it("uses the blob fallback when contents withholds the body", async () => {
    const src = "export const y = 2;\n";
    const blobSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const blobUrl = buildBlobUrl("acme", "api", blobSha);
    const routes: Record<string, GitHubApiResponse> = {
      [buildCommitUrl("acme", "api", "main")]: jsonResponse(200, { sha: SHA }),
      [treeUrl]: jsonResponse(200, {
        sha: SHA,
        tree: [{ path: "src/y.ts", mode: "100644", type: "blob", size: src.length, sha: blobSha }],
        truncated: false,
      }),
      [fileUrl("src/y.ts")]: jsonResponse(200, { sha: blobSha, size: src.length }),
      [blobUrl]: jsonResponse(200, { sha: blobSha, encoding: "base64", content: b64(src), size: src.length }),
    };
    const { fetchFn, calls } = mockTransport(routes);
    const r = await runGitHubIntake("acme", "api", "main", new GitHubRestProvider({ fetchFn }), { collectedAt: AT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.files.map((f) => f.path)).toEqual(["src/y.ts"]);
    expect(calls.map((c) => c.url)).toContain(blobUrl);
  });
  it("rejects invalid base64 without executing anything", () => {
    expect(() => decodeBase64ToBytes("!!!not-base64!!!")).toThrowError(expect.objectContaining({ code: "MALFORMED" }));
    expect(decodeBase64ToBytes(b64("hi"))).toEqual(enc.encode("hi"));
  });
  it("detects LFS pointers and ignores binary/short buffers", () => {
    expect(isLfsPointer(enc.encode("version https://git-lfs.github.com/spec/v1\noid x\n"))).toBe(true);
    expect(isLfsPointer(enc.encode("export const x = 1;\n"))).toBe(false);
    expect(isLfsPointer(new Uint8Array(0))).toBe(false);
    expect(isLfsPointer(new Uint8Array([0xff, 0xfe, 0x00]))).toBe(false);
  });
  it("per-request timeout maps to TIMEOUT, caller abort stays AbortError (offline)", async () => {
    const hanging: GitHubApiFetch = (_url, init) =>
      new Promise<GitHubApiResponse>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    const timedOut = new GitHubRestProvider({ fetchFn: hanging, requestTimeoutMs: 50 });
    await expect(timedOut.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    const controller = new AbortController();
    const userCancelled = new GitHubRestProvider({ fetchFn: hanging, requestTimeoutMs: 5000 });
    const pending = userCancelled.resolveRef("acme", "api", "main", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  }, 10_000);
});

describe("github-provider — transport hardening 002 (offline, adversarial)", () => {
  it("immutable allowlist: frozen host+protocol, every request uses redirect:manual", async () => {
    expect(GITHUB_API_ALLOWLIST.host).toBe("api.github.com");
    expect(GITHUB_API_ALLOWLIST.protocol).toBe("https:");
    expect(Object.isFrozen(GITHUB_API_ALLOWLIST)).toBe(true);
    const commitUrl = buildCommitUrl("acme", "api", "main");
    const { fetchFn, calls } = mockTransport({ [commitUrl]: jsonResponse(200, { sha: SHA }) });
    const provider = new GitHubRestProvider({ fetchFn });
    await provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.url.startsWith("https://api.github.com/")).toBe(true);
  });
  it("fails closed on 3xx: never follows redirects (301/302/307/308)", async () => {
    for (const status of [301, 302, 307, 308]) {
      const commitUrl = buildCommitUrl("acme", "api", "main");
      const { fetchFn, calls } = mockTransport({
        [commitUrl]: jsonResponse(status, { sha: SHA }, { location: "https://evil.example/x" }),
      });
      const provider = new GitHubRestProvider({ fetchFn });
      await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
      });
      expect(calls[0]?.init.redirect).toBe("manual");
      expect(calls).toHaveLength(1);
    }
    expect(() => throwForStatus(301, { get: () => null }, "X")).toThrowError(
      expect.objectContaining({ code: "PROVIDER_UNAVAILABLE" })
    );
  });
  it("Content-Length pre-check rejects oversized JSON before reading the body", async () => {
    const commitUrl = buildCommitUrl("acme", "api", "main");
    const tracker = { texts: 0, jsons: 0 };
    const { fetchFn } = mockTransport({
      [commitUrl]: rawResponse(200, JSON.stringify({ sha: SHA }), { "content-length": String(MAX_JSON_BYTES + 1) }, tracker),
    });
    const provider = new GitHubRestProvider({ fetchFn });
    await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(tracker.texts).toBe(0);
    expect(tracker.jsons).toBe(0);
  });
  it("oversized JSON body fails before parsing even without Content-Length (lazy stream, never buffered)", async () => {
    const commitUrl = buildCommitUrl("acme", "api", "main");
    // 4x-cap planned payload generated lazily: no MB-scale string is ever
    // built — the harness holds only the small header/fill/footer buffers.
    const pulls = { n: 0 };
    const texts = { n: 0 };
    const { res, plannedTotal, jsonCalls } = lazyOversizedJsonResponse({ pulls, texts });
    expect(plannedTotal).toBeGreaterThan(2 * MAX_JSON_BYTES);
    const { fetchFn } = mockTransport({ [commitUrl]: res });
    const provider = new GitHubRestProvider({ fetchFn });
    await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(jsonCalls()).toBe(0);
    expect(texts.n).toBe(0); // streamed under the cap path; text() never buffered
    // Provider-side retention stays near the cap: pulled bytes stay within
    // cap + 2 chunks, while most of the 4x-cap planned body is never even
    // generated (planned but unpulled bytes were allocated nowhere).
    const pulled = pulls.n * 4096;
    expect(pulled).toBeLessThanOrEqual(MAX_JSON_BYTES + 2 * 4096);
    expect(plannedTotal - pulled).toBeGreaterThanOrEqual(2 * MAX_JSON_BYTES);
  });
  it("oversized blob body fails BEFORE base64 decoding (never decoded into bytes)", async () => {
    const fileUrl = buildContentUrl("acme", "api", "src/big.ts", SHA);
    // Valid base64 whose decoded length exceeds the file cap; declared size
    // is small so only the pre-decode length check can fire. The base64
    // string itself is upstream test input — the provider retains no decoded
    // bytes, it rejects from the length math alone.
    const over = "A".repeat(Math.ceil(((MAX_FILE_BYTES + 16) * 4) / 3));
    expect(decodedBase64ByteLength(over)).toBeGreaterThan(MAX_FILE_BYTES);
    const { fetchFn } = mockTransport({
      [fileUrl]: jsonResponse(200, { type: "file", encoding: "base64", content: over, size: 10, sha: SHA }),
    });
    const provider = new GitHubRestProvider({ fetchFn });
    await expect(drain(provider.openFile("acme", "api", SHA, "src/big.ts", AbortSignal.timeout(5000)))).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
  });
  it("declared oversized size fails closed before fetching the blob fallback", async () => {
    const fileUrl = buildContentUrl("acme", "api", "src/huge.ts", SHA);
    const blobSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { fetchFn, calls } = mockTransport({
      [fileUrl]: jsonResponse(200, { sha: blobSha, size: MAX_FILE_BYTES + 1 }),
    });
    const provider = new GitHubRestProvider({ fetchFn });
    await expect(drain(provider.openFile("acme", "api", SHA, "src/huge.ts", AbortSignal.timeout(5000)))).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    // Blob endpoint must never be fetched once the declared size fails.
    expect(calls.map((c) => c.url).some((u) => u.includes("/git/blobs/"))).toBe(false);
  });
  it("rejects dot segments: literal, encoded, double-encoded, separators, empties", () => {
    for (const bad of [
      ".",
      "..",
      "a/../b.ts",
      "./b.ts",
      "a/./b.ts",
      "%2e",
      "%2E",
      "%2e%2e",
      "a/%2e%2e/b.ts",
      ".%2e/%2e%2e/b.ts",
      "%252e%252e",
      "a/%252e%252e/b.ts",
      "%252e",
      "a%2fb.ts",
      "a%2Fb.ts",
      "a%5cb.ts",
      "a//b.ts",
      "a/",
      "a/./",
    ]) {
      expect(() => buildContentUrl("acme", "api", bad, SHA), bad).toThrow();
      expect(() => rejectDotSegments(bad), bad).toThrow();
    }
    // Legal names with bare "%" or spaces still build.
    expect(() => buildContentUrl("acme", "api", "100%.ts", SHA)).not.toThrow();
    expect(() => buildContentUrl("acme", "api", "src/my file.ts", SHA)).not.toThrow();
    expect(decodedBase64ByteLength(btoa("hi"))).toBe(2);
  });
  it("uncooperative giant tree JSON fails at the transport cap (entry cap never reached)", async () => {
    const treeUrl = buildTreeUrl("acme", "api", SHA);
    // Lazily planned 4x-cap tree body: no MB-scale string is ever built.
    // Content past the cap is irrelevant — parsing is never reached.
    const pulls = { n: 0 };
    const { res, plannedTotal, jsonCalls } = lazyOversizedJsonResponse({
      pulls,
      header: `{"sha":"${SHA}","tree":[{"path":"p`,
      footer: `","mode":"100644","type":"blob","size":1}],"truncated":false}`,
    });
    expect(plannedTotal).toBeGreaterThan(2 * MAX_JSON_BYTES);
    const { fetchFn } = mockTransport({
      [buildCommitUrl("acme", "api", "main")]: jsonResponse(200, { sha: SHA }),
      [treeUrl]: res,
    });
    const r = await runGitHubIntake("acme", "api", "main", new GitHubRestProvider({ fetchFn }), { collectedAt: AT });
    expect(r.ok).toBe(false);
    expect(jsonCalls()).toBe(0);
    const pulled = pulls.n * 4096;
    expect(pulled).toBeLessThanOrEqual(MAX_JSON_BYTES + 2 * 4096);
    expect(plannedTotal - pulled).toBeGreaterThanOrEqual(2 * MAX_JSON_BYTES);
  });
  it("malformed base64 length helper fails closed without decoding", () => {
    expect(decodedBase64ByteLength("!!!")).toBe(Number.POSITIVE_INFINITY);
    expect(decodedBase64ByteLength("A".repeat(MAX_FILE_BYTES * 2))).toBeGreaterThan(MAX_FILE_BYTES);
  });
});

describe("github-provider — transport hardening 003 (offline, adversarial)", () => {
  const commitUrl = buildCommitUrl("acme", "api", "main");

  it("streams JSON under the byte cap with ABSENT Content-Length (lazy 4x-cap plan; bounded retention)", async () => {
    // Planned payload is 4x the cap but generated lazily — no MB-scale
    // string is ever allocated by the harness. Unpulled planned bytes are
    // never generated anywhere, which is strictly stronger than 004's
    // "preallocated upstream input left unpulled".
    const pulls = { n: 0 };
    const texts = { n: 0 };
    const { res, plannedTotal, jsonCalls } = lazyOversizedJsonResponse({ pulls, texts }); // no content-length at all
    const { fetchFn } = mockTransport({ [commitUrl]: res });
    const provider = new GitHubRestProvider({ fetchFn });
    await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(jsonCalls()).toBe(0); // parsed never; transport json() never used
    expect(texts.n).toBe(0); // never buffered via text()
    // Provider-side retention stays near the cap; the planned remainder is
    // substantial and was never generated.
    const pulled = pulls.n * 4096;
    expect(pulled).toBeLessThanOrEqual(MAX_JSON_BYTES + 2 * 4096);
    expect(plannedTotal - pulled).toBeGreaterThanOrEqual(2 * MAX_JSON_BYTES);
  });

  it("understated Content-Length cannot smuggle a giant body past the streaming cap (lazy 4x-cap plan)", async () => {
    const pulls = { n: 0 };
    const texts = { n: 0 };
    const { res, plannedTotal, jsonCalls } = lazyOversizedJsonResponse({ pulls, texts, contentLength: "10" }); // lies: declares 10
    const { fetchFn } = mockTransport({ [commitUrl]: res });
    const provider = new GitHubRestProvider({ fetchFn });
    await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(jsonCalls()).toBe(0);
    expect(texts.n).toBe(0);
    const pulled = pulls.n * 4096;
    expect(pulled).toBeLessThanOrEqual(MAX_JSON_BYTES + 2 * 4096);
    expect(plannedTotal - pulled).toBeGreaterThanOrEqual(2 * MAX_JSON_BYTES);
  });

  it("giant stream is cut at the cap even when served in small chunks (lazy 4x-cap plan)", async () => {
    const pulls = { n: 0 };
    const texts = { n: 0 };
    const { res, plannedTotal, jsonCalls } = lazyOversizedJsonResponse({ pulls, texts, chunkSize: 1024 });
    const { fetchFn } = mockTransport({ [commitUrl]: res });
    const provider = new GitHubRestProvider({ fetchFn });
    await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(jsonCalls()).toBe(0);
    expect(texts.n).toBe(0);
    const pulled = pulls.n * 1024;
    expect(pulled).toBeLessThanOrEqual(MAX_JSON_BYTES + 2 * 1024);
    expect(plannedTotal - pulled).toBeGreaterThanOrEqual(2 * MAX_JSON_BYTES);
  });

  it("absent body fails closed without buffering via text()", async () => {
    // A response with no body at all must fail closed: the provider never
    // falls back to text(), which would buffer an unbounded body.
    let texts = 0;
    const res: GitHubApiResponse = {
      status: 200,
      headers: { get: () => null },
      text: async () => {
        texts += 1;
        throw new Error("text() must never be called for an absent body");
      },
      json: async () => {
        throw new Error("json() must never be called");
      },
      body: undefined,
    };
    const { fetchFn } = mockTransport({ [commitUrl]: res });
    const provider = new GitHubRestProvider({ fetchFn });
    await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(texts).toBe(0);
  });

  it("null body fails closed without buffering via text()", async () => {
    // Built-in fetch types body as nullable; null is fail-closed, not buffered.
    let texts = 0;
    const res: GitHubApiResponse = {
      status: 200,
      headers: { get: () => null },
      text: async () => {
        texts += 1;
        throw new Error("text() must never be called for a null body");
      },
      json: async () => {
        throw new Error("json() must never be called");
      },
      body: null,
    };
    const { fetchFn } = mockTransport({ [commitUrl]: res });
    const provider = new GitHubRestProvider({ fetchFn });
    await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(texts).toBe(0);
  });

  it("never-settling transport that ignores abort still settles TIMEOUT", async () => {
    const hanging: GitHubApiFetch = () => new Promise<GitHubApiResponse>(() => {});
    const provider = new GitHubRestProvider({ fetchFn: hanging, requestTimeoutMs: 60 });
    const start = Date.now();
    await expect(
      provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - start).toBeLessThan(5000);
  }, 10_000);

  it("never-settling body (hung text and hung stream) still settles TIMEOUT", async () => {
    const hungText: GitHubApiResponse = {
      status: 200,
      headers: { get: () => null },
      text: () => new Promise<string>(() => {}),
      json: async () => {
        throw new Error("json() must never be called");
      },
      body: new ReadableStream<Uint8Array>({ start() {} }),
    };
    const { fetchFn } = mockTransport({ [commitUrl]: hungText });
    const provider = new GitHubRestProvider({ fetchFn, requestTimeoutMs: 60 });
    const start = Date.now();
    await expect(
      provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - start).toBeLessThan(5000);
  }, 10_000);

  it("real-fetch TimeoutError maps to TIMEOUT; caller-side timeout propagates as caller abort", async () => {
    // Real fetch rejects with TimeoutError (not AbortError) when OUR deadline fires.
    const ourTimeout: GitHubApiFetch = (_url, init) =>
      new Promise<GitHubApiResponse>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("fetch timed out", "TimeoutError")), {
          once: true,
        });
      });
    const provider = new GitHubRestProvider({ fetchFn: ourTimeout, requestTimeoutMs: 60 });
    await expect(
      provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))
    ).rejects.toMatchObject({ code: "TIMEOUT" });

    // Caller-owned timeout: the caller's TimeoutError is THEIR abort, not ours.
    const callerTimeout = AbortSignal.timeout(40);
    const hanging: GitHubApiFetch = () => new Promise<GitHubApiResponse>(() => {});
    const patient = new GitHubRestProvider({ fetchFn: hanging, requestTimeoutMs: 5000 });
    const err = await patient.resolveRef("acme", "api", "main", callerTimeout).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("TimeoutError");
    expect(err).toBe(callerTimeout.reason); // caller's own abort reason propagates verbatim
  }, 10_000);

  it("accepts digit filenames and legal percent-encoded names", () => {
    for (const p of ["0.ts", "123.ts", "007/a.ts", "src/v2/x1.ts"]) {
      expect(() => buildContentUrl("acme", "api", p, SHA), p).not.toThrow();
      expect(() => rejectDotSegments(p), p).not.toThrow();
    }
    for (const p of ["100%.ts", "100%25.ts", "my file.ts", "a+b.ts", "v1.0.ts"]) {
      expect(() => buildContentUrl("acme", "api", p, SHA), p).not.toThrow();
    }
  });

  it("rejects raw, encoded, and double-encoded control characters", () => {
    for (const bad of ["a\0b.ts", "a\x01b.ts", "a\x7fb.ts", "a%00b.ts", "a%01b.ts", "a%7fb.ts", "a%7Fb.ts"]) {
      expect(() => buildContentUrl("acme", "api", bad, SHA), bad).toThrow();
      expect(() => rejectDotSegments(bad), bad).toThrow();
    }
    // Double-encoded controls smuggle past a single decode: must still fail.
    for (const bad of ["a%2500b.ts", "a%2501b.ts", "a%257fb.ts", "a%257Fb.ts", "%2500.ts"]) {
      expect(() => buildContentUrl("acme", "api", bad, SHA), bad).toThrow();
      expect(() => rejectDotSegments(bad), bad).toThrow();
    }
  });

  it("rejects encoded traversal variants, allows inert triple-encoding", () => {
    for (const bad of ["%2e%2e/a.ts", "%252e%252e/a.ts", "..%2fa.ts"]) {
      expect(() => buildContentUrl("acme", "api", bad, SHA), bad).toThrow();
    }
    // Triple-encoded dot stays inert after two decodes (API single-decodes to a legal literal).
    expect(() => buildContentUrl("acme", "api", "a%25252eb.ts", SHA)).not.toThrow();
  });
});

describe("github-provider — owned retention + best-effort cancel 005 (offline)", () => {
  const commitUrl = buildCommitUrl("acme", "api", "main");

  it("toOwnedBytes copies small views out of oversized backing buffers", () => {
    const backing = new ArrayBuffer(8 * 1024 * 1024);
    const view = new Uint8Array(backing, 7_000_000, 16);
    for (let i = 0; i < view.length; i++) view[i] = i + 1;
    const owned = toOwnedBytes(view);
    expect(owned).toEqual(view);
    // Owned storage is exactly the view's bytes: retaining it cannot pin
    // the 8MB backing buffer.
    expect(owned.buffer.byteLength).toBe(owned.byteLength);
    // Mutation isolation: later writes to the backing buffer are invisible.
    view[0] = 0xff;
    expect(owned[0]).toBe(1);
  });

  it("small valid body served as tiny views into a huge buffer parses correctly", async () => {
    const raw = JSON.stringify({ sha: SHA });
    const bytes = enc.encode(raw);
    // Scatter the body across a 4MB backing buffer in 7-byte views: the
    // provider must reassemble the exact bytes (it copies each view on
    // retain, so the shared buffer is never pinned by the result).
    const backing = new ArrayBuffer(4 * 1024 * 1024);
    const views: Uint8Array[] = [];
    const base = 3_000_000;
    for (let off = 0; off < bytes.length; off += 7) {
      const len = Math.min(7, bytes.length - off);
      new Uint8Array(backing, base + off, len).set(bytes.subarray(off, off + len));
      views.push(new Uint8Array(backing, base + off, len));
    }
    let idx = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (idx < views.length) controller.enqueue(views[idx++]!);
        else controller.close();
      },
    });
    const res: GitHubApiResponse = {
      status: 200,
      headers: { get: () => null },
      text: async () => {
        throw new Error("text() must never be called");
      },
      json: async () => {
        throw new Error("json() must never be called");
      },
      body,
    };
    const provider = new GitHubRestProvider({ fetchFn: mockTransport({ [commitUrl]: res }).fetchFn });
    await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).resolves.toEqual({
      sha: SHA,
    });
  });

  it("oversized lazy stream fires best-effort cancel but keeps the primary error", async () => {
    const pulls = { n: 0 };
    const cancels = { n: 0 };
    const { res, plannedTotal, jsonCalls } = lazyOversizedJsonResponse({ pulls, cancels });
    const provider = new GitHubRestProvider({ fetchFn: mockTransport({ [commitUrl]: res }).fetchFn });
    await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(jsonCalls()).toBe(0);
    expect(cancels.n).toBeGreaterThanOrEqual(1); // cleanup fired, never awaited
    const pulled = pulls.n * 4096;
    expect(pulled).toBeLessThanOrEqual(MAX_JSON_BYTES + 2 * 4096);
    expect(plannedTotal - pulled).toBeGreaterThanOrEqual(2 * MAX_JSON_BYTES);
  });

  it("a rejecting stream cancel() is swallowed: primary error still wins", async () => {
    const cancels = { n: 0 };
    const { res, jsonCalls } = lazyOversizedJsonResponse({ cancels, rejectCancel: true });
    const provider = new GitHubRestProvider({ fetchFn: mockTransport({ [commitUrl]: res }).fetchFn });
    // A cancel rejection must not surface and must not become an unhandled
    // rejection — the overshoot error is the only outcome.
    await expect(provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(jsonCalls()).toBe(0);
    expect(cancels.n).toBeGreaterThanOrEqual(1);
  });

  it("abort while blocked in read() nudges cancel; TIMEOUT still owns the outcome", async () => {
    const cancels = { n: 0 };
    const hung: GitHubApiResponse = {
      status: 200,
      headers: { get: () => null },
      text: () => new Promise<string>(() => {}),
      json: async () => {
        throw new Error("json() must never be called");
      },
      body: new ReadableStream<Uint8Array>({
        start() {},
        cancel() {
          cancels.n += 1;
        },
      }),
    };
    const provider = new GitHubRestProvider({
      fetchFn: mockTransport({ [commitUrl]: hung }).fetchFn,
      requestTimeoutMs: 60,
    });
    const start = Date.now();
    await expect(
      provider.resolveRef("acme", "api", "main", AbortSignal.timeout(5000))
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - start).toBeLessThan(5000);
    // The abort hook fires on the deadline's own signal; allow a brief
    // settle window since the timer and the signal race each other.
    const deadline = Date.now() + 2000;
    while (cancels.n < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(cancels.n).toBeGreaterThanOrEqual(1);
  }, 10_000);

  it("openFile yields owned chunks that cannot pin the decoded file buffer", async () => {
    const src = "export const owned = 1;\n";
    const fileUrl = buildContentUrl("acme", "api", "src/owned.ts", SHA);
    const treeUrl = buildTreeUrl("acme", "api", SHA);
    const routes: Record<string, GitHubApiResponse> = {
      [buildCommitUrl("acme", "api", "main")]: jsonResponse(200, { sha: SHA }),
      [treeUrl]: jsonResponse(200, {
        sha: SHA,
        tree: [{ path: "src/owned.ts", mode: "100644", type: "blob", size: src.length, sha: SHA }],
        truncated: false,
      }),
      [fileUrl]: jsonResponse(200, { type: "file", encoding: "base64", content: b64(src), size: src.length, sha: SHA }),
    };
    const { fetchFn } = mockTransport(routes);
    const provider = new GitHubRestProvider({ fetchFn });
    const chunks: Uint8Array[] = [];
    for await (const c of provider.openFile("acme", "api", SHA, "src/owned.ts", AbortSignal.timeout(5000))) {
      chunks.push(c);
    }
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const c of chunks) {
      expect(c.buffer.byteLength).toBe(c.byteLength);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      joined.set(c, off);
      off += c.length;
    }
    expect(new TextDecoder().decode(joined)).toBe(src);
    expect(total).toBe(enc.encode(src).length);
  });
});

describe("github-provider — Buffer-owned copies 006 (offline)", () => {
  it("premise: Buffer.slice() shares storage, so slice-dispatch cannot own bytes", () => {
    const buf = Buffer.alloc(1024, 0x41);
    const sub = buf.slice(100, 116);
    sub[0] = 0x42;
    // Shared, not copied: writing the view mutates the original, and the
    // view's backing buffer is far larger than the view. If a future Node
    // ever made Buffer.slice copy, this test fails loudly instead of
    // silently blessing a slice-based toOwnedBytes.
    expect(buf[100]).toBe(0x42);
    expect(sub.byteLength).toBe(16);
    expect(sub.buffer.byteLength).toBeGreaterThan(sub.byteLength);
  });

  it("toOwnedBytes(Buffer) creates independent storage of exactly the accepted length", () => {
    const buf = Buffer.alloc(1024, 0x41);
    const sub = buf.slice(100, 116);
    const owned = toOwnedBytes(sub);
    // Byte-identical (compared structurally-neutrally: owned is a base
    // Uint8Array by design, never a Buffer, so toEqual's type tag differs).
    expect(Array.from(owned)).toEqual(Array.from(sub));
    expect(owned.byteLength).toBe(16);
    expect(owned.buffer.byteLength).toBe(owned.byteLength);
    expect(Buffer.isBuffer(owned)).toBe(false);
  });

  it("mutating the original cannot change the copy", () => {
    const buf = Buffer.alloc(1024, 0x41);
    const owned = toOwnedBytes(buf.slice(100, 116));
    buf[100] = 0x99;
    buf.fill(0x00);
    expect(owned[0]).toBe(0x41);
    expect(owned.buffer.byteLength).toBe(16);
  });

  it("mutating the copy cannot change the original", () => {
    const buf = Buffer.alloc(1024, 0x41);
    const sub = buf.slice(100, 116);
    const owned = toOwnedBytes(sub);
    owned[0] = 0x99;
    owned.fill(0x00);
    expect(sub[0]).toBe(0x41);
    expect(buf[100]).toBe(0x41);
  });

  it("toOwnedBytes handles plain views and zero-length inputs", () => {
    const backing = new ArrayBuffer(4096);
    const view = new Uint8Array(backing, 1000, 32);
    view.fill(0x5a);
    const owned = toOwnedBytes(view);
    expect(owned).toEqual(view);
    expect(owned.buffer.byteLength).toBe(32);
    const empty = toOwnedBytes(new Uint8Array(0));
    expect(empty.byteLength).toBe(0);
  });

  it("openFile over multiple 64-KiB chunks yields independently owned chunks", async () => {
    // Deterministic source just over 3x the 64KiB yield quantum, well under
    // the 512KiB file cap.
    let src = "";
    let i = 0;
    while (enc.encode(src).length <= 3 * 64 * 1024) {
      src += `export const chunked${i} = ${i};\n`;
      i += 1;
    }
    const srcBytes = enc.encode(src).length;
    expect(srcBytes).toBeGreaterThan(2 * 64 * 1024);
    expect(srcBytes).toBeLessThan(MAX_FILE_BYTES);
    const fileUrl = buildContentUrl("acme", "api", "src/big.ts", SHA);
    const treeUrl = buildTreeUrl("acme", "api", SHA);
    const routes: Record<string, GitHubApiResponse> = {
      [buildCommitUrl("acme", "api", "main")]: jsonResponse(200, { sha: SHA }),
      [treeUrl]: jsonResponse(200, {
        sha: SHA,
        tree: [{ path: "src/big.ts", mode: "100644", type: "blob", size: srcBytes, sha: SHA }],
        truncated: false,
      }),
      [fileUrl]: jsonResponse(200, {
        type: "file",
        encoding: "base64",
        content: b64(src),
        size: srcBytes,
        sha: SHA,
      }),
    };
    const provider = new GitHubRestProvider({ fetchFn: mockTransport(routes).fetchFn });
    const chunks: Uint8Array[] = [];
    for await (const c of provider.openFile("acme", "api", SHA, "src/big.ts", AbortSignal.timeout(5000))) {
      chunks.push(c);
    }
    // Spans multiple 64-KiB quanta, and no retained chunk pins the whole
    // decoded file buffer.
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.buffer.byteLength).toBe(c.byteLength);
    }
    const joined = new Uint8Array(srcBytes);
    let off = 0;
    for (const c of chunks) {
      joined.set(c, off);
      off += c.length;
    }
    expect(off).toBe(srcBytes);
    expect(new TextDecoder().decode(joined)).toBe(src);
  });
});
