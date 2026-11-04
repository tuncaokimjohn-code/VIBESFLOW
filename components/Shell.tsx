"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import {
  applyInspectorHash,
  getInspectorHashServerSnapshot,
  getInspectorHashSnapshot,
  refreshInspectorHashFromUrl,
  subscribeInspectorHashStore,
  subscribeInspectorSync,
} from "@/lib/inspector-hash";
import {
  House, Network, TriangleAlert, Columns2, FileText, CircleHelp, Menu, X,
} from "lucide-react";
import { UNSCANNED } from "@/lib/preview-data";
import { PublicRepoIntake } from "@/components/PublicRepoIntake";
import { RepoIntake } from "@/components/RepoIntake";
import { LiveAstProvider } from "@/components/LiveAstContext";
import { PUBLIC_VIEWS, publicHref, publicViewForHash, commitPublicNavigation, publicNavigationKey } from "@/lib/public-navigation";

const NAV = [
  { href: "/", label: "Overview", icon: House },
  { href: "/analysis/preview", label: "Architecture", icon: Network },
  { href: "/analysis/preview#findings", label: "Findings", icon: TriangleAlert },
  { href: "/compare/preview", label: "Compare", icon: Columns2 },
  { href: "/evaluation/preview", label: "Evaluation", icon: FileText },
];

