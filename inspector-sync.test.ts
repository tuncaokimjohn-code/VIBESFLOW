import { describe, expect, it } from "vitest";
import {
  hashForInspectorView,
  inspectorKeyAction,
  inspectorUrl,
  inspectorViewForHash,
  selectInspectorViewSync,
  type InspectorHashAdapter,
  type InspectorView,
} from "@/lib/inspector-hash";

/** In-memory stand-in for window.history + location.hash (no DOM needed). */
function fakeAdapter(path = "/analysis/preview", hash = "") {
  let currentHash = hash;
  const commits: string[] = [];
  let notifications = 0;
  const adapter: InspectorHashAdapter = {
    readHash: () => currentHash,
    readPath: () => path,
    commit: (url: string) => {
      commits.push(url);
      currentHash = url.slice(path.length);
    },
    notify: () => {
      notifications += 1;
    },
  };
  return {
    adapter,
    commits,
    currentHash: () => currentHash,
    notifications: () => notifications,
  };
}

describe("inspector hash mapping", () => {
  it("maps #findings to findings and everything else to arch", () => {
    expect(inspectorViewForHash("#findings")).toBe("findings");
    for (const h of ["", "#", "#arch", "#Findings", "#FINDINGS", "#other", "#findings-extra"]) {
      expect(inspectorViewForHash(h)).toBe("arch");
    }
  });
  it("round-trips view -> hash -> view for both tabs", () => {
    for (const v of ["arch", "findings"] as const) {
      expect(inspectorViewForHash(hashForInspectorView(v))).toBe(v);
    }
    expect(hashForInspectorView("findings")).toBe("#findings");
    expect(hashForInspectorView("arch")).toBe("");
  });
  it("builds canonical tab URLs", () => {
    expect(inspectorUrl("/analysis/preview", "", "findings")).toBe("/analysis/preview#findings");
    expect(inspectorUrl("/analysis/preview", "?x=1", "arch")).toBe("/analysis/preview?x=1");
  });
});

describe("inspector keyboard transitions (Defect B input side)", () => {
  it("moves right/left with wrap", () => {
    expect(inspectorKeyAction("arch", "ArrowRight")).toBe("findings");
    expect(inspectorKeyAction("findings", "ArrowRight")).toBe("arch");
    expect(inspectorKeyAction("findings", "ArrowLeft")).toBe("arch");
    expect(inspectorKeyAction("arch", "ArrowLeft")).toBe("findings");
  });
  it("jumps with Home/End from either tab", () => {
    expect(inspectorKeyAction("findings", "Home")).toBe("arch");
    expect(inspectorKeyAction("arch", "Home")).toBe("arch");
    expect(inspectorKeyAction("arch", "End")).toBe("findings");
    expect(inspectorKeyAction("findings", "End")).toBe("findings");
  });
  it("ignores unrelated keys", () => {
    for (const v of ["arch", "findings"] as const) {
      for (const k of ["Enter", " ", "Tab", "Escape", "a", "ArrowUp", "ArrowDown"]) {
        expect(inspectorKeyAction(v, k)).toBeNull();
      }
    }
  });
});

describe("shared sync mechanism (Defects A/B)", () => {
  it("keyboard-equivalent select commits the hash and notifies once", () => {
    const f = fakeAdapter();
    // ArrowRight on arch -> findings (Defect B: must reach Shell/sidebar).
    const afterKey = inspectorKeyAction("arch", "ArrowRight") as InspectorView;
    const applied = selectInspectorViewSync(f.adapter, "arch", afterKey);
    expect(applied).toBe("findings");
    expect(f.commits).toEqual(["/analysis/preview#findings"]);
    expect(f.notifications()).toBe(1);
    // What the Shell sidebar observes from the URL now selects Findings.
    expect(inspectorViewForHash(f.currentHash())).toBe("findings");
  });
  it("selecting arch clears the fragment and notifies", () => {
    const f = fakeAdapter("/analysis/preview", "#findings");
    const applied = selectInspectorViewSync(f.adapter, "findings", "arch");
    expect(applied).toBe("arch");
    expect(f.commits).toEqual(["/analysis/preview"]);
    expect(f.notifications()).toBe(1);
    expect(inspectorViewForHash(f.currentHash())).toBe("arch");
  });
  it("repeat select of the current view is a no-op", () => {
    const f = fakeAdapter("/analysis/preview", "#findings");
    expect(selectInspectorViewSync(f.adapter, "findings", "findings")).toBe("findings");
    expect(f.commits).toEqual([]);
    expect(f.notifications()).toBe(0);
  });
  it("external hash change converges without pushing duplicate history", () => {
    // Same-route Next <Link> navigation updated the URL without notifying
    // (Defect A): deferred re-sync derives the view and skips commit.
    const f = fakeAdapter("/analysis/preview", "#findings");
    const derived: InspectorView = inspectorViewForHash(f.adapter.readHash());
    expect(derived).toBe("findings");
    expect(selectInspectorViewSync(f.adapter, "arch", derived)).toBe("findings");
    expect(f.commits).toEqual([]);
  });
  it("back/forward traversal derives the matching view", () => {
    // popstate with restored fragment must select the matching tab.
    expect(inspectorViewForHash("")).toBe("arch");
    expect(inspectorViewForHash("#findings")).toBe("findings");
  });
});

describe("Dashboard keeps the shared contract", () => {
  it("re-exports the shared mapping helpers unchanged", async () => {
    const dash = await import("./components/Dashboard");
    expect(dash.inspectorViewForHash("#findings")).toBe("findings");
    expect(dash.inspectorViewForHash("")).toBe("arch");
    expect(dash.hashForInspectorView("findings")).toBe("#findings");
    expect(dash.hashForInspectorView("arch")).toBe("");
  });
});
