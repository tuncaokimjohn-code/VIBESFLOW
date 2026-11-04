"use client";
import { useCallback } from "react";
import { Network, List, Share2 } from "lucide-react";
import { ArchGraph, findingForNode, useDashboardState } from "@/components/Graph";
import { AstGraph } from "@/components/AstGraph";
import { FindingsPanel, EvidenceDrawer, MuseFooter } from "@/components/Panels";
import { FINDINGS, GRAPH_NODES } from "@/lib/preview-data";
import {
  hashForInspectorView,
  inspectorKeyAction,
  inspectorViewForHash,
  refreshInspectorHashFromUrl,
  selectInspectorViewSync,
  type InspectorHashAdapter,
  type InspectorView,
} from "@/lib/inspector-hash";
import { useInspectorHash } from "@/lib/use-inspector-nav";

export type { InspectorView };
export { hashForInspectorView, inspectorViewForHash };

function readHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash || "";
}

/** Window-backed adapter for the shared inspector hash mechanism (lazy: SSR-safe). */
const windowInspectorAdapter: InspectorHashAdapter = {
  readHash,
  readPath: () =>
    typeof window === "undefined" ? "" : `${window.location.pathname}${window.location.search}`,
  commit: (url: string) => window.history.pushState(null, "", url),
  // Re-read the just-committed URL into the shared store synchronously.
  // pushState fires no DOM event and Next.js emits none for its own
  // commits, so observation is always an explicit committed read — never a
  // manually dispatched hashchange and never a timing guess.
  notify: () => {
    refreshInspectorHashFromUrl(readHash);
  },
};

