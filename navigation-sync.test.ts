import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetInspectorHashStoreForTests,
  applyInspectorHash,
  getInspectorHashServerSnapshot,
  getInspectorHashSnapshot,
  hashForInspectorView,
  inspectorKeyAction,
  inspectorViewForClickEvent,
  inspectorViewForHash,
  inspectorViewForHref,
  refreshInspectorHashFromUrl,
  selectInspectorViewSync,
  subscribeInspectorHashStore,
  subscribeInspectorSync,
  type InspectorClickEvent,
  type InspectorHashAdapter,
  type InspectorView,
} from "@/lib/inspector-hash";

/**
 * Evidence tiers in this file:
 * - UNIT: pure helpers and the shared store against fake adapters/targets.
 *   Honest contract proof; NOT browser behavior.
 * - NATIVE-EVENT model: hashchange/popstate dispatched on fake targets model
 *   real *browser* behavior for native anchors and traversal (browsers do
 *   fire these). They never model Next.js App Router commits, which emit
 *   neither (verified in installed Next 16.4.3 app-router.js).
 * - SIMULATED-ROUTER: see router-simulation.test.ts.
 * - MOUNTED-COMPONENT / REAL-BROWSER: NOT RUN (no DOM runner available).
 */

const BASE = "http://preview.local/analysis/preview";

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

type Listener = (e: never) => void;

class FakeTarget {
  listeners = new Map<string, Set<Listener>>();
  addCalls: Array<[string, Listener, unknown]> = [];
  removeCalls: Array<[string, Listener, unknown]> = [];
  dispatchCalls: Array<[string, unknown]> = [];
  addEventListener(t: string, l: Listener, o?: unknown) {
    this.addCalls.push([t, l, o]);
    let s = this.listeners.get(t);
    if (!s) this.listeners.set(t, (s = new Set()));
    s.add(l);
  }
  removeEventListener(t: string, l: Listener, o?: unknown) {
    this.removeCalls.push([t, l, o]);
    this.listeners.get(t)?.delete(l);
  }
  dispatch(t: string, e?: unknown) {
    this.dispatchCalls.push([t, e]);
    for (const l of this.listeners.get(t) ?? []) l(e as never);
  }
  count(t: string) {
    return this.listeners.get(t)?.size ?? 0;
  }
}

function fakeWindow(hash = "", href = BASE) {
  const t = new FakeTarget();
  return {
    target: t,
    location: { href, hash },
    addEventListener: t.addEventListener.bind(t),
    removeEventListener: t.removeEventListener.bind(t),
  };
}

function anchor(
  href: string | null,
  opts: { parent?: unknown; target?: string | null; download?: boolean } = {}
) {
  return {
    tagName: "A",
    getAttribute: (n: string) => {
      if (n === "href") return href;
      if (n === "target") return opts.target ?? null;
      if (n === "download") return opts.download ? "" : null;
      return null;
    },
    hasAttribute: (n: string) => n === "download" && opts.download === true,
    parentElement: opts.parent ?? null,
  };
}

function nestedSpan(parent: unknown) {
  return {
    tagName: "SPAN",
    getAttribute: () => null,
    parentElement: parent,
  };
}

function click(target: unknown, overrides: Partial<InspectorClickEvent> = {}): InspectorClickEvent {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
    ...overrides,
  };
}

beforeEach(() => {
  __resetInspectorHashStoreForTests();
});

