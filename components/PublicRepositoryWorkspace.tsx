"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useLiveAst } from "@/components/LiveAstContext";
import { DemoGraph } from "@/components/DemoVibeShop";
import { moduleNodeId } from "@/lib/ast-graph";
import { presentGraph } from "@/lib/graph-presentation";
import { graphAliases } from "@/lib/graph-view";
import type { GitHubAstSuccess } from "@/lib/github-ast-contract";
import type { DetectionResult } from "@/lib/security-findings";
import { PublicFindingEvidence } from "@/components/PublicFindingEvidence";
import { publicFindingEvidence } from "@/lib/public-evidence";
import { PublicMusePanel } from "@/components/PublicMusePanel";
import { bindingFor, evidenceId } from "@/lib/public-muse-contract";
import { scanPublicAnalysis } from "@/lib/public-analysis";
import { getInspectorHashServerSnapshot, getInspectorHashSnapshot, subscribeInspectorHashStore } from "@/lib/inspector-hash";
import { publicViewForHash, type PublicView } from "@/lib/public-navigation";

type Scan = { status: "running" } | { status: "done"; result: DetectionResult };

/** Keyed by accepted result identity: replacement always discards selections/scan. */
export function PublicAnalysisResult({ live, view = "all", museActive = true }: { live: GitHubAstSuccess; view?: PublicView | "all"; museActive?: boolean }) {
  const [scan, setScan] = useState<Scan>({ status: "running" });
  const [selected, setSelected] = useState<string | null>(null);
  const [findingIndex, setFindingIndex] = useState<number | null>(null);
  const presentation = useMemo(() => presentGraph(live.graph), [live]);
  const aliases = useMemo(() => graphAliases(presentation.graph), [presentation]);
  useEffect(() => {
    const controller = new AbortController();
    void scanPublicAnalysis(live, controller.signal).then(result => {
      if (!controller.signal.aborted) setScan({ status: "done", result });
    }).catch(() => {
      if (!controller.signal.aborted) setScan({ status: "done", result: { ok: false, code: "EVIDENCE_INVALID", message: "Scan unavailable." } });
    });
    return () => controller.abort();
  }, [live]);
  const result = scan.status === "done" && scan.result.ok ? scan.result : null;
  const finding = findingIndex === null ? null : result?.findings[findingIndex];
  const evidenceRows = useMemo(() => result?.findings.map(f => publicFindingEvidence(live, f)) ?? [], [live, result]);
  const activeEvidence = findingIndex === null ? null : evidenceRows[findingIndex];
  const museBinding = useMemo(() => {
    if (!museActive || !finding || activeEvidence?.status !== "verified") return null;
    try { return bindingFor(live.requested.owner, live.requested.repo, finding); } catch { return null; }
  }, [museActive, live, finding, activeEvidence]);
  const rawNode = live.graph.nodes.find(n => presentation.nodeId(n.id) === selected);
  const file = live.snapshot.files.find(f => f.path === (finding?.path ?? rawNode?.module));
  const moduleLabel = (path: string) => aliases.get(presentation.nodeId(moduleNodeId(path))) ?? "Source module";
  return <>
    <section hidden={view !== "all" && view !== "overview"} aria-label="Immutable source receipt" className="mb-4 rounded-lg border p-4" style={{ borderColor: "var(--vf-border)" }}>
      <h2 className="text-lg font-semibold">Validated public source snapshot</h2>
      <p>{live.requested.owner}/{live.requested.repo}</p>
      <p className="break-all font-mono text-xs">Commit SHA: {live.snapshot.resolvedCommitIfGitHub}</p>
      <p className="break-all text-xs">Manifest SHA-256: {live.snapshot.manifestHash}</p>
      <p>{live.snapshot.coverage.collected} TS/TSX file(s) · {live.snapshot.coverage.totalBytes} bytes · {live.snapshot.coverage.skippedCount} skipped</p>
      <p role="status">AST coverage: {live.analysisStatus}. {live.graph.unresolved.length} unresolved/external relationships; {live.graph.unsupportedModules.length} unsupported modules; {live.graph.unsupportedForms.length} unsupported forms.</p>
      <p className="text-sm">Only collected TS/TSX source is analyzed. Skipped files and unsupported forms may contain additional behavior. Source is parsed, never executed.</p>
      <a className="underline text-sm" href={`${live.snapshot.canonicalProvenance}/tree/${live.snapshot.resolvedCommitIfGitHub}`} target="_blank" rel="noopener noreferrer">Open immutable repository snapshot on GitHub</a>
      <details className="mt-2 text-xs"><summary>Excluded source reasons ({live.snapshot.skipped.length})</summary>
        <ul>{live.snapshot.skipped.map((s, i) => <li key={i}>Excluded item {i + 1}: {s.reason}</li>)}</ul>
      </details>
    </section>
    <div className={`min-w-0 gap-5 ${view === "all" || view === "architecture" ? "grid 2xl:grid-cols-[minmax(0,1.9fr)_minmax(340px,1fr)] 2xl:items-start" : ""}`}>
      <section hidden={view !== "all" && view !== "architecture"} id="public-architecture" aria-label="Public repository architecture" className="min-w-0 overflow-hidden rounded-xl border p-4 sm:p-5" style={{ borderColor: "var(--vf-border)", background: "var(--vf-panel-bg)" }}>
        <h2 className="mb-2 text-xl font-semibold">Architecture overview</h2>
        <p className="mb-3 text-sm">Explore modules in the canvas; use fullscreen to see the complete graph. The module browser and connection legend remain below the canvas.</p>
        {live.snapshot.files.length === 0 ? <p role="status">Unsupported or empty source: no eligible TS/TSX files were collected. No graph or security coverage is claimed.</p> :
          <DemoGraph graph={presentation.graph} selected={selected} onSelect={id => { setFindingIndex(null); setSelected(id); }} />}
      </section>
      <section hidden={view !== "all" && view !== "findings" && view !== "architecture"} id="public-findings" aria-label="Public source findings and evidence" className="min-w-0 overflow-hidden rounded-xl border p-4 sm:p-5" style={{ borderColor: "var(--vf-border)", background: "var(--vf-panel-bg)" }}>
        <h2 className="text-xl font-semibold">Evidence &amp; findings</h2>
        {view === "architecture" && <p className="text-sm">Select graph modules here, or open Findings to review potential findings and citations.</p>}
        <p className="mt-2 text-sm">Three supported rules: potential credential literals, SQL string construction, and dynamic HTML. Ownership/IDOR and admin authorization are NOT SUPPORTED. No confirmed vulnerabilities or precision/recall claim.</p>
        {scan.status === "running" && <p role="status">Scanning validated source…</p>}
        {scan.status === "done" && !scan.result.ok && <p role="alert">Security scan unavailable. No findings or clean result are claimed.</p>}
        {result && <>
          <p className="mt-3" role="status">{result.findings.length} potential finding(s); {result.filesAnalyzed}/{result.filesTotal} files analyzed. {result.scanComplete && live.analysisStatus === "complete" && result.filesTotal > 0 ? "Supported-rule scan complete." : "Partial or unavailable coverage; this is not a clean scan."}</p>
          {result.findingLimitReached && <p role="alert">Finding limit reached; additional findings may exist.</p>}
          {result.malformedFiles.length > 0 && <p role="alert">{result.malformedFiles.length} malformed file(s) excluded from detection.</p>}
          {result.filesTotal > 0 && result.findings.length === 0 && <p>No potential findings in analyzed files under the three supported rules. This is not a security guarantee.</p>}
          <ol className="mt-3 max-h-[320px] space-y-2 overflow-y-auto pr-2">{result.findings.map((f, i) => <li key={i}>
            <button type="button" className="max-w-full break-all text-left underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4" aria-pressed={findingIndex === i} aria-controls="public-evidence"
              onClick={() => { setFindingIndex(i); setSelected(presentation.nodeId(moduleNodeId(f.path))); }}>
              {evidenceRows[i]?.status === "verified" ? `${evidenceRows[i].rule} · ${evidenceRows[i].path ?? "[MASKED path]"}:${evidenceRows[i].line}:${evidenceRows[i].column} · potential` : `Finding ${i + 1} · evidence ${evidenceRows[i]?.status ?? "unavailable"}`}
            </button>
          </li>)}</ol>
        </>}
        <div id="public-evidence" role="region" aria-label="Selected source evidence" className="mt-4 min-w-0 break-words rounded-lg border p-3 text-sm" style={{ borderColor: "var(--vf-border)" }} aria-live="polite">
          {activeEvidence ? <PublicFindingEvidence evidence={activeEvidence} /> : file ? <>
            <h3 className="font-semibold">Validated module evidence</h3>
            <p>{moduleLabel(file.path)} · line {rawNode?.line ?? 1}</p>
            <p className="break-all">File SHA-256: {file.sha256}</p>
            <p>Module source is withheld. Select a potential finding for independently verified source evidence.</p>
          </> : <p>Select a module or finding to inspect its source evidence.</p>}
        </div>
        {museBinding && <PublicMusePanel key={`${live.snapshot.snapshotId}:${evidenceId(museBinding)}`} binding={museBinding} />}
      </section>
    </div>
  </>;
}

