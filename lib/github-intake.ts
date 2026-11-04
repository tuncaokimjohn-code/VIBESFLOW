/**
 * E1 GitHub intake orchestrator v3 (P3 Candidate 003, findings A/B/D/F).
 *
 * Bounded streaming contract:
 * - Metadata arrives as a bounded async enumeration. Each entry is
 *   validated BEFORE sorting, dereferencing, or reading; enumeration stops
 *   at the metadata cap without ever requiring a full listing in memory.
 * - File bodies arrive as chunked async iterables. Per-file and aggregate
 *   budgets are enforced on ACTUAL transferred bytes; declared sizes only
 *   gate pre-read skips and are never trusted for accounting.
 * - A mock provider yielding one giant buffer cannot bypass limits: the
 *   accumulator stops at cap+1 and the file is skipped as oversized.
 *
 * Independently-settling boundary (Finding B): the whole collection races
 * a deadline timer and user cancellation via a managed Promise.race. A
 * non-cooperative provider cannot stall settlement; late completions are
 * ignored and every attached promise is handled, so no unhandled
 * rejections escape. Limitation (stated, not solved): an application-level
 * timeout does not forcibly terminate a non-cooperative external operation;
 * future HTTP transport cancellation must be tested separately.
 *
 * No external HTTP is implemented here. Repository code is never executed.
 */
import {
  E1_CONTRACT_VERSION,
  E1_LIMITS,
  defaultPolicy,
  isBinaryContent,
  languageForPath,
  locateByteOffset,
  canonicalSyntheticProvenance,
  derivedCoverage,
  manifestHashFor,
  sha256Hex,
  snapshotIdFor,
  skippedPathFor,
  splitSourceLines,
  validateMetaEntry,
  validateSnapshot,
  type CollectionPolicy,
  type FileMeta,
  type P3SkipReason,
  type SkippedFile,
  type SnapshotFile,
  type SourceSnapshot,
} from "@/lib/source-snapshot";

export type { FileMeta };
export type { EntryKind } from "@/lib/source-snapshot";

export type IntakeErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "PRIVATE_OR_FORBIDDEN"
  | "RATE_LIMITED"
  | "EMPTY"
  | "REF_UNRESOLVED"
  | "LIMIT_EXCEEDED"
  | "DUPLICATE_PATH"
  | "TIMEOUT"
  | "CANCELLED"
  | "PROVIDER_UNAVAILABLE"
  | "MALFORMED";

export type IntakeResult =
  | { ok: true; snapshot: SourceSnapshot }
  | { ok: false; code: IntakeErrorCode; message: string; partial?: SourceSnapshot };

/**
 * Bounded provider contract v3.
 *
 * - `listEntries` yields descriptors lazily; the caller stops iterating at
 *   the metadata cap, so no full listing is ever required.
 * - `openFile` yields body chunks lazily; the caller stops reading at
 *   per-file cap + 1, so one giant buffer cannot bypass accounting.
 * - Real-transport requirement (documented, untested here): chunks SHOULD be
 *   small (e.g. <= 64 KiB) so peak memory stays bounded; the orchestrator
 *   enforces totals regardless of chunking cooperation.
 */
export interface GitHubSourceProvider {
  resolveRef(owner: string, repo: string, ref: string | null, signal: AbortSignal): Promise<{ sha: string }>;
  listEntries(owner: string, repo: string, sha: string, signal: AbortSignal): AsyncIterable<FileMeta>;
  openFile(
    owner: string,
    repo: string,
    sha: string,
    path: string,
    signal: AbortSignal
  ): AsyncIterable<Uint8Array>;
}

export interface IntakeLimits {
  maxMetadataEntries: number;
  maxFileBytes: number;
  maxTotalTransferredBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxSkippedEntries: number;
  maxDepth: number;
}