describe("UNIT: same-route navigation mapping (Finding A input side)", () => {
  it("resolves same-path destinations by hash, ignoring query differences", () => {
    expect(inspectorViewForHref("#findings", BASE)).toBe("findings");
    expect(inspectorViewForHref("/analysis/preview#findings", BASE)).toBe("findings");
    expect(inspectorViewForHref("/analysis/preview", BASE)).toBe("arch");
    expect(inspectorViewForHref("#arch", BASE)).toBe("arch");
  });
  it("detects the confirmed Finding A failure: query change + hash resolves", () => {
    // Candidate 011 returned null here (equal-search requirement), dropping
    // intent for `/analysis/preview?x=1` -> `/analysis/preview#findings`.
    expect(inspectorViewForHref("/analysis/preview?x=1#findings", BASE)).toBe("findings");
    expect(
      inspectorViewForHref("/analysis/preview#findings", `${BASE}?x=1`)
    ).toBe("findings");
    expect(inspectorViewForClickEvent(click(anchor("/analysis/preview#findings")), `${BASE}?x=1`)).toBe(
      "findings"
    );
  });
  it("a sidebar link that intentionally changes the query resolves to its destination", () => {
    expect(inspectorViewForHref("/analysis/preview?y=2#findings", `${BASE}?x=1`)).toBe("findings");
    expect(inspectorViewForHref("/analysis/preview?y=2", `${BASE}?x=1`)).toBe("arch");
  });
  it("returns null for away-navigation or bad hrefs", () => {
    expect(inspectorViewForHref("/compare/preview", BASE)).toBeNull();
    expect(inspectorViewForHref("https://other.example/y#findings", BASE)).toBeNull();
    expect(inspectorViewForHref("::not a url::", "not a base")).toBeNull();
  });
  it("derives intent from plain left-clicks on same-page anchors", () => {
    expect(inspectorViewForClickEvent(click(anchor("/analysis/preview#findings")), BASE)).toBe(
      "findings"
    );
    expect(
      inspectorViewForClickEvent(click(nestedSpan(anchor("/analysis/preview#findings"))), BASE)
    ).toBe("findings");
    expect(inspectorViewForClickEvent(click(anchor("/analysis/preview")), BASE)).toBe("arch");
  });
  it("ignores clicks that leave the current document unchanged", () => {
    const a = anchor("/analysis/preview#findings");
    expect(inspectorViewForClickEvent(click(a, { button: 1 }), BASE)).toBeNull();
    expect(inspectorViewForClickEvent(click(a, { ctrlKey: true }), BASE)).toBeNull();
    expect(inspectorViewForClickEvent(click(a, { metaKey: true }), BASE)).toBeNull();
    expect(inspectorViewForClickEvent(click(a, { shiftKey: true }), BASE)).toBeNull();
    expect(inspectorViewForClickEvent(click(a, { altKey: true }), BASE)).toBeNull();
    expect(inspectorViewForClickEvent(click(a, { defaultPrevented: true }), BASE)).toBeNull();
    expect(
      inspectorViewForClickEvent(click(anchor("/analysis/preview#findings", { target: "_blank" })), BASE)
    ).toBeNull();
    expect(
      inspectorViewForClickEvent(click(anchor("/analysis/preview#findings", { download: true })), BASE)
    ).toBeNull();
    expect(
      inspectorViewForClickEvent(click(anchor("/analysis/preview#findings", { target: "_self" })), BASE)
    ).toBe("findings");
    expect(inspectorViewForClickEvent(click(anchor("/compare/preview")), BASE)).toBeNull();
    expect(inspectorViewForClickEvent(click(anchor(null)), BASE)).toBeNull();
    expect(inspectorViewForClickEvent(click(nestedSpan(null)), BASE)).toBeNull();
    expect(inspectorViewForClickEvent(click(null), BASE)).toBeNull();
  });
});

describe("UNIT: shared navigation-state store", () => {
  it("starts at the SSR value and converges via authoritative refresh", () => {
    expect(getInspectorHashSnapshot()).toBe("");
    const seen: string[] = [];
    const stop = subscribeInspectorHashStore(() => seen.push(getInspectorHashSnapshot()));
    expect(refreshInspectorHashFromUrl(() => "#findings")).toBe("#findings");
    expect(getInspectorHashSnapshot()).toBe("#findings");
    expect(seen).toEqual(["#findings"]);
    stop();
  });
  it("notifies only on actual change (idempotent)", () => {
    const seen: string[] = [];
    const stop = subscribeInspectorHashStore(() => seen.push(getInspectorHashSnapshot()));
    applyInspectorHash("#findings");
    applyInspectorHash("#findings");
    refreshInspectorHashFromUrl(() => "#findings");
    expect(seen).toEqual(["#findings"]);
    stop();
  });
  it("unsubscribe stops delivery", () => {
    const seen: string[] = [];
    const stop = subscribeInspectorHashStore(() => seen.push(getInspectorHashSnapshot()));
    stop();
    applyInspectorHash("#findings");
    expect(seen).toEqual([]);
  });
});

