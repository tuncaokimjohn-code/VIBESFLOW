/**
 * E1 real GitHub public read-only provider (P3 REAL_GITHUB_INTAKE_002, OFFLINE).
 *
 * Interface-only delivery: request construction + response mapping for the
 * GitHub REST API over an INJECTED HTTP transport. No external network
 * request is made by this task — tests use a mocked transport, and no route
 * or UI calls this provider yet (synthetic preview mode is preserved; the
 * intake route remains synthetic-only).
 *
 * Transport: built-in fetch via `defaultGitHubApiFetch`, always sent with
 * `redirect: "manual"` so automatic redirect-following is rejected and any
 * 3xx fails closed (PROVIDER_UNAVAILABLE) instead of leaking the request
 * to an off-allowlist host. Only these allowlisted endpoints are ever
 * constructed (all https, exact host api.github.com — never github.com
 * HTML, never arbitrary URLs):
 *   GET /repos/{owner}/{repo}                        (default-branch lookup)
 *   GET /repos/{owner}/{repo}/commits/{ref}           (ref -> pinned SHA)
 *   GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1   (listing)
 *   GET /repos/{owner}/{repo}/contents/{path}?ref={sha}      (file)
 *   GET /repos/{owner}/{repo}/git/blobs/{blobSha}            (large-file fallback)
 *
 * Guards: strict github.com input parsing stays in lib/github-url.ts;
 * owner/repo revalidated here; content paths reject dot segments
 * (literal, percent-encoded, and double-encoded); tree/file retrieval
 * requires a pinned full 40-hex SHA (never a branch name); per-request
 * timeouts via AbortSignal (combined with the caller signal) with timeout
 * vs user-cancellation distinguished (TIMEOUT code vs the caller's own
 * abort, whether AbortError or the caller's own TimeoutError); every
 * request wait AND every body read additionally settles against an
 * independent deadline so a transport that ignores abort and never
 * settles cannot hang the caller — late outcomes are observed and
 * ignored, never unhandled;
 * transport-level JSON byte caps enforced DURING streaming reads BEFORE
 * parsing (Content-Length only gates pre-read skips; absent or
 * understated values cannot smuggle a giant body past the streaming
 * cap; a missing/non-stream body fails closed instead of buffering via
 * text()) and blob byte caps enforced BEFORE base64 decoding; declared
 * sizes gate pre-read skips in the orchestrator; actual bytes enforced
 * by readBoundedStream.
 * No code is ever executed. The base provider defaults to anonymous requests.
 * The server-only PublicGitHubRestProvider adds visibility-gated optional auth.
 * No runtime environment is read by this base provider.
 *
 * Status mapping: 200 ok; 3xx PROVIDER_UNAVAILABLE (redirect, never
 * followed); 404 NOT_FOUND; 401/403-non-rate/451 PRIVATE_OR_FORBIDDEN;
 * 429 or 403-with-rate-limit headers RATE_LIMITED; 409/422
 * REF_UNRESOLVED; anything else PROVIDER_UNAVAILABLE.
 * Codes are thrown as `{ code }` objects so lib/github-intake.ts maps them.
 *
 * Known limitations (see evidence LIMITATIONS.md): live retrieval NOT tested
 * here (mocked transport only); LFS object content NOT resolved —
 * an LFS pointer at a .ts/.tsx path fails closed (PROVIDER_UNAVAILABLE +
 * partial, never a silent substitution); truncated tree listings fail
 * closed; per-request timeout aborts the wait but cannot forcibly terminate
 * a non-cooperative transport; reader.cancel() is best-effort cleanup only
 * and may be ignored by such transports. Provider-side retention is bounded
 * (accepted bytes plus transient concat/decode allocations); no bound is
 * claimed for memory the upstream transport holds itself.
 */
import { isCanonicalRef, isValidName } from "@/lib/github-url";
import type { FileMeta, GitHubSourceProvider } from "@/lib/github-intake";

