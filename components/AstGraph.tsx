"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow, Background, MiniMap, Controls, Handle, Position, MarkerType,
  type Node, type Edge, type NodeChange,
} from "@xyflow/react";
import { applyNodeSelectChanges } from "@/components/Graph";
import "@xyflow/react/dist/style.css";
import { FileText, FunctionSquare } from "lucide-react";
import { buildAstGraph, moduleNodeId, type AstGraphNode } from "@/lib/ast-graph";
import { WITHHELD_NOTICE } from "@/lib/safer-comparison";
import { validateGraphShape, type EvidenceSnapshot } from "@/lib/evidence";
import {
  AST_FIXTURE_LABEL, AST_FIXTURE_PROVENANCE, FIXTURE_SOURCES,
  fixtureContents, fixtureFileEntries,
} from "@/lib/ast-fixtures";
import { useLiveAst } from "@/components/LiveAstContext";
import { detectSecurityFindings } from "@/lib/security-findings";
import { SecurityFindings, SecurityFindingInspector, type SecurityState } from "@/components/SecurityFindings";
import { ExplanationPanel } from "@/components/ExplanationPanel";
import { sha256Text } from "@/lib/intake-client";

import { focusedGraph, graphAliases } from "@/lib/graph-view";
import { presentGraph, graphKind, graphLine } from "@/lib/graph-presentation";

const MODULE_TONE = "#EDF2F7";
const MEMBER_TONE = "#DBF5EE";