describe("UNIT: URL-drift repair for the already-selected tab (Finding B)", () => {
  it("repairs arch view with #findings URL by clearing the fragment", () => {
    const f = fakeAdapter("/analysis/preview", "#findings");
    expect(selectInspectorViewSync(f.adapter, "arch", "arch")).toBe("arch");
    expect(f.commits).toEqual(["/analysis/preview"]);
    expect(f.notifications()).toBe(1);
    expect(f.currentHash()).toBe("");
  });
  it("repairs findings view with empty URL by restoring the fragment", () => {
    const f = fakeAdapter("/analysis/preview", "");
    expect(selectInspectorViewSync(f.adapter, "findings", "findings")).toBe("findings");
    expect(f.commits).toEqual(["/analysis/preview#findings"]);
    expect(f.notifications()).toBe(1);
  });
  it("repairs a stale optimistic store without touching history", () => {
    // Cancelled-navigation aftermath: store says findings, URL says arch.
    // Selecting Architecture must repair the store with no commit.
    applyInspectorHash("#findings");
    expect(getInspectorHashSnapshot()).toBe("#findings");
    const f = fakeAdapter("/analysis/preview", "");
    let storeDeliveries = 0;
    const stop = subscribeInspectorHashStore(() => {
      storeDeliveries += 1;
    });
    expect(selectInspectorViewSync(f.adapter, "findings", "arch")).toBe("arch");
    expect(f.commits).toEqual([]);
    expect(f.notifications()).toBe(0);
    expect(getInspectorHashSnapshot()).toBe("");
    expect(storeDeliveries).toBe(1);
    stop();
  });
  it("stays a true no-op when URL, inspector, and store already agree", () => {
    const f1 = fakeAdapter("/analysis/preview", "");
    expect(selectInspectorViewSync(f1.adapter, "arch", "arch")).toBe("arch");
    expect(f1.commits).toEqual([]);
    expect(f1.notifications()).toBe(0);
    const f2 = fakeAdapter("/analysis/preview", "#findings");
    expect(selectInspectorViewSync(f2.adapter, "findings", "findings")).toBe("findings");
    expect(f2.commits).toEqual([]);
    expect(f2.notifications()).toBe(0);
  });
  it("preserves query strings for inspector-only tab switches", () => {
    const f = fakeAdapter("/analysis/preview?x=1", "");
    expect(selectInspectorViewSync(f.adapter, "arch", "findings")).toBe("findings");
    expect(f.commits).toEqual(["/analysis/preview?x=1#findings"]);
    const g = fakeAdapter("/analysis/preview?x=1", "#findings");
    expect(selectInspectorViewSync(g.adapter, "findings", "arch")).toBe("arch");
    expect(g.commits).toEqual(["/analysis/preview?x=1"]);
  });
});

describe("UNIT: idempotent synchronization (no duplicate history)", () => {
  it("full Arch -> Findings -> Arch cycle commits exactly once per change", () => {
    const f = fakeAdapter();
    let view: InspectorView = "arch";
    view = selectInspectorViewSync(f.adapter, view, "findings");
    view = selectInspectorViewSync(f.adapter, view, "arch");
    view = selectInspectorViewSync(f.adapter, view, "findings");
    expect(view).toBe("findings");
    expect(f.commits).toEqual([
      "/analysis/preview#findings",
      "/analysis/preview",
      "/analysis/preview#findings",
    ]);
    expect(f.notifications()).toBe(3);
  });
  it("repeated identical selects and clicks add no history", () => {
    const f = fakeAdapter("/analysis/preview", "#findings");
    selectInspectorViewSync(f.adapter, "findings", "findings");
    selectInspectorViewSync(f.adapter, "findings", "findings");
    expect(f.commits).toEqual([]);
    const win = fakeWindow("#findings");
    const doc = new FakeTarget();
    const seen: string[] = [];
    const stop = subscribeInspectorSync(win, doc, (h) => seen.push(h));
    const a = anchor("/analysis/preview#findings");
    doc.dispatch("click", click(a));
    doc.dispatch("click", click(a));
    expect(seen).toEqual(["#findings", "#findings"]);
    stop();
  });
});

describe("NATIVE-EVENT model: back/forward and cross-consumer consistency", () => {
  it("popstate delivers the restored fragment to every subscriber", () => {
    // Real browsers fire popstate on traversal; this models that native
    // behavior only — never a Next.js App Router commit (which is silent).
    const win = fakeWindow("#findings");
    const doc = new FakeTarget();
    const shellHashes: string[] = [];
    const dashViews: InspectorView[] = [];
    const stopShell = subscribeInspectorSync(win, doc, (h) => shellHashes.push(h));
    const stopDash = subscribeInspectorSync(win, doc, (h) =>
      dashViews.push(inspectorViewForHash(h))
    );
    win.location.hash = "";
    win.target.dispatch("popstate");
    win.location.hash = "#findings";
    win.target.dispatch("popstate");
    expect(shellHashes).toEqual(["", "#findings"]);
    expect(dashViews).toEqual(["arch", "findings"]);
    stopShell();
    stopDash();
  });
  it("sidebar hash and dashboard view agree after each step of a full session", () => {
    const f = fakeAdapter();
    const steps: Array<[InspectorView, string]> = [];
    const record = (view: InspectorView) => {
      steps.push([inspectorViewForHash(f.currentHash()), f.currentHash()]);
      return view;
    };
    let view: InspectorView = "arch";
    record(view);
    view = record(selectInspectorViewSync(f.adapter, view, "findings"));
    view = record(selectInspectorViewSync(f.adapter, view, "arch"));
    expect(steps).toEqual([
      ["arch", ""],
      ["findings", "#findings"],
      ["arch", ""],
    ]);
    expect(view).toBe("arch");
  });
});

