import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createGitHubAstPost } from '@/lib/github-ast-server';
import { createLiveAnalysisController } from '@/lib/live-ast-request';
import { scanPublicAnalysis } from '@/lib/public-analysis';
import { PublicAnalysisResult, PublicRepositoryWorkspace } from '@/components/PublicRepositoryWorkspace';
import { PublicRepoIntake } from '@/components/PublicRepoIntake';
import { useLiveAst } from '@/components/LiveAstContext';
import { readFileSync } from 'node:fs';
import type { GitHubAstSuccess } from '@/lib/github-ast-contract';
import type { GitHubSourceProvider } from '@/lib/github-intake';
import { moduleNodeId } from '@/lib/ast-graph';
import { presentGraph } from '@/lib/graph-presentation';
vi.mock('@/components/DemoVibeShop', () => ({ DemoGraph: () => <div>Preserved C010 canvas</div> }));
vi.mock('@/components/LiveAstContext', () => ({ useLiveAst: vi.fn() }));
const SHA = 'a'.repeat(40);
const canary = 'never-render-this-private-source-value';
function provider(files: Record<string, string>): GitHubSourceProvider {
  return {
    resolveRef: async () => ({ sha: SHA }),
    listEntries: async function* () { for (const [path, content] of Object.entries(files)) yield { path, kind: 'file', size: new TextEncoder().encode(content).length }; },
    openFile: async function* (_o, _r, _sha, path) { yield new TextEncoder().encode(files[path]); },
  };
}
const sources = {
  'src/main.ts': 'import { helper } from "./util";\nexport const run = () => helper();\ndb.query("SELECT * FROM users WHERE id=" + input);',
  'src/util.ts': `export function helper() { return 42; }\nconst apiKey = "${canary}";`,
};
async function intake(files: Record<string, string> = sources) {
  const post = createGitHubAstPost(() => provider(files));
  const updates: Array<GitHubAstSuccess | null> = [];
  const states: string[] = [];
  const fetchFn = vi.fn(async (_url, options) => post(new Request('http://offline.test/api/github-ast', options)));
  const controller = createLiveAnalysisController({ fetchFn, setLive: x => updates.push(x), onState: x => states.push(x.status) });
  await controller.submit('https://github.com/arbitrary-owner/arbitrary-repo/tree/main');
  const live = updates.at(-1);
  if (!live) throw new Error(`No result: ${states.join(',')}`);
  return { live, controller, states, updates, fetchFn };
}

describe('C011 public intake vertical slice (in-memory transport; source never executed)', () => {
  it('connects arbitrary URL -> route -> pinned source -> validated graph -> independently anchored findings', async () => {
    const { live, states, fetchFn } = await intake();
    expect(states).toEqual(['idle', 'loading', 'success']);
    expect(fetchFn.mock.calls[0][0]).toBe('/api/github-ast');
    expect(JSON.parse(fetchFn.mock.calls[0][1]!.body as string)).toEqual({ url: 'https://github.com/arbitrary-owner/arbitrary-repo/tree/main' });
    expect(live.synthetic).toBe(false);
    expect(live.snapshot.resolvedCommitIfGitHub).toBe(SHA);
    expect(live.graph.edges.some(e => e.kind === 'imports')).toBe(true);
    const scan = await scanPublicAnalysis(live, new AbortController().signal);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.findings.map(f => f.ruleId).sort()).toEqual(['VF-SEC-001', 'VF-SEC-002']);
    for (const f of scan.findings) {
      expect(f.commit).toBe(SHA);
      expect(live.contents[f.path].slice(f.charOffset, f.endCharOffset)).toBe(f.quote);
      expect(presentGraph(live.graph).graph.nodes.some(n => n.id === presentGraph(live.graph).nodeId(moduleNodeId(f.path)))).toBe(true);
    }
    const markup = renderToStaticMarkup(<PublicAnalysisResult live={live} />);
    expect(markup).toContain(`/tree/${SHA}`);
    expect(markup).toContain(live.snapshot.manifestHash);
    expect(markup).not.toContain(canary);
    expect(markup).not.toContain('src/util.ts');
  });
  it('fails closed on changed same-length source and cancelled detection', async () => {
    const { live } = await intake();
    const changed = { ...live, contents: { ...live.contents, 'src/util.ts': live.contents['src/util.ts'].replace('42', '43') } };
    expect(await scanPublicAnalysis(changed, new AbortController().signal)).toMatchObject({ ok: false, code: 'EVIDENCE_INVALID' });
    const abort = new AbortController(); abort.abort();
    expect(await scanPublicAnalysis(live, abort.signal)).toMatchObject({ ok: false, code: 'CANCELLED' });
  });
  it('exposes empty/unsupported TS source and partial unresolved coverage without a clean-scan claim', async () => {
    const { live } = await intake({ 'README.md': '# Only documentation' });
    const markup = renderToStaticMarkup(<PublicAnalysisResult live={live} />);
    expect(markup).toContain('no eligible TS/TSX files');
    expect(markup).not.toContain('Preserved C010 canvas');
    const partial = await intake({ 'main.ts': 'import missing from "./not-collected"; export const x = missing;' });
    expect(partial.live.analysisStatus).toBe('partial');
    expect(renderToStaticMarkup(<PublicAnalysisResult live={partial.live} />)).toContain('AST coverage: partial');
  });
  it('drops prior result on an invalid locator and never calls transport for unsupported host', async () => {
    const x = await intake();
    await x.controller.submit('https://evil.example/o/r');
    expect(x.updates.at(-1)).toBe(null);
    expect(x.states.at(-1)).toBe('error');
    expect(x.fetchFn).toHaveBeenCalledTimes(1);
  });
  it('has no substituted data and keeps comparison/provider unavailable in every normal workspace state', () => {
    for (const realStatus of ['idle', 'loading', 'error'] as const) {
      vi.mocked(useLiveAst).mockReturnValue({ live: null, realStatus, setLive: vi.fn(), setRealStatus: vi.fn() });
      const html = renderToStaticMarkup(<PublicRepositoryWorkspace />);
      expect(html).toContain('Muse explanation: NOT READY');
      expect(html).toContain('Comparison: NOT READY');
      expect(html).not.toContain('Preserved C010 canvas');
      expect(html).toContain('/demo/vibeshop');
    }
    const html = renderToStaticMarkup(<PublicRepoIntake />);
    expect(html).toContain('Inspect repository');
    expect(html).toContain('Public GitHub repository URL');
    expect(html).not.toContain('example/sample-api');
  });
  it('normal route mounts real intake and result workspace; synthetic/fixture/provider panels are not mounted there', () => {
    expect(readFileSync('app/page.tsx', 'utf8')).toContain('<PublicRepositoryWorkspace />');
    expect(readFileSync('components/Shell.tsx', 'utf8')).toContain('path === "/" ? <PublicRepoIntake /> : <RepoIntake />');
    const src = readFileSync('components/PublicRepositoryWorkspace.tsx', 'utf8');
    expect(src).not.toMatch(/<ExplanationPanel|<SaferComparison|fixtureContents|buildDemoSnapshot|fetch\(/);
    expect(readFileSync('components/PublicRepoIntake.tsx', 'utf8')).not.toContain('/api/intake');
  });
});
