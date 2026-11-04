/**
 * Shared inspector-tab <-> URL-hash synchronization (Candidate 012).
 *
 * Single shared navigation-state store with three signal halves:
 * 1. Committed state (authoritative): `hashchange`/`popstate` listeners and
 *    a commit-driven re-read (see `useInspectorHash`) read the actual
 *    `window.location.hash`. Next.js App Router commits same-route
 *    navigations via raw `history.pushState` in a post-click React effect
 *    (no `hashchange` is dispatched), so observation never assumes an
 *    event Next.js does not emit.
 * 2. Click intent (non-authoritative assist): a capture-phase click
 *    listener derives the navigation *destination* from the clicked
 *    anchor's declared `href`. The destination is known synchronously at
 *    click time, so the interface responds without depending on when
 *    Next.js commits — no requestAnimationFrame/setTimeout guessing, no
 *    polling, no patching `history`. Cancelled navigations are an explicit
 *    constraint (see below), always superseded by the next committed read.
 * 3. Programmatic tab switches: our own commits re-read the committed URL
 *    synchronously into the store — no manually dispatched DOM event.
 *
 * Pure helpers stay SSR-safe (no `window` access at module level); the
 * store mirror starts at the SSR value ("") and converges on mount.
 */
export type InspectorView = "arch" | "findings";

/** Hash `#findings` selects the findings tab; anything else selects architecture. */
export function inspectorViewForHash(hash: string): InspectorView {
  return hash === "#findings" ? "findings" : "arch";
}

/** Canonical hash for an inspector tab: findings keeps `#findings`, arch clears it. */
export function hashForInspectorView(view: InspectorView): string {
  return view === "findings" ? "#findings" : "";
}

/** Full URL (path + search + canonical hash) for an inspector tab. */
export function inspectorUrl(pathname: string, search: string, view: InspectorView): string {
  return `${pathname}${search}${hashForInspectorView(view)}`;
}

const ORDER: readonly InspectorView[] = ["arch", "findings"];

/**
 * Pure keyboard transition for the inspector tablist (roving tabindex).
 * Returns the next view, or null for keys this tablist does not handle.
 */
export function inspectorKeyAction(view: InspectorView, key: string): InspectorView | null {
  const i = ORDER.indexOf(view);
  if (key === "ArrowRight") return ORDER[(i + 1) % ORDER.length];
  if (key === "ArrowLeft") return ORDER[(i - 1 + ORDER.length) % ORDER.length];
  if (key === "Home") return ORDER[0];
  if (key === "End") return ORDER[ORDER.length - 1];
  return null;
}

export interface InspectorHashAdapter {
  readHash(): string;
  readPath(): string;
  /** pushState-equivalent: must update the URL synchronously. */
  commit(url: string): void;
  /**
   * Re-read the committed URL into the shared store. Must run
   * synchronously after `commit`; never synthesizes a DOM event.
   */
  notify(): void;
}

/**
 * Apply a tab change through the shared mechanism and return the view to render.
 * Reconciliation covers all three states — requested view, committed URL, and
 * shared store:
 * - URL disagreement with the request commits exactly one history entry,
 *   then re-reads the committed URL into the store (`notify`).
 * - URL agreement still reconciles the store to the requested view. This
 *   repairs stale optimistic intent (e.g. a cancelled Findings navigation
 *   left the store on "findings" while the URL stayed Architecture): the
 *   store write is idempotent, so full agreement remains a true no-op and
 *   no duplicate history entries are ever created.
 *
 * `commit` (pushState) fires no DOM event on its own, so the synchronous
 * committed re-read (`notify`) is required — without it, keyboard-driven
 * changes update the inspector while the sidebar keeps the stale selection.
 */
export function selectInspectorViewSync(
  adapter: InspectorHashAdapter,
  current: InspectorView,
  next: InspectorView
): InspectorView {
  const urlView = inspectorViewForHash(adapter.readHash());
  if (urlView !== next) {
    adapter.commit(`${adapter.readPath()}${hashForInspectorView(next)}`);
    adapter.notify();
  } else {
    applyInspectorHash(hashForInspectorView(next));
  }
  return next;
}

/**
 * Map a link destination to an inspector view, or null when the link
 * navigates away (different path/origin) or is unparseable.
 *
 * Query strings are intentionally ignored: a same-path navigation keeps the
 * mounted Dashboard/Shell while only the query and/or hash change, so the
 * inspector must resolve from the destination hash. (Candidate 011 required
 * equal search strings and therefore dropped intent for e.g.
 * `/analysis/preview?x=1` -> `/analysis/preview#findings`.) Inspector-only
 * tab switches preserve the query separately via `inspectorUrl`.
 */
export function inspectorViewForHref(href: string, baseHref: string): InspectorView | null {
  let u: URL;
  let b: URL;
  try {
    u = new URL(href, baseHref);
    b = new URL(baseHref);
  } catch {
    return null;
  }
  if (u.origin !== b.origin || u.pathname !== b.pathname) return null;
  return inspectorViewForHash(u.hash);
}

/** Minimal structural shape of a click event the intent parser needs. */
export interface InspectorClickEvent {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: unknown;
}