export function Dashboard() {
  const s = useDashboardState();
  // Below xl (incl. 1024px) the inspector is a tabbed single column; at
  // xl (1280px+) both panels sit side by side in 2 columns.
  //
  // The inspector view is derived from the shared navigation-state store,
  // so URL, inspector, and sidebar can never diverge into stale React
  // state. Convergence signals: click intent from the anchor destination,
  // committed hashchange/popstate reads, and a commit-driven re-read on
  // query changes — no timing guesses, no synthesized DOM events.
  //
  // The store starts at "" (matching the SSR HTML), so direct #findings
  // loads stay hydration-safe and converge on mount.
  const hash = useInspectorHash();
  const inspectorView = inspectorViewForHash(hash);

  const selectInspectorView = useCallback((next: InspectorView) => {
    // Shared mechanism: synchronous commit, then a synchronous re-read of
    // the committed URL into the store, so the Shell sidebar observes
    // keyboard- and click-driven switches alike.
    selectInspectorViewSync(windowInspectorAdapter, inspectorView, next);
  }, [inspectorView]);
  const activeFindingId = findingForNode(s.findingId, s.selectedNode);
  const selectedFinding = FINDINGS.find((f) => f.id === activeFindingId) ?? null;

  let center: React.ReactNode;
  if (s.status === "loading") {
    center = <div className="grid h-[548px] place-items-center rounded-[10px] bg-[#F7FAFC] text-[#1C3043]" role="status">Loading preview graph…</div>;
  } else if (s.status === "error") {
    center = (
      <div className="grid h-[548px] place-items-center rounded-[10px] bg-[#F7FAFC] text-[#1C3043]" role="alert">
        <p>Preview failed to load. <button className="underline" onClick={() => s.setStatus("ready")}>Retry</button></p>
      </div>
    );
  } else if (s.status === "empty") {
    center = <div className="grid h-[548px] place-items-center rounded-[10px] bg-[#F7FAFC] text-[#1C3043]" role="status">No modules in this preview snapshot.</div>;
  } else if (s.tab === "graph") {
    center = <ArchGraph selectedNode={s.selectedNode} onSelect={s.setSelectedNode} />;
  } else if (s.tab === "modules") {
    center = (
      <ul className="rounded-[10px] bg-[#F7FAFC] p-4 text-[#1C3043]" aria-label="Module list fallback">
        {GRAPH_NODES.map((n) => (
          <li key={n.id} className="border-b py-2 last:border-0">
            <button className="underline" onClick={() => s.setSelectedNode(n.id)}>
              <span className="font-mono text-[13px] font-semibold">{n.path}</span>
            </button>
            <span className="ml-2 text-[12px] opacity-70">{n.role} · {n.countLabel}</span>
          </li>
        ))}
      </ul>
    );
  } else {
    center = (
      <ul className="rounded-[10px] bg-[#F7FAFC] p-4 text-[#1C3043]" aria-label="Dependencies fallback">
        <li className="py-1 font-mono text-[13px]">src/index.ts → src/api, src/services</li>
        <li className="py-1 font-mono text-[13px]">src/api → src/api/orders.ts, src/api/users.ts</li>
        <li className="py-1 font-mono text-[13px]">src/services → src/db.ts, src/utils</li>
      </ul>
    );
  }

  const inspectorTabs = (
    [
      { k: "arch", label: "Architecture" },
      { k: "findings", label: `Findings (${FINDINGS.length})` },
    ] as const
  );

  return (
    <>
      {/* Single-column tabbed inspector below xl (covers 1024px tablets and
          390px phones); hidden here with display:none so inactive panels keep
          no focusable controls. xl:block restores the 2-column layout. */}
      <div
        className="mb-3 flex gap-2 xl:hidden"
        role="tablist"
        aria-label="Preview panels"
        onKeyDown={(ev) => {
          const next = inspectorKeyAction(inspectorView, ev.key);
          if (next !== null) {
            ev.preventDefault();
            selectInspectorView(next);
            document.getElementById(`inspector-tab-${next}`)?.focus();
          }
        }}
      >
        {inspectorTabs.map((t) => (
          <button
            key={t.k}
            id={`inspector-tab-${t.k}`}
            role="tab"
            aria-selected={inspectorView === t.k}
            aria-controls={`inspector-panel-${t.k}`}
            tabIndex={inspectorView === t.k ? 0 : -1}
            onClick={() => selectInspectorView(t.k)}
            className="rounded-lg border px-3 py-1.5 text-[13px]"
            style={
              inspectorView === t.k
                ? { borderColor: "var(--vf-primary-cyan)", color: "var(--vf-text)" }
                : { borderColor: "var(--vf-border)", color: "var(--vf-muted-text)" }
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div
          role="tabpanel"
          id="inspector-panel-arch"
          aria-labelledby="inspector-tab-arch"
          tabIndex={0}
          className={inspectorView === "arch" ? "" : "hidden xl:block"}
        >
        <section
          className="rounded-[10px] border p-4"
          style={{ background: "var(--vf-panel-bg)", borderColor: "var(--vf-border)" }}
          aria-label="Architecture overview"
        >
          <div className="mb-1 flex items-start justify-between gap-3">
            <h1 className="text-[32px] font-semibold leading-tight">Architecture overview</h1>
            <span className="mt-2 shrink-0 rounded-full border px-2.5 py-1 text-[11px]" style={{ borderColor: "var(--vf-border)", color: "var(--vf-muted-text)" }}>
              Preview data
            </span>
          </div>
          <p className="mb-3 text-[14px]" style={{ color: "var(--vf-muted-text)" }}>
            Source graph from your TypeScript repository. Explore how key modules relate to each other.
          </p>
          <div
            className="mb-3 flex gap-2"
            role="tablist"
            aria-label="Architecture views (fictional preview)"
            onKeyDown={(ev) => {
              const order = ["graph", "modules", "deps"] as const;
              const i = order.indexOf(s.tab);
              let next: number | null = null;
              if (ev.key === "ArrowRight") next = (i + 1) % order.length;
              else if (ev.key === "ArrowLeft") next = (i - 1 + order.length) % order.length;
              else if (ev.key === "Home") next = 0;
              else if (ev.key === "End") next = order.length - 1;
              if (next !== null) {
                ev.preventDefault();
                s.setTab(order[next]);
                document.getElementById(`arch-tab-${order[next]}`)?.focus();
              }
            }}
          >
            {(
              [
                { k: "graph", label: "Source graph", Icon: Network },
                { k: "modules", label: "Module list", Icon: List },
                { k: "deps", label: "Dependencies", Icon: Share2 },
              ] as const
            ).map((t) => (
              <button
                key={t.k}
                id={`arch-tab-${t.k}`}
                role="tab"
                aria-selected={s.tab === t.k}
                aria-controls={`arch-panel-${t.k}`}
                tabIndex={s.tab === t.k ? 0 : -1}
                onClick={() => s.setTab(t.k)}
                className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px]"
                style={s.tab === t.k ? { borderColor: "var(--vf-primary-cyan)", color: "var(--vf-text)" } : { borderColor: "var(--vf-border)", color: "var(--vf-muted-text)" }}
              >
                <t.Icon size={16} aria-hidden="true" /> {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`arch-panel-${s.tab}`} aria-labelledby={`arch-tab-${s.tab}`}>
            {center}
          </div>
          {s.selectedNode && (
            <p className="mt-2 text-[13px]" style={{ color: "var(--vf-muted-text)" }} role="status">
              Selected: <span className="font-mono underline">{GRAPH_NODES.find((n) => n.id === s.selectedNode)?.path}</span>
              {selectedFinding ? ` · linked finding: ${selectedFinding.title}` : ""}
              <button className="ml-2 underline" onClick={() => s.setSelectedNode(null)}>Clear</button>
            </p>
          )}
          <div className="mt-2 flex gap-2 text-[12px]" style={{ color: "var(--vf-muted-text)" }} aria-label="Preview state demos">
            <span>State:</span>
            {(["ready", "loading", "error", "empty"] as const).map((st) => (
              <button key={st} onClick={() => s.setStatus(st)} aria-pressed={s.status === st} className="underline">{st}</button>
            ))}
          </div>
        </section>
        <AstGraph />
        </div>
        <div
          role="tabpanel"
          id="inspector-panel-findings"
          aria-labelledby="inspector-tab-findings"
          tabIndex={0}
          className={inspectorView === "findings" ? "" : "hidden xl:block"}
        >
        <FindingsPanel
          filter={s.filter}
          setFilter={s.setFilter}
          onOpen={(id) => {
            const f = FINDINGS.find((x) => x.id === id);
            if (!f) return;
            s.setSelectedNode(f.nodeId);
            s.setFindingId(f.id);
            selectInspectorView("findings");
            s.setDrawerOpen(true);
          }}
        />
        </div>
      </div>
      <MuseFooter />
      {s.drawerOpen && (
        <EvidenceDrawer findingId={activeFindingId} onClose={() => s.setDrawerOpen(false)} />
      )}
      <p className="mt-2 text-right text-[11px]" style={{ color: "var(--vf-muted-text)" }}>Preview design</p>
    </>
  );
}
