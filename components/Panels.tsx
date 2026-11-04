"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TriangleAlert, CircleAlert, ChevronRight, Info } from "lucide-react";
import { FINDINGS, UNSCANNED } from "@/lib/preview-data";

export function FindingsPanel({
  filter, setFilter, onOpen,
}: {
  filter: "all" | "security" | "quality";
  setFilter: (f: "all" | "security" | "quality") => void;
  onOpen: (id: string) => void;
}) {
  const list = FINDINGS.filter((f) => filter === "all" || f.severity === filter);
  return (
    <section
      id="findings"
      className="scroll-mt-20 rounded-[10px] border p-4"
      style={{ background: "var(--vf-panel-bg)", borderColor: "var(--vf-border)" }}
      aria-label="Evidence and findings"
      tabIndex={-1}
    >
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[24px] font-semibold">Evidence &amp; findings</h2>
        <span className="rounded-full border px-2.5 py-1 text-[11px]" style={{ borderColor: "var(--vf-border)", color: "var(--vf-muted-text)" }}>
          Preview data
        </span>
      </div>
      <p className="mb-3 text-[13px]" style={{ color: "var(--vf-muted-text)" }}>
        Potential issues found in your source. Review the evidence and validate against the code.
      </p>
      <div className="mb-3 flex gap-2" role="group" aria-label="Filter findings">
        {(["all", "security", "quality"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className="rounded-lg border px-3 py-1.5 text-[13px]"
            style={
              filter === f
                ? { borderColor: "var(--vf-primary-cyan)", color: "var(--vf-text)" }
                : { borderColor: "var(--vf-border)", color: "var(--vf-muted-text)" }
            }
          >
            {f === "all" ? "All 2" : f === "security" ? "Security 1" : "Code quality 1"}
          </button>
        ))}
      </div>
      <ul className="divide-y" style={{ borderColor: "var(--vf-border)" }}>
        {list.map((f) => (
          <li key={f.id}>
            <button onClick={() => onOpen(f.id)} className="flex w-full items-start gap-3 py-4 text-left">
              {f.severity === "security" ? (
                <CircleAlert size={26} aria-hidden="true" style={{ color: "var(--vf-danger)" }} />
              ) : (
                <TriangleAlert size={26} aria-hidden="true" style={{ color: "var(--vf-warning)" }} />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold">{f.title}</span>
                  <span
                    className="rounded-full border px-2 py-0.5 text-[11px]"
                    style={{
                      borderColor: f.severity === "security" ? "var(--vf-danger)" : "var(--vf-warning)",
                      color: f.severity === "security" ? "var(--vf-danger)" : "var(--vf-warning)",
                    }}
                  >
                    {f.severity === "security" ? "Security" : "Code quality"}
                  </span>
                </span>
                <span className="mt-0.5 block font-mono text-[12px] underline" style={{ color: "var(--vf-muted-text)" }}>
                  {f.fileLine}
                </span>
                <span className="mt-1 block text-[13px]" style={{ color: "var(--vf-muted-text)" }}>{f.summary}</span>
              </span>
              <ChevronRight size={20} aria-hidden="true" style={{ color: "var(--vf-muted-text)" }} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 rounded-[10px] border p-3" style={{ borderColor: "var(--vf-border)" }}>
        <p className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
          <Info size={16} aria-hidden="true" /> Unscanned areas <Info size={14} aria-hidden="true" style={{ color: "var(--vf-muted-text)" }} />
        </p>
        <p className="mb-2 text-[13px]" style={{ color: "var(--vf-muted-text)" }}>
          The following paths were not analyzed. They may contain additional code that could affect these results.
        </p>
        <div className="flex flex-wrap gap-2">
          {UNSCANNED.map((u) => (
            <span key={u} className="rounded-lg border px-2.5 py-1 font-mono text-[12px]" style={{ borderColor: "var(--vf-border)", color: "var(--vf-muted-text)" }}>
              {u}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

export function EvidenceDrawer({
  findingId, onClose,
}: {
  findingId: string | null; onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const openerRef = useRef<Element | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    if (!findingId || !mounted) return;
    openerRef.current = document.activeElement;
    // Initial focus moves into the dialog (portaled outside inert ancestors).
    closeRef.current?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        onClose();
        return;
      }
      if (ev.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], pre[tabindex], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute("disabled"));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const regions = Array.from(document.querySelectorAll("header, nav, main"));
    regions.forEach((el) => el.setAttribute("inert", ""));
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      regions.forEach((el) => el.removeAttribute("inert"));
      document.body.style.overflow = "";
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [findingId, mounted, onClose]);
  if (!findingId || !mounted) return null;
  const f = FINDINGS.find((x) => x.id === findingId);
  if (!f) return null;
  // Portaled to document.body so the dialog lives outside every inert
  // background ancestor (header/nav/main) and stays fully interactive.
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`Fictional preview evidence for ${f.title}`} className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        className="absolute right-0 top-0 h-full w-full max-w-[440px] overflow-y-auto border-l p-5"
        style={{ background: "var(--vf-panel-bg)", borderColor: "var(--vf-border)" }}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="rounded-full border px-2.5 py-1 text-[11px]" style={{ borderColor: "var(--vf-border)", color: "var(--vf-muted-text)" }}>
            Read-only · Preview data
          </span>
          <button ref={closeRef} onClick={onClose} className="rounded-lg border px-3 py-1.5 text-[13px]" style={{ borderColor: "var(--vf-border)" }} aria-label="Close evidence drawer">
            Close ✕
          </button>
        </div>
        <h3 className="text-[18px] font-semibold">{f.title}</h3>
        <p className="mt-1 font-mono text-[12px] underline" style={{ color: "var(--vf-primary-cyan)" }}>{f.fileLine}</p>
        <p className="mt-2 text-[13px]" style={{ color: "var(--vf-muted-text)" }}>{f.summary}</p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-[12px] leading-relaxed" tabIndex={0}>
          {f.code.join("\n")}
        </pre>
        <p className="mt-3 text-[12px]" style={{ color: "var(--vf-muted-text)" }}>
          Synthetic fictional illustration only. No real repository was scanned and no Muse model call was made.
        </p>
      </aside>
    </div>,
    document.body
  );
}

export function MuseFooter() {
  return (
    <section
      className="mt-4 rounded-[10px] border p-5"
      style={{ background: "var(--vf-panel-bg)", borderColor: "var(--vf-border)" }}
      aria-label="Muse explanation"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[20px] font-semibold">
          <span style={{ color: "var(--vf-primary-cyan)" }} aria-hidden="true">✦</span> Muse explanation
        </h2>
        <div className="text-right">
          <button
            type="button"
            disabled
            aria-disabled="true"
            aria-describedby="verify-note"
            title="Verification is disabled in this synthetic preview — no real repository or evidence to verify."
            className="cursor-not-allowed text-[13px] opacity-60 underline decoration-dotted"
            style={{ color: "var(--vf-primary-cyan)" }}
          >
            Verify source evidence →
          </button>
          <p id="verify-note" className="mt-1 text-[11px]" style={{ color: "var(--vf-muted-text)" }}>
            Disabled: fictional preview only, nothing to verify.
          </p>
        </div>
      </div>
      <p className="mt-2 max-w-[90ch] text-[13.5px] leading-relaxed" style={{ color: "var(--vf-muted-text)" }}>
        Muse unavailable — no model call was made in this preview. The summary below is deterministic text
        describing the fictional sample only, not a model verdict.
      </p>
      <p className="mt-2 max-w-[90ch] text-[13.5px] leading-relaxed" style={{ color: "var(--vf-muted-text)" }}>
        This fictional repository is a TypeScript Express API. The entry point (src/index.ts) registers route
        handlers from src/api. Data access is centralized in src/db.ts. One area to review is
        src/api/orders.ts:42, where input handling should use parameterized queries. Verify that sensitive
        routes in src/api/users.ts:18 include authorization checks.
      </p>
    </section>
  );
}
