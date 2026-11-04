"use client";
import { useCallback, useMemo, useState } from "react";
import {
  ReactFlow, Background, MiniMap, Controls, Handle, Position, MarkerType,
  type Node, type Edge, type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FileText, Folder } from "lucide-react";
import { GRAPH_NODES, GRAPH_EDGES, FINDINGS, type GraphNodeDatum } from "@/lib/preview-data";

const TONE: Record<GraphNodeDatum["tone"], string> = {
  blue: "#DDEEFF",
  violet: "#EAE6FF",
  teal: "#DBF5EE",
  slate: "#EDF2F7",
};

function ModuleNode({ data }: { data: { datum: GraphNodeDatum; selected: boolean } }) {
  const d = data.datum;
  const Icon = d.path.endsWith(".ts") ? FileText : Folder;
  return (
    <div
      className="rounded-[9px] border px-3 py-2 text-left"
      style={{
        background: TONE[d.tone],
        borderColor: data.selected ? "#24BCD7" : "#9FB4C7",
        borderWidth: data.selected ? 2 : 1,
        minWidth: 150,
        color: "#1C3043",
      }}
    >
      <div className="flex items-center gap-2">
        <Icon size={20} aria-hidden="true" />
        <span className="text-[13px] font-semibold">{d.path}</span>
      </div>
      <p className="mt-0.5 text-[12px] opacity-80">{d.role}</p>
      <span className="mt-1 inline-block rounded-full bg-black/10 px-2 py-0.5 text-[11px]">{d.countLabel}</span>
      <Handle
        type="target"
        position={Position.Top}
        aria-label={`${d.path} incoming connection`}
        style={{ width: 10, height: 10, background: "#24BCD7", border: "2px solid #fff" }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        aria-label={`${d.path} outgoing connection`}
        style={{ width: 10, height: 10, background: "#24BCD7", border: "2px solid #fff" }}
      />
    </div>
  );
}

const nodeTypes = { module: ModuleNode };

export function ArchGraph({
  selectedNode, onSelect,
}: { selectedNode: string | null; onSelect: (id: string | null) => void }) {
  const nodes: Node[] = useMemo(
    () =>
      GRAPH_NODES.map((d) => ({
        id: d.id,
        type: "module",
        position: { x: d.x, y: d.y },
        data: { datum: d, selected: selectedNode === d.id },
        selected: selectedNode === d.id,
      })),
    [selectedNode]
  );
  const edges: Edge[] = useMemo(
    () =>
      GRAPH_EDGES.map((e) => {
        const active = selectedNode !== null && (e.source === selectedNode || e.target === selectedNode);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          type: e.label ? "straight" : "default",
          animated: active,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: active
            ? { stroke: "#24BCD7", strokeWidth: 2.5 }
            : e.label
              ? { strokeDasharray: "5 4", stroke: "#8AA0B4", strokeWidth: 1.6 }
              : { stroke: "#42566B", strokeWidth: 1.6 },
          labelStyle: { fill: "#42566B", fontSize: 11 },
          labelBgStyle: { fill: "#F7FAFC" },
        };
      }),
    [selectedNode]
  );
  const onNodeClick = useCallback(
    (_: unknown, n: Node) => onSelect(n.id === selectedNode ? null : n.id),
    [onSelect, selectedNode]
  );
  // Canonical selection path for controlled nodes. React Flow routes EVERY
  // selection mutation — mouse click, keyboard Enter/Space/Escape on a
  // focused node, pane interactions — through triggerNodeChanges, which for
  // controlled nodes (no defaultNodes) publishes ONLY via this callback:
  // the internal store is never updated, so onSelectionChange would never
  // fire and keyboard selection would be silently dropped. Only select-type
  // changes affect application state; positions/dimensions are static by
  // design and intentionally ignored. Echoes resolve to the current node,
  // so the guard skips onSelect and no render loop is introduced.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const next = applyNodeSelectChanges(changes, selectedNode);
      if (next !== selectedNode) onSelect(next);
    },
    [onSelect, selectedNode]
  );
  return (
    <div className="h-[400px] w-full overflow-hidden rounded-[10px] sm:h-[480px] xl:h-[548px]" style={{ background: "var(--vf-graph-bg)" }} role="application" aria-label="Source graph (synthetic preview)">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodesChange={onNodesChange}
        onPaneClick={() => onSelect(null)}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.5}
        colorMode="light"
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#D6E0EA" gap={22} />
        <Controls position="top-right" showInteractive={false} aria-label="Graph zoom controls" />
        <MiniMap pannable={false} style={{ display: "none" }} />
      </ReactFlow>
    </div>
  );
}

/** Minimal structural shape of the React Flow changes this app consumes. */
export interface GraphSelectChange {
  type: string;
  id?: string;
  selected?: boolean;
}

/**
 * Fold a React Flow NodeChange batch into application selection.
 * Only select-type changes matter; positions/dimensions are static by
 * design and intentionally ignored. Later changes win; a select:false
 * clears only the node it targets (mirroring React Flow semantics).
 * Returns the resolved node (callers compare with current and skip
 * `onSelect` on equality, so echoes never loop).
 */
export function applyNodeSelectChanges(
  changes: ReadonlyArray<GraphSelectChange>,
  current: string | null
): string | null {
  let next = current;
  for (const c of changes) {
    if (c.type !== "select" || typeof c.id !== "string") continue;
    if (c.selected) next = c.id;
    else if (next === c.id) next = null;
  }
  return next;
}

/**
 * Resolve the active finding for the currently selected graph node.
 * Returns the finding id only when it exists AND belongs to the selected
 * node; otherwise null (stale/unrelated associations are cleared).
 */
export function findingForNode(
  findingId: string | null,
  selectedNode: string | null
): string | null {
  if (!findingId || !selectedNode) return null;
  const f = FINDINGS.find((x) => x.id === findingId);
  if (!f) return null;
  return f.nodeId === selectedNode ? f.id : null;
}

export function useDashboardState() {
  const [tab, setTab] = useState<"graph" | "modules" | "deps">("graph");
  const [filter, setFilter] = useState<"all" | "security" | "quality">("all");
  const [findingId, setFindingId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [status, setStatus] = useState<"ready" | "loading" | "error" | "empty">("ready");
  return { tab, setTab, filter, setFilter, findingId, setFindingId, drawerOpen, setDrawerOpen, selectedNode, setSelectedNode, status, setStatus };
}
