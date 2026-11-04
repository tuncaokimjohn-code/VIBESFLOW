/** Session-local presentation state only; never changes source or graph topology. */
import type { AstGraph } from '@/lib/ast-graph';
export type Point = { x: number; y: number };
export type Offsets = Record<string, Point>;
export function moveOffsets(offsets: Offsets, changes: readonly { type: string; id?: string; position?: Point }[], base: Map<string, Point>): Offsets {
  let next = offsets;
  for (const c of changes) {
    const p = c.id ? base.get(c.id) : undefined;
    if (c.type !== 'position' || !c.id || !p || !c.position || !Number.isFinite(c.position.x) || !Number.isFinite(c.position.y)) continue;
    const x = c.position.x - p.x, y = c.position.y - p.y;
    const previous = next[c.id];
    if (x === (previous?.x ?? 0) && y === (previous?.y ?? 0)) continue;
    if (next === offsets) next = { ...offsets };
    next[c.id] = { x, y };
  }
  return next;
}
export function movedPosition(base: Point, offset?: Point): Point {
  return { x: base.x + (offset?.x ?? 0), y: base.y + (offset?.y ?? 0) };
}
export function importConnections(graph: AstGraph, id: string | undefined) {
  const edges = graph.edges.filter(e => e.kind === 'imports');
  return { incoming: edges.filter(e => e.to === id), outgoing: edges.filter(e => e.from === id) };
}
export function connectionEmphasis(graph: AstGraph, module: string | null, edgeId: string | null) {
  const edge = graph.edges.find((_, i) => `demo-edge:${i}` === edgeId);
  const connected = edge ? [edge] : graph.edges.filter(e => e.kind === 'imports' && (e.from === module || e.to === module));
  return { active: !!edge || !!module, nodes: new Set([...(!edge && module ? [module] : []), ...connected.flatMap(e => [e.from, e.to])]), edges: new Set(connected) };
}
