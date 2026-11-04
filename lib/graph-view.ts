/** Presentation only. Aliases follow opaque-ID order within a snapshot. */
import { moduleNodeId, type AstGraph } from '@/lib/ast-graph';
export function graphAliases(graph: AstGraph): Map<string, string> {
  const labels = new Map<string, string>();
  let moduleIndex = 0, memberIndex = 0;
  for (const n of [...graph.nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const label = n.kind === 'module' ? `Module ${String(++moduleIndex).padStart(2, '0')}` : `Member ${String(++memberIndex).padStart(2, '0')}`;
    labels.set(n.id, label); labels.set(n.label, label);
    if (n.kind === 'module') labels.set(n.module, label);
  }
  return labels;
}
/** Six direct neighbours per page. Every arrow is an original import edge. */
export function focusedGraph(graph: AstGraph, selected: string | null, page = 0) {
  const modules = graph.nodes.filter(n => n.kind === 'module').sort((a, b) => a.id < b.id ? -1 : 1);
  const imports = graph.edges.filter(e => e.kind === 'imports');
  const selectedNode = graph.nodes.find(n => n.id === selected);
  const degree = (id: string) => imports.filter(e => e.from === id || e.to === id).length;
  const focus = selectedNode ? modules.find(n => n.id === moduleNodeId(selectedNode.module)) : [...modules].sort((a, b) => degree(b.id) - degree(a.id) || (a.id < b.id ? -1 : 1))[0];
  const adjacent = new Set(imports.filter(e => e.from === focus?.id || e.to === focus?.id).flatMap(e => [e.from, e.to]));
  const neighbours = modules.filter(n => n.id !== focus?.id && adjacent.has(n.id));
  const incoming = neighbours.filter(n => imports.some(e => e.from === n.id && e.to === focus?.id));
  const outgoing = neighbours.filter(n => !incoming.includes(n));
  const pages = Math.max(1, Math.ceil(incoming.length / 3), Math.ceil(outgoing.length / 3));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const left = incoming.slice(safePage * 3, (safePage + 1) * 3);
  const right = outgoing.slice(safePage * 3, (safePage + 1) * 3);
  const visible = [...left, ...right];
  const positions = new Map<string, { x: number; y: number }>();
  if (focus) positions.set(focus.id, { x: 220, y: 130 });
  left.forEach((n, i) => positions.set(n.id, { x: 0, y: i * 130 }));
  right.forEach((n, i) => positions.set(n.id, { x: 440, y: i * 130 }));
  const nodes = focus ? [focus, ...visible] : [];
  const ids = new Set(nodes.map(n => n.id));
  return { nodes, focus, modules, neighbours, pages, page: safePage, positions,
    edges: imports.filter(e => ids.has(e.from) && ids.has(e.to) && (e.from === focus?.id || e.to === focus?.id)) };
}

/** Full module overview. Layout is presentational; relationships remain exact imports. */
export function overviewGraph(graph: AstGraph) {
  const modules = graph.nodes.filter(n => n.kind === 'module').sort((a, b) => a.id < b.id ? -1 : 1);
  const ids = new Set(modules.map(n => n.id));
  const positions = new Map(modules.map((n, i) => [n.id, { x: (i % 8) * 210, y: Math.floor(i / 8) * 110 }]));
  return { nodes: modules, modules, positions,
    edges: graph.edges.filter(e => e.kind === 'imports' && ids.has(e.from) && ids.has(e.to)) };
}