export function PublicRepositoryWorkspace() {
  const { live, realStatus, attempt } = useLiveAst();
  const hash = useSyncExternalStore(subscribeInspectorHashStore, getInspectorHashSnapshot, getInspectorHashServerSnapshot);
  const view = publicViewForHash(hash);
  useEffect(() => { if (window.location.hash) document.getElementById("public-view-heading")?.focus(); }, [view]);
  const title = { overview: "Repository overview", architecture: "Repository architecture", findings: "Repository findings", compare: "Compare — NOT READY", evaluation: "Evaluation — NOT MEASURED" }[view];
  return <div className="vf-demo min-w-0">
    <h1 id="public-view-heading" tabIndex={-1} className="mb-2 text-2xl font-semibold">{title}</h1>
    <p className="mb-4 text-sm">Enter a public repository URL above, then choose Inspect repository. Intake resolves the requested ref to an immutable commit before reading source.</p>
    {!live && <p role="status" className="mb-4">{realStatus === "loading" ? "Loading real repository source…" : realStatus === "error" ? "No active analysis. Review the intake error and retry." : "No repository loaded. No sample graph or findings are substituted."}</p>}
    {live && <section role={realStatus === "error" ? "alert" : "status"} className="mb-4 rounded-lg border-2 p-4" style={{ borderColor: realStatus === "success" ? "var(--vf-border)" : "#eab308" }}>
      <h2 className="font-semibold">{realStatus === "success" ? "Last successful real analysis" : "STALE / RETAINED SNAPSHOT — not a new successful analysis"}</h2>
      <p className="break-all">Displayed source: {live.requested.owner}/{live.requested.repo} · ref {live.requested.ref ?? "default branch"} · commit {live.snapshot.resolvedCommitIfGitHub}</p>
      {realStatus !== "success" && <p>The graph and findings belong only to this retained source, not to the edited URL or latest attempted repository. Clear / new analysis removes it.</p>}
    </section>}
    {attempt && attempt.status !== "idle" && <section aria-label="Latest analysis attempt" role={attempt.status === "error" ? "alert" : "status"} className="mb-4 rounded-lg border p-4" style={{ borderColor: "var(--vf-border)" }}>
      <h2 className="font-semibold">Latest attempt: {attempt.status === "error" ? "FAILED — no new analysis succeeded" : attempt.status}</h2>
      <p className="break-all">{attempt.requested ? `${attempt.requested.owner}/${attempt.requested.repo} · ref ${attempt.requested.ref ?? "default branch"}` : "No valid repository locator"}</p>
      <p>{attempt.code ? `${attempt.code}: ` : ""}{attempt.message}</p>
    </section>}
    {live && <PublicAnalysisResult key={`${live.requested.owner}/${live.requested.repo}/${live.snapshot.snapshotId}`} live={live} view={view} museActive={realStatus === "success"} />}
    {!live && (view === "architecture" || view === "findings") && <p>No source is available for this {view} view. Inspect a public repository to begin.</p>}
    {view === "compare" && <section id="public-readiness" aria-label="Comparison readiness" className="rounded-lg border p-4" style={{ borderColor: "var(--vf-border)" }}><h2 className="text-xl font-semibold">Comparison: NOT READY</h2><p>Independently imported and scanned vulnerable/safer snapshots are required. No comparison has run; no safer result or preview success is substituted.</p></section>}
    {view === "evaluation" && <section id="public-evaluation" aria-label="Evaluation readiness" className="rounded-lg border p-4" style={{ borderColor: "var(--vf-border)" }}><h2 className="text-xl font-semibold">Evaluation: NOT MEASURED</h2><p>Independent blind-test precision and recall have not been measured. No accuracy or evaluation success is claimed.</p></section>}
    <footer className="mt-4 rounded-lg border p-4 text-sm" style={{ borderColor: "var(--vf-border)" }}>
      <p>Muse explanation · Meta Direct: Select a supported potential finding, then use Verify this finding for Muse to check current availability without inference. A genuine explanation is shown only after consent and a validated model response. Unconfigured, expired or quota-limited requests fail closed. Offline results are labeled mocks.</p>
      <p>Comparison: NOT READY — independently scanned vulnerable/safer snapshots are pending.</p>
      <p>Evaluation: NOT MEASURED — independent blind-test precision and recall are pending.</p>
      <p>Security parsing is bounded and cooperative; large files can delay browser input.</p>
      <Link className="mt-2 inline-block underline" href="/demo/vibeshop">Open preserved offline VibeShop fixture demo</Link>
    </footer>
  </div>;
}
