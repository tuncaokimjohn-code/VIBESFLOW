import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { securityFixture } from './security-test-fixture';
import { buildAstGraph } from '@/lib/ast-graph';
import { analysisStatus, type GitHubAstSuccess } from '@/lib/github-ast-contract';
import { detectSecurityFindings } from '@/lib/security-findings';
import { sha256Text } from '@/lib/source-snapshot';
import { publicFindingEvidence } from '@/lib/public-evidence';
import { PublicFindingEvidence } from '@/components/PublicFindingEvidence';

async function fixture(source = 'const apiKey = "C014_SYNTHETIC_CREDENTIAL_NEVER_SHOW";\ndb.query("SELECT * FROM t WHERE id=" + input);', path = 'src/query.ts') {
  const contents = { [path]: source }, snapshot = securityFixture(contents);
  const graph = buildAstGraph(snapshot, new Map(Object.entries(contents)));
  const live: GitHubAstSuccess = { ok: true, synthetic: false, requested: { owner: 'example', repo: 'offline-fixture', ref: null }, snapshot, contents, graph: { ...graph, resolvedCommitIfGitHub: snapshot.resolvedCommitIfGitHub! }, shapeOk: true, evidenceVerified: true, undecoded: [], analysisStatus: analysisStatus(snapshot, graph), note: '' };
  const scan = await detectSecurityFindings(snapshot, new Map(Object.entries(contents)), sha256Text);
  if (!scan.ok || !scan.findings.length) throw Error('Fixture detection failed');
  return { live, f: scan.findings[0], findings: scan.findings };
}
const html = (e: ReturnType<typeof publicFindingEvidence>) => renderToStaticMarkup(<PublicFindingEvidence evidence={e} />);
describe('C014 independently verified source evidence projection', () => {
  it('renders individual real detector anchors, path, rule, exact line, provenance and immutable links', async () => {
    const { live, findings } = await fixture();
    for (const f of findings) {
      const e = publicFindingEvidence(live, f);
      expect(e.status).toBe('verified'); if (e.status !== 'verified') continue;
      expect(e.path).toBe(f.path); expect(e.line).toBe(f.line); expect(e.endLine).toBe(f.line);
      expect(e.quote).toBe(live.contents[f.path].slice(f.charOffset, f.endCharOffset));
      expect(e.href).toBe(`https://github.com/example/offline-fixture/blob/${f.commit}/src/query.ts#L${f.line}-L${f.line}`);
      const markup = html(e);
      for (const value of [f.ruleId, f.fileSha256, f.commit!, f.snapshotId, f.path, 'Potential', 'unconfirmed', 'Anchor verified']) expect(markup).toContain(value);
      expect(markup).not.toContain('C014_SYNTHETIC_CREDENTIAL_NEVER_SHOW');
      expect(markup).not.toContain('SELECT *');
      expect(markup).toContain('rel="noopener noreferrer"');
    }
  });
  it.each(['fileSha256', 'commit', 'snapshotId', 'quote', 'line', 'column', 'charOffset', 'endCharOffset', 'byteOffset', 'endByteOffset'] as const)('rejects mismatched %s without a quote or citation', async key => {
    const { live, f } = await fixture();
    const changed = { ...f, [key]: typeof f[key] === 'number' ? (f[key] as number) + 1 : 'forged' };
    const e = publicFindingEvidence(live, changed);
    expect(e.status).toBe('invalid'); expect(html(e)).not.toContain('<a'); expect(html(e)).not.toContain('<code');
  });
  it('rehashes actual bytes despite matching recorded finding/file SHA', async () => {
    const { live, f } = await fixture(); live.contents[f.path] = live.contents[f.path].replace('NEVER', 'ALTER');
    expect(publicFindingEvidence(live, f).status).toBe('invalid');
  });
  it.each(['missing file', 'missing content', 'unsupported rule', 'unsafe path', 'bad provenance', 'bad graph commit', 'unverified'])( '%s fails closed', async scenario => {
    const { live, f } = await fixture();
    if (scenario === 'missing file') live.snapshot.files = [];
    if (scenario === 'missing content') delete live.contents[f.path];
    if (scenario === 'unsupported rule') (f as any).ruleId = '<script>evil</script>';
    if (scenario === 'unsafe path') f.path = '../query.ts';
    if (scenario === 'bad provenance') live.snapshot.canonicalProvenance = 'javascript:alert(1)';
    if (scenario === 'bad graph commit') live.graph.resolvedCommitIfGitHub = 'b'.repeat(40);
    if (scenario === 'unverified') (live as any).evidenceVerified = false;
    const e = publicFindingEvidence(live, f);
    expect(e.status).not.toBe('verified'); expect(html(e)).not.toContain('<a'); expect(html(e)).not.toContain('<script>');
  });
  it('renders malicious path strings as escaped text and URL-encodes each path segment', async () => {
    const path = 'src/<img onerror=alert(1)>.ts';
    const { live, f } = await fixture(undefined, path);
    const e = publicFindingEvidence(live, f), markup = html(e);
    expect(e.status).toBe('verified');
    expect(markup).toContain('&lt;img onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img'); expect(markup).not.toContain('<script');
    if (e.status === 'verified') expect(e.href).toContain('%3Cimg%20onerror%3Dalert%281%29%3E.ts');
  });
  it('does not render malicious or credential-bearing detector context, excerpt, quote, title or recommendation', async () => {
    const { live, f } = await fixture();
    Object.assign(f, { excerpt: '<script>SECRET</script>', context: [{ text: '<img src=x onerror=alert(1)>SECRET' }], title: 'SECRET', recommendation: 'SECRET' });
    const markup = html(publicFindingEvidence(live, f));
    expect(markup).not.toContain('SECRET'); expect(markup).not.toContain('<img');
    f.quote = '<script>SECRET</script>';
    expect(publicFindingEvidence(live, f).status).toBe('invalid');
  });
  it('masks arbitrary identifier anchors and neighboring multiline/comment/template credentials', async () => {
    const source = '// C014_NEVER_RENDER_COMMENT\nconst apiKey = `C014_NEVER_RENDER_TEMPLATE\nCONTINUATION`;\nconst htmlCanarySecret = input;\nexport const V = <div dangerouslySetInnerHTML={{__html: htmlCanarySecret}}/>;';
    const { live, findings } = await fixture(source, 'src/view.tsx');
    for (const f of findings) {
      const e = publicFindingEvidence(live, f), markup = html(e);
      expect(e.status).toBe('verified'); expect(markup).not.toMatch(/C014_NEVER|CONTINUATION|htmlCanarySecret/);
      if (f.quote === 'htmlCanarySecret') { expect(markup).toContain('MASKED'); expect(markup).not.toContain('Exact source anchor quote:'); }
    }
  });
  it('withholds privacy-sensitive paths from both text and href', async () => {
    const { live, f } = await fixture(undefined, 'src/synthetic-CREDENTIAL12345.ts');
    const e = publicFindingEvidence(live, f), markup = html(e);
    expect(e.status).toBe('verified'); expect(markup).toContain('MASKED'); expect(markup).not.toContain(f.path); expect(markup).not.toContain('<a');
  });
  it('supports CRLF/unicode source coordinates and never cites an out-of-range line', async () => {
    const { live, f } = await fixture('// 中文 😀\r\n\r\nconst apiKey = "C014_SYNTHETIC_CREDENTIAL_NEVER_SHOW";');
    const e = publicFindingEvidence(live, f);
    expect(e).toMatchObject({ status: 'verified', line: 3, endLine: 3 });
    expect(publicFindingEvidence(live, { ...f, line: 999 }).status).toBe('invalid');
  });
});