export const GITHUB_API_HOST = "api.github.com" as const;
/** Immutable allowlist: exact host + scheme. Never extended at runtime. */
export const GITHUB_API_ALLOWLIST = Object.freeze({
  host: GITHUB_API_HOST,
  protocol: "https:",
} as const);
const API_BASE = `https://${GITHUB_API_HOST}` as const;
const CHUNK_BYTES = 64 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
/** Transport-level JSON cap: enforced BEFORE parsing (never json() first). */
export const MAX_JSON_BYTES = 1_048_576;
/** Blob/file cap: decoded bytes enforced BEFORE base64 decoding. */
export const MAX_FILE_BYTES = 512 * 1024;

/** Minimal transport surface: satisfied by built-in fetch, mocked in tests. */
export interface GitHubApiResponse {
  status: number;
  headers: { get(name: string): string | null };
  /**
   * Never called by the provider. Retained only so the built-in-fetch
   * cast stays assignable; any mock whose `text()` runs proves the
   * provider regressed (fail-closed tests instrument it to throw).
   */
  text(): Promise<string>;
  /** Never called by the provider: JSON is streamed with a byte cap, then parsed. */
  json(): Promise<unknown>;
  /**
   * REQUIRED streaming body (built-in fetch always provides this). The
   * provider reads it incrementally with a hard byte cap BEFORE parsing,
   * so an absent or understated Content-Length cannot smuggle a giant
   * body into memory. A response with an absent or null body is NOT
   * buffered via `text()` — it fails closed (PROVIDER_UNAVAILABLE),
   * because `text()` would buffer an unbounded body into memory outside
   * the streaming cap.
   */
  body?: ReadableStream<Uint8Array> | null;
}

export type GitHubApiFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal; redirect: "manual" }
) => Promise<GitHubApiResponse>;

/**
 * Default transport: built-in fetch, GET only, `redirect: "manual"` so the
 * client never auto-follows a redirect off the allowlist.
 */
export const defaultGitHubApiFetch: GitHubApiFetch = (url, init) =>
  fetch(url, {
    method: init.method,
    headers: init.headers,
    signal: init.signal,
    redirect: "manual",
  }) as unknown as Promise<GitHubApiResponse>;

export function isPinnedSha(value: string): boolean {
  return SHA_RE.test(value);
}

/**
 * Copy a chunk view into freshly owned storage whose backing buffer is
 * exactly the view's bytes. A hostile or careless transport may hand back a
 * tiny Uint8Array view (small byteLength, large byteOffset) into a huge
 * shared ArrayBuffer; retaining the view would pin the entire oversized
 * buffer for as long as the chunk lives. Always copying bounds provider-side
 * retention to the accepted bytes (at most maxBytes total) plus the transient
 * concatenation and decoding allocations described on readBodyText. This
 * bounds what the PROVIDER retains — it makes no claim about peak memory
 * held upstream by the transport itself, which allocates outside provider
 * control.
 *
 * Deliberately NOT `view.slice()`: subtype dispatch would call
 * `Buffer.prototype.slice` for Node Buffer inputs, which shares (not copies)
 * the underlying storage — a small Buffer view would keep pinning the huge
 * backing buffer. Explicit allocation plus `set` copies for every input kind
 * (plain Uint8Array, Buffer, or any Uint8Array view) and always returns a
 * base Uint8Array, never a Buffer.
 */
export function toOwnedBytes(view: Uint8Array): Uint8Array {
  const owned = new Uint8Array(view.byteLength);
  owned.set(view);
  return owned;
}

/**
 * Best-effort reader cancellation. Fires cancel() without awaiting it and
 * swallows every outcome — synchronous throws and asynchronous rejections
 * alike — so cleanup can never override the primary error, never rejects
 * unhandled, and never stalls the caller. A non-cooperative transport may
 * ignore the signal entirely; the independently-settled deadline (not this
 * helper) is what keeps the caller from hanging.
 */
