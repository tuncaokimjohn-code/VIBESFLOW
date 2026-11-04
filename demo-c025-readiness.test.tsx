/** Offline component/callback contracts. No browser geometry or pointer claim. */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import { ReactFlow } from '@xyflow/react';
import { DemoVibeShop, DemoGraph, DemoFindingsList, DemoFindingInspector } from '@/components/DemoVibeShop';
import { Shell } from '@/components/Shell';
import { measuredFitOptions } from '@/components/MeasuredGraphCanvas';
import { buildDemoSnapshot, fixtureContents } from '@/lib/demo-fixture';
import { buildAstGraph, moduleNodeId } from '@/lib/ast-graph';
import { presentGraph } from '@/lib/graph-presentation';
import { graphAliases } from '@/lib/graph-view';
import { detectSecurityFindings } from '@/lib/security-findings';

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as any[], effects: [] as (() => unknown)[], path: '/demo/vibeshop', hash: '' }));
vi.mock('react', async original => {
  const real = await original<typeof import('react')>();
  const same = (a: unknown[] | undefined, b: unknown[]) => !!a && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return { ...real,
    useState: (initial: any) => {
      const i = hooks.cursor++;
      if (!hooks.slots[i]) hooks.slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks.slots[i].value, (v: any) => { hooks.slots[i].value = typeof v === 'function' ? v(hooks.slots[i].value) : v; }];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = hooks.cursor++;
      if (!same(hooks.slots[i]?.deps, deps)) hooks.slots[i] = { value: fn(), deps };
      return hooks.slots[i].value;
    },
    useEffect: (fn: () => unknown, deps: unknown[]) => {
      const i = hooks.cursor++;
      if (!same(hooks.slots[i]?.deps, deps)) { hooks.slots[i] = { deps }; hooks.effects.push(fn); }
    },
    useSyncExternalStore: () => hooks.hash,
  };
});
vi.mock('next/navigation', () => ({ usePathname: () => hooks.path }));
vi.mock('next/link', () => ({ default: ({ prefetch: _prefetch, ...props }: any) => <a {...props} /> }));
vi.mock('@/components/LiveAstContext', () => ({ LiveAstProvider: ({ children }: any) => children }));
vi.mock('@/components/PublicRepoIntake', () => ({ PublicRepoIntake: () => <p>PUBLIC_INTAKE_CONTROL</p> }));
vi.mock('@/components/RepoIntake', () => ({ RepoIntake: () => <p>PREVIEW_INTAKE_CONTROL</p> }));
vi.mock('@xyflow/react', () => ({
  ReactFlow: () => null, Background: () => null, Handle: () => null,
  Position: { Left: 'left', Right: 'right' }, MarkerType: { ArrowClosed: 'arrow' },
}));
function elements(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return tree?.props ? [tree, ...elements(tree.props.children)] : [];
}
function get(tree: any, predicate: (n: any) => boolean) {
  const n = elements(tree).find(predicate); expect(n).toBeDefined(); return n;
}
const contents = fixtureContents(), snapshot = buildDemoSnapshot(contents);
const raw = buildAstGraph(snapshot, new Map(Object.entries(contents)));
const presentation = presentGraph(raw), graph = presentation.graph, aliases = graphAliases(graph);
const result = await detectSecurityFindings(snapshot, new Map(Object.entries(contents)), async text => createHash('sha256').update(text).digest('hex'));
if (!result.ok) throw Error('Offline fixture detection failed');
const findings = result.findings;
const renderDemo = () => { hooks.cursor = 0; hooks.effects = []; return DemoVibeShop(); };
const renderGraph = (selected: string | null = null) => { hooks.cursor = 0; return DemoGraph({ graph, selected, onSelect: vi.fn() }); };
const flowOf = (tree: any) => get(tree, n => n.type === ReactFlow).props;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.path = '/demo/vibeshop'; hooks.hash = '';
  vi.unstubAllGlobals();
  fetchSpy = vi.fn(() => { throw Error('No network allowed'); });
  vi.stubGlobal('fetch', fetchSpy);
});

