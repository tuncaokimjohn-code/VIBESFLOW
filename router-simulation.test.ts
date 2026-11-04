import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetInspectorHashStoreForTests,
  applyInspectorHash,
  getInspectorHashServerSnapshot,
  getInspectorHashSnapshot,
  hashForInspectorView,
  inspectorViewForHash,
  refreshInspectorHashFromUrl,
  selectInspectorViewSync,
  subscribeInspectorHashStore,
  subscribeInspectorSync,
  type InspectorHashAdapter,
  type InspectorView,
} from "@/lib/inspector-hash";

/**
 * SIMULATED-ROUTER evidence (Finding B).
 *
 * The harness below models ONLY the installed Next.js 16.4.3 App Router
 * commit behavior verified by reading
 * `next/dist/client/components/app-router.js`:
 * - same-route navigations commit asynchronously (after the click handler
 *   returns) via raw `history.pushState`,
 * - NO `hashchange`/`popstate` is dispatched for those commits,
 * - components that consume search params re-render after the commit.
 *
 * The harness therefore has NO event-dispatch API at all: convergence must
 * come from (a) timing-free click intent and (b) an explicit committed
 * re-read on re-render — the exact two paths the production hook effect
 * uses. This file proves the contract under that model; it is NOT
 * mounted-component or real-browser evidence (both reported NOT RUN).
 */

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Minimal Next-commit model: async silent commit + conditional rerender.
 * Rerender callbacks fire ONLY when pathname or search changed — mirroring
 * production, where `usePathname`/`useSearchParams` consumers (the only
 * commit-observation channel besides events) re-render solely on those
 * changes. Hash-only commits re-render nothing. The harness has NO
 * hashchange dispatch API at all: Next.js never emits it.
 */
class SimulatedNextRouter {
  url: URL;
  private rerenderListeners = new Set<() => void>();
  constructor(initial: string) {
    this.url = new URL(initial);
  }
  onRerender(cb: () => void): () => void {
    this.rerenderListeners.add(cb);
    return () => {
      this.rerenderListeners.delete(cb);
    };
  }
  private commit(dest: URL): void {
    const prev = this.url;
    this.url = dest;
    if (dest.pathname !== prev.pathname || dest.search !== prev.search) {
      for (const l of [...this.rerenderListeners]) l();
    }
  }
  /** Models a Next <Link> click: resolves href, commits async, fires nothing. */
  clickLink(href: string): void {
    const dest = new URL(href, this.url.href);
    queueMicrotask(() => this.commit(dest));
  }
  /** Restores a committed URL (e.g. back/forward); popstate dispatch is modeled by the test, like a browser. */
  traverseTo(url: string): void {
    this.commit(new URL(url));
  }
}

type Listener = (e: never) => void;

class FakeDocTarget {
  listeners = new Map<string, Set<Listener>>();
  dispatched: Array<[string, unknown]> = [];
  addEventListener(t: string, l: Listener) {
    let s = this.listeners.get(t);
    if (!s) this.listeners.set(t, (s = new Set()));
    s.add(l);
  }
  removeEventListener(t: string, l: Listener) {
    this.listeners.get(t)?.delete(l);
  }
  dispatchClick(e: unknown) {
    this.dispatch("click", e);
  }
  dispatch(t: string, e?: unknown) {
    this.dispatched.push([t, e]);
    for (const l of this.listeners.get(t) ?? []) l(e as never);
  }
}

