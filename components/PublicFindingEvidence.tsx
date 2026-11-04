import type { PublicEvidence } from "@/lib/public-evidence";

export function PublicFindingEvidence({ evidence }: { evidence: PublicEvidence }) {
  if (evidence.status !== "verified") return <p role="status">Evidence {evidence.status}: {evidence.message}</p>;
  return <>
    <h3 className="font-semibold">Validated finding evidence</h3>
    <p>{evidence.title} · {evidence.rule}</p>
    <p className="break-all">{evidence.path ?? "[MASKED — privacy-sensitive source path]"} · line {evidence.line}{evidence.endLine !== evidence.line ? `–${evidence.endLine}` : ""} · column {evidence.column}</p>
    <p>Potential finding · medium confidence · static heuristic; exploitability and input trust are unconfirmed.</p>
    <p>Anchor verified against returned source bytes, line/column, quote, SHA-256 and pinned commit.</p>
    <p className="mt-2">{evidence.quoteStatus === "exact" ? "Exact source anchor quote:" : "Source anchor: masked for privacy (not an exact displayed quote)."}</p>
    <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded border p-3"><code>{evidence.quote}</code></pre>
    <p className="mt-2">Surrounding excerpts, literals, comments and arbitrary identifiers are withheld. Only allowlisted anchor tokens are displayed; masking is not universal secret detection.</p>
    <p className="break-all">File SHA-256: {evidence.sha256}</p>
    <p className="break-all">Commit SHA: {evidence.commit}</p>
    <p className="break-all">Snapshot: {evidence.snapshotId}</p>
    <p>Provenance: validated public GitHub snapshot. Source remains untrusted text and is never executed.</p>
    {evidence.href ? <a className="mt-2 inline-block underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4" href={evidence.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open verified source lines on GitHub (new tab)</a> : <p>Source link withheld because the path may expose a credential.</p>}
  </>;
}