function bestEffortCancel(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // ignore: cleanup outcome must never replace the primary error
  }
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Reject anything that is not an exact https://api.github.com URL we built. */
export function assertAllowlistedApiUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw codedError("MALFORMED", "Provider built an unparseable URL.");
  }
  if (parsed.protocol !== GITHUB_API_ALLOWLIST.protocol || parsed.hostname.toLowerCase() !== GITHUB_API_ALLOWLIST.host) {
    throw codedError("MALFORMED", "Provider URL must be https://api.github.com.");
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") {
    throw codedError("MALFORMED", "Provider URL must not carry credentials or a port.");
  }
}

function checkOwnerRepo(owner: string, repo: string): void {
  if (!isValidName(owner) || !isValidName(repo)) {
    throw codedError("MALFORMED", "Provider requires canonical owner/repo names.");
  }
}

function checkRef(ref: string | null): void {
  if (!isCanonicalRef(ref)) {
    throw codedError("REF_UNRESOLVED", "Provider requires a canonical branch/tag ref.");
  }
}

function checkSha(sha: string): void {
  if (!isPinnedSha(sha)) {
    throw codedError("REF_UNRESOLVED", "Tree/file retrieval requires a pinned 40-hex commit SHA.");
  }
}

export function buildRepoUrl(owner: string, repo: string): string {
  checkOwnerRepo(owner, repo);
  const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  assertAllowlistedApiUrl(url);
  return url;
}

export function buildCommitUrl(owner: string, repo: string, ref: string): string {
  checkOwnerRepo(owner, repo);
  checkRef(ref);
  const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
  assertAllowlistedApiUrl(url);
  return url;
}

export function buildTreeUrl(owner: string, repo: string, sha: string): string {
  checkOwnerRepo(owner, repo);
  checkSha(sha);
  const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${sha}?recursive=1`;
  assertAllowlistedApiUrl(url);
  return url;
}

/**
 * Reject dot segments in a raw content path, including percent-encoded and
 * double-encoded tricks. Each "/"-separated segment is decoded once: a
 * literal or single-encoded "." / ".." fails; a segment decoding to a path
 * separator fails (encoded-slash smuggling); a residual "%" that decodes
 * further to a dot or separator on a second pass fails (double-encoding).
 * A segment that does not decode cleanly is kept literally (a bare "%" is
 * a legal filename character) and still checked against the literal rules.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
export function rejectDotSegments(path: string): void {
  for (const seg of path.split("/")) {
    if (seg.length === 0) throw codedError("MALFORMED", "Provider requires a non-empty content path segment.");
    if (seg === "." || seg === "..") throw codedError("MALFORMED", "Provider rejects dot segments in content paths.");
    let once = seg;
    let decodedOnce = false;
    try {
      once = decodeURIComponent(seg);
      decodedOnce = true;
    } catch {
      once = seg; // bare "%" is legal in a name; keep literally
    }
    if (once === "." || once === "..") {
      throw codedError("MALFORMED", "Provider rejects dot segments in content paths.");
    }
    if (once.includes("/") || once.includes("\\")) {
      throw codedError("MALFORMED", "Provider rejects encoded separators in content paths.");
    }
    if (CONTROL_RE.test(once)) {
      throw codedError("MALFORMED", "Provider rejects control characters in content paths.");
    }
    if (decodedOnce && once.includes("%")) {
      // Possible double-encoding: decode once more and fail when the
      // second pass reveals a dot segment, a separator, or a control
      // character — "%2500"-style smuggling must not bypass CONTROL_RE
      // merely by escaping it one layer deeper. A stray "%" from a legal
      // name such as "100%.ts" throws here and stays allowed.
      try {
        const twice = decodeURIComponent(once);
        if (
          twice !== once &&
          (twice === "." || twice === ".." || twice.includes("/") || twice.includes("\\")
            || twice === seg || CONTROL_RE.test(twice))
        ) {
          throw codedError("MALFORMED", "Provider rejects double-encoded content paths.");
        }
      } catch (err) {
        if (err instanceof Error && "code" in err) throw err;
        // Stray "%" after one clean decode: legal name, allowed.
      }
    }
  }
}

export function buildContentUrl(owner: string, repo: string, path: string, sha: string): string {
  checkOwnerRepo(owner, repo);
  checkSha(sha);
  if (path.length === 0 || path.length > 512 || path.startsWith("/") || path.includes("\\")) {
    throw codedError("MALFORMED", "Provider requires a relative content path.");
  }
  rejectDotSegments(path);
  const encoded = path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}?ref=${sha}`;
  assertAllowlistedApiUrl(url);
  return url;
}

