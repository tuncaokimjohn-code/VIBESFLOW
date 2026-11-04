/** Offline layout/markup contracts only; these do not measure browser geometry. */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import postcss, { type AtRule, type Document, type Root, type Rule } from 'postcss';
import { DemoVibeShop } from '@/components/DemoVibeShop';

vi.mock('@xyflow/react', () => ({
  ReactFlow: () => null, Background: () => null, Handle: () => null,
  Position: { Left: 'left', Right: 'right' }, MarkerType: { ArrowClosed: 'arrow' },
}));

const css = postcss.parse(readFileSync('app/globals.css', 'utf8'));

// Resolve only the exact selectors under test, including their responsive
// overrides. This is a CSS contract, not a browser cascade/layout simulator.
function styleAt(selector: string, width: number) {
  const style: Record<string, string> = {};
  css.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    for (let parent: AtRule | Document | Root | Rule | undefined = rule.parent; parent; parent = parent.parent) {
      if (parent.type !== 'atrule' || parent.name !== 'media') continue;
      const query = /^\((min|max)-width:\s*(\d+)px\)$/.exec(parent.params);
      if (!query) throw new Error(`Unsupported contract media query: ${parent.params}`);
      if (query[1] === 'min' ? width < Number(query[2]) : width > Number(query[2])) return;
    }
    rule.walkDecls(decl => { style[decl.prop] = decl.value; });
  });
  return style;
}

describe('C026 demo section navigation overlap regression (browser QA separate)', () => {
  it.each([1324, 1440, 1280, 1024, 390, 320])('keeps navigation in flow with wrapping touch targets at %ipx', width => {
    const nav = styleAt('.vf-demo-section-nav', width);
    expect(nav.position).toBe('static');
    for (const prop of ['top', 'bottom', 'left', 'right', 'inset', 'z-index', 'transform']) {
      expect(nav[prop]).toBeUndefined();
    }
    expect(nav.display).toBe('flex');
    expect(nav['flex-wrap']).toBe('wrap');
    expect(styleAt('.vf-demo-section-nav a', width)['min-height']).toBe('44px');
    expect(styleAt('.vf-demo [id^="demo-"]', width)['scroll-margin-top']).toBe('16px');
  });

  it('renders three named native section links before the graph/findings workspace without a request', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<DemoVibeShop />);
      const nav = /<nav class="vf-demo-section-nav" aria-label="Demo sections">([\s\S]*?)<\/nav>/.exec(html);
      expect(nav).not.toBeNull();
      const links = [...nav![1].matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(([, href, label]) => [href, label]);
      expect(links).toEqual([
        ['#demo-graph', 'Architecture graph'],
        ['#demo-findings', 'Potential findings'],
        ['#demo-comparison', 'Safer comparison'],
      ]);
      expect(html.indexOf(nav![0]) + nav![0].length).toBeLessThanOrEqual(html.indexOf('<div class="vf-demo-workspace">'));
      for (const id of ['demo-graph', 'demo-findings', 'demo-comparison']) {
        expect(html).toContain(`id="${id}" tabindex="-1"`);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('retains a visible keyboard focus indicator on native navigation links', () => {
    const focus = styleAt(':focus-visible', 1324);
    expect(focus.outline).toBe('2px solid var(--vf-primary-cyan)');
    expect(focus['outline-offset']).toBe('2px');
  });
});