interface AnchorLike {
  getAttribute(name: string): string | null;
  hasAttribute?(name: string): boolean;
  tagName?: string;
  parentElement?: unknown;
  parentNode?: unknown;
}

export interface AnchorNavigation {
  href: string;
  /** Non-null target (e.g. "_blank") means the current document is unchanged. */
  target: string | null;
  /** Download links never perform a same-document navigation. */
  download: boolean;
}

/** Walk up from the click target to the enclosing anchor, if any. */
function anchorFromTarget(target: unknown): AnchorNavigation | null {
  let node: unknown = target;
  const seen = new Set<unknown>();
  while (node !== null && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const el = node as Partial<AnchorLike>;
    if (typeof el.getAttribute === "function") {
      const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
      if (tag === "A") {
        let href: string | null = null;
        let targetAttr: string | null = null;
        let download = false;
        try {
          href = el.getAttribute("href");
          targetAttr = el.getAttribute("target");
          download =
            typeof el.hasAttribute === "function"
              ? el.hasAttribute("download")
              : el.getAttribute("download") !== null;
        } catch {
          href = null;
        }
        if (typeof href !== "string") return null;
        return { href, target: targetAttr, download };
      }
    }
    node = el.parentElement ?? el.parentNode ?? null;
  }
  return null;
}

/**
 * Derive the navigation destination view from a click, or null when the click
 * is not a plain same-document link activation: modifier keys, non-left
 * button, already-prevented, non-link target, away-navigation, a download,
 * or a target that keeps the current document unchanged.
 *
 * Pure and unit-testable; the destination comes from the anchor's declared
 * `href`, never from timing assumptions about when Next.js commits.
 * Optimistic intent is an assist only: a cancelled navigation leaves the
 * intent standing until the next committed read or selection corrects it.
 */
export function inspectorViewForClickEvent(
  e: InspectorClickEvent,
  baseHref: string
): InspectorView | null {
  if (e.defaultPrevented || e.button !== 0) return null;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const anchor = anchorFromTarget(e.target);
  if (anchor === null) return null;
  if (anchor.download) return null;
  if (anchor.target !== null && anchor.target !== "_self") return null;
  return inspectorViewForHref(anchor.href, baseHref);
}

/** Minimal structural shapes for the shared subscription (real window/document satisfy these). */
export interface InspectorSyncWindow {
  readonly location: { readonly href: string; readonly hash: string };
  addEventListener(type: "hashchange" | "popstate", listener: () => void): void;
  removeEventListener(type: "hashchange" | "popstate", listener: () => void): void;
}

export interface InspectorSyncDocument {
  addEventListener(type: "click", listener: (e: InspectorClickEvent) => void, capture: boolean): void;
  removeEventListener(
    type: "click",
    listener: (e: InspectorClickEvent) => void,
    capture: boolean
  ): void;
}

/**
 * Shared subscription used by both Dashboard and Shell. Delivers the
 * canonical committed-or-intended hash to `onHash`:
 * - `hashchange`/`popstate`: authoritative committed `location.hash`.
 * - capture-phase `click`: timing-free intent from the anchor destination.
 * Returns an unsubscribe function that removes all three listeners.
 */
export function subscribeInspectorSync(
  win: InspectorSyncWindow,
  doc: InspectorSyncDocument,
  onHash: (hash: string) => void
): () => void {
  const applyCommitted = () => onHash(win.location.hash || "");
  const onClick = (e: InspectorClickEvent) => {
    const view = inspectorViewForClickEvent(e, win.location.href);
    if (view !== null) onHash(hashForInspectorView(view));
  };
  win.addEventListener("hashchange", applyCommitted);
  win.addEventListener("popstate", applyCommitted);
  doc.addEventListener("click", onClick, true);
  return () => {
    win.removeEventListener("hashchange", applyCommitted);
    win.removeEventListener("popstate", applyCommitted);
    doc.removeEventListener("click", onClick, true);
  };
}

/* ------------------------------------------------------------------ */
/* Shared navigation-state store (single source of truth for consumers) */
/* ------------------------------------------------------------------ */

type HashListener = () => void;

const storeListeners = new Set<HashListener>();
let storeHash = "";

/** Client snapshot for `useSyncExternalStore` (SSR mirror starts at ""). */
export function getInspectorHashSnapshot(): string {
  return storeHash;
}

/** Server snapshot: always "" so SSR HTML never depends on the URL hash. */
export function getInspectorHashServerSnapshot(): string {
  return "";
}

export function subscribeInspectorHashStore(listener: HashListener): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

/**
 * Write a hash observed from any sync signal into the store. Notifies
 * subscribers only when the value actually changes (idempotent).
 */
export function applyInspectorHash(next: string): string {
  if (next === storeHash) return storeHash;
  storeHash = next;
  for (const l of Array.from(storeListeners)) l();
  return storeHash;
}

/**
 * Authoritative: re-read the committed URL into the store. Used after our
 * own commits (synchronous, deterministic) and whenever Next.js commits a
 * navigation that re-renders a searchParams/pathname consumer.
 */
export function refreshInspectorHashFromUrl(readHash: () => string): string {
  return applyInspectorHash(readHash());
}

/** Test-only reset of module state (components never call this). */
export function __resetInspectorHashStoreForTests(): void {
  storeHash = "";
  storeListeners.clear();
}