function plainClick(target: unknown, overrides: Record<string, unknown> = {}) {
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

function anchor(href: string) {
  return {
    tagName: "A",
    getAttribute: (n: string) => (n === "href" ? href : null),
    hasAttribute: () => false,
    parentElement: null,
  };
}

const ROUTER_ORIGIN = "http://router.local";

/**
 * Mount one consumer exactly the way the production hook effect works:
 * DOM subscription (intent + native committed events) plus an explicit
 * committed re-read whenever the router re-renders us (the `[search]`
 * re-run). `seen` records the store value after every delivery.
 */
function mountConsumer(router: SimulatedNextRouter, seen: string[]) {
  const doc = new FakeDocTarget();
  const winEvents = new FakeDocTarget();
  const win = {
    location: {
      get href() {
        return router.url.href;
      },
      get hash() {
        return router.url.hash;
      },
    },
    addEventListener: winEvents.addEventListener.bind(winEvents),
    removeEventListener: winEvents.removeEventListener.bind(winEvents),
  };
  refreshInspectorHashFromUrl(() => win.location.hash || "");
  seen.push(getInspectorHashSnapshot());
  const stopDom = subscribeInspectorSync(win, doc, (h) => {
    applyInspectorHash(h);
    seen.push(getInspectorHashSnapshot());
  });
  const stopRerender = router.onRerender(() => {
    refreshInspectorHashFromUrl(() => win.location.hash || "");
    seen.push(getInspectorHashSnapshot());
  });
  return {
    /** Deliver a capture-phase click through the REAL subscription only. */
    dispatchDocClick(target: unknown, overrides: Record<string, unknown> = {}) {
      doc.dispatchClick(plainClick(target, overrides));
    },
    /**
     * Full browser+Next click: the document dispatches to listeners AND
     * Next.js commits asynchronously. A prevented click commits nothing,
     * mirroring the browser.
     */
    navigateClick(href: string, overrides: Record<string, unknown> = {}) {
      doc.dispatchClick(plainClick(anchor(href), overrides));
      if (!overrides.defaultPrevented) router.clickLink(href);
    },
    /**
     * Model browser traversal: the URL is already restored by
     * `router.traverseTo`, then popstate dispatches like a real browser.
     * Real browsers also fire hashchange on fragment-only traversal; that
     * native path is covered in navigation-sync.test.ts, not here.
     */
    dispatchPopstate() {
      winEvents.dispatch("popstate");
    },
    /** No hashchange may ever be dispatched: Next.js never emits it. */
    dispatchedWinEvents: () => winEvents.dispatched.map(([t]) => t),
    winEventListenerCount: () =>
      (winEvents.listeners.get("hashchange")?.size ?? 0) +
      (winEvents.listeners.get("popstate")?.size ?? 0),
    stop() {
      stopDom();
      stopRerender();
    },
  };
}

beforeEach(() => {
  __resetInspectorHashStoreForTests();
});

describe("SIMULATED-ROUTER: query-aware same-route navigation (Finding A)", () => {
  it("converges /analysis/preview?x=1 -> Findings with zero committed events", async () => {
    const router = new SimulatedNextRouter(`${ROUTER_ORIGIN}/analysis/preview?x=1`);
    const seen: string[] = [];
    const c = mountConsumer(router, seen);
    expect(seen).toEqual([""]);

    // Click lands; Next.js has NOT committed (URL still carries ?x=1).
    c.navigateClick("/analysis/preview#findings");
    expect(seen).toEqual(["", "#findings"]);
    expect(router.url.hash).toBe("");
    expect(router.url.search).toBe("?x=1");

    // Late async commit: no event exists to observe it by.
    await flush();
    expect(router.url.href).toBe(`${ROUTER_ORIGIN}/analysis/preview#findings`);
    expect(seen[seen.length - 1]).toBe("#findings");
    // Mount ("") plus every later delivery agrees: no dependence on timing.
    expect(seen[0]).toBe("");
    expect(new Set(seen.slice(1)).size).toBe(1);

    // Structural proof: the harness has no hashchange dispatch at all and
    // the consumer's native listeners never fired — the final state came
    // only from intent + the explicit committed re-read on re-render.
    expect(c.winEventListenerCount()).toBe(2);
    expect(c.dispatchedWinEvents()).toEqual([]);
    c.stop();
  });

  it("delayed commit stays converged across extra frames", async () => {
    const router = new SimulatedNextRouter(`${ROUTER_ORIGIN}/analysis/preview?x=1`);
    const seen: string[] = [];
    const c = mountConsumer(router, seen);
    c.navigateClick("/analysis/preview#findings");
    await flush();
    await flush();
    expect(router.url.hash).toBe("#findings");
    expect(seen[seen.length - 1]).toBe("#findings");
    expect(c.dispatchedWinEvents()).toEqual([]);
    c.stop();
  });

  it("Findings -> Architecture navigation clears the fragment", async () => {
    const router = new SimulatedNextRouter(`${ROUTER_ORIGIN}/analysis/preview#findings`);
    const seen: string[] = [];
    const c = mountConsumer(router, seen);
    expect(seen).toEqual(["#findings"]);
    // Hash-only commit: no search/path change, so NO re-render fires.
    // Convergence must (and does) come from the intent alone.
    c.navigateClick("/analysis/preview");
    await flush();
    expect(router.url.href).toBe(`${ROUTER_ORIGIN}/analysis/preview`);
    expect(seen).toEqual(["#findings", ""]);
    expect(c.dispatchedWinEvents()).toEqual([]);
    c.stop();
  });

  it("optimistic intent followed by a different committed destination resolves correctly", async () => {
    const router = new SimulatedNextRouter(`${ROUTER_ORIGIN}/analysis/preview?x=1`);
    const seen: string[] = [];
    const c = mountConsumer(router, seen);
    c.navigateClick("/analysis/preview#findings");
    expect(seen[seen.length - 1]).toBe("#findings");
    // Before the first commit lands, a second navigation commits elsewhere.
    c.navigateClick("/analysis/preview?y=2");
    await flush();
    expect(router.url.href).toBe(`${ROUTER_ORIGIN}/analysis/preview?y=2`);
    // The second commit changed the search, so the hook re-ran and the
    // authoritative refresh corrected the store to the committed URL.
    expect(seen[seen.length - 1]).toBe("");
    expect(inspectorViewForHash(seen[seen.length - 1])).toBe("arch");
    c.stop();
  });

  it("two consumers (sidebar + inspector) agree at every step", async () => {
    const router = new SimulatedNextRouter(`${ROUTER_ORIGIN}/analysis/preview?x=1`);
    const shellSeen: string[] = [];
    const dashSeen: string[] = [];
    const shell = mountConsumer(router, shellSeen);
    const dash = mountConsumer(router, dashSeen);
    expect(shellSeen).toEqual([""]);
    expect(dashSeen).toEqual([""]);
    // One browser document dispatches the click to every subscriber; Next
    // commits once for the single activation.
    shell.dispatchDocClick(anchor("/analysis/preview#findings"));
    dash.dispatchDocClick(anchor("/analysis/preview#findings"));
    router.clickLink("/analysis/preview#findings");
    await flush();
    const shellView = inspectorViewForHash(shellSeen[shellSeen.length - 1]);
    const dashView = inspectorViewForHash(dashSeen[dashSeen.length - 1]);
    expect(shellView).toBe("findings");
    expect(dashView).toBe("findings");
    expect(shellView).toBe(dashView);
    expect(shell.dispatchedWinEvents()).toEqual([]);
    expect(dash.dispatchedWinEvents()).toEqual([]);
    shell.stop();
    dash.stop();
  });
});

describe("SIMULATED-ROUTER: cancellation, modifiers, rapid navigation", () => {
  it("cancelled navigation leaves intent standing until the next committed signal", async () => {
    const router = new SimulatedNextRouter(`${ROUTER_ORIGIN}/analysis/preview`);
    const seen: string[] = [];
    const c = mountConsumer(router, seen);
    // Subscription processes the click, but Next.js never commits it.
    c.dispatchDocClick(anchor("/analysis/preview#findings"));
    await flush();
    expect(seen).toEqual(["", "#findings"]);
    expect(router.url.hash).toBe("");
    // Documented constraint: the assist stands until a committed signal
    // corrects it — here an explicit committed re-read (as the hook runs
    // on every search/path re-render).
    refreshInspectorHashFromUrl(() => router.url.hash || "");
    expect(getInspectorHashSnapshot()).toBe("");
    c.stop();
  });

  it("prevented clicks never produce intent", async () => {
    const router = new SimulatedNextRouter(`${ROUTER_ORIGIN}/analysis/preview`);
    const seen: string[] = [];
    const c = mountConsumer(router, seen);
    c.navigateClick("/analysis/preview#findings", { defaultPrevented: true });
    c.dispatchDocClick(anchor("/analysis/preview#findings"), { button: 1 });
    c.dispatchDocClick(anchor("/analysis/preview#findings"), { ctrlKey: true });
    await flush();
    expect(seen).toEqual([""]);
    expect(router.url.href).toBe(`${ROUTER_ORIGIN}/analysis/preview`);
    c.stop();
  });

  it("rapid overlapping navigations resolve to the final destination", async () => {
    const router = new SimulatedNextRouter(`${ROUTER_ORIGIN}/analysis/preview`);
    const seen: string[] = [];
    const c = mountConsumer(router, seen);
    // Hash-only: no search/path change, so no re-render fires — the ordered
    // intents alone must converge to the final destination.
    c.dispatchDocClick(anchor("/analysis/preview#findings"));
    c.dispatchDocClick(anchor("/analysis/preview"));
    router.clickLink("/analysis/preview#findings");
    router.clickLink("/analysis/preview");
    await flush();
    expect(router.url.href).toBe(`${ROUTER_ORIGIN}/analysis/preview`);
    expect(seen).toEqual(["", "#findings", ""]);
    expect(c.dispatchedWinEvents()).toEqual([]);
    c.stop();
  });

  it("back/forward traversal converges via popstate and committed re-read", async () => {
    const router = new SimulatedNextRouter(`${ROUTER_ORIGIN}/analysis/preview`);
    const seen: string[] = [];
    const c = mountConsumer(router, seen);
    // Same-search traversal: real browsers fire popstate; no re-render.
    router.traverseTo(`${ROUTER_ORIGIN}/analysis/preview#findings`);
    c.dispatchPopstate();
    expect(seen[seen.length - 1]).toBe("#findings");
    // Search-changing traversal: popstate plus the conditional re-render.
    router.traverseTo(`${ROUTER_ORIGIN}/analysis/preview?y=2`);
    c.dispatchPopstate();
    await flush();
    expect(router.url.href).toBe(`${ROUTER_ORIGIN}/analysis/preview?y=2`);
    expect(seen[seen.length - 1]).toBe("");
    c.stop();
  });

  it("cancelled Findings intent is repaired by selecting Architecture", async () => {
    // Exact Codex Finding A scenario, end to end:
    // URL=arch, stale store=findings after a cancelled navigation,
    // then the user selects the Architecture tab.
    const router = new SimulatedNextRouter(`${ROUTER_ORIGIN}/analysis/preview`);
    const seen: string[] = [];
    const c = mountConsumer(router, seen);
    c.dispatchDocClick(anchor("/analysis/preview#findings"));
    await flush();
    expect(getInspectorHashSnapshot()).toBe("#findings");
    expect(router.url.hash).toBe("");
    // Selecting Architecture must repair the store even though the URL
    // already represents it — with no history write and no events.
    const commits: string[] = [];
    const adapter: InspectorHashAdapter = {
      readHash: () => router.url.hash || "",
      readPath: () => router.url.pathname + router.url.search,
      commit: (url: string) => {
        commits.push(url);
      },
      notify: () => {
        refreshInspectorHashFromUrl(() => router.url.hash || "");
        seen.push(getInspectorHashSnapshot());
      },
    };
    // The UI observes the store (useSyncExternalStore): subscribe before
    // the repair and assert the repair delivery reaches the subscriber.
    const storeSeen: string[] = [];
    const stopStore = subscribeInspectorHashStore(() => storeSeen.push(getInspectorHashSnapshot()));
    expect(selectInspectorViewSync(adapter, "findings", "arch")).toBe("arch");
    stopStore();
    expect(commits).toEqual([]);
    expect(getInspectorHashSnapshot()).toBe("");
    expect(storeSeen).toEqual([""]);
    expect(c.dispatchedWinEvents()).toEqual([]);
    c.stop();
  });
});

describe("SIMULATED-ROUTER: keyboard-equivalent select notifies both consumers", () => {
  it("commit + synchronous committed re-read fans out with no events", () => {
    let fakeHash = "";
    const commits: string[] = [];
    const adapter: InspectorHashAdapter = {
      readHash: () => fakeHash,
      readPath: () => "/analysis/preview",
      commit: (url: string) => {
        commits.push(url);
        fakeHash = url.slice("/analysis/preview".length);
      },
      // Production notify() reads the just-committed URL into the store.
      notify: () => {
        refreshInspectorHashFromUrl(() => fakeHash);
      },
    };
    const s1: string[] = [];
    const s2: string[] = [];
    const stop1 = subscribeInspectorHashStore(() => s1.push(getInspectorHashSnapshot()));
    const stop2 = subscribeInspectorHashStore(() => s2.push(getInspectorHashSnapshot()));
    // ArrowRight on arch == keyboard selection of findings.
    expect(selectInspectorViewSync(adapter, "arch", "findings")).toBe("findings");
    expect(commits).toEqual(["/analysis/preview#findings"]);
    expect(s1).toEqual(["#findings"]);
    expect(s2).toEqual(["#findings"]);
    // Repeat select: idempotent, no extra history, no extra fan-out.
    expect(selectInspectorViewSync(adapter, "findings", "findings")).toBe("findings");
    expect(commits).toEqual(["/analysis/preview#findings"]);
    expect(s1).toEqual(["#findings"]);
    stop1();
    stop2();
  });
});

describe("SIMULATED-ROUTER: hydration-safe startup", () => {
  it("server snapshot is empty and mount derives findings from committed URL", () => {
    expect(getInspectorHashServerSnapshot()).toBe("");
    expect(getInspectorHashSnapshot()).toBe("");
    const router = new SimulatedNextRouter(`${ROUTER_ORIGIN}/analysis/preview#findings`);
    const seen: string[] = [];
    const c = mountConsumer(router, seen);
    expect(seen).toEqual(["#findings"]);
    expect(hashForInspectorView(inspectorViewForHash(seen[0]))).toBe("#findings");
    c.stop();
  });
});
