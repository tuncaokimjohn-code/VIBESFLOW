/**
 * UNIT: independently-settling deadline/cancel boundary (Finding B).
 * Proves settlement against hanging, late, and non-cooperative providers.
 */
import { describe, expect, it } from "vitest";
import { settleIndependently } from "@/lib/github-intake";

function hanging(signal?: AbortSignal): Promise<string> {
  return new Promise<string>((_, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}

describe("settleIndependently", () => {
  it("settles TIMEOUT for a provider that never resolves and ignores abort", async () => {
    const start = Date.now();
    await expect(
      settleIndependently(new Promise<string>(() => {}), { deadlineMs: 50 })
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - start).toBeLessThan(5000);
  });
  it("late completion after the deadline does not change the settled result", async () => {
    let resolveLate!: (v: string) => void;
    const late = new Promise<string>((resolve) => { resolveLate = resolve; });
    const settled = settleIndependently(late, { deadlineMs: 50 });
    await expect(settled).rejects.toMatchObject({ code: "TIMEOUT" });
    resolveLate("too-late");
    await expect(late).resolves.toBe("too-late"); // handled, no unhandled rejection
    await expect(settled).rejects.toMatchObject({ code: "TIMEOUT" }); // unchanged
  });
  it("late rejection after settlement is observed, not unhandled", async () => {
    let rejectLate!: (e: unknown) => void;
    const late = new Promise<string>((_, reject) => { rejectLate = reject; });
    const settled = settleIndependently(late, { deadlineMs: 50 });
    await expect(settled).rejects.toMatchObject({ code: "TIMEOUT" });
    rejectLate(new Error("late failure"));
    await expect(late.catch((e: Error) => e.message)).resolves.toBe("late failure");
  });
  it("reject-after-cancellation settles CANCELLED (first signal wins)", async () => {
    const c = new AbortController();
    const work = hanging(c.signal);
    const settled = settleIndependently(work, { deadlineMs: 5000, signal: c.signal });
    c.abort();
    await expect(settled).rejects.toBeInstanceOf(DOMException);
  });
  it("immediate completion before cancellation resolves normally", async () => {
    const c = new AbortController();
    const result = await settleIndependently(Promise.resolve("fast"), { deadlineMs: 5000, signal: c.signal });
    expect(result).toBe("fast");
    c.abort(); // abort after settlement: no effect, no throw
  });
  it("already-aborted signal rejects without running out the clock", async () => {
    const c = new AbortController();
    c.abort();
    const start = Date.now();
    await expect(settleIndependently(hanging(), { deadlineMs: 30_000, signal: c.signal })).rejects.toBeInstanceOf(DOMException);
    expect(Date.now() - start).toBeLessThan(5000);
  });
  it("already-aborted late rejection is observed, never unhandled (Finding B)", async () => {
    const c = new AbortController();
    c.abort();
    let rejectLate!: (e: unknown) => void;
    const late = new Promise<string>((_, reject) => { rejectLate = reject; });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const settled = settleIndependently(late, { deadlineMs: 30_000, signal: c.signal });
      await expect(settled).rejects.toBeInstanceOf(DOMException);
      rejectLate(new Error("late failure after abort"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
  it("non-cooperative stream cancel is bounded, never awaited (Finding B)", async () => {
    const { readBoundedBody } = await import("@/lib/intake-api");
    let cancelCalls = 0;
    const hangingStream = new ReadableStream<Uint8Array>({
      start() { /* never enqueues, never closes, ignores cancel */ },
      cancel() {
        cancelCalls++;
        return new Promise<void>(() => {}); // never settles
      },
    });
    const c = new AbortController();
    const pending = readBoundedBody(hangingStream, 64, { signal: c.signal });
    c.abort();
    const start = Date.now();
    await expect(pending).resolves.toMatchObject({ ok: false, code: "CANCELLED" });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(cancelCalls).toBe(1);
  });
});
