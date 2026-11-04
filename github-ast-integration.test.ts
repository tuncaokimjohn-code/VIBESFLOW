/**
 * OFFLINE GitHub-to-AST integration tests (Candidate 001).
 * All HTTP is a mocked GitHubApiFetch injected into GitHubRestProvider;
 * no live GitHub request is made and no repository code is executed.
 */
import { describe, expect, it, vi } from "vitest";
import { GitHubRestProvider, buildCommitUrl, buildContentUrl, buildTreeUrl, type GitHubApiFetch, type GitHubApiResponse } from "@/lib/github-provider";
import { runGitHubToAst, createGitHubAstPost } from "@/lib/github-ast-server";
import { validateEvidence } from "@/lib/evidence";
import { sha256Hex, sha256Text } from "@/lib/source-snapshot";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const enc = new TextEncoder();
const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

function streamBody(raw: string): ReadableStream<Uint8Array> {
  const bytes = enc.encode(raw);
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (off >= bytes.length) { c.close(); return; }
      const end = Math.min(off + 4096, bytes.length);
      c.enqueue(bytes.subarray(off, end));
      off = end;
    },
  });
}
function jsonResponse(status: number, body: unknown): GitHubApiResponse {
  const raw = JSON.stringify(body);
  return { status, headers: { get: () => null }, text: async () => raw, json: async () => body, body: streamBody(raw) };
}

const FILES: Record<string, string> = {
  "src/index.ts": 'import { helper } from "./util";\nexport const main = (): number => helper();\n',
  "src/util.ts": "export function helper(): number {\n  return 42;\n}\n",
  "README.md": "# fixture\n",
};

function mockFetch(opts: { failAt?: string; truncated?: boolean; extraTree?: unknown[] } = {}) {
  const calls: string[] = [];
  const fetchFn: GitHubApiFetch = async (url) => {
    calls.push(url);
    if (opts.failAt && url.includes(opts.failAt)) throw new Error("mock transport down");
    if (url === buildCommitUrl("acme", "demo", "main")) return jsonResponse(200, { sha: SHA });
    if (url === buildTreeUrl("acme", "demo", SHA)) {
      const tree = [
        ...Object.entries(FILES).map(([path, text]) => ({ path, mode: "100644", type: "blob", size: enc.encode(text).length, sha: "b".repeat(40) })),
        ...(opts.extraTree ?? []),
      ];
      return jsonResponse(200, { tree, truncated: opts.truncated ?? false });
    }
    for (const [path, text] of Object.entries(FILES)) {
      if (url === buildContentUrl("acme", "demo", path, SHA)) {
        return jsonResponse(200, { type: "file", encoding: "base64", content: b64(text), size: enc.encode(text).length, sha: "b".repeat(40) });
      }
    }
    return jsonResponse(404, { message: "not found" });
  };
  return { fetchFn, calls };
}

const provider = (fetchFn: GitHubApiFetch) => new GitHubRestProvider({ fetchFn });
const AT = "2026-10-30T00:00:00.000Z";

