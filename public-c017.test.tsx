/** C017 deterministic component handlers + real bounded parser/scan. Not browser/DOM evidence. */
import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createGitHubAstPost } from '@/lib/github-ast-server';
import { createLiveAnalysisController, type LiveAnalysisState } from '@/lib/live-ast-request';
import type { GitHubAstSuccess } from '@/lib/github-ast-contract';
import { PublicRepoIntake } from '@/components/PublicRepoIntake';
import { PublicAnalysisResult, PublicRepositoryWorkspace } from '@/components/PublicRepositoryWorkspace';
import { Shell } from '@/components/Shell';
import { DemoGraph } from '@/components/DemoVibeShop';
import { PUBLIC_VIEWS, commitPublicNavigation, publicHref, publicNavigationKey, publicViewForHash } from '@/lib/public-navigation';
import { applyInspectorHash, getInspectorHashSnapshot } from '@/lib/inspector-hash';

const h = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => any)[], context: {} as any, hash: '' }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState(initial: any) { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial;
    return [h.slots[i], (v: any) => { h.slots[i] = typeof v === 'function' ? v(h.slots[i]) : v; }]; },
  useMemo(fn: () => any, deps: any[]) { const i = h.cursor++; const old = h.slots[i];
    if (!old || deps.some((d,j) => d !== old.deps[j])) h.slots[i] = { deps, value: fn() }; return h.slots[i].value; },
  useEffect(fn: () => any) { h.effects.push(fn); },
  useSyncExternalStore: () => h.hash,
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('next/link', () => ({ default: (p: any) => <a {...p} /> }));
vi.mock('@/components/LiveAstContext', () => ({ useLiveAst: () => h.context, LiveAstProvider: ({ children }: any) => children }));
vi.mock('@/components/DemoVibeShop', () => ({ DemoGraph: () => <div>Preserved graph</div> }));
function treeNodes(t: any): any[] { return Array.isArray(t) ? t.flatMap(treeNodes) : t?.props ? [t, ...treeNodes(t.props.children)] : []; }
function render(fn: () => any) { h.cursor = 0; h.effects = []; return fn(); }
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
let a: GitHubAstSuccess, b: GitHubAstSuccess;
async function synthetic(repo: string): Promise<GitHubAstSuccess> {
  const content = 'export const value = 1;'; // Newly authored offline source; never executed.
  const post = createGitHubAstPost(() => ({
    resolveRef: async () => ({ sha: (repo === 'alpha' ? 'a' : 'b').repeat(40) }),
    listEntries: async function* () { yield { path: 'src/main.ts', kind: 'file' as const, size: content.length }; },
    openFile: async function* () { yield new TextEncoder().encode(content); },
  }));
  return await (await post(new Request('http://offline/api/github-ast', { method: 'POST', body: JSON.stringify({ url: `github.com/acme/${repo}` }) }))).json();
}
beforeAll(async () => { a = await synthetic('alpha'); b = await synthetic('beta'); expect(a.ok && b.ok).toBe(true); });
beforeEach(() => {
  h.slots = []; h.cursor = 0; h.effects = []; h.hash = '';
  h.context = { live: null, realStatus: 'idle', setLive: vi.fn(), setRealStatus: vi.fn(), setAttempt: vi.fn() };
  vi.unstubAllGlobals();
});
function session(fetchFn: typeof fetch) {
  let live: GitHubAstSuccess | null = null;
  const states: LiveAnalysisState[] = [];
  const controller = createLiveAnalysisController({ retainOnFailure: true, fetchFn, setLive: x => { live = x; }, onState: x => states.push(x) });
  return { controller, states, live: () => live };
}
describe('C017 retained real analysis, retry and trust boundaries', () => {
  it('keeps alpha after beta rate limit, identifies both, then replaces on a validated beta retry', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(a)).mockResolvedValueOnce(response({ok:false,code:'RATE_LIMITED',message:'UNTRUSTED_CANARY'},429)).mockResolvedValueOnce(response(b));
    const s = session(fetchFn); await s.controller.submit('github.com/acme/alpha');
    await s.controller.submit('github.com/acme/beta');
    expect(s.live()?.requested.repo).toBe('alpha');
    expect(s.states.at(-1)).toMatchObject({status:'error',code:'RATE_LIMITED',requested:{repo:'beta'}});
    expect(s.states.at(-1)?.message).toContain('Retry later'); expect(JSON.stringify(s.states)).not.toContain('UNTRUSTED_CANARY');
    s.controller.edit(); expect(s.states.at(-1)?.status).toBe('error'); expect(s.live()?.requested.repo).toBe('alpha');
    await s.controller.submit('github.com/acme/beta'); expect(s.live()?.requested.repo).toBe('beta'); expect(s.states.at(-1)?.status).toBe('success');
    s.controller.clear(); expect(s.live()).toBe(null); expect(s.states.at(-1)).toMatchObject({status:'idle',requested:null});
  });
  it.each(['invalid-url','mismatched-repo','bad-hash','http-failure','invalid-json','unknown-error','network','bare-429'])('retains validated data and fails closed: %s', async mode => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(a));
    const s = session(fetchFn); await s.controller.submit('github.com/acme/alpha');
    if (mode === 'network') fetchFn.mockRejectedValueOnce(new Error('UNTRUSTED_CANARY'));
    else if (mode === 'invalid-json') fetchFn.mockResolvedValueOnce(new Response('UNTRUSTED_CANARY'));
    else if (mode === 'bare-429') fetchFn.mockResolvedValueOnce(new Response('UNTRUSTED_CANARY',{status:429}));
    else if (mode === 'bad-hash') fetchFn.mockResolvedValueOnce(response({...b,contents:{'src/main.ts':'export const value = 2;'}}));
    else if (mode === 'unknown-error') fetchFn.mockResolvedValueOnce(response({ok:false,code:'UNTRUSTED_CANARY',message:'UNTRUSTED_CANARY'}));
    else fetchFn.mockResolvedValueOnce(response(mode === 'mismatched-repo' ? a : b, mode === 'http-failure' ? 500 : 200));
    await s.controller.submit(mode === 'invalid-url' ? 'https://evil.test/a/b' : 'github.com/acme/beta');
    expect(s.live()?.requested.repo).toBe('alpha'); expect(s.states.at(-1)?.status).toBe('error');
    expect(JSON.stringify(s.states)).not.toContain('UNTRUSTED_CANARY');
    expect(fetchFn).toHaveBeenCalledTimes(mode === 'invalid-url' ? 1 : 2);
    if (mode === 'bare-429') expect(s.states.at(-1)?.code).toBe('RATE_LIMITED');
  });
  it.each(['cancel','edit','clear','dispose'] as const)('%s prevents a late response from replacing the retained result', async action => {
    let finish!: (r: Response) => void;
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(a)).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const s = session(fetchFn); await s.controller.submit('github.com/acme/alpha');
    const pending = s.controller.submit('github.com/acme/beta'); s.controller[action]();
    const count = s.states.length; finish(response(b)); await pending;
    expect(s.live()?.requested.repo ?? null).toBe(action === 'clear' ? null : 'alpha'); expect(s.states).toHaveLength(count);
  });
  it('a superseded slow request cannot overwrite a successful retry', async () => {
    let finish!: (r: Response) => void;
    const fetchFn = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(response(b));
    const s = session(fetchFn); const pending = s.controller.submit('github.com/acme/alpha');
    await s.controller.submit('github.com/acme/beta'); finish(response(a)); await pending;
    expect(s.live()?.requested.repo).toBe('beta'); expect(s.states.at(-1)?.requested?.repo).toBe('beta');
  });
});
describe('C017 navigation and public UI handler contracts', () => {
  it('all five destinations map distinctly; unknown hashes safely select Overview', () => {
    for (const v of PUBLIC_VIEWS) expect(publicViewForHash(publicHref(v).slice(1))).toBe(v);
    expect(publicViewForHash('#bogus')).toBe('overview');
    expect(publicNavigationKey(0,'ArrowUp')).toBe(4); expect(publicNavigationKey(4,'ArrowDown')).toBe(0);
    expect(publicNavigationKey(2,'Home')).toBe(0); expect(publicNavigationKey(2,'End')).toBe(4); expect(publicNavigationKey(2,'Tab')).toBe(null);
  });
  it('commits history once, preserves query, and reconciles selected state after back/forward', () => {
    const entries = ['/?scope=public']; let index = 0;
    const location = { pathname:'/',search:'?scope=public',hash:'' };
    const commit = vi.fn((_s,_t,url: string) => { entries.splice(++index); entries.push(url); location.hash = new URL(url,'http://offline').hash; });
    const win = { location,history:{pushState:commit} } as unknown as Pick<Window,'location'|'history'>;
    commitPublicNavigation('architecture',win); commitPublicNavigation('findings',win); commitPublicNavigation('findings',win);
    expect(commit).toHaveBeenCalledTimes(2); expect(entries.at(-1)).toBe('/?scope=public#public-findings');
    location.hash = new URL(entries[--index],'http://offline').hash; applyInspectorHash(location.hash);
    expect(publicViewForHash(getInspectorHashSnapshot())).toBe('architecture');
    location.hash = new URL(entries[++index],'http://offline').hash; applyInspectorHash(location.hash);
    expect(publicViewForHash(getInspectorHashSnapshot())).toBe('findings');
  });
  it('sidebar selects exactly one section and supports keyboard focus and mobile Escape', () => {
    for (const view of PUBLIC_VIEWS) {
      h.hash = publicHref(view).slice(1); const tree = render(() => Shell({children:null}));
      const links = treeNodes(tree).filter(n => n.props['data-public-nav']);
      expect(links).toHaveLength(5); expect(links.filter(n => n.props['aria-current'] === 'page')).toHaveLength(1);
      expect(links.find(n => n.props['aria-current'] === 'page').props['data-public-nav']).toBe(view);
      const focus = vi.fn(), preventDefault = vi.fn();
      links[0].props.onKeyDown({key:'End',preventDefault,currentTarget:{parentElement:{querySelectorAll:()=>[{}, {}, {}, {}, {focus}]}}});
      expect(focus).toHaveBeenCalledOnce(); expect(preventDefault).toHaveBeenCalledOnce();
    }
    let tree = render(() => Shell({children:null}));
    treeNodes(tree).find(n=>n.props['aria-controls']==='mobile-nav').props.onClick();
    tree = render(() => Shell({children:null})); expect(treeNodes(tree).find(n=>n.props.id==='mobile-nav')).toBeDefined();
    const focus = vi.fn(); vi.stubGlobal('document',{querySelector:()=>({focus})});
    treeNodes(tree).find(n=>n.props.id==='mobile-nav').props.onKeyDown({key:'Escape'});
    tree = render(() => Shell({children:null})); expect(treeNodes(tree).find(n=>n.props.id==='mobile-nav')).toBeUndefined(); expect(focus).toHaveBeenCalledOnce();
  });
  it('root Shell subscribes to committed hashes and popstate, including back to Overview; cleans up listeners', () => {
    const listeners = new Map<string, () => void>();
    const win = {location:{hash:'#public-findings'},addEventListener:vi.fn((n,fn)=>listeners.set(n,fn)),removeEventListener:vi.fn((n)=>listeners.delete(n))};
    vi.stubGlobal('window',win);
    render(()=>Shell({children:null})); const cleanups = h.effects.map(fn=>fn());
    expect(publicViewForHash(getInspectorHashSnapshot())).toBe('findings');
    win.location.hash='#public-architecture'; listeners.get('popstate')!(); expect(publicViewForHash(getInspectorHashSnapshot())).toBe('architecture');
    win.location.hash=''; listeners.get('popstate')!(); expect(publicViewForHash(getInspectorHashSnapshot())).toBe('overview');
    win.location.hash='#public-readiness'; listeners.get('hashchange')!(); expect(publicViewForHash(getInspectorHashSnapshot())).toBe('compare');
    cleanups.forEach(fn=>fn?.()); expect(listeners.size).toBe(0);
  });
  it('mobile link activation commits the target, focuses the view, and closes the menu; modified clicks remain native', () => {
    let tree=render(()=>Shell({children:null})); treeNodes(tree).find(n=>n.props['aria-controls']==='mobile-nav').props.onClick();
    tree=render(()=>Shell({children:null})); const mobile=treeNodes(tree).find(n=>n.props.id==='mobile-nav');
    const link=treeNodes(mobile).find(n=>n.props['data-public-nav']==='findings');
    const location={pathname:'/',search:'',hash:''}; const pushState=vi.fn((_a,_b,url)=>{location.hash=new URL(url,'http://offline').hash;});
    const focus=vi.fn(),preventDefault=vi.fn();
    vi.stubGlobal('window',{location,history:{pushState}}); vi.stubGlobal('document',{getElementById:()=>({focus})});
    link.props.onClick({button:0,ctrlKey:true,preventDefault}); expect(preventDefault).not.toHaveBeenCalled(); expect(pushState).not.toHaveBeenCalled();
    link.props.onClick({button:0,preventDefault}); expect(preventDefault).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledOnce(); expect(location.hash).toBe('#public-findings');
    tree=render(()=>Shell({children:null})); expect(treeNodes(tree).find(n=>n.props.id==='mobile-nav')).toBeUndefined();
  });
  it('shows distinct views and an unmistakable alpha retained / beta failed identity', () => {
    h.context = {...h.context,live:a,realStatus:'error',attempt:{status:'error',requested:b.requested,code:'RATE_LIMITED',message:'GitHub rate limit reached. Retry later.'}};
    for (const view of PUBLIC_VIEWS) {
      h.hash = publicHref(view).slice(1); const tree = render(() => PublicRepositoryWorkspace());
      const html = renderToStaticMarkup(tree);
      expect(html).toContain('STALE / RETAINED SNAPSHOT'); expect(html).toContain('Displayed source: acme/alpha'); expect(html).toContain('acme/beta'); expect(html).toContain('FAILED — no new analysis succeeded');
      expect(treeNodes(tree).find(n=>n.type===PublicAnalysisResult).props.view).toBe(view);
      if (view==='compare') { expect(html).toContain('No comparison has run'); expect(html).not.toContain('Potential SQL injection'); }
      if (view==='evaluation') expect(html).toContain('have not been measured');
    }
  });
  it('Overview only exposes the receipt; architecture and findings expose the appropriate panels while keeping the graph mounted', () => {
    for (const view of PUBLIC_VIEWS) {
      h.slots = []; const tree = render(() => PublicAnalysisResult({live:a,view}));
      const sections = treeNodes(tree).filter(n=>n.type==='section');
      expect(sections.find(n=>n.props['aria-label']==='Immutable source receipt').props.hidden).toBe(view!=='overview');
      expect(sections.find(n=>n.props.id==='public-architecture').props.hidden).toBe(view!=='architecture');
      expect(sections.find(n=>n.props.id==='public-findings').props.hidden).toBe(view!=='architecture'&&view!=='findings');
      expect(treeNodes(tree).find(n=>n.type===DemoGraph)).toBeDefined();
    }
  });
  it('header URL edit retains snapshot; inspect failure is specific; explicit clear removes snapshot and input', async () => {
    h.context = {...h.context,live:a};
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response({ok:false,code:'RATE_LIMITED',message:'unsafe-provider-text'},429)); vi.stubGlobal('fetch',fetchFn);
    let tree = render(() => PublicRepoIntake());
    treeNodes(tree).find(n=>n.type==='input').props.onChange({target:{value:'github.com/acme/beta'}});
    expect(h.context.setLive).not.toHaveBeenCalled(); expect(fetchFn).not.toHaveBeenCalled();
    tree = render(() => PublicRepoIntake()); treeNodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault:vi.fn()});
    await vi.waitFor(()=>expect(h.context.setAttempt).toHaveBeenLastCalledWith(expect.objectContaining({status:'error',code:'RATE_LIMITED'})));
    tree = render(() => PublicRepoIntake()); const html=renderToStaticMarkup(tree); expect(html).toContain('RATE_LIMITED'); expect(html).toContain('Retry later'); expect(html).not.toContain('unsafe-provider-text');
    treeNodes(tree).find(n=>n.type==='button'&&n.props.children==='Clear / new analysis').props.onClick();
    expect(h.context.setLive).toHaveBeenLastCalledWith(null);
    tree = render(() => PublicRepoIntake()); expect(treeNodes(tree).find(n=>n.type==='input').props.value).toBe('');
  });
});
