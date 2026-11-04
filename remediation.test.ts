import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isActive } from "./components/Shell";
import { findingForNode } from "./components/Graph";

const ARCH = "/analysis/preview";
const FIND = "/analysis/preview#findings";

describe("nav single-active tracking", () => {
  it("activates Architecture only without hash", () => {
    expect(isActive("/analysis/preview", "", ARCH)).toBe(true);
    expect(isActive("/analysis/preview", "", FIND)).toBe(false);
  });
  it("activates Findings only with #findings hash", () => {
    expect(isActive("/analysis/preview", "#findings", FIND)).toBe(true);
    expect(isActive("/analysis/preview", "#findings", ARCH)).toBe(false);
  });
  it("matches analysis subpaths", () => {
    expect(isActive("/analysis/preview/extra", "", ARCH)).toBe(true);
    expect(isActive("/analysis/preview/extra", "#findings", FIND)).toBe(true);
  });
  it("tracks hash-only changes (Link pushState / back-forward)", () => {
    // Candidate 011: Shell no longer names pushState directly — hash-only
    // tracking moved to the shared subscribeInspectorSync mechanism (which
    // subscribes hashchange/popstate and derives timing-free click intent).
    const src = readFileSync("components/Shell.tsx", "utf8");
    expect(src).toContain("popstate");
    expect(src).toContain("hashchange");
    expect(src).toContain("subscribeInspectorSync");
  });
  it("findings anchor exists", () => {
    expect(readFileSync("components/Panels.tsx", "utf8")).toContain('id="findings"');
  });
});

describe("evidence dialog portal", () => {
  it("portals to document.body outside inert ancestors", () => {
    const src = readFileSync("components/Panels.tsx", "utf8");
    expect(src).toContain("createPortal");
    expect(src).toContain("document.body");
  });
});

describe("codex findings remediation", () => {
  it("help link keeps an accessible name when its text is hidden at 390px", () => {
    const src = readFileSync("components/Shell.tsx", "utf8");
    expect(src).toMatch(/aria-label="Help"/);
  });
  it("graph edges render directional arrowheads via MarkerType", () => {
    const src = readFileSync("components/Graph.tsx", "utf8");
    expect(src).toContain("MarkerType");
    expect(src).toContain("markerEnd");
  });
  it("inspector is a keyboard-accessible tab panel below 1280px, 2 columns at xl", () => {
    const src = readFileSync("components/Dashboard.tsx", "utf8");
    expect(src).toContain("xl:grid-cols-");
    expect(src).not.toContain("lg:grid-cols-");
    expect(src).toMatch(/role="tablist"/);
    expect(src).toMatch(/aria-label="Preview panels"/);
    expect(src).toMatch(/role="tab"/);
    expect(src).toMatch(/aria-selected/);
    expect(src).toMatch(/aria-controls/);
    expect(src).toMatch(/role="tabpanel"/);
    expect(src).toMatch(/ArrowRight/);
    expect(src).toMatch(/ArrowLeft/);
    expect(src).toMatch(/hidden xl:block/);
    expect(src).toMatch(/xl:hidden/);
  });
  it("selected finding matches the selected node or is cleared", () => {
    expect(findingForNode("f1", "orders")).toBe("f1");
    expect(findingForNode("f2", "users")).toBe("f2");
    expect(findingForNode("f1", "users")).toBeNull();
    expect(findingForNode("f2", "orders")).toBeNull();
    expect(findingForNode("f1", null)).toBeNull();
    expect(findingForNode(null, "orders")).toBeNull();
    expect(findingForNode("nope", "orders")).toBeNull();
    const src = readFileSync("components/Dashboard.tsx", "utf8");
    expect(src).toContain("findingForNode");
  });
  it("no unsupported synthetic 'more' evidence count remains", () => {
    expect(readFileSync("components/Panels.tsx", "utf8")).not.toMatch(/and \d+ more/);
    expect(readFileSync("components/Shell.tsx", "utf8")).not.toMatch(/and 3 more/);
    expect(readFileSync("components/Shell.tsx", "utf8")).toContain("UNSCANNED.length - 4");
  });
});

describe("home public intake copy", () => {
  it("mounts the real workspace and retains explicit readiness limits", () => {
    expect(readFileSync("app/page.tsx", "utf8")).toContain("<PublicRepositoryWorkspace />");
    const src = readFileSync("components/PublicRepositoryWorkspace.tsx", "utf8");
    expect(src).toContain("immutable commit");
    expect(src).toContain("Muse explanation: NOT READY");
    expect(src).toContain("Comparison: NOT READY");
    expect(src).toContain("No sample graph or findings are substituted.");
  });
  it("wires the enabled intake control into the header", () => {
    const shell = readFileSync("components/Shell.tsx", "utf8");
    expect(shell).toMatch(/RepoIntake/);
    expect(shell).not.toMatch(/aria-disabled/);
  });
});

describe("inspector hash/tab synchronization (below 1280px)", () => {
  it("maps #findings to findings tab and everything else to arch", async () => {
    const { inspectorViewForHash, hashForInspectorView } = await import("./components/Dashboard");
    expect(inspectorViewForHash("#findings")).toBe("findings");
    for (const h of ["", "#", "#arch", "#Findings", "#FINDINGS", "#other", "#findings-extra"]) {
      expect(inspectorViewForHash(h)).toBe("arch");
    }
    expect(hashForInspectorView("findings")).toBe("#findings");
    expect(hashForInspectorView("arch")).toBe("");
  });
  it("round-trips view -> hash -> view for both tabs", async () => {
    const { inspectorViewForHash, hashForInspectorView } = await import("./components/Dashboard");
    for (const v of ["arch", "findings"] as const) {
      expect(inspectorViewForHash(hashForInspectorView(v))).toBe(v);
    }
  });
  it("Dashboard wires hashchange/popstate sync and pushState tab updates", () => {
    const src = readFileSync("components/Dashboard.tsx", "utf8");
    expect(src).toContain("hashchange");
    expect(src).toContain("popstate");
    expect(src).toContain("pushState");
    expect(src).toContain("inspectorViewForHash");
    expect(src).toContain("hashForInspectorView");
    expect(src).toContain("selectInspectorView");
  });
  it("keyboard roving keeps single tabbable tab with aria wiring", () => {
    const src = readFileSync("components/Dashboard.tsx", "utf8");
    expect(src).toMatch(/tabIndex=\{inspectorView === t\.k \? 0 : -1\}/);
    expect(src).toContain("aria-selected");
    expect(src).toContain("aria-controls");
  });
});
