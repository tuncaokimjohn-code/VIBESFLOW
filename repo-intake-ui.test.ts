/** STATIC (Finding G): intake control wiring — mounted/browser NOT RUN. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("RepoIntake wiring", () => {
  const src = readFileSync("components/RepoIntake.tsx", "utf8");
  it("validates API payloads at runtime with no unsafe assertions", () => {
    expect(src).toMatch(/parseIntakeResponse\(await res\.json\(\)\)/);
    // No assertion casts on untrusted data (the "as P2/P3" in the comment is prose, not a cast).
    expect(src).not.toMatch(/data\.snapshot as /);
    expect(src).not.toMatch(/res\.json\(\) as /);
    expect(src).not.toMatch(/ as unknown as /);
  });
  it("is usable at narrow widths (not hidden on mobile)", () => {
    expect(src).not.toMatch(/hidden sm:block/);
    expect(src).toMatch(/flex-wrap|min-w-0/);
  });
  it("exposes idle/validating/loading/success/error states with live status", () => {
    for (const s of ["idle", "validating", "loading", "success", "error"]) {
      expect(src).toContain(`status: "${s}"`);
    }
    expect(src).toMatch(/aria-live="polite"/);
    expect(src).toMatch(/role="alert"/);
  });
  it("never fabricates graph or finding data", () => {
    expect(src).not.toMatch(/GRAPH_NODES|FINDINGS|ArchGraph|FindingsPanel/);
    expect(src).toMatch(/no findings produced/);
  });
  it("offers cancellation during loading", () => {
    expect(src).toMatch(/AbortController/);
    expect(src).toMatch(/Cancel/);
  });
  it("verifies the receipt matches the submitted locator before success (Finding D)", () => {
    expect(src).toMatch(/receiptMatchesRequest\(data\.requested, parsed\.owner, parsed\.repo, parsed\.ref\)/);
    expect(src).toContain("Intake receipt did not match the submitted repository.");
  });
});