function AstModuleNode({
  data,
}: {
  data: { datum: AstGraphNode; selected: boolean; unsupported: number; label: string };
}) {
  const d = data.datum;
  const isMember = d.kind === "member";
  const Icon = isMember ? FunctionSquare : FileText;
  return (
    <div
      className="rounded-[9px] border px-3 py-2 text-left"
      style={{
        background: isMember ? MEMBER_TONE : MODULE_TONE,
        borderColor: data.selected ? "#24BCD7" : "#9FB4C7",
        borderWidth: data.selected ? 2 : 1,
        width: 180, minHeight: 78,
        color: "#1C3043",
      }}
    >
      <div className="flex items-center gap-2">
        <Icon size={20} aria-hidden="true" />
        <span className="max-w-[220px] break-all text-[13px] font-semibold">{data.label}</span>
      </div>
      <p className="mt-0.5 max-w-[220px] break-all text-[12px] opacity-80">
        {isMember ? `line ${d.line ?? "?"}` : "TypeScript module"}
      </p>
      {!isMember && data.unsupported > 0 && (
        <span className="mt-1 inline-block rounded-full bg-black/10 px-2 py-0.5 text-[11px]">
          {data.unsupported} unsupported import{data.unsupported === 1 ? "" : "s"}
        </span>
      )}
      <Handle
        type="target"
        position={Position.Left}
        aria-label={`${data.label} incoming connection`}
        style={{ width: 10, height: 10, background: "#24BCD7", border: "2px solid #fff" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        aria-label={`${data.label} outgoing connection`}
        style={{ width: 10, height: 10, background: "#24BCD7", border: "2px solid #fff" }}
      />
    </div>
  );
}

const nodeTypes = { module: AstModuleNode, member: AstModuleNode };

/**
 * C005 (Codex C004 QA HIGH): untrusted import specifiers are arbitrary
 * source-derived strings — they can be credential-bearing URLs
 * (`https://user:password@host/...`) or carry other sensitive literals.
 * They are NEVER rendered here: edge labels carry no source text and the
 * unsupported-imports list shows only the trusted-safe shape (edge kind +
 * 1-based line + opaque index) plus this fixed notice.
 */
export const SPECIFIER_WITHHELD_NOTICE = "specifier withheld — untrusted source text is never displayed";

/** Unsupported/external import list with NO source-derived strings (C005 HIGH). */
export function UnsupportedImports({ edges, mod }: {
  // `specifier` is accepted (callers pass full graph edges) and
  // deliberately IGNORED: arbitrary source text must never reach markup.
  edges: Array<{ kind: string; line: number; specifier?: string }>; mod: string
}) {
  const unsupported = edges.filter((e) => e.kind !== "imports" && e.kind !== "references");
  if (unsupported.length === 0) return null;
  return (
    <>
      <details className="vf-import-details mt-3 text-[12px]">
      <summary className="font-semibold">Unsupported / external imports ({unsupported.length})</summary>
      <ul className="mt-1 font-mono text-[12px]" aria-label="Unsupported imports">
        {unsupported.map((e, i) => (
          <li key={i}>
            {graphKind(e.kind)} import #{i + 1} (line {graphLine(e.line)}; {SPECIFIER_WITHHELD_NOTICE})
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[12px] opacity-80" aria-label="Unsupported import provenance">
        Provenance: source module withheld; line geometry only; specifier bytes are never shown.
      </p>
      </details>
    </>
  );
}

export function AstGraph() {
  const [selected, setSelected] = useState<string | null>(null);
  const { live, realStatus } = useLiveAst();
  const [findingId, setFindingId] = useState<string | null>(null);
  const [security, setSecurity] = useState<SecurityState>({ snapshotId: null, status: "idle" });
  useEffect(() => {
    if (!live) { setSecurity({ snapshotId: null, status: "idle" }); return; }
    const controller = new AbortController();
    const snapshotId = live.snapshot.snapshotId;
    setSecurity({ snapshotId, status: "running" });
    detectSecurityFindings(live.snapshot, new Map(Object.entries(live.contents)), sha256Text, { signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) setSecurity(r.ok ? { snapshotId, status: "done", result: r } : { snapshotId, status: "invalid", message: r.message }); })
      .catch(() => { if (!controller.signal.aborted) setSecurity({ snapshotId, status: "invalid", message: "Detection failed." }); });
    return () => { controller.abort(); };
  }, [live]);
  useEffect(() => { setSelected(null); setFindingId(null); }, [live?.snapshot.snapshotId, realStatus]);
  useEffect(() => {
    if (selected && !findingId) document.getElementById("ast-selected-heading")?.focus();
  }, [selected, findingId]);
  // Never expose a previous snapshot during the render before effect cleanup.
  const visibleSecurity: SecurityState = live && security.snapshotId === live.snapshot.snapshotId
    ? security : { snapshotId: live?.snapshot.snapshotId ?? null, status: live ? "running" : "idle" };
  const selectedFinding = visibleSecurity.result?.findings.find(f => f.id === findingId) ?? null;

  const built = useMemo(() => {
    try {
      if (live) {
        // The client contract verifies this exact server graph against source
        // hashes, geometry and AST evidence before it enters shared state.
        const contents = new Map(Object.entries(live.contents));
        return { graph: live.graph, contents, snapshot: live.snapshot,
          shape: { ok: live.evidenceVerified && live.shapeOk, issues: [] as string[] }, error: null as string | null };
      }
      if (realStatus !== "idle") throw new Error(realStatus === "loading" ? "Real repository analysis is loading." : "Real repository analysis is unavailable; no previous graph is retained.");
      const contents = fixtureContents();
      const snapshot: EvidenceSnapshot = {
        snapshotId: "ast-fixture",
        sourceKind: "synthetic",
        files: fixtureFileEntries().map((f) => ({ ...f, lineCount: f.lineCount })),
        skipped: [],
        canonicalProvenance: AST_FIXTURE_PROVENANCE,
        resolvedCommitIfGitHub: null,
      };
      const graph = buildAstGraph(snapshot, contents);
      const shape = validateGraphShape(graph, snapshot, contents);
      return { graph, contents, snapshot, shape, error: null as string | null };
    } catch (err) {
      return {
        graph: {
          nodes: [], edges: [], unresolved: [], unsupportedModules: [] as string[],
          unsupportedForms: [], snapshotId: "", canonicalProvenance: "",
          resolvedCommitIfGitHub: null,
        },
        contents: new Map<string, string>(),
        snapshot: null,
        shape: { ok: false, issues: ["graph build failed"] },
        error: err instanceof Error ? err.message : "graph build failed",
      };
    }
  }, [live, realStatus]);

  const { shape } = built;
  const presentation = useMemo(() => presentGraph(built.graph), [built.graph]);
  const { graph } = presentation;
  const [connectionPage, setConnectionPage] = useState(0);
  const aliases = useMemo(() => graphAliases(graph), [graph]);
  const view = useMemo(() => focusedGraph(graph, selected, connectionPage), [graph, selected, connectionPage]);
  const positions = view.positions;

  const unsupportedByModule = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of graph.edges) {
      if (e.kind === "imports" || e.kind === "references") continue;
      const mod = e.from.replace(/^ast-module:/, "");
      m.set(mod, (m.get(mod) ?? 0) + 1);
    }
    return m;
  }, [graph]);

  const nodes: Node[] = useMemo(
    () =>
      view.nodes.map((n) => ({
        id: n.id,
        type: n.kind,
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        ariaLabel: aliases.get(n.id),
        data: { datum: n, label: aliases.get(n.id), selected: view.focus?.id === n.id, unsupported: unsupportedByModule.get(n.module) ?? 0 },
        selected: selected === n.id,
      })),
    [view, aliases, positions, selected, unsupportedByModule]
  );

  const edges: Edge[] = useMemo(
    () =>
      view.edges
        .filter((e) => e.kind === "imports" || e.kind === "references")
        .map((e, i) => {
          const active = selected !== null && (e.from === selected || e.to === selected);
          const isRef = e.kind === "references";
          return {
            id: `${e.kind}:${i}`,
            ariaLabel: "Source relationship",
            source: e.from,
            target: e.to,
            // C005 HIGH: edge labels NEVER carry source-derived specifier
            // text (credential-bearing URLs). No canvas label at all.
            label: undefined,
            type: "smoothstep",
            animated: active,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: active
              ? { stroke: "#24BCD7", strokeWidth: 2.5 }
              : isRef
                ? { strokeDasharray: "5 4", stroke: "#8AA0B4", strokeWidth: 1.6 }
                : { stroke: "#42566B", strokeWidth: 1.6 },
            labelStyle: { fill: "#42566B", fontSize: 11 },
            labelBgStyle: { fill: "#F7FAFC" },
          };
        }),
    [view, selected]
  );

  const onNodeClick = useCallback(
    (_: unknown, n: Node) => { setConnectionPage(0); setFindingId(null); setSelected(n.id === selected ? null : n.id); },
    [selected]
  );
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const next = applyNodeSelectChanges(changes, selected);
      if (next !== selected) { setFindingId(null); setSelected(next); }
    },
    [selected]
  );

  const selNode = selected ? graph.nodes.find((n) => n.id === selected) ?? null : null;
  // C004 (Codex C003 QA HIGH): the node source view NEVER renders untrusted
  // original source text — no source rows, quote, anchor, or adjacent preview
  // (including multiline credentials). Only safe line/column/path metadata is
  // shown, plus the fixed withheld notice. `contents` stays in state for
  // detection/evidence only and is never rendered here.
  const selLine = selNode && selNode.line !== null ? selNode.line : 1;
  const moduleMembers =
    selNode?.kind === "member"
      ? []
      : selNode
        ? Object.values(selNode.members)
        : [];
  const selModuleNode =
    selNode && selNode.kind === "member"
      ? graph.nodes.find((n) => n.id === moduleNodeId(selNode.module)) ?? null
      : selNode;

  return (
    <section
      className="mt-4 rounded-[10px] border p-4"
      style={{ background: "var(--vf-panel-bg)", borderColor: "var(--vf-border)" }}
      aria-label={realStatus === "idle" ? "Real TypeScript AST graph (offline fixtures)" : "Repository TypeScript AST graph"}
    >
      <div className="mb-1 flex items-start justify-between gap-3">
        <h2 className="text-[20px] font-semibold leading-tight">Architecture graph — real AST</h2>
        <span className="mt-2 shrink-0 rounded-full border px-2.5 py-1 text-[11px]" style={{ borderColor: "var(--vf-border)", color: "var(--vf-muted-text)" }}>
          {live ? "Real repository source" : realStatus === "idle" ? "Offline fixtures" : realStatus === "loading" ? "Analyzing repository" : "Real analysis unavailable"}
        </span>
      </div>
      {live ? (
        <p className="mb-3 text-[13px]" style={{ color: "var(--vf-muted-text)" }} role="note">
          Real source: repository snapshot (identity withheld) · {live.snapshot.coverage.collected} file(s),{" "}
          {live.snapshot.coverage.skippedCount} skipped · provenance identity withheld. Parsed with the
          TypeScript Compiler API. Select any module or function to inspect its source location.
        </p>
      ) : realStatus === "idle" ? (
        <p className="mb-3 text-[13px]" style={{ color: "var(--vf-muted-text)" }} role="note">
          {AST_FIXTURE_LABEL}. {FIXTURE_SOURCES.length} local fixture files parsed with the
          TypeScript Compiler API. Select any module or function to inspect its source location.
        </p>
      ) : null}
      <p className="mb-2 text-[12px]" role="note">Source names and paths withheld. Opaque graph identities retain relationships and line geometry.</p>
      {live ? <p className="mb-3 text-[12px]" role="note">Source evidence: SHA-256, byte/line geometry and graph checks passed. Analysis coverage: {live.analysisStatus === "complete" ? "complete" : "partial"}. Potential security findings (P5, not confirmed vulnerabilities) are listed below when detected.</p> : realStatus === "idle" ? <p className="mb-3 text-[12px]" style={{ color: "var(--vf-muted-text)" }} role="note">
        Evidence status: PARTIAL — structural checks run in this browser; SHA-256
        verification runs only in the offline tests and is never claimed here.
        Invalid evidence hides the graph entirely (fail closed).
      </p> : null}

      {live && <SecurityFindings state={visibleSecurity} selected={findingId} onSelect={f => {
        setFindingId(f.id); setSelected(presentation.nodeId(moduleNodeId(f.path)));
      }} />}
      {realStatus === "loading" && !live ? (
        <div className="grid h-[320px] place-items-center rounded-[10px] bg-[#F7FAFC] text-[#1C3043]" role="status">
          Analyzing repository source…
        </div>
      ) : built.error ? (
        <div className="grid h-[320px] place-items-center rounded-[10px] bg-[#F7FAFC] text-[#1C3043]" role="alert">
          <p>AST graph unavailable: Graph build failed.</p>
        </div>
      ) : !shape.ok ? (
        <div className="grid h-[320px] place-items-center rounded-[10px] bg-[#FFF5F5] text-[#9B2C2C]" role="alert">
          <p>
            Evidence unavailable — this graph failed structural validation
            ({shape.issues.length} issue{shape.issues.length === 1 ? "" : "s"}) and is
            hidden. No source evidence is shown for an unverified graph.
          </p>
        </div>
      ) : graph.nodes.length === 0 ? (
        <div className="grid h-[320px] place-items-center rounded-[10px] bg-[#F7FAFC] text-[#1C3043]" role="status">
          No parsed modules in this fixture snapshot.
        </div>
      ) : (
        <div className="vf-graph-layout grid gap-4">
          <div className="min-w-0">
            <p className="vf-graph-guide">{aliases.get(view.focus?.id ?? "")} · {view.neighbours.length} directly connected modules · {view.modules.length} total</p>
            <p className="vf-graph-guide">Arrows show static imports. Exported members remain accessible in the inspector.</p>
            <details className="vf-all-modules"><summary>Browse all {view.modules.length} modules</summary>
              <ul className="vf-module-list" aria-label="AST module list">{view.modules.map(m => <li key={m.id}>
                <button aria-pressed={selected === m.id} onClick={() => { setConnectionPage(0); setFindingId(null); setSelected(m.id); }}>{aliases.get(m.id)}</button>
              </li>)}</ul>
            </details>
          <div className="vf-graph-canvas h-[400px] w-full overflow-hidden rounded-[10px] sm:h-[480px] xl:h-[548px]" style={{ background: "var(--vf-graph-bg)" }} role="application" aria-label="Real AST architecture graph">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={onNodeClick}
              onNodesChange={onNodesChange}
              onPaneClick={() => { setFindingId(null); setSelected(null); }}
              key={`${view.focus?.id}:${view.page}`}
              fitView
              fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
              minZoom={0.25}
              maxZoom={1.8}
              colorMode="light"
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#D6E0EA" gap={22} />
              <Controls position="top-right" showInteractive={false} aria-label="AST graph zoom controls" />
              <MiniMap pannable={false} style={{ display: "none" }} />
            </ReactFlow>
          </div>
          {view.pages > 1 && <div className="vf-connection-pages">
            <button disabled={view.page === 0} onClick={() => setConnectionPage(view.page - 1)}>Previous connections</button>
            <span>{view.page + 1} / {view.pages}</span>
            <button disabled={view.page + 1 === view.pages} onClick={() => setConnectionPage(view.page + 1)}>Next connections</button>
          </div>}
          </div>

          <div
            className="vf-ast-inspector min-w-0 rounded-[10px] bg-[#F7FAFC] p-4 text-[#1C3043]"
            role="complementary"
            aria-label="AST evidence inspector"
            aria-live="polite"
          >
            {selectedFinding ? (
              <>
                <SecurityFindingInspector finding={selectedFinding} trustedEvidence={live ? {
                  snapshotId: live.snapshot.snapshotId,
                  commit: live.snapshot.resolvedCommitIfGitHub,
                  files: live.snapshot.files,
                  contents: live.contents,
                  // C005: live snapshot+contents passed detection-time SHA-256,
                  // byte/line geometry and graph checks before entering state
                  // (see useEffect above). The comparison ALWAYS re-hashes the
                  // actual source bytes with its bundled browser-safe sync
                  // SHA-256 and compares against the snapshot file digest —
                  // no caller boolean is trusted. Anything unverified still
                  // fails closed below.
                  verified: true as const,
                } : undefined} />
                {live && <ExplanationPanel key={`${live.snapshot.snapshotId}:${selectedFinding.id}`} finding={selectedFinding} snapshot={live.snapshot} contents={live.contents} />}
              </>
            ) : !selNode ? (
              <p className="text-[13px]" role="status">
                Select a module from the canvas or module browser to inspect line metadata. Arrows are direct static module imports; exported members are listed after selection. Potential
                security findings, when present, are listed below the graph.
              </p>
            ) : (
              <>
                <h3 id="ast-selected-heading" tabIndex={-1} className="text-[13px] font-semibold">
                  {selNode.kind === "member"
                    ? `${(selNode.declKind ?? "member").charAt(0).toUpperCase()}${(selNode.declKind ?? "member").slice(1)}`
                    : "Module"}: {aliases.get(selNode.id)}
                </h3>
                <p className="mt-1 font-mono text-[12px]" aria-label="Source location">
                  {aliases.get(selNode.module)}:{selLine}
                </p>
                <p className="mt-1 text-[12px] opacity-80">
                  Line {selLine} declares <span className="font-mono">{aliases.get(selNode.id)}</span>
                  {selNode.kind === "member" ? ` (exported ${selNode.declKind ?? "member"})` : ` in ${aliases.get(selNode.module)}`}.
                </p>
                {graph.unsupportedModules.includes(selNode.module) && (
                  <p className="mt-2 rounded-[6px] bg-[#FFF5F5] px-3 py-2 text-[12px] text-[#9B2C2C]" role="alert">
                    Unsupported module: parse diagnostics in {aliases.get(selNode.module)}; its
                    relationships are downgraded and its members are not shown.
                  </p>
                )}
                <pre
                  className="mt-2 overflow-x-auto rounded-[6px] bg-[#EDF2F7] p-3 font-mono text-[12px] leading-relaxed"
                  aria-label="Source excerpt withheld"
                >{WITHHELD_NOTICE}</pre>
                <p className="mt-1 text-[12px] opacity-80">
                  Location above is retained; no source text is displayed.
                </p>

                {selNode.kind === "member" && selModuleNode && (
                  <p className="mt-3 text-[12px]">
                    Module:{" "}
                    <button
                      className="font-mono underline"
                      onClick={() => { setFindingId(null); setSelected(selModuleNode.id); }}
                      aria-label={`Select module ${aliases.get(selModuleNode.module)}`}
                    >
                      {aliases.get(selModuleNode.module)}
                    </button>
                  </p>
                )}

                {selNode.kind === "module" && moduleMembers.length > 0 && (
                  <>
                    <h4 className="mt-4 text-[12px] font-semibold">Exported members</h4>
                    <ul className="mt-1" aria-label="Exported members">
                      {[...moduleMembers].sort((a, b) => a.line - b.line).map((m) => {
                        const id = `${selNode.id}#${m.name}`;
                        return (
                          <li key={id}>
                            <button
                              className="text-left font-mono text-[12px] underline"
                              onClick={() => { setFindingId(null); setSelected(id); }}
                              aria-label={`Select member ${aliases.get(m.name)}`}
                              aria-pressed={selected === id}
                            >
                              {aliases.get(m.name)} — line {m.line} ({m.kind})
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}

                <UnsupportedImports
                  edges={graph.edges.filter((e) => e.from === moduleNodeId(selNode.module))}
                  mod={selNode.module}
                />
                <p className="mt-3 text-[12px] opacity-80">
                  Source text withheld; repository code is never executed.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
