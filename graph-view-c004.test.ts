import { describe, expect, it } from 'vitest';
import { buildDemoSnapshot, fixtureContents } from '@/lib/demo-fixture';
import { buildAstGraph } from '@/lib/ast-graph';
import { presentGraph } from '@/lib/graph-presentation';
import { focusedGraph, graphAliases } from '@/lib/graph-view';
const contents = fixtureContents();
const raw = buildAstGraph(buildDemoSnapshot(contents), new Map(Object.entries(contents)));
const graph = presentGraph(raw).graph;
describe('C004 readable graph preserves the verified graph', () => {
  it('assigns 46 unique safe labels independently of node order, without mutating source or identities', () => {
    const before = JSON.stringify(raw), opaque = JSON.stringify(graph);
    const aliases = graphAliases(graph);
    const reordered = graphAliases({ ...graph, nodes: [...graph.nodes].reverse() });
    const modules = graph.nodes.filter(n => n.kind === 'module');
    expect(modules).toHaveLength(46);
    expect(new Set(modules.map(n => aliases.get(n.id))).size).toBe(46);
    for (const n of graph.nodes) {
      expect(aliases.get(n.id)).toMatch(/^(Module|Member) \d{2,}$/);
      expect(reordered.get(n.id)).toBe(aliases.get(n.id));
    }
    expect(JSON.stringify(raw)).toBe(before); expect(JSON.stringify(graph)).toBe(opaque);
  });
  it('keeps every module reachable and every paginated direct import exact, including direction and line', () => {
    for (const module of graph.nodes.filter(n => n.kind === 'module')) {
      const first = focusedGraph(graph, module.id);
      const neighbours = new Set<string>();
      const actual = new Set<object>();
      for (let page = 0; page < first.pages; page++) {
        const view = focusedGraph(graph, module.id, page);
        expect(view.focus?.id).toBe(module.id);
        expect(view.nodes.length).toBeLessThanOrEqual(7);
        expect(new Set(view.nodes.map(n => n.id)).size).toBe(view.nodes.length);
        for (const n of view.nodes) if (n.id !== module.id) neighbours.add(n.id);
        for (const e of view.edges) {
          expect(graph.edges).toContain(e); expect(e.kind).toBe('imports');
          expect(e.from === module.id || e.to === module.id).toBe(true);
          expect(view.positions.has(e.from)).toBe(true); expect(view.positions.has(e.to)).toBe(true);
          actual.add(e);
        }
      }
      expect(neighbours).toEqual(new Set(first.neighbours.map(n => n.id)));
      expect(actual).toEqual(new Set(graph.edges.filter(e => e.kind === 'imports' && (e.from === module.id || e.to === module.id))));
    }
  });
  it('handles empty graphs and clamps pages without inventing nodes', () => {
    expect(focusedGraph({ ...graph, nodes: [], edges: [] }, null).nodes).toEqual([]);
    const view = focusedGraph(graph, null, 999);
    expect(view.page).toBe(view.pages - 1);
  });
});
