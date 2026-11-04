/**
 * P8 C001 offline judge-facing demo (VIBESHOP_DEMO_001).
 *
 * End-to-end over the controlled local VibeShop fixture ONLY:
 * fixture intake card -> read-only source snapshot -> existing AST graph
 * pipeline (buildAstGraph + presentGraph, opaque labels) -> existing P5
 * detector -> selected-finding evidence -> P7 synthetic before/after
 * (example-only fallback: NO finding citation rendered) -> honest Muse
 * NOT CONFIGURED status. No network, no GitHub fetch, no Muse call.
 *
 * Privacy: raw fixture paths, excerpts, quotes and anchors are NEVER
 * rendered here. Opaque Module-* tokens preserve graph relationships and
 * finding->module projection without leaking source names.
 */
"use client";
import { ExplanationPanel } from "@/components/ExplanationPanel";
import { memo, useEffect, useMemo, useState } from "react";
import {
  ReactFlow, Background, Handle, Position, MarkerType,
  type Edge, type Node, type ReactFlowInstance, type ReactFlowProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createPositionProjector } from "@/lib/demo-drag";
import { MeasuredGraphCanvas } from "@/components/MeasuredGraphCanvas";
import { applyNodeSelectChanges } from "@/components/Graph";
import { FileText, FunctionSquare } from "lucide-react";
import { buildAstGraph, moduleNodeId, type AstGraphNode } from "@/lib/ast-graph";
import { focusedGraph, overviewGraph, graphAliases } from "@/lib/graph-view";
import { moveOffsets, importConnections, connectionEmphasis, type Offsets } from "@/lib/graph-interaction";
import { presentGraph } from "@/lib/graph-presentation";
import { validateGraphShape } from "@/lib/evidence";
import { detectSecurityFindings, type SecurityFinding } from "@/lib/security-findings";
import { browserSnapshotSchema, sha256Text } from "@/lib/intake-client";
import { WITHHELD_NOTICE } from "@/lib/safer-comparison";
import { SaferComparison } from "@/components/SaferComparison";
import { UnsupportedImports } from "@/components/AstGraph";
import {
  FIXTURE_PINNED_COMMIT, FIXTURE_PROVENANCE, FIXTURE_LABEL,
  NOT_FETCHED_NOTE, FIXTURE_VS_GITHUB_NOTE, MUSE_STATUS_NOTE, POTENTIAL_FINDINGS_NOTE,
  buildDemoSnapshot, demoFindingCard,
  fixtureContents, fixtureManifest,
} from "@/lib/demo-fixture";

export const DEMO_PATH_WITHHELD_NOTICE =
  "[WITHHELD — source path not shown in this demo surface; the opaque file identity preserves graph relationships]";

/* ---------- presentational pieces (SSR-testable, no effects) ---------- */

const DemoNode = memo(function DemoNode({ data }: { data: { datum: AstGraphNode; selected: boolean; focused: boolean; unsupported: number; label: string } }) {
  const d = data.datum;
  const isMember = d.kind === "member";
  const Icon = isMember ? FunctionSquare : FileText;
  return (
    <div className="vf-demo-node rounded-[9px] border px-3 py-2 text-left"
      style={{ background: data.focused ? "#DDEEFF" : isMember ? "#DBF5EE" : "#FFFFFF",
        borderColor: data.focused ? "#075985" : data.selected ? "#328278" : "#70899E",
        borderWidth: data.selected ? 2 : 1, width: 180, minHeight: 78, color: "#1C3043" }}>
      <div className="flex items-center gap-2">
        <Icon size={20} aria-hidden="true" />
        <span className="max-w-[220px] break-all text-[18px] font-semibold">{data.label}</span>
      </div>
      <p className="mt-0.5 max-w-[220px] break-all text-[12px] opacity-80">
        {isMember ? `line ${d.line ?? "?"}` : `${Object.keys(d.members).length} exports · TS module`}
      </p>
      {!isMember && data.unsupported > 0 && (
        <span className="mt-1 inline-block rounded-full bg-black/10 px-2 py-0.5 text-[11px]">
          {data.unsupported} unsupported import{data.unsupported === 1 ? "" : "s"}
        </span>
      )}
      <Handle type="target" position={Position.Left} aria-label={`${data.label} incoming connection`}
        style={{ width: 10, height: 10, background: "#075985", border: "2px solid #fff" }} />
      <Handle type="source" position={Position.Right} aria-label={`${data.label} outgoing connection`}
        style={{ width: 10, height: 10, background: "#075985", border: "2px solid #fff" }} />
    </div>
  );
}, (previous, next) => previous.data === next.data);
const demoNodeTypes = { module: DemoNode, member: DemoNode };