describe("GitHub-to-AST mocked integration", () => {
  it("1-5: resolves pinned SHA, snapshots real fixture source, builds source-backed graph", async () => {
    const { fetchFn, calls } = mockFetch();
    const r = await runGitHubToAst({ owner: "acme", repo: "demo", ref: "main", provider: provider(fetchFn), collectedAt: AT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.resolvedCommitIfGitHub).toBe(SHA);
    expect(r.snapshot.canonicalProvenance).toBe("https://github.com/acme/demo");
    expect(r.snapshot.files.map((f) => f.path)).toEqual(["src/index.ts", "src/util.ts"]);
    expect(r.snapshot.skipped.some((s) => s.path === "README.md")).toBe(true);
    expect(r.contents.get("src/util.ts")).toContain("export function helper");
    const util = r.snapshot.files.find((f) => f.path === "src/util.ts");
    expect(util?.sha256).toBe(sha256Hex(enc.encode(FILES["src/util.ts"])));
    const mods = r.graph.nodes.filter((n) => n.kind === "module").map((n) => n.module).sort();
    expect(mods).toEqual(["src/index.ts", "src/util.ts"]);
    expect(r.graph.edges.some((e) => e.kind === "imports")).toBe(true);
    expect(r.graph.nodes.some((n) => n.label === "helper")).toBe(true);
    expect(r.shapeOk).toBe(true);
    const ev = await validateEvidence(r.graph, r.snapshot, r.contents, (t) => sha256Text(t));
    expect(ev.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((u) => u.startsWith("https://api.github.com/repos/acme/demo/"))).toBe(true);
  });

  it("7: invalid URL rejected by handler without any transport call", async () => {
    const { fetchFn, calls } = mockFetch();
    const post = createGitHubAstPost(() => provider(fetchFn));
    const res = await post(new Request("http://local/api/github-ast", { method: "POST", body: JSON.stringify({ url: "https://evil.example/x/y" }) }));
    expect(res.status).toBe(422);
    expect(calls).toEqual([]);
  });

  it("8: truncated tree and unsafe/symlink entries are handled conservatively", async () => {
    const t = mockFetch({ truncated: true });
    const r1 = await runGitHubToAst({ owner: "acme", repo: "demo", ref: "main", provider: provider(t.fetchFn), collectedAt: AT });
    expect(r1.ok).toBe(false);
    const s = mockFetch({ extraTree: [
      { path: "link.ts", mode: "120000", type: "blob", size: 4, sha: "c".repeat(40) },
      { path: "../evil.ts", mode: "100644", type: "blob", size: 4, sha: "c".repeat(40) },
      { path: "bin.ts", mode: "100644", type: "blob", size: 4, sha: "c".repeat(40) },
    ] });
    // bin.ts has no contents route -> 404 -> skipped, never in graph
    const r2 = await runGitHubToAst({ owner: "acme", repo: "demo", ref: "main", provider: provider(s.fetchFn), collectedAt: AT });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.graph.nodes.some((n) => n.module.includes("evil"))).toBe(false);
      expect(r2.graph.nodes.some((n) => n.module === "link.ts")).toBe(false);
      expect(r2.graph.nodes.some((n) => n.module === "bin.ts")).toBe(false);
    }
  });

  it("9: mocked network failure and abort are reported honestly", async () => {
    const f = mockFetch({ failAt: "/commits/" });
    const r = await runGitHubToAst({ owner: "acme", repo: "demo", ref: "main", provider: provider(f.fetchFn), collectedAt: AT });
    expect(r.ok).toBe(false);
    const ok = mockFetch();
    const ctl = new AbortController();
    ctl.abort();
    const r2 = await runGitHubToAst({ owner: "acme", repo: "demo", ref: "main", provider: provider(ok.fetchFn), signal: ctl.signal, collectedAt: AT });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("CANCELLED");
  });

  it("10: hash/provenance mismatch in contents is rejected by evidence validation", async () => {
    const { fetchFn } = mockFetch();
    const r = await runGitHubToAst({ owner: "acme", repo: "demo", ref: "main", provider: provider(fetchFn), collectedAt: AT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const forged = new Map(r.contents);
    forged.set("src/util.ts", "export function helper(): number {\n  return 43;\n}\n");
    const ev = await validateEvidence(r.graph, r.snapshot, forged, (t) => sha256Text(t));
    expect(ev.ok).toBe(false);
  });

  it("11: sequential repositories do not contaminate each other", async () => {
    const a = mockFetch();
    const r1 = await runGitHubToAst({ owner: "acme", repo: "demo", ref: "main", provider: provider(a.fetchFn), collectedAt: AT });
    const b = mockFetch({ failAt: "/git/trees/" });
    const r2 = await runGitHubToAst({ owner: "acme", repo: "demo", ref: "main", provider: provider(b.fetchFn), collectedAt: AT });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (r1.ok) expect(r1.graph.nodes.length).toBeGreaterThan(0);
  });

  it("handler returns graph + contents bound to the pinned commit", async () => {
    const { fetchFn } = mockFetch();
    const post = createGitHubAstPost(() => provider(fetchFn));
    const res = await post(new Request("http://local/api/github-ast", { method: "POST", body: JSON.stringify({ url: "github.com/acme/demo/tree/main" }) }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; synthetic: boolean; snapshot: { resolvedCommitIfGitHub: string }; graph: { nodes: unknown[] } };
    expect(data.ok).toBe(true);
    expect(data.synthetic).toBe(false);
    expect(data.snapshot.resolvedCommitIfGitHub).toBe(SHA);
    expect(data.graph.nodes.length).toBeGreaterThan(0);
  });
});
