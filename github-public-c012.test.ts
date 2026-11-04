/** C012 offline contracts. All credentials and transport responses are synthetic. */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PublicGitHubRestProvider } from "@/lib/github-public-server";
import { createGitHubAstPost } from "@/lib/github-ast-server";
import { type GitHubApiFetch, type GitHubApiResponse } from "@/lib/github-provider";

const SHA = "a".repeat(40), BLOB = "b".repeat(40);
const TOKEN = "C012_SYNTHETIC_CREDENTIAL_ONLY";
const ROOT = "https://api.github.com/repos/acme/demo";
const signal = () => new AbortController().signal;
const response = (body: unknown, status = 200, headers: Record<string, string> = {}): GitHubApiResponse =>
  new Response(JSON.stringify(body), { status, headers });
const publicInfo = { private: false, visibility: "public", default_branch: "main" };
function setup(options: {
  info?: unknown; token?: () => string | undefined;
  source?: (url: string, init: Parameters<GitHubApiFetch>[1]) => GitHubApiResponse | Promise<GitHubApiResponse>;
  metadata?: () => GitHubApiResponse;
} = {}) {
  const calls: { url: string; init: Parameters<GitHubApiFetch>[1] }[] = [];
  const token = vi.fn(options.token ?? (() => TOKEN));
  const fetchFn: GitHubApiFetch = async (url, init) => {
    calls.push({ url, init });
    if (url === ROOT) return options.metadata?.() ?? response(options.info ?? publicInfo);
    if (options.source) return options.source(url, init);
    if (url.includes("/commits/")) return response({ sha: SHA });
    if (url.includes("/git/trees/")) return response({ tree: [{ path: "src/index.ts", type: "blob", mode: "100644", size: 20 }], truncated: false });
    if (url.includes("/contents/")) return response({ type: "file", size: 20, encoding: "base64", content: btoa("export const x = 1;\n") });
    return response({}, 404);
  };
  return { provider: new PublicGitHubRestProvider({ fetchFn, readPublicToken: token }), calls, token, fetchFn };
}
async function drain<T>(items: AsyncIterable<T>): Promise<T[]> { const out = []; for await (const x of items) out.push(x); return out; }

