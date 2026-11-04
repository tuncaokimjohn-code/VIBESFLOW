import { browserSnapshotSchema, receiptMatchesRequest, sha256Text } from "@/lib/intake-client";
import { validateEvidence } from "@/lib/evidence";
import { AST_LIMITS, createGitHubAstResponseSchema, invalidAstResponse, type GitHubAstResponse, type RequestedRepo } from "@/lib/github-ast-contract";

const responseSchema = createGitHubAstResponseSchema(browserSnapshotSchema);

/** Strict receipt + inventory + digest + exact returned graph validation. */
export async function parseGitHubAstResponse(payload: unknown, expected: RequestedRepo): Promise<GitHubAstResponse> {
  try {
    const checked = await responseSchema.safeParseAsync(payload);
    if (!checked.success) return invalidAstResponse();
    const data = checked.data;
    if (!data.ok) return data;
    if (!receiptMatchesRequest(data.requested, expected.owner, expected.repo, expected.ref)) return invalidAstResponse();
    const hashes = new Map(await Promise.all(Object.values(data.contents).map(async src => [src, await sha256Text(src)] as const)));
    const evidence = validateEvidence(data.graph, data.snapshot, new Map(Object.entries(data.contents)), src => {
      const digest = hashes.get(src);
      if (!digest) throw new Error("Missing content digest");
      return digest;
    }, { canonicalProvenance: `https://github.com/${expected.owner}/${expected.repo}` });
    return evidence.ok ? data : invalidAstResponse();
  } catch {
    return invalidAstResponse();
  }
}

/** Bound the actual response stream before JSON parsing; never trust Content-Length. */
export async function readGitHubAstResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Missing response body");
  signal.throwIfAborted();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let stop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { stop = reject; });
  const cancel = () => { try { void reader.cancel().catch(() => undefined); } catch { /* bounded cleanup */ } };
  const onAbort = () => { stop(new DOMException("Analysis cancelled", "AbortError")); cancel(); };
  const timer = setTimeout(() => { stop(new Error("Response read deadline exceeded")); cancel(); }, AST_LIMITS.responseReadDeadlineMs);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > AST_LIMITS.maxResponseBytes) throw new Error("Response byte budget exceeded");
      const owned = new Uint8Array(value.byteLength); owned.set(value); chunks.push(owned);
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) { bytes.set(chunk, off); off += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", onAbort); cancel();
    try { reader.releaseLock(); } catch { /* an ignored pending read may retain its lock */ }
  }
}