export function isActive(path: string, hash: string, href: string): boolean {
  if (href === "/") return path === "/";
  const [hPath, hHash] = href.split("#");
  if (hHash) return path === hPath || path.startsWith(hPath + "/") ? hash === `#${hHash}` : false;
  return (path === hPath || path.startsWith(hPath + "/")) && hash !== "#findings";
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const isOfflineDemo = path === "/demo/vibeshop";
  // Sidebar selection reads the same shared navigation-state store as the
  // Dashboard inspector, so both converge from identical signals and can
  // never diverge into stale React state. This component avoids search-param
  // hooks, keeping it static-prerender safe; commit-driven authoritative
  // refreshes are published from the analysis inspector (see
  // useInspectorHash) and every committed hashchange/popstate reaches the
  // store through the shared subscription below.
  const hash = useSyncExternalStore(
    subscribeInspectorHashStore,
    getInspectorHashSnapshot,
    getInspectorHashServerSnapshot
  );
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (menuOpen) document.querySelector<HTMLAnchorElement>("#mobile-nav a")?.focus();
  }, [menuOpen]);
  useEffect(() => {
    refreshInspectorHashFromUrl(() => window.location.hash || "");
    if (path === "/") {
      const sync = () => { applyInspectorHash(window.location.hash); setMenuOpen(false); };
      window.addEventListener("hashchange", sync);
      window.addEventListener("popstate", sync);
      return () => { window.removeEventListener("hashchange", sync); window.removeEventListener("popstate", sync); };
    }
    return subscribeInspectorSync(window, document, (h) => {
      applyInspectorHash(h);
    });
  }, [path]);
  const navList = (onNavigate?: () => void) => (
    <>
      {NAV.map((n, index) => {
        const view = PUBLIC_VIEWS[index];
        const demoAnchors = ["#demo-overview", "#demo-graph", "#demo-findings", "#demo-comparison"];
        const href = isOfflineDemo && index < demoAnchors.length ? demoAnchors[index] : path === "/" ? publicHref(view) : n.href;
        const active = isOfflineDemo ? href === (hash || "#demo-graph") : path === "/" ? publicViewForHash(hash) === view : isActive(path, hash, n.href);
        const NavLink = path === "/" || isOfflineDemo ? "a" : Link;
        return (
          <NavLink
            key={n.label}
            href={href}
            onClick={event => {
              if (path === "/" && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
                event.preventDefault(); commitPublicNavigation(view, window);
                document.getElementById("public-view-heading")?.focus();
              }
              if (isOfflineDemo && href === "#demo-comparison") {
                const target = document.getElementById("demo-comparison") as HTMLDetailsElement | null;
                if (target?.tagName === "DETAILS") target.open = true;
              }
              onNavigate?.();
            }}
            onKeyDown={event => {
              if (path !== "/") return;
              const next = publicNavigationKey(index, event.key);
              if (next !== null) { event.preventDefault(); const links = event.currentTarget.parentElement?.querySelectorAll<HTMLAnchorElement>("a[data-public-nav]"); links?.[next]?.focus(); }
            }}
            data-public-nav={path === "/" ? view : undefined}
            aria-current={active ? "page" : undefined}
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={active ? { background: "var(--vf-panel-active)", color: "var(--vf-text)" } : { color: "var(--vf-muted-text)" }}
          >
            <n.icon size={19} aria-hidden="true" style={active ? { color: "var(--vf-primary-cyan)" } : undefined} />
            {n.label}
          </NavLink>
        );
      })}
    </>
  );
  return (
    <LiveAstProvider>
    <div className="min-h-screen" style={{ background: "var(--vf-shell-bg)" }}>
      <header
        className="vf-header items-center gap-4 border-b px-4"
        style={{ background: "var(--vf-topbar)", borderColor: "var(--vf-border)" }}
      >
        <button
          className="vf-menu-button rounded-lg border px-2.5 py-2"
          style={{ borderColor: "var(--vf-border)", color: "var(--vf-text)" }}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
          onClick={() => setMenuOpen((v) => !v)}
          onKeyDown={event => { if (event.key === "Escape") setMenuOpen(false); }}
        >
          {menuOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
        </button>
        <div className="flex items-center gap-2">
          <img src="/vibeflow-approved-logo.jpg" width="44" height="44" alt="VibeFlow official VF logo" className="vf-logo shrink-0 rounded-lg" />
          <span className="vf-brand text-[17px] font-semibold tracking-tight">
            VibeFlow Inspector <span style={{ color: "var(--vf-primary-cyan)" }}>AI</span>
          </span>
        </div>
        {isOfflineDemo ? <div className="vf-intake-form vf-demo-intake-switch">
          <span>Offline fixture · no GitHub fetch</span>
          <Link href="/" prefetch={false}>Open public GitHub intake →</Link>
        </div> : path === "/" ? <PublicRepoIntake /> : <RepoIntake />}
        <span
          className="rounded-full border px-3 py-1 text-[12px]"
          style={{ borderColor: "var(--vf-primary-cyan)", color: "var(--vf-primary-cyan)" }}
        >
          Read-only
        </span>
        <div className="ml-auto flex items-center gap-3">
          <a href={path === "/" ? "/#public-evaluation" : "/evaluation/preview"} aria-label="Help" className="vf-help flex items-center gap-1.5 text-[13px]" style={{ color: "var(--vf-muted-text)" }}>
            <CircleHelp size={18} aria-hidden="true" /> <span className="vf-help-text" aria-hidden="true">Help</span>
          </a>
          <span
            className="flex h-8 w-8 items-center justify-center rounded-full text-[12px] font-semibold"
            style={{ background: "var(--vf-panel-active)" }}
            aria-label="Preview avatar"
          >
            JD
          </span>
        </div>
      </header>
      {menuOpen && (
        <nav
          id="mobile-nav"
          className="vf-mobile-nav flex flex-col gap-1 border-b p-3"
          style={{ borderColor: "var(--vf-border)" }}
          aria-label="Primary"
          onKeyDown={event => { if (event.key === "Escape") { setMenuOpen(false); document.querySelector<HTMLButtonElement>(".vf-menu-button")?.focus(); } }}
        >
          {navList(() => setMenuOpen(false))}
        </nav>
      )}
      <div className="flex">
        <nav
          className="vf-desktop-nav w-[228px] shrink-0 flex-col gap-1 border-r p-3"
          style={{ borderColor: "var(--vf-border)" }}
          aria-label="Primary"
        >
          {navList()}
          <div
            className="mt-6 rounded-[10px] border p-3 text-[12px]"
            style={{ borderColor: "var(--vf-border)", background: "var(--vf-panel-bg)" }}
          >
            {isOfflineDemo ? <>
              <p className="mb-2 font-medium">Offline demo scope</p>
              <p>Bundled TS/TSX fixture. Parsed only; never executed.</p>
              <p className="mt-2">Source paths and excerpts withheld.</p>
              <p className="mt-2">Muse: operator-authorized saved results only.</p>
              <Link href="/" prefetch={false} className="mt-3 inline-block underline">Public GitHub intake →</Link>
            </> : path === "/" ? <>
              <p className="mb-2 font-medium">Repository scope</p>
              <p>Read-only public GitHub TS/TSX.</p>
              <p className="mt-2">Review the source receipt for actual collected, skipped and unsupported coverage.</p>
              <p className="mt-2">Comparison and saved Muse results are restricted to the synthetic fixture demo.</p>
            </> : <>
            <p className="mb-2 flex items-center gap-1.5 font-medium" style={{ color: "var(--vf-text)" }}>
              Preview scope <span style={{ color: "var(--vf-muted-text)" }}>ⓘ</span>
            </p>
            <p className="mb-1 flex items-center gap-1.5"><span style={{ color: "var(--vf-success)" }}>●</span> Labeled preview</p>
            <ul className="mb-3 ml-4 space-y-0.5" style={{ color: "var(--vf-muted-text)" }}>
              <li>Illustrative navigation only</li><li>No scan coverage claimed</li><li>See page-specific provenance</li>
            </ul>
            <p className="mb-1 flex items-center gap-1.5"><span>●</span> Example exclusions</p>
            <ul className="ml-4 space-y-0.5" style={{ color: "var(--vf-muted-text)" }}>
              {UNSCANNED.slice(0, 4).map((u) => <li key={u}>{u}</li>)}
              <li><Link href="/analysis/preview" className="underline" style={{ color: "var(--vf-primary-cyan)" }}>and {UNSCANNED.length - 4} more…</Link></li>
            </ul>
            </>}

          </div>
        </nav>
        <main className="vf-main min-w-0 flex-1 p-4">{children}</main>
      </div>
    </div>
    </LiveAstProvider>
  );
}
