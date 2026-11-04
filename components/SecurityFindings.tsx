"use client";
import { useRef, useEffect } from "react";
import { DETECTION_LIMITS, type DetectionResult, type SecurityFinding } from "@/lib/security-findings";
import { WITHHELD_NOTICE, type TrustedSourceEvidence } from "@/lib/safer-comparison";
import { SaferComparison } from "@/components/SaferComparison";

export type SecurityState = { snapshotId: string | null; status: "idle" | "running" | "done" | "invalid";
  result?: Extract<DetectionResult, { ok: true }>; message?: string };
export function SecurityFindings({ state, selected, onSelect }: {
  state: SecurityState; selected: string | null; onSelect: (finding: SecurityFinding) => void;
}) {
  const r = state.result;
  return <div className="mt-4 rounded-[10px] bg-[#F7FAFC] p-4 text-[#1C3043]" aria-label="Potential security findings">
    <h3 className="text-[13px] font-semibold">Potential security findings (P5)</h3>
    <p className="mt-1 text-[12px]" role="note">Three supported rules: credential literals, SQL construction, and dynamic HTML. Ownership and admin authorization are not analyzed. Maximum {DETECTION_LIMITS.maxFindings} findings. Cancellation and the time budget are cooperative: synchronous parsing can delay browser input and cannot be interrupted mid-file.</p>
    {state.status === "running" && <p role="status">Analyzing source for potential findings…</p>}
    {state.status === "invalid" && <p role="alert">Security analysis unavailable: {state.message} No findings are shown.</p>}
    {state.status === "done" && r && <>
      <p className="mt-1 text-[12px]" role="status">{r.findings.length} potential finding(s) shown; {r.filesAnalyzed}/{r.filesTotal} file(s) fully analyzed. {r.scanComplete ? "Supported-rule scan complete." : "Partial supported-rule scan."} This is not a security guarantee.</p>
      {r.findingLimitReached && <p role="alert">Finding cap reached ({r.findings.length}); scanning stopped early. Additional findings may exist.</p>}
      {r.malformedFiles.length > 0 && <div role="alert">Malformed source excluded from detection:<ul>{r.malformedFiles.map(f => <li key={f.path}>{f.path}: {f.diagnostics} parser diagnostic(s)</li>)}</ul></div>}
      {r.findings.length === 0 && <p>No potential findings from the supported rules in the analyzed files.</p>}
      <ol aria-label="Detected potential findings">{r.findings.map((f, i) => <li key={f.id} className="mt-2 rounded-[6px] bg-[#FFF5F5] px-3 py-2 text-[12px]">
        <button className="font-mono underline" onClick={() => onSelect(f)} aria-label={`Inspect finding ${i + 1}: ${f.path}:${f.line}:${f.column}`} aria-pressed={selected === f.id} aria-controls="security-finding-inspector">
          {i + 1}. {f.ruleId} · {f.severity} · {f.path}:{f.line}:{f.column}
        </button>
        <p className="mt-1 font-medium">{f.title}</p>
        <p className="mt-1 font-mono text-[12px]" aria-label={`Location for finding ${i + 1}`}>{f.path}:{f.line}:{f.column}</p>
        <p role="note" className="mt-1 text-[11px] opacity-70">{WITHHELD_NOTICE}</p>
        <p className="mt-1 opacity-80">{f.limitations}</p>
        <p className="mt-1">Safer: {f.recommendation}</p>
      </li>)}</ol>
    </>}
  </div>;
}

export function SecurityFindingInspector({ finding: f, trustedEvidence }: { finding: SecurityFinding; trustedEvidence?: TrustedSourceEvidence }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [f.id]);
  return <div id="security-finding-inspector">
    <h3 ref={heading} tabIndex={-1} className="text-[13px] font-semibold">Selected potential finding: {f.ruleId}</h3>
    <p className="mt-1 font-mono text-[12px]" aria-label="Finding source location">{f.path}:{f.line}:{f.column}</p>
    <p className="mt-1 text-[12px]">UTF-8 bytes [{f.byteOffset}, {f.endByteOffset}); UTF-16 offsets [{f.charOffset}, {f.endCharOffset}).</p>
    <p className="mt-1 text-[12px]">Snapshot: {f.snapshotId} · Commit: {f.commit ?? "synthetic source"}</p>
    <p className="mt-1 break-all text-[12px]">Source SHA-256: {f.fileSha256}</p>
    <p role="note" className="mt-2 rounded-[6px] bg-[#EDF2F7] p-3 text-[12px]" aria-label="Source excerpt withheld">{WITHHELD_NOTICE}</p>
    <p className="mt-1 text-[12px] opacity-80">Location and provenance metadata above are retained; no source excerpt is displayed.</p>
    <p className="mt-1 text-[12px]">{f.limitations}</p>
    <p className="mt-1 text-[12px]">Safer: {f.recommendation}</p>
    <p className="mt-3 text-[12px]">Excerpt withheld; repository code is never executed.</p>
    <SaferComparison finding={f} trustedEvidence={trustedEvidence} />
  </div>;
}