export function defaultLimits(): IntakeLimits {
  return {
    maxMetadataEntries: E1_LIMITS.maxMetadataEntries,
    maxFileBytes: E1_LIMITS.maxFileBytes,
    maxTotalTransferredBytes: E1_LIMITS.maxTotalTransferredBytes,
    maxTotalBytes: E1_LIMITS.maxTotalBytes,
    maxFiles: E1_LIMITS.maxFiles,
    maxSkippedEntries: E1_LIMITS.maxSkippedEntries,
    maxDepth: E1_LIMITS.maxPathDepth,
  };
}

function providerFailure(err: unknown): Extract<IntakeResult, { ok: false }> {
  if (err instanceof DOMException && err.name === "AbortError") {
    return { ok: false, code: "CANCELLED", message: "Intake was cancelled." };
  }
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case "NOT_FOUND":
      return { ok: false, code: "NOT_FOUND", message: "Repository or reference was not found." };
    case "PRIVATE_OR_FORBIDDEN":
      return { ok: false, code: "PRIVATE_OR_FORBIDDEN", message: "Repository is private or access is forbidden." };
    case "RATE_LIMITED":
      return { ok: false, code: "RATE_LIMITED", message: "Provider rate limit reached. Retry later." };
    case "EMPTY":
      return { ok: false, code: "EMPTY", message: "Repository contains no retrievable entries." };
    case "REF_UNRESOLVED":
      return { ok: false, code: "REF_UNRESOLVED", message: "Branch/tag reference could not be resolved." };
    case "MALFORMED":
      return { ok: false, code: "MALFORMED", message: "Provider listing was malformed." };
    default:
      return { ok: false, code: "PROVIDER_UNAVAILABLE", message: "Source provider is unavailable." };
  }
}

/**
 * Reject unsafe paths: traversal, absolute, backslashes, control
 * characters, over-depth, blank segments.
 */
export function rejectUnsafePath(path: string, maxDepth: number): string | null {
  if (path.length === 0 || path.length > 512) return "path-length";
  if (path.startsWith("/") || path.includes("\\")) return "absolute-or-separator";
  // Control characters and DEL must never appear in snapshot paths.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control-chars";
  const segments = path.split("/");
  if (segments.length > maxDepth) return "max-depth";
  for (const seg of segments) {
    if (seg.length === 0 || seg === "." || seg === "..") return "traversal";
  }
  return null;
}

/** Mutable collection progress, shared with the deadline boundary. */
interface Progress {
  sha: string | null;
  files: SnapshotFile[];
  skipped: SkippedFile[];
  complete: boolean;
  /** Provider metadata entries actually observed (enumeration count). */
  enumerated: number;
}