describe('C025 honest offline entry and navigation', () => {
  it('separates the demo header and sidebar from both public and preview intake', () => {
    const html = renderToStaticMarkup(<Shell><p>Demo body</p></Shell>);
    expect(html).toContain('Offline fixture · no GitHub fetch');
    expect(html).toContain('href="/"');
    for (const id of ['demo-overview', 'demo-graph', 'demo-findings', 'demo-comparison']) expect(html).toContain(`href="#${id}"`);
    expect(html).not.toContain('PUBLIC_INTAKE_CONTROL');
    expect(html).not.toContain('PREVIEW_INTAKE_CONTROL');
    expect(html).toContain('Offline demo scope');
    expect(html).not.toContain('Example exclusions');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  for (const [path, control] of [['/', 'PUBLIC_INTAKE_CONTROL'], ['/analysis/preview', 'PREVIEW_INTAKE_CONTROL']]) {
    it(`preserves the existing intake on ${path}`, () => {
      hooks.path = path;
      expect(renderToStaticMarkup(<Shell><p>Body</p></Shell>)).toContain(control);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
  it('offers a comparison empty state and expands the native disclosure without a request', () => {
    let tree = renderDemo();
    expect(get(tree, n => n.props.id === 'demo-comparison').props.tabIndex).toBe(-1);
    const detail = { tagName: 'DETAILS', open: false };
    vi.stubGlobal('document', { getElementById: vi.fn(() => detail) });
    get(tree, n => n.type === 'a' && n.props.href === '#demo-comparison').props.onClick();
    expect(detail.open).toBe(true);
    tree = renderDemo();
    expect(get(tree, n => n.type === DemoGraph).props.selected).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('maps an actual fixture finding to its opaque graph node and retains focus behavior', async () => {
    let tree = renderDemo();
    for (const effect of hooks.effects) effect();
    await vi.waitFor(() => expect(hooks.slots.some(s => s?.value?.status === 'done')).toBe(true));
    tree = renderDemo();
    const list = get(tree, n => n.type === DemoFindingsList);
    const finding = list.props.findings[0];
    list.props.onSelect(finding);
    tree = renderDemo();
    const focus = vi.fn();
    vi.stubGlobal('document', { getElementById: vi.fn(() => ({ focus })) });
    for (const effect of hooks.effects) effect();
    expect(get(tree, n => n.type === DemoGraph).props.selected).toBe(presentation.nodeId(moduleNodeId(finding.path)));
    expect(get(tree, n => n.type === DemoFindingInspector).props.finding).toBe(finding);
    expect(focus).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('C025 graph readability without changing topology', () => {
  it('collapses secondary lists and avoids overlapping labels on every focused import', () => {
    const tree = renderGraph();
    const flow = flowOf(tree);
    expect(flow.edges.length).toBeGreaterThan(1);
    expect(flow.edges.every((e: any) => e.label === undefined)).toBe(true);
    for (const name of ['vf-module-browser', 'vf-demo-disclosure']) {
      const disclosure = get(tree, n => n.type === 'details' && n.props.className?.includes(name));
      expect(disclosure.props.open).toBeUndefined();
    }
    expect(flow.nodes.filter((n: any) => n.data.focused)).toHaveLength(1);
    expect(flow.nodes.map((n: any) => n.id).every((id: string) => graph.nodes.some(n => n.id === id))).toBe(true);
  });
  it('shows exactly one selected edge label and its actual AST import line without a source path', () => {
    const before = JSON.stringify(graph);
    let tree = renderGraph(), flow = flowOf(tree);
    const edge = flow.edges[0];
    flow.onEdgeClick({}, edge);
    tree = renderGraph(); flow = flowOf(tree);
    const original = graph.edges[Number(edge.id.split(':')[1])];
    expect(flow.edges.find((e: any) => e.id === edge.id).label).toBe('imports');
    expect(edge.ariaLabel).toBe(`${aliases.get(original.from)} imports ${aliases.get(original.to)}`);
    expect(flow.edges.filter((e: any) => e.label !== undefined).map((e: any) => e.id)).toEqual([edge.id]);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain(`import statement at ${aliases.get(original.from)}:${original.line} (path withheld)`);
    for (const path of Object.keys(contents)) expect(html).not.toContain(path);
    expect(JSON.stringify(graph)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('fits the focused desktop column while retaining readable phone and overview defaults', () => {
    const nodes = [{ id: 'first' }, { id: 'selected', selected: true }];
    for (const width of [500, 560, 640]) expect(measuredFitOptions(width, nodes, true)).toEqual({ padding: .12, maxZoom: 1 });
    for (const width of [320, 390]) expect(measuredFitOptions(width, nodes, true)).toEqual({ nodes: [{ id: 'selected' }], padding: .12, minZoom: .8, maxZoom: 1 });
    expect(measuredFitOptions(640, nodes)).toHaveProperty('nodes');
    expect(measuredFitOptions(1280, nodes)).not.toHaveProperty('nodes');
  });
  it('keeps the fullscreen overview, original import endpoints, drag and zoom controls', () => {
    let tree = renderGraph();
    get(tree, n => n.props.id === 'demo-fullscreen-open').props.onClick();
    tree = renderGraph(); const flow = flowOf(tree);
    expect(flow.nodes).toHaveLength(46);
    expect(flow.edges.map((e: any) => [e.source, e.target])).toEqual(graph.edges.filter(e => e.kind === 'imports').map(e => [e.from, e.to]));
    expect(flow.nodesDraggable).toBe(true); expect(flow.zoomOnPinch).toBe(true);
    expect(flow.selectNodesOnDrag).toBe(false);
    const zoomIn = vi.fn(), zoomOut = vi.fn(), fitView = vi.fn();
    flow.onInit({ zoomIn, zoomOut, fitView }); tree = renderGraph();
    for (const label of ['Zoom In', 'Zoom Out', 'Fit All']) get(tree, n => n.type === 'button' && n.props.children === label).props.onClick();
    expect(zoomIn).toHaveBeenCalledOnce(); expect(zoomOut).toHaveBeenCalledOnce(); expect(fitView).toHaveBeenCalledOnce();
  });
});

describe('C025 evidence privacy and inert Muse', () => {
  for (const rule of ['VF-SEC-001', 'VF-SEC-002', 'VF-SEC-003']) {
    it(`keeps ${rule} geometry/hash metadata and example-only comparison without raw source or requests`, () => {
      const finding = findings.find(f => f.ruleId === rule)!; expect(finding).toBeDefined();
      const html = renderToStaticMarkup(<DemoFindingInspector finding={finding} snapshotId={snapshot.snapshotId} contents={contents} moduleLabel="Module 01" />);
      expect(html).toContain(`line ${finding.line}:${finding.column}`);
      expect(html).toContain(finding.fileSha256);
      expect(html).toContain('href="#demo-graph"');
      expect(html).toContain('not a clickable file:line citation');
      expect(html).toContain('Illustrative synthetic example — NOT from the selected repository');
      expect(html).toContain('Example only: no validated finding');
      expect(html).toContain('Muse NOT CONFIGURED');
      expect(html).not.toMatch(/Request explanation|type="checkbox"|https:\/\/github\.com/);
      for (const path of Object.keys(contents)) expect(html).not.toContain(path);
      expect(html).not.toContain(finding.id);
      expect(html).not.toContain(finding.excerpt);
      if (finding.quote.length >= 16) expect(html).not.toContain(finding.quote);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
});