describe("C012 public-only optional server authentication", () => {
  it("gates metadata anonymously then authenticates commit, tree, contents and blob only on the exact API", async () => {
    const s = setup({ source: url => {
      if (url.includes("/commits/")) return response({ sha: SHA });
      if (url.includes("/git/trees/")) return response({ tree: [], truncated: false });
      if (url.includes("/contents/")) return response({ type: "file", sha: BLOB });
      return response({ encoding: "base64", content: btoa("export {};"), size: 10 });
    } });
    expect(await s.provider.resolveRef("acme", "demo", null, signal())).toEqual({ sha: SHA });
    await drain(s.provider.listEntries("acme", "demo", SHA, signal()));
    await drain(s.provider.openFile("acme", "demo", SHA, "src/index.ts", signal()));
    expect(s.calls.filter(c => c.url !== ROOT)).toHaveLength(4);
    s.calls.forEach((c, i) => {
      expect(new URL(c.url).origin).toBe("https://api.github.com");
      expect(c.init.redirect).toBe("manual"); expect(c.init.method).toBe("GET");
      if (c.url === ROOT) expect(c.init.headers.Authorization).toBeUndefined();
      else { expect(s.calls[i - 1].url).toBe(ROOT); expect(c.init.headers.Authorization).toBe(`Bearer ${TOKEN}`); }
    });
    expect(JSON.stringify(s.provider)).not.toContain(TOKEN);
  });

  it.each([
    { private: true, visibility: "private" }, { private: false, visibility: "internal" },
    { private: true, visibility: "public" }, { private: false }, { visibility: "public" }, {}, [], "public",
  ])("rejects non-public or ambiguous visibility before credential transmission or source reads: %j", async info => {
    const s = setup({ info });
    await expect(s.provider.resolveRef("acme", "demo", "main", signal())).rejects.toMatchObject({ code: "PRIVATE_OR_FORBIDDEN" });
    await expect(drain(s.provider.listEntries("acme", "demo", SHA, signal()))).rejects.toMatchObject({ code: "PRIVATE_OR_FORBIDDEN" });
    await expect(drain(s.provider.openFile("acme", "demo", SHA, "x.ts", signal()))).rejects.toMatchObject({ code: "PRIVATE_OR_FORBIDDEN" });
    expect(s.calls.every(c => c.url === ROOT && !c.init.headers.Authorization)).toBe(true);
    expect(s.token).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 404])("anonymous metadata status %i never retries with credentials", async status => {
    const s = setup({ metadata: () => response({ message: TOKEN }, status) });
    const error = await s.provider.resolveRef("acme", "demo", "main", signal()).catch(e => e);
    expect(String(error)).not.toContain(TOKEN); expect(s.calls).toHaveLength(1); expect(s.token).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", "unsafe\r\nheader", "x".repeat(256)])("missing/invalid config retains anonymous success", async value => {
    const s = setup({ token: () => value });
    expect(await s.provider.resolveRef("acme", "demo", "main", signal())).toEqual({ sha: SHA });
    expect(s.calls.every(c => !c.init.headers.Authorization)).toBe(true);
  });

  it("unavailable optional configuration falls back anonymously", async () => {
    const s = setup({ token: () => { throw Error(TOKEN); } });
    expect(await s.provider.resolveRef("acme", "demo", "main", signal())).toEqual({ sha: SHA });
    expect(s.calls.every(c => !c.init.headers.Authorization)).toBe(true);
  });

  it("401 auth rejection rechecks public visibility and retries once anonymously", async () => {
    const s = setup({ source: (_url, init) => init.headers.Authorization ? response({ message: TOKEN }, 401) : response({ sha: SHA }) });
    expect(await s.provider.resolveRef("acme", "demo", "main", signal())).toEqual({ sha: SHA });
    expect(s.calls.map(c => Boolean(c.init.headers.Authorization))).toEqual([false, true, false, false]);
  });

  it("fallback stops if repository visibility changes", async () => {
    let n = 0;
    const s = setup({ metadata: () => response(++n === 1 ? publicInfo : { private: true, visibility: "private" }), source: () => response({}, 401) });
    await expect(s.provider.resolveRef("acme", "demo", "main", signal())).rejects.toMatchObject({ code: "PRIVATE_OR_FORBIDDEN" });
    expect(s.calls).toHaveLength(3);
  });

  it.each([301, 302, 307, 308])("redirect %i cannot forward credentials or cause fallback", async status => {
    const s = setup({ source: () => response({ message: TOKEN }, status, { location: "https://evil.invalid/" }) });
    await expect(s.provider.resolveRef("acme", "demo", "main", signal())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(s.calls).toHaveLength(2); expect(s.calls.every(c => c.url.startsWith(ROOT))).toBe(true);
  });

  it("metadata redirects stop before credential transmission", async () => {
    const s = setup({ metadata: () => response({}, 302, { location: ROOT + "/other" }) });
    await expect(s.provider.resolveRef("acme", "demo", "main", signal())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(s.calls).toHaveLength(1); expect(s.token).toHaveBeenCalledTimes(1);
  });

  it.each([[429, {}], [403, { "x-ratelimit-remaining": "0" }], [403, { "retry-after": "60" }]] as const)("rate limits stop without fallback: %i %j", async (status, headers) => {
    const s = setup({ source: () => response({ message: TOKEN }, status, headers) });
    await expect(s.provider.resolveRef("acme", "demo", "main", signal())).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(s.calls).toHaveLength(2);
  });

  it("does not retry an ordinary forbidden source response", async () => {
    const s = setup({ source: () => response({ message: TOKEN }, 403) });
    await expect(s.provider.resolveRef("acme", "demo", "main", signal())).rejects.toMatchObject({ code: "PRIVATE_OR_FORBIDDEN" });
    expect(s.calls).toHaveLength(2);
  });

  it("rechecks visibility for direct file calls after a prior public result", async () => {
    let n = 0;
    const s = setup({ metadata: () => response(++n === 1 ? publicInfo : { private: true, visibility: "private" }) });
    await s.provider.resolveRef("acme", "demo", "main", signal());
    await expect(drain(s.provider.openFile("acme", "demo", SHA, "x.ts", signal()))).rejects.toMatchObject({ code: "PRIVATE_OR_FORBIDDEN" });
    expect(s.calls.filter(c => c.url.includes("/contents/"))).toHaveLength(0);
  });

  it.each(["https://evil.invalid/repos/acme/demo/commits/main", "https://api.github.com.evil.invalid/repos/acme/demo", "http://api.github.com/repos/acme/demo", "https://user:pass@api.github.com/repos/acme/demo", "https://api.github.com:444/repos/acme/demo", "https://api.github.com/user", "https://api.github.com/repos/acme/demo/actions/secrets"])("rejects untrusted URL before transport or credentials: %s", async url => {
    const s = setup();
    class Probe extends PublicGitHubRestProvider { probe() { return this.getJson(url, signal(), TOKEN); } }
    await expect(new Probe({ fetchFn: s.fetchFn, readPublicToken: s.token }).probe()).rejects.toMatchObject({ code: "MALFORMED" });
    expect(s.calls).toHaveLength(0); expect(s.token).not.toHaveBeenCalled();
  });

  it("retains SHA pinning and path validation before transport", async () => {
    const s = setup();
    await expect(drain(s.provider.listEntries("acme", "demo", "main", signal()))).rejects.toMatchObject({ code: "REF_UNRESOLVED" });
    await expect(drain(s.provider.openFile("acme", "demo", SHA, "../x.ts", signal()))).rejects.toMatchObject({ code: "MALFORMED" });
    expect(s.calls).toHaveLength(0);
  });

  it.each(["throw", "timeout", "status", "json", "stream"])("redacts provider failure through the actual route: %s", async mode => {
    const s = setup({ source: () => {
      if (mode === "throw") throw Error(TOKEN);
      if (mode === "timeout") throw Object.assign(Error(TOKEN), { code: "TIMEOUT" });
      if (mode === "status") return response({ message: TOKEN }, 500);
      if (mode === "json") return new Response(TOKEN);
      return { ...response({}), status: 200, headers: new Headers(), body: new ReadableStream({ start(c) { c.error(Error(TOKEN)); } }) } as GitHubApiResponse;
    } });
    const post = createGitHubAstPost(() => s.provider);
    const res = await post(new Request("http://localhost/api/github-ast", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/demo/tree/main" }) }));
    expect((await res.clone().json()).ok).toBe(false);
    expect(await res.text()).not.toContain(TOKEN);
    expect(JSON.stringify([...res.headers])).not.toContain(TOKEN);
  });

  it("successful route preserves pinned evidence without auth in response", async () => {
    const s = setup();
    const res = await createGitHubAstPost(() => s.provider)(new Request("http://localhost/api/github-ast", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/demo/tree/main" }) }));
    const text = await res.text(); const body = JSON.parse(text);
    expect(body.ok).toBe(true); expect(body.snapshot.resolvedCommitIfGitHub).toBe(SHA);
    expect(body.evidenceVerified).toBe(true); expect(text).not.toContain(TOKEN); expect(text).not.toContain("Authorization");
  });

  it("authenticated JSON remains bounded before parsing", async () => {
    const s = setup({ source: () => response({ sha: SHA, padding: "x".repeat(500) }) });
    const provider = new PublicGitHubRestProvider({ fetchFn: s.fetchFn, readPublicToken: s.token, maxJsonBytes: 128 });
    await expect(provider.resolveRef("acme", "demo", "main", signal())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(s.calls).toHaveLength(2); expect(s.calls[1].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("metadata bounds fail before credential transmission", async () => {
    const s = setup({ metadata: () => response({ ...publicInfo, padding: "x".repeat(500) }) });
    const provider = new PublicGitHubRestProvider({ fetchFn: s.fetchFn, readPublicToken: s.token, maxJsonBytes: 128 });
    await expect(provider.resolveRef("acme", "demo", "main", signal())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(s.calls).toHaveLength(1); expect(s.token).toHaveBeenCalledTimes(1);
  });

  it("authenticated transport cannot hang past its independent deadline", async () => {
    const s = setup({ source: () => new Promise<GitHubApiResponse>(() => {}) });
    const provider = new PublicGitHubRestProvider({ fetchFn: s.fetchFn, readPublicToken: s.token, requestTimeoutMs: 20 });
    await expect(provider.resolveRef("acme", "demo", "main", signal())).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(s.calls).toHaveLength(2);
  });

  it("abort reasons cannot disclose credentials", async () => {
    const s = setup(); const ctl = new AbortController(); ctl.abort(TOKEN);
    const error = await s.provider.resolveRef("acme", "demo", "main", ctl.signal).catch(e => e);
    expect(error.name).toBe("AbortError"); expect(String(error)).not.toContain(TOKEN);
    expect(s.calls).toHaveLength(0); expect(s.token).not.toHaveBeenCalled();
  });

  it("successful anonymous route works without a configured token", async () => {
    const s = setup({ token: () => undefined });
    const res = await createGitHubAstPost(() => s.provider)(new Request("http://localhost/api/github-ast", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/demo/tree/main" }) }));
    expect((await res.json()).ok).toBe(true);
    expect(s.calls.every(c => !c.init.headers.Authorization)).toBe(true);
  });

  it("production wiring reads only the named runtime variable lazily", () => {
    const source = readFileSync("lib/github-public-server.ts", "utf8");
    const route = readFileSync("app/api/github-ast/route.ts", "utf8");
    expect(source).toContain('from "node:process"');
    expect(source).toContain("(): string | undefined => env.VIBEFLOW_GITHUB_PUBLIC_TOKEN");
    expect(source).not.toMatch(/NEXT_PUBLIC_|execSync|child_process|readFile|GITHUB_TOKEN|GH_TOKEN/);
    expect(route).toContain("() => new PublicGitHubRestProvider()");
  });
});