function buildSnapshot(
  owner: string,
  repo: string,
  sha: string,
  progress: Progress,
  policy: CollectionPolicy,
  collectedAt?: string
): SourceSnapshot {
  const sorted = [...progress.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const derived = derivedCoverage(sorted, progress.skipped);
  // Full-digest identity: the manifest (bound to policy + completeness +
  // enumeration + content) hashed with the required provenance/commit
  // inputs. 7 + 64 = 71 chars, within P1's 128-char cap. No abbreviated
  // prefix is ever claimed unique on its own.
  const canonicalProvenance = `https://github.com/${owner}/${repo}`;
  const manifestHash = manifestHashFor(sorted, progress.skipped, policy, progress.complete, progress.enumerated);
  const snapshotId = snapshotIdFor("github", canonicalProvenance, sha, manifestHash);
  return validateSnapshot({
    contractVersion: E1_CONTRACT_VERSION,
    sourceKind: "github",
    snapshotId,
    canonicalProvenance,
    resolvedCommitIfGitHub: sha,
    manifestHash,
    files: sorted,
    skipped: progress.skipped,
    coverage: {
      supportedLanguages: derived.supportedLanguages,
      unsupportedAreas: derived.unsupportedAreas,
      unsupportedAreasTruncated: derived.unsupportedAreasTruncated,
      metadataEntries: progress.enumerated,
      collected: sorted.length,
      skippedCount: progress.skipped.length,
      totalBytes: sorted.reduce((n, f) => n + f.bytes, 0),
      complete: progress.complete,
      collectionPolicy: policy,
    },
    collectedAt: collectedAt ?? new Date().toISOString(),
  });
}

/**
 * Independently-settling boundary (Finding B). Races `work` against a
 * deadline timer and an abort signal with a correctly managed Promise:
 * exactly one outcome settles; handlers are attached to `work` so late
 * fulfillment or rejection after settlement is observed-and-ignored, never
 * an unhandled rejection and never a result change.
 */
export function settleIndependently<T>(
  work: Promise<T>,
  opts: { deadlineMs: number; signal?: AbortSignal; timeoutCode?: IntakeErrorCode; onDeadline?: () => void }
): Promise<T> {
  const timeoutCode = opts.timeoutCode ?? "TIMEOUT";
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      // Snapshot abort state BEFORE cleanup: onDeadline typically aborts
      // the signal to release a hanging reader, and that cleanup abort
      // must not convert the outcome to CANCELLED — the deadline owns it.
      const wasAborted = opts.signal?.aborted ?? false;
      try {
        opts.onDeadline?.();
      } catch {
        // cleanup attempts must never break settlement
      }
      finish(() => {
        if (wasAborted) {
          reject(Object.assign(new DOMException("aborted", "AbortError"), { intakeSettled: "cancelled" as const }));
        } else {
          reject(Object.assign(new Error(`deadline of ${opts.deadlineMs}ms exceeded`), { code: timeoutCode }));
        }
      });
    }, opts.deadlineMs);
    const onAbort = (): void => {
      finish(() => reject(new DOMException("aborted", "AbortError")));
    };
    // Worker handlers attach BEFORE the already-aborted check: a promise
    // that rejects late must be observed, never unhandled — even when the
    // signal fired before we got here.
    work.then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err))
    );
    if (opts.signal?.aborted) {
      finish(() => reject(new DOMException("aborted", "AbortError")));
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Read a chunked file stream under hard budgets (Finding A).
 *
 * `consumed` reports EVERY byte pulled from the provider — including bytes
 * pulled before a truncation, a stream error, or a thrown failure — so the
 * caller accounts all actual transfer. Iteration errors are caught here so
 * bytes pulled before the exception are still reported; a yield-then-throw
 * provider cannot evade the budget. Provider error codes pass through.
 *
 * Allocation caveat (stated, not solved): a single provider chunk is
 * allocated in full before its length is checked; a hostile provider
 * yielding one giant chunk forces that one allocation. Caps still hold
 * (truncated, never stored beyond cap+1; aggregate stops further pulls),
 * but transport-level memory safety requires the eventual network adapter
 * to yield bounded chunks — the mock contract alone does not guarantee it.
 * Real-provider chunk bounds require separate verification.
 */
/**
 * Checked non-negative addition. Returns null on overflow/unsafe integers
 * so the caller fails closed instead of wrapping the budget.
 */
function checkedAdd(a: number, b: number): number | null {
  const s = a + b;
  return Number.isSafeInteger(s) && s >= 0 ? s : null;
}

export type BoundedRead =
  | { ok: true; bytes: Uint8Array; truncated: boolean; consumed: number }
  | { ok: false; error: string; code: "LIMIT_EXCEEDED" | "STREAM"; consumed: number }
  | { ok: false; error: string; code: "ITERATOR"; consumed: number; thrown: unknown };

/**
 * Attempt iterator cleanup without letting it affect the decided outcome
 * (Finding A, 007): on early termination `return()` is invoked when
 * available so providers can release resources, but the call is fired
 * without awaiting — independently settling. A synchronous throw is
 * swallowed; a rejection or never-settling cleanup is observed (never
 * unhandled) yet cannot overwrite the outcome, reset byte counts, or
 * delay settlement. Exactly-once settlement is preserved: this function
 * returns void and never touches the read result.
 */
export function settleIteratorCleanup(it: AsyncIterator<Uint8Array>): void {
  let ret: unknown;
  try {
    const candidate = (it as { return?: unknown }).return;
    if (typeof candidate !== "function") return;
    ret = (candidate as () => unknown).call(it);
  } catch {
    return; // throwing cleanup: resources stay provider-side; outcome already decided
  }
  if (ret !== null && (typeof ret === "object" || typeof ret === "function")) {
    try {
      const then = (ret as { then?: unknown }).then;
      if (typeof then === "function") {
        (ret as PromiseLike<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // ignore accessor/calling pathologies; nothing to observe
    }
  }
}

export async function readBoundedStream(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
  aggregateAllowance: number
): Promise<BoundedRead> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Manual iteration (007): `for await` with an early return/break awaits
  // the iterator's `return()` cleanup, and a throwing cleanup would discard
  // this function's already-computed outcome and consumed count. Manual
  // next() calls decide bytes here; early termination additionally FIRES
  // cleanup via settleIteratorCleanup (never awaited, never outcome-bearing)
  // so providers can release resources without any power over accounting.
  // The consumer never awaits non-cooperative teardown; bounded retention
  // holds (cap+1 max). A single provider-supplied giant chunk is allocated
  // in full before its length is inspected — caps hold on what is stored,
  // but transport-level memory safety needs bounded real-provider chunks.
  let it: AsyncIterator<Uint8Array>;
  try {
    it = stream[Symbol.asyncIterator]();
  } catch {
    return { ok: false, error: "unreadable stream", code: "STREAM", consumed: 0 };
  }
  for (;;) {
    let step: IteratorResult<Uint8Array>;
    try {
      step = await it.next();
    } catch (err) {
      // Structured outcome, error UNMUTATED: the thrown value — Error,
      // coded object, or primitive — passes through untouched so provider
      // codes (including non-Error thrown values) survive for the caller
      // to map. The pulled-byte count travels alongside the outcome, never
      // attached to the error object. The failed iterator needs no
      // cleanup attempt: it already signaled termination itself.
      return { ok: false, error: "iterator failure", code: "ITERATOR", consumed: total, thrown: err };
    }
    if (step.done) break;
    const chunk = step.value;
    if (!(chunk instanceof Uint8Array)) {
      settleIteratorCleanup(it);
      return { ok: false, error: "non-bytes chunk", code: "STREAM", consumed: total };
    }
    // A successfully received chunk counts BEFORE any size rejection: the
    // refused chunk was received, so consumed includes it — never stored.
    const roomFile = maxBytes + 1 - total;
    if (chunk.length >= roomFile) {
      settleIteratorCleanup(it);
      return { ok: true, bytes: new Uint8Array(0), truncated: true, consumed: total + chunk.length };
    }
    // Aggregate allowance enforced DURING chunk processing: stop pulling
    // the moment it would be exceeded, counting the refused chunk (it was
    // received) without storing it.
    const roomAgg = aggregateAllowance + 1 - total;
    if (chunk.length >= roomAgg) {
      settleIteratorCleanup(it);
      return {
        ok: false,
        error: "aggregate transfer allowance exceeded",
        code: "LIMIT_EXCEEDED",
        consumed: total + chunk.length,
      };
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { ok: true, bytes: out, truncated: false, consumed: total };
}

/**
 * Run E1 intake under the bounded streaming contract.
 *
 * Envelope (deadlines/cancellation) is enforced by `settleIndependently`
 * around the whole collection; per-operation aborts additionally use a
 * derived signal so cooperative providers stop early.
 */
export async function runGitHubIntake(
  owner: string,
  repo: string,
  ref: string | null,
  provider: GitHubSourceProvider,
  opts?: {
    signal?: AbortSignal;
    collectedAt?: string;
    limits?: Partial<IntakeLimits>;
    deadlineMs?: number;
  }
): Promise<IntakeResult> {
  const limits: IntakeLimits = { ...defaultLimits(), ...opts?.limits };
  const deadlineMs = opts?.deadlineMs ?? E1_LIMITS.defaultDeadlineMs;
  const policy: CollectionPolicy = {
    version: E1_CONTRACT_VERSION,
    maxFileBytes: limits.maxFileBytes,
    maxTotalBytes: limits.maxTotalBytes,
    maxFiles: limits.maxFiles,
    maxDepth: limits.maxDepth,
    maxMetadataEntries: limits.maxMetadataEntries,
    maxTotalTransferredBytes: limits.maxTotalTransferredBytes,
    maxSkippedEntries: limits.maxSkippedEntries,
    deadlineMs,
    binaryProbeBytes: E1_LIMITS.binaryProbeBytes,
  };
  const progress: Progress = { sha: null, files: [], skipped: [], complete: true, enumerated: 0 };

  const skip = (path: string, reason: P3SkipReason): IntakeResult | null => {
    if (progress.skipped.length >= limits.maxSkippedEntries) {
      progress.complete = false;
      return {
        ok: false,
        code: "LIMIT_EXCEEDED",
        message: "Skipped-entry cap exceeded; coverage cannot be recorded honestly.",
        partial: tryPartial(),
      };
    }
    progress.skipped.push({ path: skippedPathFor(path), reason });
    return null;
  };
  const tryPartial = (): SourceSnapshot | undefined => {
    // Partial snapshots preserve the REAL resolved commit (Finding D).
    // Before resolution there is no commit to preserve: no partial.
    if (progress.sha === null) return undefined;
    try {
      return buildSnapshot(owner, repo, progress.sha, progress, policy, opts?.collectedAt);
    } catch {
      return undefined;
    }
  };
  const abortError = (): Extract<IntakeResult, { ok: false }> =>
    opts?.signal?.aborted
      ? { ok: false, code: "CANCELLED", message: "Intake was cancelled." }
      : { ok: false, code: "TIMEOUT", message: "Intake exceeded its processing deadline." };

  if (opts?.signal?.aborted) return { ok: false, code: "CANCELLED", message: "Intake was cancelled." };

  const collection = (async (): Promise<IntakeResult> => {
    const deadline = AbortSignal.timeout(deadlineMs);
    const signal = opts?.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
    const aborted = (): boolean => signal.aborted;

    let sha: string;
    try {
      ({ sha } = await provider.resolveRef(owner, repo, ref, signal));
    } catch (err) {
      if (aborted()) return { ...abortError(), partial: tryPartial() };
      return providerFailure(err);
    }
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return { ok: false, code: "REF_UNRESOLVED", message: "Provider returned a malformed commit SHA." };
    }
    // The real commit is recorded the moment it resolves, so every later
    // partial preserves it (Finding D) — never a fabricated zero SHA.
    progress.sha = sha;

    // Bounded enumeration: validate each entry on arrival; stop at the cap
    // without ever requiring the full listing.
    const metas: FileMeta[] = [];
    try {
      for await (const raw of provider.listEntries(owner, repo, sha, signal)) {
        if (aborted()) {
          progress.complete = false;
          return { ...abortError(), partial: tryPartial() };
        }
        if (metas.length >= limits.maxMetadataEntries) {
          progress.complete = false;
          return {
            ok: false,
            code: "LIMIT_EXCEEDED",
            message: `Metadata entries exceed the enumeration cap (${limits.maxMetadataEntries}); entries beyond the cap were not examined.`,
            partial: tryPartial(),
          };
        }
        const checked = validateMetaEntry(raw);
        if (!checked.ok) {
          progress.complete = false;
          return { ok: false, code: "MALFORMED", message: `Provider metadata invalid: ${checked.error}.`, partial: tryPartial() };
        }
        // Count every validated entry observed — including duplicates found
        // later: enumeration happened regardless of downstream filtering.
        progress.enumerated += 1;
        metas.push(checked.meta);
      }
    } catch (err) {
      if (aborted()) {
        progress.complete = false;
        return { ...abortError(), partial: tryPartial() };
      }
      progress.complete = false;
      const mapped = providerFailure(err);
      return { ...mapped, partial: tryPartial() };
    }

    // Canonical order before limits: same commit + same policy => same
    // selection regardless of provider enumeration order.
    const ordered = [...metas].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const seen = new Set<string>();
    let transferred = 0;

    for (const meta of ordered) {
      if (aborted()) {
        progress.complete = false;
        return { ...abortError(), partial: tryPartial() };
      }
      if (seen.has(meta.path)) {
        return { ok: false, code: "DUPLICATE_PATH", message: `Duplicate path in provider listing: ${meta.path}.` };
      }
      seen.add(meta.path);

      const unsafe = rejectUnsafePath(meta.path, limits.maxDepth);
      if (unsafe !== null) {
        if (unsafe === "max-depth") {
          const stop = skip(meta.path, "depth-limit");
          if (stop) return stop;
          continue;
        }
        // Syntax-unsafe paths are NEVER itemized in skipped[] (Finding C):
        // recording them would embed traversal/control sequences in the
        // snapshot. They stay counted in coverage.metadataEntries
        // (enumeration scope), so scope is preserved without naming them.
        continue;
      }
      if (meta.kind === "symlink" || meta.mode === "120000") {
        const stop = skip(meta.path, "symlink");
        if (stop) return stop;
        continue;
      }
      // Gitlink (submodule commit reference) is never source: record, don't fetch.
      if (meta.kind === "submodule" || meta.mode === "160000") {
        const stop = skip(meta.path, "submodule");
        if (stop) return stop;
        continue;
      }
      if (meta.kind !== undefined && meta.kind !== "file") {
        const stop = skip(meta.path, "other");
        if (stop) return stop;
        continue;
      }
      const language = languageForPath(meta.path);
      if (language === null) {
        const stop = skip(meta.path, "unsupported-language");
        if (stop) return stop;
        continue;
      }
      // Declared size gates pre-read skips only; accounting uses actuals.
      if (!(meta.size >= 0) || meta.size > limits.maxFileBytes) {
        const stop = skip(meta.path, "oversized");
        if (stop) return stop;
        continue;
      }
      if (progress.files.length >= limits.maxFiles) {
        progress.complete = false;
        const stop = skip(meta.path, "entry-limit");
        if (stop) return stop;
        continue;
      }

      // Transfer budget exhausted: fail closed (LIMIT_EXCEEDED + partial),
      // never silently convert remaining files into skips. Non-read skips
      // above already passed through; everything reaching here needs reads.
      if (transferred >= limits.maxTotalTransferredBytes) {
        progress.complete = false;
        return {
          ok: false,
          code: "LIMIT_EXCEEDED",
          message: `Aggregate transfer budget (${limits.maxTotalTransferredBytes} bytes) exhausted; remaining entries not examined.`,
          partial: tryPartial(),
        };
      }

      // Open the stream: only a synchronous provider throw lands here
      // (consumed 0 — nothing was pulled). Iteration failures surface
      // through the bounded reader below, WITH their pulled byte counts.
      let stream: AsyncIterable<Uint8Array>;
      try {
        stream = provider.openFile(owner, repo, sha, meta.path, signal);
      } catch (err) {
        if (aborted()) {
          progress.complete = false;
          return { ...abortError(), partial: tryPartial() };
        }
        const code = (err as { code?: string } | null)?.code;
        if (code === "NOT_FOUND") {
          progress.complete = false;
          const stop = skip(meta.path, "not-found");
          if (stop) return stop;
          continue;
        }
        progress.complete = false;
        const mapped = providerFailure(err);
        return { ...mapped, partial: tryPartial() };
      }
      if (aborted()) {
        progress.complete = false;
        return { ...abortError(), partial: tryPartial() };
      }
      // Remaining aggregate allowance enforced DURING chunk processing.
      // readBoundedStream never throws: iterator failures arrive as a
      // structured ITERATOR outcome carrying the unmutated thrown value
      // plus the pulled-byte count, so cleanup cannot discard accounting.
      const remaining = limits.maxTotalTransferredBytes - transferred;
      const read: BoundedRead = await readBoundedStream(stream, limits.maxFileBytes, remaining);
      if (!read.ok && read.code === "ITERATOR") {
        // Count first, then map — never reset, never lost.
        const afterThrow = checkedAdd(transferred, read.consumed);
        if (afterThrow === null || afterThrow > limits.maxTotalTransferredBytes) {
          progress.complete = false;
          // Record the over-cap total when representable (honest accounting);
          // on overflow keep the last safe total and still fail closed.
          if (afterThrow !== null) transferred = afterThrow;
          return {
            ok: false,
            code: "LIMIT_EXCEEDED",
            message: `Aggregate transfer budget (${limits.maxTotalTransferredBytes} bytes) exceeded by failed read of ${meta.path}.`,
            partial: tryPartial(),
          };
        }
        transferred = afterThrow;
        if (aborted()) {
          progress.complete = false;
          return { ...abortError(), partial: tryPartial() };
        }
        // The thrown value passes through unmutated: coded objects AND
        // non-Error primitives keep their identity for mapping.
        const thrownCode = (read.thrown as { code?: string } | null)?.code;
        if (thrownCode === "NOT_FOUND") {
          // Missing on read — after partial transfer: counted, then skipped.
          progress.complete = false;
          const stop = skip(meta.path, "not-found");
          if (stop) return stop;
          continue;
        }
        progress.complete = false;
        const mapped = providerFailure(read.thrown);
        return { ...mapped, partial: tryPartial() };
      }
      // EVERY consumed byte counts — truncation and refused chunks included.
      // Never reset, never subtracted.
      const nextTransferred = checkedAdd(transferred, read.consumed);
      if (nextTransferred === null || nextTransferred > limits.maxTotalTransferredBytes) {
        progress.complete = false;
        return {
          ok: false,
          code: "LIMIT_EXCEEDED",
          message: `Aggregate transfer budget (${limits.maxTotalTransferredBytes} bytes) exceeded by ${meta.path}; repeated oversized content cannot evade the cap.`,
          partial: tryPartial(),
        };
      }
      transferred = nextTransferred;
      if (!read.ok) {
        progress.complete = false;
        if (read.code === "LIMIT_EXCEEDED") {
          return {
            ok: false,
            code: "LIMIT_EXCEEDED",
            message: `Aggregate transfer allowance exhausted during ${meta.path}.`,
            partial: tryPartial(),
          };
        }
        return { ok: false, code: "MALFORMED", message: `Provider stream invalid for ${meta.path}: ${read.error}.`, partial: tryPartial() };
      }
      if (read.truncated) {
        // Declared size lied or chunks overflowed: skip, never store excess.
        // consumed bytes are already counted above and stay counted.
        const stop = skip(meta.path, "oversized");
        if (stop) return stop;
        continue;
      }
      const body = read.bytes;
      if (isBinaryContent(body, policy.binaryProbeBytes)) {
        const stop = skip(meta.path, "binary");
        if (stop) return stop;
        continue;
      }
      let geom: { text: string; lineCount: number; lineStartOffsets: number[] };
      try {
        geom = splitSourceLines(body);
      } catch {
        const stop = skip(meta.path, "binary");
        if (stop) return stop;
        continue;
      }
      // Interior-offset sanity: every recorded start must locate cleanly.
      for (const off of geom.lineStartOffsets) {
        const located = locateByteOffset(geom.text, geom.lineStartOffsets, off, body.length);
        if (!located.ok) {
          progress.complete = false;
          return { ok: false, code: "MALFORMED", message: `Line geometry invalid for ${meta.path}.`, partial: tryPartial() };
        }
      }
      progress.files.push({
        path: meta.path,
        language,
        bytes: body.length,
        sha256: sha256Hex(body),
        lineCount: geom.lineCount,
        lineStartOffsets: geom.lineStartOffsets,
      });
      if (progress.files.reduce((n, f) => n + f.bytes, 0) > limits.maxTotalBytes) {
        progress.files.pop();
        progress.complete = false;
        const stop = skip(meta.path, "size-limit");
        if (stop) return stop;
      }
    }

    if (progress.files.length === 0 && progress.skipped.length === 0) {
      return { ok: false, code: "EMPTY", message: "Repository contains no retrievable entries." };
    }
    // Authoritative-deadline recheck (Finding B, 007): a non-cooperative
    // provider may finish DURING the outer boundary's backstop window after
    // the inner deadline already expired. Success after expiry must never
    // be returned — recheck the derived signal (user abort OR inner
    // deadline) before settling success. The outer +1s race stays a pure
    // backstop with no success semantics of its own; the inner deadlineMs
    // remains the single authoritative collection deadline.
    if (aborted()) {
      progress.complete = false;
      return { ...abortError(), partial: tryPartial() };
    }
    return { ok: true, snapshot: buildSnapshot(owner, repo, sha, progress, policy, opts?.collectedAt) };
  })();

  // The independent boundary settles even for hanging providers; the inner
  // promise is handled either way, so late outcomes are ignored silently.
  // Margin above the inner deadline is small: cooperative paths settle via
  // the inner abort almost immediately; the outer race is only a backstop.
  try {
    return await settleIndependently(collection, { deadlineMs: deadlineMs + 1_000, signal: opts?.signal });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (err instanceof DOMException && err.name === "AbortError") {
      progress.complete = false;
      return { ...abortError(), partial: tryPartial() };
    }
    if (code === "TIMEOUT") {
      progress.complete = false;
      return { ok: false, code: "TIMEOUT", message: "Intake exceeded its processing deadline.", partial: tryPartial() };
    }
    progress.complete = false;
    const mapped = providerFailure(err);
    return { ...mapped, partial: tryPartial() };
  }
}

/**
 * Build a synthetic-labeled snapshot for UI/test flows (never "github").
 * Provenance binds owner + repo + exact normalized ref via
 * canonicalSyntheticProvenance — never an ambiguous concatenated label.
 */
export function buildSyntheticSnapshot(
  owner: string,
  repo: string,
  ref: string | null,
  files: SnapshotFile[],
  skipped: SkippedFile[],
  collectedAt?: string
): SourceSnapshot {
  const policy = defaultPolicy();
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const derived = derivedCoverage(sorted, skipped);
  const canonicalProvenance = canonicalSyntheticProvenance(owner, repo, ref);
  const manifestHash = manifestHashFor(sorted, skipped, policy, true, sorted.length + skipped.length);
  return validateSnapshot({
    contractVersion: E1_CONTRACT_VERSION,
    sourceKind: "synthetic",
    snapshotId: snapshotIdFor("synthetic", canonicalProvenance, null, manifestHash),
    canonicalProvenance,
    resolvedCommitIfGitHub: null,
    manifestHash,
    files: sorted,
    skipped,
    coverage: {
      supportedLanguages: derived.supportedLanguages,
      unsupportedAreas: derived.unsupportedAreas,
      unsupportedAreasTruncated: derived.unsupportedAreasTruncated,
      metadataEntries: sorted.length + skipped.length,
      collected: sorted.length,
      skippedCount: skipped.length,
      totalBytes: sorted.reduce((n, f) => n + f.bytes, 0),
      complete: true,
      collectionPolicy: policy,
    },
    collectedAt: collectedAt ?? new Date().toISOString(),
  });
}