describe("UNIT: direct #findings load and hydration-safe initialization", () => {
  it("mount sync derives findings from the committed hash", () => {
    // Component/store initial state is the SSR-safe constant ""; the mount
    // effect applies this exact derivation from the committed URL.
    expect(getInspectorHashServerSnapshot()).toBe("");
    expect(getInspectorHashSnapshot()).toBe("");
    expect(inspectorViewForHash("#findings")).toBe("findings");
    expect(inspectorViewForHash("")).toBe("arch");
  });
  it("keyboard transitions remain pure roving-tablist moves", () => {
    let v: InspectorView = "arch";
    const next = inspectorKeyAction(v, "ArrowRight");
    expect(next).toBe("findings");
    v = next ?? v;
    expect(inspectorKeyAction(v, "ArrowRight")).toBe("arch");
    expect(inspectorKeyAction(v, "Home")).toBe("arch");
    expect(inspectorKeyAction("arch", "End")).toBe("findings");
    expect(inspectorKeyAction(v, "Enter")).toBeNull();
  });
});

describe("UNIT: event listener cleanup", () => {
  it("unsubscribe removes all three listeners", () => {
    const win = fakeWindow("");
    const doc = new FakeTarget();
    const seen: string[] = [];
    const stop = subscribeInspectorSync(win, doc, (h) => seen.push(h));
    expect(win.target.count("hashchange")).toBe(1);
    expect(win.target.count("popstate")).toBe(1);
    expect(doc.count("click")).toBe(1);
    stop();
    expect(win.target.count("hashchange")).toBe(0);
    expect(win.target.count("popstate")).toBe(0);
    expect(doc.count("click")).toBe(0);
    win.target.dispatch("hashchange");
    win.target.dispatch("popstate");
    doc.dispatch("click", click(anchor("/analysis/preview#findings")));
    expect(seen).toEqual([]);
  });
  it("store unsubscribe stops fan-out delivery", () => {
    const seen: string[] = [];
    const stop = subscribeInspectorHashStore(() => seen.push(getInspectorHashSnapshot()));
    stop();
    applyInspectorHash("#findings");
    expect(seen).toEqual([]);
    expect(getInspectorHashSnapshot()).toBe("#findings");
  });
});

describe("WIRING (static checks, not behavior proof)", () => {
  it("Dashboard derives its view from the shared store and hook", () => {
    const dashSrc = readFileSync("components/Dashboard.tsx", "utf8");
    expect(dashSrc).toContain("useInspectorHash");
    expect(dashSrc).toContain("selectInspectorViewSync");
    expect(dashSrc).toContain("pushState");
    expect(dashSrc).toContain("inspectorViewForHash");
    expect(dashSrc).not.toContain("requestAnimationFrame");
    expect(dashSrc).not.toContain("dispatchEvent");
    expect(dashSrc).not.toContain("setTimeout(sync");
  });
  it("Shell consumes the shared store without useSearchParams (static-safe)", () => {
    const shellSrc = readFileSync("components/Shell.tsx", "utf8");
    expect(shellSrc).toContain("useSyncExternalStore");
    expect(shellSrc).toContain("subscribeInspectorHashStore");
    expect(shellSrc).not.toContain("useSearchParams");
    expect(shellSrc).not.toContain("requestAnimationFrame");
    expect(shellSrc).not.toContain("dispatchEvent");
  });
  it("the hook re-reads committed state when search commits change", () => {
    const hookSrc = readFileSync("lib/use-inspector-nav.ts", "utf8");
    expect(hookSrc).toContain("useSearchParams");
    expect(hookSrc).toContain("[search]");
    expect(hookSrc).toContain("subscribeInspectorSync");
    expect(hookSrc).toContain("refreshInspectorHashFromUrl");
  });
});