export function DemoGraph({ graph, selected, onSelect }: {
  graph: ReturnType<typeof presentGraph>["graph"];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [page, setPage] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const [layout, setLayout] = useState<{ graph: typeof graph; offsets: Offsets }>({ graph, offsets: {} });
  const [zoom, setZoom] = useState(1);
  const [reset, setReset] = useState(0);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  useEffect(() => {
    if (!fullscreen) return;
    const dialog = document.getElementById("demo-fullscreen-graph") as HTMLDialogElement | null;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    document.getElementById("demo-fullscreen-close")?.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      document.getElementById("demo-fullscreen-open")?.focus();
    };
  }, [fullscreen]);
  useEffect(() => {
    // A finding can change the module without using a canvas callback. Drop
    // connection/hover context from the previous module (or graph snapshot).
    setSelectedEdge(null); setHoverEdge(null); setHoverNode(null); setPage(0);
  }, [graph, selected]);
  const changeFullscreen = (open: boolean) => { setHoverNode(null); setHoverEdge(null); setFlow(null); setZoom(1); setFullscreen(open); };
  const aliases = useMemo(() => graphAliases(graph), [graph]);
  const view = useMemo(() => focusedGraph(graph, selected, page), [graph, selected, page]);
  const overview = useMemo(() => overviewGraph(graph), [graph]);
  const activeView = fullscreen ? overview : view;
  const positions = activeView.positions;
  const offsets = layout.graph === graph ? layout.offsets : {};
  const emphasis = useMemo(() => connectionEmphasis(graph, hoverNode ?? selected ?? view.focus?.id ?? null, hoverEdge ?? (hoverNode ? null : selectedEdge)),
    [graph, hoverNode, selected, view.focus?.id, hoverEdge, selectedEdge]);
  const connections = useMemo(() => importConnections(graph, view.focus?.id), [graph, view.focus?.id]);
  const edgeId = (edge: (typeof graph.edges)[number]) => `demo-edge:${graph.edges.indexOf(edge)}`;
  const relationshipLabel = (edge: (typeof graph.edges)[number]) => `${aliases.get(edge.from)} imports ${aliases.get(edge.to)}`;
  const chooseEdge = useMemo(() => (id: string) => { setHoverNode(null); setHoverEdge(null); setSelectedEdge(id); }, []);
  const fit = () => { void flow?.fitView({ padding: 0.12, maxZoom: 1 }); };
  const tools = <div className="vf-graph-tools" role="group" aria-label="Graph layout controls">
    <button type="button" disabled={!flow || zoom >= 2.5} onClick={() => { void flow?.zoomIn(); }}>Zoom In</button>
    <button type="button" disabled={!flow || zoom <= 0.1} onClick={() => { void flow?.zoomOut(); }}>Zoom Out</button>
    <button type="button" disabled={!flow} onClick={fit}>{fullscreen ? "Fit All" : "Fit View"}</button>
    <button type="button" onClick={() => { setFlow(null); setZoom(1); setLayout({ graph, offsets: {} }); setReset(v => v + 1); }}>Reset layout</button>
  </div>;
  const connectionList = useMemo(() => <section className="vf-directional-connections" aria-label="Directional connections">
    <p>Solid arrows: static imports · source → imported module</p>
    {(["incoming", "outgoing"] as const).map(direction => <details key={direction} open>
      <summary>{direction === "incoming" ? "Incoming" : "Outgoing"} ({connections[direction].length}) · {aliases.get(view.focus?.id ?? "")}</summary>
      <ul>{connections[direction].map(edge => <li key={edgeId(edge)}><button type="button"
        aria-pressed={selectedEdge === edgeId(edge)}
        onMouseEnter={() => { setHoverNode(null); setHoverEdge(edgeId(edge)); }} onMouseLeave={() => setHoverEdge(null)}
        onFocus={() => { setHoverNode(null); setHoverEdge(edgeId(edge)); }} onBlur={() => setHoverEdge(null)}
        onClick={() => {
          chooseEdge(edgeId(edge));
          for (let p = 0; p < view.pages; p++) if (focusedGraph(graph, selected, p).edges.includes(edge)) { setPage(p); break; }
        }}>{relationshipLabel(edge)}</button></li>)}</ul>
    </details>)}
    <p role="status">{(() => {
      const edge = graph.edges.find((_, i) => `demo-edge:${i}` === (hoverEdge ?? selectedEdge));
      return edge ? `${relationshipLabel(edge)} · import statement at ${aliases.get(edge.from)}:${edge.line} (path withheld)` : "Select a connection to highlight its endpoints.";
    })()}</p>
    <button type="button" onClick={() => { setSelectedEdge(null); setHoverEdge(null); setHoverNode(null); }}>Clear connection highlight</button>
  </section>, [connections, aliases, view, graph, selected, selectedEdge, hoverEdge, chooseEdge]);
  const unsupportedByModule = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of graph.edges) {
      if (e.kind === "imports" || e.kind === "references") continue;
      const mod = e.from.replace(/^ast-module:/, "");
      m.set(mod, (m.get(mod) ?? 0) + 1);
    }
    return m;
  }, [graph]);
  const baseNodes = useMemo<Node[]>(() => activeView.nodes.map((n) => ({
    id: n.id, type: n.kind, dragHandle: ".vf-demo-node", position: positions.get(n.id) ?? { x: 0, y: 0 },
    ariaLabel: aliases.get(n.id),
    style: { opacity: emphasis.active && !emphasis.nodes.has(n.id) ? 0.3 : 1 },
    data: { datum: n, label: aliases.get(n.id), selected: emphasis.nodes.has(n.id), focused: n.id === (selected ?? view.focus?.id), unsupported: unsupportedByModule.get(n.module) ?? 0 },
    selected: selected === n.id,
  })), [activeView.nodes, positions, aliases, emphasis, unsupportedByModule, selected]);
  // Only the moved nodes receive new objects. Stable data lets memoized cards
  // skip position-only renders; Flow still receives every coordinate immediately.
  const projectPositions = useMemo(() => createPositionProjector(), []);
  const nodes = projectPositions(baseNodes, offsets);
  const edges = useMemo<Edge[]>(() => activeView.edges.map(e => {
    const highlighted = emphasis.edges.has(e);
    const color = highlighted ? "#075985" : "#42566B";
    return {
      id: edgeId(e), ariaLabel: relationshipLabel(e),
      source: e.from, target: e.to, label: (hoverEdge ?? selectedEdge) === edgeId(e) ? "imports" : undefined,
      type: "smoothstep", selected: selectedEdge === edgeId(e),
      markerEnd: { type: MarkerType.ArrowClosed, width: 24, height: 24, color },
      labelStyle: { fill: "#10283f", fontWeight: 700, fontSize: 12 }, labelBgStyle: { fill: "#fff" },
      interactionWidth: 24,
      style: { stroke: color, strokeWidth: highlighted ? 3 : 1.8, opacity: emphasis.active && !highlighted ? 0.15 : 1 },
    };
  }), [activeView.edges, graph, aliases, emphasis, selectedEdge, hoverEdge]);
  const onNodesChange = useMemo<NonNullable<ReactFlowProps["onNodesChange"]>>(() => changes => {
    if (changes.some(c => c.type === "position")) setLayout(old => {
      const offsets = moveOffsets(old.graph === graph ? old.offsets : {}, changes, positions);
      return old.graph === graph && offsets === old.offsets ? old : { graph, offsets };
    });
    // Edge-induced deselection must not navigate away from the finding.
    const next = changes.some(c => c.type === "select" && c.selected) ? applyNodeSelectChanges(changes, selected) : selected;
    if (next !== selected) { setSelectedEdge(null); setPage(0); onSelect(next); }
  }, [graph, positions, selected, onSelect]);
  // Stable event props also let Flow's memoized renderers skip unrelated work.
  const flowHandlers = useMemo<ReactFlowProps>(() => ({
    onMove: (_, viewport) => setZoom(viewport.zoom),
    onNodeClick: (_, n) => { setSelectedEdge(null); setPage(0); onSelect(n.id === selected ? null : n.id); },
    onNodeMouseEnter: (_, n) => { setHoverEdge(null); setHoverNode(n.id); },
    onNodeMouseLeave: () => setHoverNode(null),
    onEdgeMouseEnter: (_, e) => { setHoverNode(null); setHoverEdge(e.id); },
    onEdgeMouseLeave: () => setHoverEdge(null),
    onEdgeClick: (_, e) => chooseEdge(e.id),
    onEdgesChange: changes => { for (const c of changes) if (c.type === "select") setSelectedEdge(old => c.selected ? c.id : old === c.id ? null : old); },
    onFocusCapture: event => {
      const target = event.target as HTMLElement;
      const edge = target.closest?.(".react-flow__edge")?.getAttribute("data-id");
      const node = target.closest?.(".react-flow__node")?.getAttribute("data-id");
      if (edge) { setHoverNode(null); setHoverEdge(edge); }
      else if (node) { setHoverEdge(null); setHoverNode(node); }
    },
    onKeyDownCapture: event => {
      // Only explicit node Escape may clear module context; modal Escape keeps it.
      if (!fullscreen && event.key === "Escape" && (event.target as HTMLElement).closest?.(".react-flow__node")) onSelect(null);
    },
    onBlurCapture: () => { setHoverNode(null); setHoverEdge(null); },
    onPaneClick: () => { setSelectedEdge(null); setHoverEdge(null); setHoverNode(null); onSelect(null); },
  }), [selected, onSelect, fullscreen, chooseEdge]);
  const modules = view.modules;
  const canvas = (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={demoNodeTypes}
      onInit={setFlow} {...flowHandlers}
      onNodesChange={onNodesChange}
      // XYDrag otherwise publishes positive node selection before drag-start.
      // Only click/keyboard selection navigates findings and remounts the focus
      // view; dragging preserves its key, module context and base positions.
      selectNodesOnDrag={false} nodesDraggable nodesConnectable={false} edgesFocusable
      deleteKeyCode={null} edgesReconnectable={false} preventScrolling={false} zoomOnScroll={false} zoomOnPinch
      key={`${fullscreen ? "overview" : `${view.focus?.id}:${view.page}`}:${reset}`}
      fitView fitViewOptions={{ padding: 0.12, maxZoom: 1 }} minZoom={0.1} maxZoom={2.5}
      colorMode="light" proOptions={{ hideAttribution: true }}>
      <Background color="#D6E0EA" gap={22} />
    </ReactFlow>
  );
  return (
    <div className="vf-graph-layout grid min-w-0 gap-5">
      <div>
        <button id="demo-fullscreen-open" className="vf-fullscreen-button" type="button"
          aria-haspopup="dialog" aria-controls="demo-fullscreen-graph"
          onClick={() => changeFullscreen(true)}>
          Fullscreen · View all {modules.length} modules
        </button>
        <p className="vf-graph-guide">{aliases.get(view.focus?.id ?? "")} · {view.neighbours.length} directly connected modules · {view.modules.length} total</p>
        <p className="vf-graph-guide">Solid arrows: imports → imported module. Drag cards to arrange; drag the canvas to pan.</p>
        {fullscreen ? (
          <dialog id="demo-fullscreen-graph" className="vf-fullscreen-graph"
            aria-labelledby="demo-fullscreen-title" aria-describedby="demo-fullscreen-help"
            onCancel={(event) => { event.preventDefault(); changeFullscreen(false); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); changeFullscreen(false); }
            }}>
            <header className="vf-fullscreen-toolbar">
              <div>
                <h2 id="demo-fullscreen-title">All {modules.length} modules · {overview.edges.length} static imports</h2>
                <p id="demo-fullscreen-help">Pinch to zoom; drag the background to pan or a module to move it. Tab and Enter select; arrow keys move focused modules. Escape closes. Fit All zooms out to show every module; narrow screens start near one module for readable labels.</p>
                <p role="status">{selected ? `Selected: ${aliases.get(selected)}` : "Select a module"}</p>
              </div>
              {tools}
              <button id="demo-fullscreen-close" type="button" onClick={() => changeFullscreen(false)}>Close fullscreen</button>
            </header>
            <div className="vf-fullscreen-canvas" role="application" aria-label="All fixture modules and static imports">
              <MeasuredGraphCanvas overview={fullscreen} focused={!fullscreen}>{canvas}</MeasuredGraphCanvas>
            </div>
            <details className="vf-fullscreen-connections">
              <summary>Directional connections · {aliases.get(view.focus?.id ?? "")}</summary>
              {connectionList}
            </details>
          </dialog>
        ) : (
          <div className="min-w-0 overflow-hidden rounded-lg border border-[#D6E0EA] p-2 sm:p-3">{tools}<div className="vf-graph-canvas h-[400px] w-full overflow-hidden rounded-[10px] sm:h-[480px] xl:h-[548px]"
            style={{ background: "var(--vf-graph-bg)" }} role="application" aria-label="VibeShop fixture architecture graph">
            <MeasuredGraphCanvas overview={fullscreen} focused={!fullscreen}>{canvas}</MeasuredGraphCanvas>
          </div><details className="vf-demo-disclosure"><summary>Explore connections · {connections.incoming.length} incoming / {connections.outgoing.length} outgoing</summary>{connectionList}</details></div>
        )}
        {view.pages > 1 && <div className="vf-connection-pages">
          <button disabled={view.page === 0} onClick={() => setPage(view.page - 1)}>Previous connections</button>
          <span>{view.page + 1} / {view.pages}</span>
          <button disabled={view.page + 1 === view.pages} onClick={() => setPage(view.page + 1)}>Next connections</button>
        </div>}
      </div>
      <details className="vf-module-browser vf-demo-disclosure min-w-0 overflow-hidden rounded-[10px] border border-[#D6E0EA] bg-[#F7FAFC] p-3 text-[#1C3043]">
        <summary className="text-[14px] font-semibold">Fixture modules ({modules.length}) · browse all</summary>
        <p className="mt-1 text-[12px] opacity-80" role="note">{DEMO_PATH_WITHHELD_NOTICE}</p>
        <ul className="vf-module-list mt-2 max-h-[320px] overflow-y-auto pr-2" aria-label="Fixture module list">
          {modules.map((m) => (
            <li key={m.id} className="border-b py-1.5 last:border-0">
              <button className="max-w-full break-all text-left font-mono text-[12px] underline"
                onClick={() => { setSelectedEdge(null); setHoverEdge(null); setHoverNode(null); setPage(0); onSelect(m.id === selected ? null : m.id); }}
                aria-pressed={selected === m.id}
                aria-label={`Select fixture module ${aliases.get(m.id)}`}>
                {aliases.get(m.id)}
              </button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function DemoFindingsList({ findings, selected, onSelect, moduleLabel }: {
  findings: SecurityFinding[]; selected: string | null; onSelect: (f: SecurityFinding) => void; moduleLabel?: (f: SecurityFinding) => string;
}) {
  return (
    <div className="vf-demo-findings rounded-[10px] p-4" aria-label="Potential fixture findings">
      <h3 className="text-[13px] font-semibold">Potential findings in fixture (P5)</h3>
      <p className="mt-1 text-[12px]" role="note">{POTENTIAL_FINDINGS_NOTE}</p>
      <p className="mt-1 text-[12px]" role="status">
        {findings.length} potential finding(s) shown. This is not a security guarantee.
      </p>
      {findings.length === 0 && <p>No potential findings from the supported rules in the fixture files.</p>}
      <ol aria-label="Detected potential fixture findings">
        {findings.map((f, i) => {
          const card = demoFindingCard(f, i);
          return (
            <li key={f.id} className="vf-demo-finding-row mt-2 rounded-[6px] px-3 py-2 text-[13px]">
              <button className="font-mono underline" onClick={() => onSelect(f)}
                aria-label={`Inspect potential finding ${i + 1}: ${f.ruleId} at line ${f.line}`}
                aria-pressed={selected === f.id} aria-controls="demo-finding-inspector">
                {i + 1}. {card.ruleId} · {card.severity} · line {card.line}:{card.column}
              </button>
              <p className="mt-1 font-medium">{card.title}</p>
              <p className="mt-1 font-mono text-[12px]">File: {moduleLabel?.(f) ?? "Source module (identity withheld)"} · sha {card.fileShaShort}…</p>
            </li>
          );
        })}
      </ol>
      <details className="mt-2"><summary>Evidence visibility &amp; limitations</summary><p role="note">{DEMO_PATH_WITHHELD_NOTICE}</p><p role="note">{WITHHELD_NOTICE}</p></details>
    </div>
  );
}

export function DemoFindingInspector({ finding, snapshot, contents, index = 0, moduleLabel, operatorResults = false, onRealResult }: {
  finding: SecurityFinding; snapshotId: string; snapshot?: unknown; contents: Record<string, string>; index?: number; moduleLabel?: string;
  operatorResults?: boolean; onRealResult?: (available: boolean) => void;
}) {
  const card = demoFindingCard(finding, index);
  return (
    <div id="demo-finding-inspector" className="vf-demo-evidence rounded-[10px] bg-[#F7FAFC] p-4 text-[#1C3043]">
      <h3 id="demo-finding-heading" tabIndex={-1} className="text-[16px] font-semibold">Selected potential finding: {card.ruleId}</h3>
      <p className="mt-1 font-medium">{card.title}</p>
      <p className="mt-2 font-mono text-[13px]">File: {moduleLabel ?? "Source module (identity withheld)"} · line {card.line}:{card.column}</p>
      <a className="vf-demo-evidence-link" href="#demo-graph">Locate {moduleLabel ?? "selected module"} in graph ↑</a>
      <p className="mt-2 text-[13px]">{card.limitations}</p>
      <p className="mt-2 text-[13px]">Safer pattern: {card.recommendation}</p>
      <details className="mt-2 text-[12px]"><summary>Source integrity details</summary>
        <p className="break-all">Source SHA-256: {finding.fileSha256}</p>
        <p>UTF-8 bytes [{finding.byteOffset}, {finding.endByteOffset}); UTF-16 offsets [{finding.charOffset}, {finding.endCharOffset}).</p>
        <p>Snapshot: {card.snapshotId} · Fixture commit: {FIXTURE_PINNED_COMMIT.slice(0, 12)}… (metadata only)</p>
      </details>
      <p role="note" className="mt-2 rounded-[6px] bg-[#EDF2F7] p-3 text-[12px]">{WITHHELD_NOTICE}</p>
      <details className="mt-1 text-[12px]"><summary>Why no source link?</summary><p>{DEMO_PATH_WITHHELD_NOTICE}</p>
        <p>Location and provenance metadata above are retained; no source excerpt is displayed. This is not a clickable file:line citation.</p>
      </details>
      <details id="demo-comparison" className="vf-demo-comparison mt-3">
        <summary id="demo-comparison-heading" tabIndex={-1}>Compare safer pattern · synthetic example</summary>
        <SaferComparison finding={finding} trustedEvidence={undefined} />
      </details>
      <p className="mt-3 text-[12px]" role="note">{operatorResults
        ? "Muse · operator-only execution. No provider is configured in the browser. NOT CONFIGURED until a separately authorized local result is available. The browser cannot spend credits."
        : "Muse NOT CONFIGURED · No provider is configured. Real Muse output is NOT VERIFIED. Live inference is disabled."}</p>
      {snapshot != null && <ExplanationPanel finding={finding} snapshot={snapshot} contents={contents} withholdFailureDetails withholdSourceDetails operatorResults={operatorResults} onRealResult={onRealResult} />}
    </div>
  );
}

/* ---------- full offline flow ---------- */

type DemoSecurity =
  | { status: "preparing" | "running" }
  | { status: "done"; result: Extract<Awaited<ReturnType<typeof detectSecurityFindings>>, { ok: true }> }
  | { status: "invalid" };

export function DemoVibeShop() {
  const man = fixtureManifest();
  const contents = useMemo(() => fixtureContents(), []);
  const snapshotResult = useMemo(() => {
    try {
      const snapshot = buildDemoSnapshot(contents);
      return { ok: true as const, snapshot, contentsMap: new Map(Object.entries(contents)) };
    } catch {
      return { ok: false as const };
    }
  }, [contents]);
  const [security, setSecurity] = useState<DemoSecurity>({ status: "preparing" });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [findingId, setFindingId] = useState<string | null>(null);
  const [realMuseFindingId, setRealMuseFindingId] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshotResult.ok) {
      setSecurity({ status: "invalid" });
      return;
    }
    const controller = new AbortController();
    setSecurity({ status: "running" });
    (async () => {
      try {
        await browserSnapshotSchema.parseAsync(snapshotResult.snapshot);
        const r = await detectSecurityFindings(snapshotResult.snapshot, snapshotResult.contentsMap, sha256Text, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSecurity(r.ok ? { status: "done", result: r } : { status: "invalid" });
      } catch {
        if (!controller.signal.aborted) {
          setSecurity({ status: "invalid" });
        }
      }
    })();
    return () => { controller.abort(); };
  }, [snapshotResult]);

  // Reject invalid graphs and withhold all library/validation exception details.
  const presentation = useMemo(() => {
    if (!snapshotResult.ok) return null;
    try {
      const graph = buildAstGraph(snapshotResult.snapshot, snapshotResult.contentsMap);
      const shape = validateGraphShape(graph, snapshotResult.snapshot, snapshotResult.contentsMap);
      return shape.ok ? presentGraph(graph) : null;
    } catch {
      return null;
    }
  }, [snapshotResult]);
  const aliases = useMemo(() => presentation ? graphAliases(presentation.graph) : new Map<string, string>(), [presentation]);
  const findings = security.status === "done" ? security.result.findings : [];
  const selectedFinding = findings.find((f) => f.id === findingId) ?? null;

  // Move keyboard and mobile readers to the committed selection, after React
  // has mounted its comparison. Selection is viewport-independent; never put
  // source paths or finding IDs in a hash/URL to navigate this private surface.
  useEffect(() => {
    if (selectedFinding && typeof document !== "undefined") {
      document.getElementById("demo-finding-heading")?.focus();
    }
  }, [selectedFinding?.id]);

  const selectFinding = (f: SecurityFinding) => {
    setRealMuseFindingId(null);
    setFindingId(f.id);
    if (presentation) setSelectedNode(presentation.nodeId(moduleNodeId(f.path)));
  };

  return (
    <div className="vf-demo min-w-0">
      <section id="demo-overview" className="vf-demo-intake vf-demo-panel" aria-label="Controlled fixture intake">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-[26px] font-semibold leading-tight">VibeShop offline demo</h1>
          <span className="vf-demo-badge">Offline fixture · read-only</span>
        </div>
        <p className="mt-2 text-[14px]" role="note">NOT fetched from GitHub. {man.fileCount} bundled TS/TSX files · source paths and excerpts withheld.</p>
        <details className="mt-1"><summary className="text-[13px]">Fixture provenance &amp; snapshot integrity</summary>
          <p role="note">{FIXTURE_LABEL}. {NOT_FETCHED_NOTE}</p>
          <p role="note">{FIXTURE_VS_GITHUB_NOTE}</p>
          <dl className="mt-2 grid gap-2 text-[12px] sm:grid-cols-2">
            <div><dt>Staged files / bytes</dt><dd>{man.fileCount} / {man.totalBytes}</dd></div>
            <div><dt>Pinned public commit (metadata only)</dt><dd className="font-mono">{FIXTURE_PINNED_COMMIT}</dd></div>
            <div><dt>Fixture provenance</dt><dd>{FIXTURE_PROVENANCE}</dd></div>
          </dl>
          {snapshotResult.ok && <section className="mt-2" aria-label="Read-only source snapshot">
            <h2 className="font-semibold">Read-only source snapshot</h2>
            <p>Parsed only — inspected fixture code is never executed. No source text is rendered on this page.</p>
            <dl className="mt-2 grid gap-2 text-[12px] sm:grid-cols-2">
              <div><dt>Snapshot ID</dt><dd className="font-mono">{snapshotResult.snapshot.snapshotId}</dd></div>
              <div><dt>Kind / provenance</dt><dd>{snapshotResult.snapshot.sourceKind} / {snapshotResult.snapshot.canonicalProvenance}</dd></div>
              <div><dt>Manifest SHA-256</dt><dd className="font-mono">{snapshotResult.snapshot.manifestHash}</dd></div>
              <div><dt>Collected coverage</dt><dd>{snapshotResult.snapshot.coverage.collected} files · {snapshotResult.snapshot.coverage.skippedCount} skipped · {snapshotResult.snapshot.coverage.totalBytes} bytes</dd></div>
            </dl>
          </section>}
        </details>
      </section>
      {!snapshotResult.ok && <p className="mt-3 rounded-lg bg-[#FFF5F5] p-4 text-[#9B2C2C]" role="alert">Fixture snapshot unavailable; validation failed.</p>}

      <nav className="vf-demo-section-nav" aria-label="Demo sections">
        <a href="#demo-graph">Architecture graph</a>
        <a href="#demo-findings">Potential findings{security.status === "done" ? ` (${findings.length})` : ""}</a>
        <a href="#demo-comparison" onClick={() => {
          const target = document.getElementById("demo-comparison") as HTMLDetailsElement | null;
          if (target?.tagName === "DETAILS") target.open = true;
        }}>Safer comparison</a>
      </nav>

      <div className="vf-demo-workspace">
        <section id="demo-graph" tabIndex={-1} className="vf-demo-panel" aria-label="Fixture architecture graph">
          <h2 className="text-[22px] font-semibold">Architecture overview</h2>
          <p className="mt-1 mb-3 text-[13px]" style={{ color: "var(--vf-muted-text)" }} role="note">
            Fixture AST · one module and its direct imports. Module labels are opaque; source names and paths are withheld.
          </p>
          {security.status !== "done" && <p role="status" className="mb-2 text-[13px]">
            {security.status === "invalid" ? "Security analysis unavailable; validation or detection failed." : "Analyzing fixture source…"}
          </p>}
          {snapshotResult.ok && !presentation && <p role="alert">Fixture architecture unavailable; validation or presentation failed.</p>}
          {presentation && <>
            <DemoGraph graph={presentation.graph} selected={selectedNode}
              onSelect={(id) => { setFindingId(null); setSelectedNode(id); }} />
            {selectedNode && !selectedFinding && <p className="mt-2 text-[13px]" role="status">
              Selected: <span className="font-mono">{aliases.get(selectedNode)}</span>
              <button className="ml-2 underline" onClick={() => setSelectedNode(null)}>Clear</button>
            </p>}
            <details className="mt-2"><summary>Unsupported import coverage</summary><UnsupportedImports
              edges={presentation.graph.edges.filter((e) => e.from.startsWith("ast-module:"))} mod="fixture" /></details>
          </>}
        </section>

        <section id="demo-findings" tabIndex={-1} className="vf-demo-panel vf-demo-inspector" aria-label="Evidence and findings">
          <h2 className="text-[22px] font-semibold">Evidence &amp; findings</h2>
          <p className="mt-1 text-[13px]" style={{ color: "var(--vf-muted-text)" }}>Select a potential finding to locate its module and review its evidence limits.</p>
          {security.status === "done" ? <DemoFindingsList findings={findings} selected={findingId} onSelect={selectFinding}
            moduleLabel={f => presentation ? aliases.get(presentation.nodeId(moduleNodeId(f.path))) ?? "Source module" : "Source module"} />
            : <p className="mt-3" role="status">{security.status === "invalid" ? "Findings unavailable; source validation or detection failed." : "Preparing potential findings…"}</p>}
          {selectedFinding && snapshotResult.ok ? <section className="mt-3" aria-label="Selected finding evidence" aria-live="polite">
            <DemoFindingInspector finding={selectedFinding} snapshot={snapshotResult.snapshot} snapshotId={snapshotResult.snapshot.snapshotId} contents={contents}
              operatorResults onRealResult={available => setRealMuseFindingId(available ? selectedFinding.id : null)}
              moduleLabel={presentation ? aliases.get(selectedNode ?? "") : undefined} />
            <button className="mt-2 underline text-[13px]" onClick={() => setFindingId(null)}>Clear selected finding</button>
          </section> : <div id="demo-comparison" tabIndex={-1} className="vf-demo-empty mt-3">
            <h3 className="font-semibold">Evidence &amp; safer comparison</h3>
            <p className="mt-1">Select a finding above. Line, column and source hash metadata are retained; source excerpts remain withheld.</p>
            <p className="mt-2 text-[12px]">Comparisons are illustrative synthetic examples, not a diff or a validated fix of this fixture.</p>
          </div>}
        </section>
      </div>

      <section className="vf-demo-panel vf-demo-muse mt-4" aria-label="Muse explanation status">
        <h2 className="text-[18px] font-semibold">Muse explanation <span className="vf-demo-badge">{findingId && realMuseFindingId === findingId ? "REAL MUSE · SAVED RESULT" : "NOT CONFIGURED"}</span></h2>
        <p className="mt-2 text-[13px]" role="status">Browser provider: null · retrieval only · no automatic Muse calls. The selected panel labels a validated real operator result separately from OFFLINE MOCK tests.</p>
        <details><summary className="text-[12px]">Availability details</summary><p>{MUSE_STATUS_NOTE}</p>
          <p>Select a finding and load its authorized explanation after an operator has produced one. Until then, NOT CONFIGURED is expected.</p>
        </details>
      </section>
    </div>
  );
}
