import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { buildAstGraph } from "@/lib/ast-graph";
import { presentGraph, graphToken } from "@/lib/graph-presentation";
import { AstGraph as GraphUI, UnsupportedImports } from "@/components/AstGraph";
const state = vi.hoisted(() => ({ live: null as any, selected: null as string | null, calls: 0 }));
vi.mock("@/components/LiveAstContext", () => ({ useLiveAst: () => ({ live: state.live, realStatus: "done" }) }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => actual.useState(state.calls++ === 0 ? state.selected : initial) };
});
// SSR canvas adapter renders EVERY passed node with its production component,
// edges and accessible IDs. Full GraphUI/inspector render; no browser claim.
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ nodes, edges, nodeTypes, children }: any) => <div>
    {nodes.map((n: any) => <div key={n.id} data-id={n.id} aria-label={n.ariaLabel}>
      {React.createElement(nodeTypes[n.type], { data: n.data })}</div>)}
    {edges.map((e: any) => <div key={e.id} data-source={e.source} data-target={e.target} aria-label={e.ariaLabel}>{e.label}</div>)}{children}</div>,
  Handle: (p: any) => <span aria-label={p['aria-label']} />,
  Background: () => null, MiniMap: () => null, Controls: () => null,
  Position: { Top: "top", Bottom: "bottom" }, MarkerType: { ArrowClosed: "arrow" },
}));
const payloads = ['https://u:C006-password@host', 'https%3A%2F%2Fu%3AC006-encoded%40host',
  'aHR0cHM6Ly91OkMwMDYtYmFzZTY0QGhvc3Q=', 'C006-first\nC006-second', 'C006-user\u2028C006-pass',
  'C006_user_C006_password', 'normalHarmlessName', '<img src=x onerror=C006_markup>', 'C006-\u0000-control'];
function fixture() {
  const path = 'src/C006-path-credential.ts';
  const src = `const x = 1;\n${payloads.map(p => `export { x as ${JSON.stringify(p)} };`).join('\n')}\nimport "https://u:C006-import-pass@host";`;
  const snapshot = { snapshotId: 'C006-snapshot-secret', sourceKind: 'synthetic' as const,
    canonicalProvenance: 'C006-provenance-secret', resolvedCommitIfGitHub: null,
    files: [{ path, language: 'ts' as const, bytes: Buffer.byteLength(src), sha256: createHash('sha256').update(src).digest('hex'), lineCount: src.split('\n').length }],
    skipped: [], coverage: { collected: 1, skippedCount: 0 } };
  const other = 'import { normalHarmlessName } from "./C006-path-credential"; export const harmless = normalHarmlessName;';
  snapshot.files.push({ path: 'src/other.ts', language: 'ts', bytes: Buffer.byteLength(other), sha256: createHash('sha256').update(other).digest('hex'), lineCount: 1 });
  const graph = buildAstGraph(snapshot, new Map([[path, src], ['src/other.ts', other]]));
  state.live = { graph, snapshot, contents: { [path]: src }, evidenceVerified: true, shapeOk: true,
    requested: { owner: 'C006-owner-secret', repo: 'C006-repo-secret' }, analysisStatus: 'complete' };
  return graph;
}
function markup(selected: string | null) {
  state.calls = 0; state.selected = selected;
  return renderToStaticMarkup(<GraphUI />);
}
describe('C006 fail-closed graph presentation', () => {
  it('renders full canvas, module list and EVERY member inspector without original labels or credentials', () => {
    const original = fixture();
    expect(original.nodes.filter(n => n.kind === 'member')).toHaveLength(payloads.length + 1);
    const before = JSON.stringify(original);
    const { graph } = presentGraph(original);
    const screens = [markup(null), ...graph.nodes.map(n => markup(n.id))];
    for (const html of screens) {
      for (const secret of [...payloads, 'C006-', 'C006_', 'C006-import-pass', 'src/C006']) expect(html).not.toContain(secret);
      expect(html).toContain('Module 01'); expect(html).toContain('Source relationship');
    }
    expect(screens[1]).toContain('Exported members');
    expect(screens[1]).toContain('Unsupported / external imports');
    expect(screens[1]).toContain('specifier withheld');
    for (const n of graph.nodes.filter(n => n.kind === 'member')) expect(markup(n.id)).toContain('Source excerpt withheld');
    expect(JSON.stringify(original)).toBe(before);
    expect(presentGraph(original).graph).toEqual(presentGraph(original).graph);
    expect(new Set(graph.nodes.map(n => n.id)).size).toBe(graph.nodes.length);
    const ids = new Set(graph.nodes.map(n => n.id));
    for (const e of graph.edges.filter(e => e.kind === 'references' || e.kind === 'imports')) {
      expect(ids.has(e.from)).toBe(true); expect(ids.has(e.to)).toBe(true);
    }
  });
  it('drops provenance, import/export details and unknown kinds; preserves distinct identities', () => {
    const graph = fixture(); graph.nodes[0].declKind = 'C006-kind-secret';
    graph.nodes[0].label = 'C006-label-secret'; graph.nodes[0].namedExports = payloads;
    graph.nodes[0].defaultMember = 'C006-default-secret';
    graph.unsupportedForms.push({ module: 'C006-form-secret', line: 1, form: 'C006-form-value' });
    graph.edges[0].kind = 'C006-edge-kind' as any; graph.edges[0].line = NaN;
    const output = JSON.stringify(presentGraph(graph).graph);
    for (const value of ['C006', 'https', 'provenance', 'namedExports']) expect(output).not.toContain(value);
    expect(graphToken('Member', '\ud800')).not.toBe(graphToken('Member', '\ud801'));
    const html = renderToStaticMarkup(<UnsupportedImports edges={[{ kind: 'C006-kind-secret', line: NaN, specifier: payloads[0] }]} mod={payloads[1]} />);
    expect(html).not.toContain('C006'); expect(html).toContain('unknown import #1 (line 1;');
  });
});