export function buildBlobUrl(owner: string, repo: string, blobSha: string): string {
  checkOwnerRepo(owner, repo);
  if (!isPinnedSha(blobSha)) {
    throw codedError("MALFORMED", "Blob lookup requires a pinned 40-hex blob SHA.");
  }
  const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${blobSha}`;
  assertAllowlistedApiUrl(url);
  return url;
}

function isRateLimited(status: number, headers: { get(name: string): string | null }): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  const remaining = headers.get("x-ratelimit-remaining");
  const retryAfter = headers.get("retry-after");
  return remaining === "0" || retryAfter !== null;
}

/** Map an HTTP status to a thrown intake code (200 returns null = ok). */
export function throwForStatus(
  status: number,
  headers: { get(name: string): string | null },
  context: string
): void {
  if (status === 200) return;
  // Redirects are never followed (transport sends redirect:"manual"): any
  // 3xx fails closed here so a redirect cannot leak off the allowlist.
  if (status >= 300 && status < 400) {
    throw codedError("PROVIDER_UNAVAILABLE", `${context} was redirected; redirects are not followed.`);
  }
  if (status === 404) throw codedError("NOT_FOUND", `${context} was not found.`);
  if (status === 401 || status === 451 || (status === 403 && !isRateLimited(status, headers))) {
    throw codedError("PRIVATE_OR_FORBIDDEN", `${context} is private or access is forbidden.`);
  }
  if (isRateLimited(status, headers)) {
    throw codedError("RATE_LIMITED", "GitHub rate limit reached. Retry later.");
  }
  if (status === 409 || status === 422) {
    throw codedError("REF_UNRESOLVED", `${context} could not be resolved.`);
  }
  throw codedError("PROVIDER_UNAVAILABLE", `${context} failed (status ${status}).`);
}

export interface GitHubRestProviderOptions {
  fetchFn?: GitHubApiFetch;
  requestTimeoutMs?: number;
  maxTreeEntries?: number;
  /** Transport-level JSON cap (bytes, enforced BEFORE parsing). */
  maxJsonBytes?: number;
  /** Blob/file cap (decoded bytes, enforced BEFORE base64 decoding). */
  maxFileBytes?: number;
  userAgent?: string;
}

interface TreeEntryJson {
  path?: unknown;
  mode?: unknown;
  type?: unknown;
  size?: unknown;
  sha?: unknown;
}

/**
 * Real GitHub REST provider implementing the bounded GitHubSourceProvider
 * contract. All HTTP flows through the injected fetch (default: built-in
 * fetch). No route wires this up in this task — offline interface only.
 */
export class GitHubRestProvider implements GitHubSourceProvider {
  private readonly fetchFn: GitHubApiFetch;
  private readonly requestTimeoutMs: number;
  private readonly maxTreeEntries: number;
  private readonly maxJsonBytes: number;
  private readonly maxFileBytes: number;
  private readonly userAgent: string;

  constructor(opts: GitHubRestProviderOptions = {}) {
    this.fetchFn = opts.fetchFn ?? defaultGitHubApiFetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.maxTreeEntries = opts.maxTreeEntries ?? 2000;
    this.maxJsonBytes = opts.maxJsonBytes ?? MAX_JSON_BYTES;
    this.maxFileBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;
    this.userAgent = opts.userAgent ?? "vibeflow-inspector-ai-e1/1.0";
  }

  /**
   * Build the per-request signal pair. The combined signal aborts on either
   * caller cancellation or the request timeout; `timedOut()` distinguishes
   * the two so OUR timeout maps to TIMEOUT while caller cancellation —
   * AbortError OR the caller's own TimeoutError from their own deadline —
   * propagates verbatim as the caller's abort (CANCELLED upstream).
   */
  private requestScope(caller: AbortSignal): {
    combined: AbortSignal;
    timedOut: () => boolean;
  } {
    caller.throwIfAborted();
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    return {
      combined: AbortSignal.any([caller, timeout]),
      timedOut: () => !caller.aborted && timeout.aborted,
    };
  }

  /**
   * Independently-settling request boundary. Races `work` (the transport
   * wait or a body read) against caller cancellation and an independent
   * deadline timer: exactly one outcome settles, handlers attach to `work`
   * first so a late fulfillment or rejection after settlement is
   * observed-and-ignored (never an unhandled rejection, never a result
   * change). A transport that ignores abort and never settles still loses
   * to the timer — the deadline owns the outcome. Settling never forcibly
   * terminates transport work; cooperative transports still stop early
   * via the combined signal.
   */
  private settleRequest<T>(work: Promise<T>, combined: AbortSignal, timedOut: () => boolean): Promise<T> {
    const ms = this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        combined.removeEventListener("abort", onAbort);
        fn();
      };
      const settleAbort = (): void => {
        if (timedOut()) {
          finish(() => reject(codedError("TIMEOUT", "GitHub request exceeded its deadline.")));
          return;
        }
        const reason: unknown = combined.reason;
        finish(() => reject(reason instanceof DOMException ? reason : new DOMException("aborted", "AbortError")));
      };
      const timer = setTimeout(() => {
        // Backstop: no abort observed yet (non-cooperative transport that
        // also swallowed the signal) — the deadline still owns the outcome.
        if (timedOut() || !combined.aborted) {
          finish(() => reject(codedError("TIMEOUT", "GitHub request exceeded its deadline.")));
        } else {
          settleAbort();
        }
      }, ms);
      const onAbort = (): void => {
        settleAbort();
      };
      work.then(
        (value) => finish(() => resolve(value)),
        (err) => finish(() => reject(err))
      );
      if (combined.aborted) {
        settleAbort();
        return;
      }
      combined.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Map a transport/wait failure. Coded TIMEOUT from the independent
   * boundary passes through untouched. Real fetch rejects with
   * TimeoutError (not AbortError) when a deadline signal fires, so both
   * names are classified: OUR deadline -> TIMEOUT; anything the caller
   * owns (their abort OR their own TimeoutError) propagates verbatim.
   */
  private mapWaitError(err: unknown, timedOut: () => boolean, context: string): Error {
    if (err instanceof Error && (err as { code?: unknown }).code === "TIMEOUT") return err;
    if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError")) {
      if (timedOut()) return codedError("TIMEOUT", `${context} request timed out.`);
      return err;
    }
    return codedError("PROVIDER_UNAVAILABLE", `${context} request failed.`);
  }

  private headers(): Record<string, string> {
    // Anonymous defaults. The server wrapper may add visibility-gated auth
    // at the protected request boundary; nothing here reads credentials.
    return { Accept: "application/vnd.github+json", "User-Agent": this.userAgent };
  }

  /**
   * Incrementally read a response body with a hard byte cap, retaining at
   * most maxBytes bytes of ACCEPTED body. Each accepted chunk is copied into
   * owned storage on push (toOwnedBytes), so a small view into an oversized
   * transport backing buffer cannot pin that buffer. Oversized bodies fail
   * closed DURING the read (the excess chunk is counted, never stored).
   * Reader cancellation is best-effort only: cancel() is fired (never
   * awaited) on overshoot, on read errors, and when the request signal
   * aborts mid-read — its outcome can never override the primary error or
   * stall the caller, and a non-cooperative transport may ignore it (the
   * independent settleRequest deadline is what keeps the caller from
   * hanging). A null/absent body fails closed here — PROVIDER_UNAVAILABLE
   * without touching text() — because text() would buffer an unbounded body
   * into memory outside the streaming cap.
   *
   * Provider-side retention accounting: at most maxBytes accepted bytes,
   * plus transient allocations the caller should know about — one
   * concatenation buffer of `total` bytes and one decoded string of similar
   * size (plus a small encoder pass in getJson). No bound is claimed for
   * memory the UPSTREAM transport holds itself (its own buffers, queues, or
   * a pre-materialized body it streams from); those allocate outside
   * provider control.
   */
  private async readBodyText(
    res: GitHubApiResponse,
    maxBytes: number,
    context: string,
    signal?: AbortSignal
  ): Promise<string> {
    const stream = res.body;
    if (stream === undefined || stream === null) {
      throw codedError(
        "PROVIDER_UNAVAILABLE",
        `${context} body was not retrievable as a stream; refusing to buffer an unbounded body.`
      );
    }
    const reader = stream.getReader();
    // Narrowly scoped abort hook: if our deadline or the caller aborts while
    // blocked in read(), nudge the stream closed. Best-effort only.
    const onAbort = (): void => {
      bestEffortCancel(reader);
    };
    if (signal !== undefined && !signal.aborted) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let completed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw codedError("MALFORMED", `${context} returned an invalid body chunk.`);
        }
        const room = maxBytes + 1 - total;
        if (value.length >= room) {
          bestEffortCancel(reader);
          throw codedError("PROVIDER_UNAVAILABLE", `${context} response exceeds the JSON byte cap.`);
        }
        chunks.push(toOwnedBytes(value));
        total += value.length;
      }
      completed = true;
    } finally {
      if (!completed) bestEffortCancel(reader);
      signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(out);
    } catch {
      throw codedError("MALFORMED", `${context} returned undecodable JSON bytes.`);
    }
  }

  /**
   * Fetch + parse one JSON document under hard transport caps. Order:
   * allowlist -> independently-settled fetch (never-settling transports
   * still lose to the deadline) -> status (3xx fails closed) ->
   * Content-Length pre-check BEFORE reading -> independently-settled
   * bounded STREAMING read (cap enforced during the read, never after
   * buffering) -> byte-cap check BEFORE parsing -> JSON.parse.
   * res.json() is never used, so an absent or understated Content-Length
   * cannot smuggle an oversized body into memory past the cap.
   */
  protected async getJson(url: string, caller: AbortSignal, context: string, authorization?: string): Promise<unknown> {
    assertAllowlistedApiUrl(url);
    const { combined, timedOut } = this.requestScope(caller);
    let pending: Promise<GitHubApiResponse>;
    try {
      pending = this.fetchFn(url, { method: "GET", headers: { ...this.headers(), ...(authorization ? { Authorization: authorization } : {}) }, signal: combined, redirect: "manual" });
    } catch (err) {
      throw this.mapWaitError(err, timedOut, context);
    }
    let res: GitHubApiResponse;
    try {
      res = await this.settleRequest(pending, combined, timedOut);
    } catch (err) {
      throw this.mapWaitError(err, timedOut, context);
    }
    if (authorization && res.status === 401) {
      throw codedError("AUTH_REJECTED", "Optional public authentication was rejected.");
    }
    throwForStatus(res.status, res.headers, context);
    const declared = res.headers.get("content-length");
    if (declared !== null) {
      const n = Number(declared);
      if (!Number.isSafeInteger(n) || n < 0 || n > this.maxJsonBytes) {
        throw codedError("PROVIDER_UNAVAILABLE", `${context} response exceeds the JSON byte cap.`);
      }
    }
    let raw: string;
    try {
      raw = await this.settleRequest(
        this.readBodyText(res, this.maxJsonBytes, context, combined),
        combined,
        timedOut
      );
    } catch (err) {
      throw this.mapWaitError(err, timedOut, context);
    }
    // UTF-8 encodes every char in >= 1 byte, so a char count already over
    // the cap implies a byte count over the cap — fail fast without the
    // transient encoder allocation on that path.
    if (raw.length > this.maxJsonBytes || new TextEncoder().encode(raw).length > this.maxJsonBytes) {
      throw codedError("PROVIDER_UNAVAILABLE", `${context} response exceeds the JSON byte cap.`);
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw codedError("MALFORMED", `${context} returned invalid JSON.`);
    }
  }

  async resolveRef(owner: string, repo: string, ref: string | null, signal: AbortSignal): Promise<{ sha: string }> {
    checkOwnerRepo(owner, repo);
    if (ref === null) {
      // Null ref = default-resolution intent: read default_branch, then pin it.
      const info = (await this.getJson(buildRepoUrl(owner, repo), signal, "Repository")) as {
        default_branch?: unknown;
      };
      const branch = typeof info?.default_branch === "string" ? info.default_branch : "";
      if (!isCanonicalRef(branch) || branch.length === 0) {
        throw codedError("REF_UNRESOLVED", "Repository default branch could not be resolved.");
      }
      const commit = (await this.getJson(
        buildCommitUrl(owner, repo, branch),
        signal,
        "Commit reference"
      )) as { sha?: unknown };
      if (typeof commit?.sha !== "string" || !isPinnedSha(commit.sha)) {
        throw codedError("REF_UNRESOLVED", "Branch reference could not be pinned to a commit SHA.");
      }
      return { sha: commit.sha };
    }
    checkRef(ref);
    const commit = (await this.getJson(buildCommitUrl(owner, repo, ref), signal, "Commit reference")) as {
      sha?: unknown;
    };
    if (typeof commit?.sha !== "string" || !isPinnedSha(commit.sha)) {
      throw codedError("REF_UNRESOLVED", "Reference could not be pinned to a commit SHA.");
    }
    return { sha: commit.sha };
  }

  async *listEntries(owner: string, repo: string, sha: string, signal: AbortSignal): AsyncIterable<FileMeta> {
    checkOwnerRepo(owner, repo);
    checkSha(sha);
    const data = (await this.getJson(buildTreeUrl(owner, repo, sha), signal, "Repository tree")) as {
      tree?: unknown;
      truncated?: unknown;
    };
    if (data?.truncated === true) {
      // An incomplete listing must never become a complete:true snapshot.
      throw codedError("PROVIDER_UNAVAILABLE", "Repository tree listing was truncated by the provider.");
    }
    if (!Array.isArray(data?.tree)) {
      throw codedError("MALFORMED", "Repository tree listing was malformed.");
    }
    if (data.tree.length > this.maxTreeEntries) {
      throw codedError("PROVIDER_UNAVAILABLE", "Repository tree exceeds the enumeration cap.");
    }
    for (const raw of data.tree as TreeEntryJson[]) {
      signal.throwIfAborted();
      if (typeof raw !== "object" || raw === null) {
        throw codedError("MALFORMED", "Repository tree entry was malformed.");
      }
      if (typeof raw.path !== "string" || raw.path.length === 0) continue; // directories carry no path use
      const entry: FileMeta = {
        path: raw.path,
        size: typeof raw.size === "number" && Number.isInteger(raw.size) && raw.size >= 0 ? raw.size : 0,
      };
      // Git modes: 120000 symlink, 160000 submodule (gitlink / type commit).
      if (raw.mode === "120000") entry.kind = "symlink";
      else if (raw.mode === "160000" || raw.type === "commit") entry.kind = "submodule";
      else if (raw.type === "tree") entry.kind = "other"; // directory: orchestrator skips as "other"
      else entry.kind = "file";
      if (typeof raw.mode === "string") entry.mode = raw.mode;
      yield entry;
    }
  }

  async *openFile(
    owner: string,
    repo: string,
    sha: string,
    path: string,
    signal: AbortSignal
  ): AsyncIterable<Uint8Array> {
    checkOwnerRepo(owner, repo);
    checkSha(sha);
    const { combined, timedOut } = this.requestScope(signal);
    const data = (await this.getJson(
      buildContentUrl(owner, repo, path, sha),
      signal,
      `File ${path}`
    )) as {
      type?: unknown;
      encoding?: unknown;
      content?: unknown;
      size?: unknown;
      sha?: unknown;
    };
    if (data?.type !== undefined && data.type !== "file") {
      throw codedError("NOT_FOUND", `File ${path} is not retrievable.`);
    }
    // Declared-size pre-check BEFORE fetching/decoding any body: a declared
    // oversized file fails closed without pulling its bytes.
    if (typeof data?.size === "number" && Number.isSafeInteger(data.size) && data.size > this.maxFileBytes) {
      throw codedError("LIMIT_EXCEEDED", `File ${path} exceeds the file byte cap.`);
    }
    let base64: string | null = null;
    if (typeof data?.content === "string" && data?.encoding === "base64") {
      base64 = data.content;
    } else if (typeof data?.sha === "string" && isPinnedSha(data.sha)) {
      // Contents endpoint withholds bodies for large files: blob fallback.
      const blob = (await this.getJson(
        buildBlobUrl(owner, repo, data.sha),
        signal,
        `File ${path}`
      )) as { encoding?: unknown; content?: unknown; size?: unknown };
      if (typeof blob?.content !== "string" || blob?.encoding !== "base64") {
        throw codedError("PROVIDER_UNAVAILABLE", `File ${path} body was not retrievable.`);
      }
      if (typeof blob?.size === "number" && Number.isSafeInteger(blob.size) && blob.size > this.maxFileBytes) {
        throw codedError("LIMIT_EXCEEDED", `File ${path} exceeds the file byte cap.`);
      }
      base64 = blob.content;
    } else {
      throw codedError("PROVIDER_UNAVAILABLE", `File ${path} body was not retrievable.`);
    }
    // Blob byte cap BEFORE decoding: exact decoded length from the base64
    // length, so an oversized body never gets decoded into memory.
    if (decodedBase64ByteLength(base64) > this.maxFileBytes) {
      throw codedError("LIMIT_EXCEEDED", `File ${path} exceeds the file byte cap.`);
    }
    const bytes = decodeBase64ToBytes(base64);
    if (isLfsPointer(bytes)) {
      // Fail closed: never present a pointer as source, never resolve
      // binary LFS objects here.
      throw codedError("LFS_UNRESOLVED", `File ${path} is a Git-LFS pointer; object content is not resolved.`);
    }
    // Bounded streaming: fixed-size chunks, abort checked per chunk on the
    // combined (caller + timeout) signal so a slow consumer cannot stall
    // past either deadline; early break by the reader stops iteration here.
    // Each yielded chunk is an owned copy (toOwnedBytes), so a consumer that
    // retains one small chunk does not pin the whole decoded file buffer.
    for (let off = 0; off < bytes.length; off += CHUNK_BYTES) {
      if (combined.aborted) {
        if (timedOut()) throw codedError("TIMEOUT", `File ${path} request timed out.`);
        combined.throwIfAborted();
      }
      yield toOwnedBytes(bytes.subarray(off, off + CHUNK_BYTES));
    }
  }
}

/**
 * Exact decoded byte length of a base64 string WITHOUT decoding it.
 * Whitespace-tolerant like decodeBase64ToBytes; returns +Infinity for
 * malformed input so the caller fails closed before allocating.
 */
export function decodedBase64ByteLength(base64: string): number {
  const compact = base64.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(compact)) return Number.POSITIVE_INFINITY;
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

/** Base64 (whitespace-tolerant) to bytes. Throws MALFORMED on bad input. */
export function decodeBase64ToBytes(base64: string): Uint8Array {
  const compact = base64.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(compact)) {
    throw codedError("MALFORMED", "Provider returned invalid base64 content.");
  }
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    throw codedError("MALFORMED", "Provider returned undecodable base64 content.");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** True when decoded bytes are a Git-LFS pointer (not the real object). */
export function isLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length > 1024) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 256)));
  } catch {
    return false;
  }
  return text.startsWith(LFS_POINTER_PREFIX);
}
