/** C013 offline quota/privacy regressions. Transport and credentials are synthetic. */
import { describe, expect, it, vi } from "vitest";
import { GitHubRestProvider, type GitHubApiFetch } from "@/lib/github-provider";
import { PublicGitHubRestProvider } from "@/lib/github-public-server";

const ROOT = "https://api.github.com/repos/acme/demo";
const SHA = "a".repeat(40), BLOB = "b".repeat(40);
const TOKEN = "C013_SYNTHETIC_ONLY";
const signal = () => new AbortController().signal;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
async function drain<T>(items: AsyncIterable<T>) { const out = []; for await (const item of items) out.push(item); return out; }
function transport(blob = false) {
  const calls: { url: string; init: Parameters<GitHubApiFetch>[1] }[] = [];
  const fetchFn: GitHubApiFetch = async (url, init) => {
    calls.push({ url, init });
    if (url === ROOT) return response({ private: false, visibility: "public", default_branch: "main" });
    if (url.includes("/commits/")) return response({ sha: SHA });
    if (url.includes("/git/trees/")) return response({ tree: Array.from({ length: 28 }, (_, n) => ({ path: `src/file${n}.ts`, type: "blob", mode: "100644", size: 10 })), truncated: false });
    if (blob && url.includes("/contents/")) return response({ type: "file", sha: BLOB });
    return response({ type: "file", encoding: "base64", content: btoa("export {};"), size: 10 });
  };
  return { calls, fetchFn };
}
async function collect(provider: GitHubRestProvider, ref: string | null) {
  const { sha } = await provider.resolveRef("acme", "demo", ref, signal());
  const entries = await drain(provider.listEntries("acme", "demo", sha, signal()));
  for (const entry of entries) await drain(provider.openFile("acme", "demo", sha, entry.path, signal()));
  return entries.length;
}

describe("C013 anonymous quota efficiency", () => {
  it.each([undefined, "", "bad\r\nheader", "x".repeat(256), "throws"])("28 files use exactly the base provider's 30 requests for config %j", async config => {
    const s = transport(), base = transport();
    const readPublicToken = () => { if (config === "throws") throw Error(TOKEN); return config; };
    expect(await collect(new PublicGitHubRestProvider({ fetchFn: s.fetchFn, readPublicToken }), "main")).toBe(28);
    await collect(new GitHubRestProvider({ fetchFn: base.fetchFn }), "main");
    expect(s.calls.map(c => c.url)).toEqual(base.calls.map(c => c.url));
    expect(s.calls).toHaveLength(30); // C012 used 60: one extra probe per source request.
    expect(s.calls.filter(c => c.url === ROOT)).toHaveLength(0);
    expect(s.calls.every(c => !c.init.headers.Authorization && c.init.redirect === "manual")).toBe(true);
  });

  it("default branch lookup consumes only one metadata call: 31 total for 28 files", async () => {
    const s = transport();
    await collect(new PublicGitHubRestProvider({ fetchFn: s.fetchFn, readPublicToken: () => undefined }), null);
    expect(s.calls).toHaveLength(31);
    expect(s.calls.filter(c => c.url === ROOT)).toHaveLength(1);
  });

  it("direct anonymous tree, contents and blob calls require no metadata probe", async () => {
    const s = transport(true);
    const provider = new PublicGitHubRestProvider({ fetchFn: s.fetchFn, readPublicToken: () => undefined });
    await drain(provider.listEntries("acme", "demo", SHA, signal()));
    await drain(provider.openFile("acme", "demo", SHA, "src/file0.ts", signal()));
    expect(s.calls).toHaveLength(3);
    expect(s.calls.some(c => c.url === ROOT || c.init.headers.Authorization)).toBe(false);
    expect(s.calls[2].url).toBe(`${ROOT}/git/blobs/${BLOB}`);
  });

  it("anonymous private-source denial makes one request and sanitizes its body", async () => {
    const fetchFn = vi.fn<GitHubApiFetch>(async () => response({ message: TOKEN }, 404));
    const provider = new PublicGitHubRestProvider({ fetchFn, readPublicToken: () => undefined });
    const error = await provider.resolveRef("acme", "demo", "main", signal()).catch(e => e);
    expect(error.code).toBe("NOT_FOUND"); expect(String(error)).not.toContain(TOKEN);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("a token appearing after an anonymous read still requires a fresh public gate", async () => {
    const s = transport(); let token: string | undefined;
    const provider = new PublicGitHubRestProvider({ fetchFn: s.fetchFn, readPublicToken: () => token });
    await provider.resolveRef("acme", "demo", "main", signal());
    token = TOKEN;
    await drain(provider.openFile("acme", "demo", SHA, "src/file0.ts", signal()));
    expect(s.calls.map(c => c.url === ROOT)).toEqual([false, true, false]);
    expect(s.calls.map(c => c.init.headers.Authorization)).toEqual([undefined, undefined, `Bearer ${TOKEN}`]);
  });

  it("visibility is checked again before authenticated blob fallback; private transition withholds blob", async () => {
    const s = transport(true); let probes = 0;
    const fetchFn: GitHubApiFetch = (url, init) => {
      if (url === ROOT && ++probes === 2) {
        s.calls.push({ url, init });
        return Promise.resolve(response({ private: true, visibility: "private" }));
      }
      return s.fetchFn(url, init);
    };
    const provider = new PublicGitHubRestProvider({ fetchFn, readPublicToken: () => TOKEN });
    await expect(drain(provider.openFile("acme", "demo", SHA, "src/file0.ts", signal()))).rejects.toMatchObject({ code: "PRIVATE_OR_FORBIDDEN" });
    expect(s.calls.map(c => c.url === ROOT)).toEqual([true, false, true]);
    expect(s.calls.filter(c => c.init.headers.Authorization)).toHaveLength(1);
    expect(s.calls.some(c => c.url.includes("/git/blobs/"))).toBe(false);
  });
});
