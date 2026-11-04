/** Offline builder regressions for QA-01 through QA-05; no browser qualification. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createGitHubAstPost, runGitHubToAst } from "@/lib/github-ast-server";
import type { GitHubSourceProvider } from "@/lib/github-intake";
import { parseGitHubAstResponse, readGitHubAstResponse } from "@/lib/github-ast-client";
import { AST_LIMITS, AstGraphSchema, assertAnalysisBudget, type GitHubAstSuccess } from "@/lib/github-ast-contract";
import { serializeAstResponse, withAnalysisDeadline } from "@/lib/analysis-budget-server";
import { numberedExcerpt } from "@/lib/ast-graph";
import { sha256Hex } from "@/lib/source-snapshot";
import { createLiveAnalysisController, type LiveAnalysisState } from "@/lib/live-ast-request";
import * as evidenceModule from "@/lib/evidence";

const SHA = "a".repeat(40);
const encoder = new TextEncoder();
const expected = { owner: "acme", repo: "demo", ref: "main" };
const files = { "src/a.ts": 'import { b } from "./b";\nexport const a = () => b();\n', "src/b.ts": "export function b() { return 42; }\n" };
function provider(input: Record<string, string> = files): GitHubSourceProvider {
  return {
    resolveRef: async () => ({ sha: SHA }),
    async *listEntries() {
      for (const [path, text] of Object.entries(input)) yield { path, size: encoder.encode(text).length, kind: "file" };
    },
    async *openFile(_owner, _repo, _sha, path, signal) {
      signal.throwIfAborted();
      yield encoder.encode(input[path]);
    },
  };
}
async function payload(repo = "demo", input: Record<string, string> = files) {
  const post = createGitHubAstPost(() => provider(input));
  const response = await post(new Request("http://local/api/github-ast", { method: "POST", body: JSON.stringify({ url: `github.com/acme/${repo}/tree/main` }) }));
  expect(response.status).toBe(200);
  return await response.json() as GitHubAstSuccess;
}
let original: GitHubAstSuccess;
beforeAll(async () => { original = await payload(); });
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("QA-01/04: exact UTF-8 and ECMAScript line geometry", () => {
  for (const [name, separator] of [["LF", "\n"], ["CR", "\r"], ["CRLF", "\r\n"], ["LS", "\u2028"], ["PS", "\u2029"], ["mixed", "\r\n\u2028\r\u2029\n"]]) {
    for (const bom of ["", "\ufeff"]) {
      it(`${name}, BOM=${Boolean(bom)}: server/client hashes, anchors, offsets and excerpts agree`, async () => {
        const source = `${bom}// 😀${separator}import { b } from "./b";${separator}export const a = () => b();`;
        const response = await payload("demo", { ...files, "src/a.ts": source });
        const checked = await parseGitHubAstResponse(response, expected);
        expect(checked.ok).toBe(true);
        if (!checked.ok) return;
        expect(checked.contents["src/a.ts"]).toBe(source);
        const file = checked.snapshot.files.find(f => f.path === "src/a.ts")!;
        expect(file.bytes).toBe(encoder.encode(source).length);
        expect(file.sha256).toBe(sha256Hex(encoder.encode(source)));
        const extra = name === "mixed" ? 5 : 1;
        const declarationLine = 1 + 2 * extra;
        expect(checked.graph.nodes.find(n => n.label === "a")?.line).toBe(declarationLine);
        expect(checked.graph.edges.find(e => e.kind === "imports")?.line).toBe(1 + extra);
        expect(file.lineStartOffsets[extra]).toBe(encoder.encode(`${bom}// 😀${separator}`).length);
        const excerpt = numberedExcerpt(source, declarationLine, 0, 0);
        expect(excerpt).toEqual([{ n: declarationLine, text: "export const a = () => b();", target: true }]);
      });
    }
  }
  it("production rejects a failed evidence result instead of returning a success flag", async () => {
    vi.spyOn(evidenceModule, "validateEvidence").mockReturnValue({ ok: false, issues: ["controlled invalid evidence"] });
    const post = createGitHubAstPost(() => provider());
    const response = await post(new Request("http://local/api/github-ast", { method: "POST", body: JSON.stringify({ url: "github.com/acme/demo/tree/main" }) }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, code: "EVIDENCE_INVALID" });
  });
  it("revalidates the schema output before serializing the success body", async () => {
    const validate = evidenceModule.validateEvidence;
    vi.spyOn(evidenceModule, "validateEvidence")
      .mockImplementationOnce(validate)
      .mockReturnValueOnce({ ok: false, issues: ["controlled wire-stage evidence failure"] });
    const post = createGitHubAstPost(() => provider());
    const response = await post(new Request("http://local/api/github-ast", { method: "POST", body: JSON.stringify({ url: "github.com/acme/demo/tree/main" }) }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, code: "EVIDENCE_INVALID" });
  });
});

describe("QA-02: strict and cryptographically bound real response", () => {
  const mutations: Array<[string, (p: GitHubAstSuccess) => void]> = [
    ["unknown wire key", p => Object.assign(p, { extra: true })],
    ["false shape flag", p => Object.assign(p, { shapeOk: false })],
    ["false evidence flag", p => Object.assign(p, { evidenceVerified: false })],
    ["synthetic relabel", p => Object.assign(p, { synthetic: true })],
    ["missing coverage", p => { Reflect.deleteProperty(p.snapshot, "coverage"); }],
    ["missing graph", p => { Reflect.deleteProperty(p, "graph"); }],
    ["foreign requested repo", p => { p.requested.repo = "other"; }],
    ["foreign requested ref", p => { p.requested.ref = null; }],
    ["foreign provenance", p => { p.snapshot.canonicalProvenance = "https://github.com/acme/other"; }],
    ["foreign commit", p => { p.snapshot.resolvedCommitIfGitHub = "b".repeat(40); }],
    ["forged manifest", p => { p.snapshot.manifestHash = "b".repeat(64); }],
    ["forged identity", p => { p.snapshot.snapshotId = "github-" + "b".repeat(64); }],
    ["same-shape changed source", p => { p.contents["src/b.ts"] = p.contents["src/b.ts"].replace("42", "43"); }],
    ["missing content", p => { delete p.contents["src/a.ts"]; }],
    ["extra content", p => { p.contents["extra.ts"] = "export const invented=1;"; }],
    ["unsafe file path", p => { p.snapshot.files[0].path = "../a.ts"; }],
    ["forged line offsets", p => { p.snapshot.files[0].lineStartOffsets[1]++; }],
    ["changed graph anchor", p => { p.graph.nodes.find(n => n.kind === "member")!.line = 1; }],
    ["removed graph node", p => { p.graph.nodes.pop(); }],
    ["removed graph edge", p => { p.graph.edges.pop(); }],
    ["foreign graph binding", p => { p.graph.resolvedCommitIfGitHub = "b".repeat(40); }],
    ["undecoded source", p => Object.assign(p, { undecoded: ["src/a.ts"] })],
    ["wrong coverage status", p => { p.analysisStatus = "partial"; }],
  ];
  it("accepts a valid server graph without replacing it with a client graph", async () => {
    const checked = await parseGitHubAstResponse(original, expected);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.graph).toEqual(original.graph);
  });
  it.each(mutations)("rejects %s", async (_label, mutate) => {
    const changed = structuredClone(original); mutate(changed);
    expect((await parseGitHubAstResponse(changed, expected)).ok).toBe(false);
  });
  it.each([null, {}, { ok: true }, { ok: false, code: "X" }])("rejects malformed payload %j", async input => {
    expect((await parseGitHubAstResponse(input, expected)).ok).toBe(false);
  });
  it("fails closed when browser crypto rejects", async () => {
    vi.stubGlobal("crypto", { subtle: { digest: async () => { throw new Error("unavailable"); } } });
    expect((await parseGitHubAstResponse(original, expected)).ok).toBe(false);
  });
  it("reports skipped source and unsupported forms as partial", async () => {
    const response = await payload("demo", { ...files, "README.md": "not TS", "src/anonymous.ts": "export default () => 1;" });
    expect(response.analysisStatus).toBe("partial");
    expect(response.snapshot.skipped.some(f => f.path === "README.md")).toBe(true);
    expect((await parseGitHubAstResponse(response, expected)).ok).toBe(true);
  });
  it("concurrent repositories with identical paths remain isolated", async () => {
    const [a, b] = await Promise.all([payload("demo", files), payload("other", { "src/a.ts": "export const other = 9;" })]);
    expect((await parseGitHubAstResponse(a, expected)).ok).toBe(true);
    expect((await parseGitHubAstResponse(b, { ...expected, repo: "other" })).ok).toBe(true);
    expect(a.contents["src/a.ts"]).not.toBe(b.contents["src/a.ts"]);
    expect(a.snapshot.snapshotId).not.toBe(b.snapshot.snapshotId);
  });
});

describe("QA-05: enforced analysis and response budgets", () => {
  it.each([0, -1, 0.5, AST_LIMITS.analysisDeadlineMs + 1])("rejects invalid or enlarged deadline %s", timeout => {
    expect(() => withAnalysisDeadline(() => 42, timeout)).toThrow(RangeError);
  });
  it("interrupts non-cooperative synchronous nested trusted work and remains usable", () => {
    const nested = () => { for (;;) { /* controlled trusted deadline regression */ } };
    expect(() => withAnalysisDeadline(() => nested(), 20)).toThrow();
    try { withAnalysisDeadline(nested, 20); } catch (error) {
      expect((error as { code: string }).code).toBe("ERR_SCRIPT_EXECUTION_TIMEOUT");
    }
    expect(withAnalysisDeadline(() => 42)).toBe(42);
  });
  it("rejects collected source above the separate analysis byte budget", async () => {
    const source = "//" + "x".repeat(AST_LIMITS.maxSourceBytes / 2);
    const result = await runGitHubToAst({ ...expected, provider: provider({ "a.ts": source, "b.ts": source }) });
    expect(result).toMatchObject({ ok: false, code: "ANALYSIS_LIMIT" });
  });
  it("rejects more than the allowed analyzed file count", async () => {
    const source = Object.fromEntries(Array.from({ length: AST_LIMITS.maxFiles + 1 }, (_, i) => [`a${i}.ts`, "export const x=1;"]));
    const result = await runGitHubToAst({ ...expected, provider: provider(source) });
    expect(result).toMatchObject({ ok: false, code: "ANALYSIS_LIMIT" });
  });
  it("bounds expanded line geometry before AST work", () => {
    const snapshot = structuredClone(original.snapshot);
    snapshot.files[0].lineStartOffsets = Array(AST_LIMITS.maxLineStarts + 1).fill(0);
    expect(() => assertAnalysisBudget(snapshot)).toThrow();
  });
  it("bounds node and edge arrays", () => {
    expect(AstGraphSchema.safeParse({ ...original.graph, nodes: Array(AST_LIMITS.maxNodes + 1).fill(original.graph.nodes[0]) }).success).toBe(false);
    expect(AstGraphSchema.safeParse({ ...original.graph, edges: Array(AST_LIMITS.maxEdges + 1).fill(original.graph.edges[0]) }).success).toBe(false);
  });
  it("enforces the exact serialized UTF-8 response cap", () => {
    expect(encoder.encode(serializeAstResponse("a".repeat(AST_LIMITS.maxResponseBytes - 2))).length).toBe(AST_LIMITS.maxResponseBytes);
    expect(() => serializeAstResponse("a".repeat(AST_LIMITS.maxResponseBytes - 1))).toThrow();
    expect(() => serializeAstResponse("😀".repeat(AST_LIMITS.maxResponseBytes / 4))).toThrow();
  });
  it("bounds actual incoming bytes despite a lying Content-Length", async () => {
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(AST_LIMITS.maxResponseBytes + 1)); c.close(); } }), { headers: { "content-length": "1" } });
    await expect(readGitHubAstResponse(response, new AbortController().signal)).rejects.toThrow("byte budget");
  });
  it("cancels a non-cooperative pending response read", async () => {
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ pull() { return new Promise(() => undefined); } }));
    const reading = readGitHubAstResponse(response, controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });
  it("independently expires a stalled response body", async () => {
    vi.useFakeTimers();
    const response = new Response(new ReadableStream({ pull() { return new Promise(() => undefined); } }));
    const reading = readGitHubAstResponse(response, new AbortController().signal);
    const rejected = expect(reading).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(AST_LIMITS.responseReadDeadlineMs);
    await rejected;
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function responseFor(body: unknown) { return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }); }
function session(fetchFn: typeof fetch) {
  const results: Array<GitHubAstSuccess | null> = [];
  const states: LiveAnalysisState[] = [];
  const controller = createLiveAnalysisController({ fetchFn, setLive: value => results.push(value), onState: value => states.push(value) });
  return { controller, results, states };
}
describe("QA-03: actual request controller async regressions", () => {
  it("clears a successful previous graph before a failed next request", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(responseFor(original)).mockResolvedValueOnce(responseFor({ ok: false, code: "NOT_FOUND", message: "Missing" }));
    const s = session(fetchFn);
    await s.controller.submit("github.com/acme/demo/tree/main");
    expect(s.results.at(-1)?.requested.repo).toBe("demo");
    const pending = s.controller.submit("github.com/acme/other/tree/main");
    expect(s.results.at(-1)).toBe(null);
    await pending;
    expect(s.results.at(-1)).toBe(null);
    expect(s.states.at(-1)?.status).toBe("error");
  });
  it("a late older repository cannot replace a newer success", async () => {
    const old = deferred<Response>();
    const other = await payload("other", { "src/a.ts": "export const other=2;" });
    const fetchFn = vi.fn<typeof fetch>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(responseFor(other));
    const s = session(fetchFn);
    const first = s.controller.submit("github.com/acme/demo/tree/main");
    await s.controller.submit("github.com/acme/other/tree/main");
    old.resolve(responseFor(original)); await first;
    expect(s.results.at(-1)?.requested.repo).toBe("other");
  });
  it("invalid new input invalidates a non-cooperative older request", async () => {
    const old = deferred<Response>(); const fetchFn = vi.fn<typeof fetch>().mockReturnValue(old.promise);
    const s = session(fetchFn); const first = s.controller.submit("github.com/acme/demo/tree/main");
    await s.controller.submit("https://evil.example/acme/demo");
    const error = s.states.at(-1);
    expect(fetchFn.mock.calls[0][1]?.signal?.aborted).toBe(true);
    old.resolve(responseFor(original)); await first;
    expect(s.states.at(-1)).toEqual(error); expect(s.results.at(-1)).toBe(null);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each(["cancel", "clear", "dispose"] as const)("%s invalidates pending responses", async action => {
    const old = deferred<Response>(); const fetchFn = vi.fn<typeof fetch>().mockReturnValue(old.promise);
    const s = session(fetchFn); const pending = s.controller.submit("github.com/acme/demo/tree/main");
    s.controller[action](); const count = s.states.length;
    old.resolve(responseFor(original)); await pending;
    expect(s.results.at(-1)).toBe(null); expect(s.states.length).toBe(count);
  });
  it("effect cleanup/setup remains usable without resurrecting old requests", async () => {
    const old = deferred<Response>(); const fetchFn = vi.fn<typeof fetch>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(responseFor(original));
    const s = session(fetchFn); const first = s.controller.submit("github.com/acme/demo/tree/main");
    s.controller.dispose(); s.controller.activate();
    await s.controller.submit("github.com/acme/demo/tree/main");
    const count = s.states.length; old.resolve(responseFor(original)); await first;
    expect(s.results.at(-1)?.requested.repo).toBe("demo"); expect(s.states.length).toBe(count);
  });
  it("HTTP failure cannot install an otherwise valid success body", async () => {
    const s = session(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(original), { status: 500 })));
    await s.controller.submit("github.com/acme/demo/tree/main");
    expect(s.results.at(-1)).toBe(null); expect(s.states.at(-1)?.status).toBe("error");
  });
});
