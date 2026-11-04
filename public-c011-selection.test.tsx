/** Hook/state contract, not a browser/native-input or visual fidelity claim. */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PublicAnalysisResult } from '@/components/PublicRepositoryWorkspace';
import { scanPublicAnalysis } from '@/lib/public-analysis';
import { DemoGraph } from '@/components/DemoVibeShop';
import { createGitHubAstPost } from '@/lib/github-ast-server';
import { parseGitHubAstResponse } from '@/lib/github-ast-client';
import { detectSecurityFindings } from '@/lib/security-findings';
import { sha256Text } from '@/lib/intake-client';
import type { GitHubAstSuccess } from '@/lib/github-ast-contract';
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as any[], effects: [] as (() => any)[] }));
vi.mock('react', async original => {
  const real = await original<typeof import('react')>();
  return { ...real,
    useState: (initial: any) => {
      const i = hooks.cursor++;
      if (!hooks.slots[i]) hooks.slots[i] = { value: initial };
      return [hooks.slots[i].value, (value: any) => { hooks.slots[i].value = typeof value === 'function' ? value(hooks.slots[i].value) : value; }];
    },
    useMemo: (fn: () => any) => fn(),
    useEffect: (fn: () => any, deps: any[]) => {
      const i = hooks.cursor++;
      const old = hooks.slots[i]?.deps;
      if (!old || !old.every((v: any, j: number) => v === deps[j])) { hooks.effects.push(fn); hooks.slots[i] = { deps }; }
    },
  };
});
vi.mock('@/lib/public-analysis', () => ({ scanPublicAnalysis: vi.fn() }));
vi.mock('@/components/DemoVibeShop', () => ({ DemoGraph: () => <div>Canvas</div> }));
function nodes(t: any): any[] {
  if (Array.isArray(t)) return t.flatMap(nodes);
  if (!t || typeof t !== 'object' || !t.props) return [];
  return [t, ...nodes(t.props.children)];
}
function render(live: GitHubAstSuccess) { hooks.cursor = 0; return PublicAnalysisResult({ live }); }
let live: GitHubAstSuccess;
beforeEach(async () => {
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; vi.mocked(scanPublicAnalysis).mockReset();
  const source = 'export const x = 1;\nconst apiKey = "canary-do-not-render-secret";';
  const route = createGitHubAstPost(() => ({
    resolveRef: async () => ({ sha: 'b'.repeat(40) }),
    listEntries: async function* () { yield { path: 'canary-path.ts', size: source.length, kind: 'file' as const }; },
    openFile: async function* () { yield new TextEncoder().encode(source); },
  }));
  const response = await route(new Request('http://offline/api/github-ast', { method: 'POST', body: JSON.stringify({ url: 'https://github.com/acme/project' }) }));
  const result = await parseGitHubAstResponse(await response.json(), { owner: 'acme', repo: 'project', ref: null });
  if (!result.ok) throw new Error(result.message);
  live = result;
});
describe('C011 result lifecycle and selection contracts', () => {
  it('finding selection preserves focus target and C010 selection with C014 verified anchor evidence', async () => {
    const result = await detectSecurityFindings(live.snapshot, new Map(Object.entries(live.contents)), sha256Text);
    expect(result.ok).toBe(true);
    vi.mocked(scanPublicAnalysis).mockResolvedValue(result);
    render(live); hooks.effects.splice(0).forEach(fn => fn()); await Promise.resolve();
    let tree = render(live);
    const choose = nodes(tree).find(n => n.type === 'button' && n.props['aria-controls'] === 'public-evidence');
    expect(choose).toBeDefined(); choose.props.onClick();
    tree = render(live);
    const graph = nodes(tree).find(n => n.type === DemoGraph);
    expect(graph.props.selected).toBeTruthy();
    expect(graph.props.graph.nodes.some((n: any) => n.id === graph.props.selected)).toBe(true);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('Validated finding evidence');
    expect(html).toContain(live.snapshot.files[0].sha256);
    expect(html).toContain('Anchor verified');
    expect(html).not.toContain('canary-do-not-render-secret');
    expect(html).toContain('canary-path.ts');
    expect(html).toContain('Exact source anchor quote:');
    expect(html).toContain('apiKey');
    expect(choose.type).toBe('button');
    expect(choose.props.className).toContain('focus-visible:outline');
    expect(choose.props.tabIndex).not.toBe(-1);
    expect(choose.props['aria-controls']).toBe('public-evidence');
    expect(nodes(tree).find(n => n.type === 'button' && n.props['aria-pressed'] === true)).toBeDefined();
    graph.props.onSelect(null);
    expect(renderToStaticMarkup(render(live))).not.toContain('Validated finding evidence');
  });
  it('unmount abort prevents late scan publication; rejected scans cannot display clean results', async () => {
    let finish!: (value: any) => void;
    vi.mocked(scanPublicAnalysis).mockImplementation((_live, signal) => {
      expect(signal.aborted).toBe(false); return new Promise(resolve => { finish = resolve; });
    });
    render(live); const cleanup = hooks.effects.shift()!(); cleanup();
    expect(vi.mocked(scanPublicAnalysis).mock.calls[0][1].aborted).toBe(true);
    finish({ ok: true, findings: [], scanComplete: true, filesTotal: 1, filesAnalyzed: 1, malformedFiles: [], findingLimitReached: false });
    await Promise.resolve();
    expect(renderToStaticMarkup(render(live))).toContain('Scanning validated source');
    hooks.slots = []; hooks.effects = [];
    vi.mocked(scanPublicAnalysis).mockRejectedValue(new Error('untrusted error canary'));
    render(live); hooks.effects.shift()!(); await Promise.resolve(); await Promise.resolve();
    const html = renderToStaticMarkup(render(live));
    expect(html).toContain('Security scan unavailable');
    expect(html).not.toContain('untrusted error canary');
    expect(html).not.toContain('Supported-rule scan complete');
  });
});
