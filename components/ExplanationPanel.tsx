"use client";
import { useEffect, useRef, useState } from "react";
import type { SecurityFinding } from "@/lib/security-findings";
import type { ExplanationOutcome } from "@/lib/muse-contract";
import { createGenerationGuard, parseExplanationResponse } from "@/lib/muse-client";
import { bindFinding, sameBinding } from "@/lib/muse-binding";

/**
 * P6 explanation panel. Consent is explicit and per-request. With no
 * provider configured the server honestly reports that a real Muse
 * connection is NOT VERIFIED — this panel never fabricates an
 * explanation or presents mock output as real.
 */
export function ExplanationPanel({ finding, snapshot, contents, withholdFailureDetails = false, withholdSourceDetails = false,
  operatorResults = false, onRealResult }: {
  finding: SecurityFinding;
  snapshot: unknown;
  contents: Record<string, string>;
  /** Demo surfaces must not render response-derived failure details. */
  withholdFailureDetails?: boolean;
  withholdSourceDetails?: boolean;
  operatorResults?: boolean;
  onRealResult?: (available: boolean) => void;
}) {
  const snapshotId = (snapshot as { snapshotId?: string } | null)?.snapshotId ?? "";
  const binding = bindFinding(finding);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExplanationOutcome | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const guardRef = useRef(createGenerationGuard());
  const findingRef = useRef(finding.id);
  findingRef.current = finding.id;
  const bindingRef = useRef(binding.evidenceId);
  bindingRef.current = binding.evidenceId;

  // QA-05 finding isolation: any identity change (or unmount) cancels the
  // outstanding request and resets consent, results and busy state, so a
  // response for finding A can never appear under finding B.
  useEffect(() => {
    guardRef.current.invalidate();
    abortRef.current?.abort();
    setConsent(false);
    setResult(null);
    setBusy(false);
    return () => { guardRef.current.invalidate(); abortRef.current?.abort(); };
  }, [finding.id, snapshotId]);
  // Also invalidate when evidence bytes/geometry change under the same IDs.
  useEffect(() => {
    guardRef.current.invalidate(); abortRef.current?.abort();
    setConsent(false); setResult(null); setBusy(false);
    return () => { guardRef.current.invalidate(); abortRef.current?.abort(); };
  }, [binding.evidenceId]);

  async function explain() {
    if (!consent || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const token = guardRef.current.next();
    setBusy(true);
    setResult(null);
    onRealResult?.(false);
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consent: true, findingId: finding.id, snapshot, contents, evidence: binding }),
        signal: controller.signal,
      });
      const raw: unknown = await res.json();
      // C004-02: publish ONLY if this generation is still current, the
      // request was not aborted, and the payload passes runtime schema
      // validation bound to the active finding — never on assertion.
      if (!guardRef.current.isCurrent(token) || controller.signal.aborted) return;
      if (findingRef.current !== finding.id) return; // stale: superseded finding
      if (bindingRef.current !== binding.evidenceId) return;
      const data = parseExplanationResponse(raw, finding.id, binding);
      onRealResult?.(!!data?.ok && "mock" in data && data.mock === false);
      setResult(data ?? { ok: false, code: "EVIDENCE_INVALID", message: "Server response failed runtime validation; nothing was published." });
    } catch {
      if (!guardRef.current.isCurrent(token) || controller.signal.aborted) return;
      if (findingRef.current === finding.id && bindingRef.current === binding.evidenceId) {
        setResult({ ok: false, code: "CANCELLED", message: "Explanation request was cancelled or failed." });
      }
    } finally {
      if (guardRef.current.isCurrent(token) && findingRef.current === finding.id && bindingRef.current === binding.evidenceId) {
        setBusy(false);
        abortRef.current = null;
      }
    }
  }

  return (
    <div className="mt-3 rounded-[6px] bg-[#EDF2F7] px-3 py-2 text-[12px] text-[#1C3043]" aria-label="Muse explanation">
      <p className="font-medium">{operatorResults ? "Muse explanation · local operator" : "Explain this potential finding (Muse)"}</p>
      <p className="mt-1 opacity-80">
        {operatorResults ? result?.ok && "mock" in result && !result.mock && "binding" in result && sameBinding(result.binding, binding)
          ? "A genuine authorized Muse result is available for this exact synthetic evidence. This browser only retrieves the saved response; it cannot trigger Muse or authorize spending."
          : "NOT CONFIGURED until an authorized local execution saves a validated result. This browser only retrieves results; it cannot trigger Muse or authorize spending."
          : "Live Muse is disabled. A real Muse connection is NOT VERIFIED in this build. This page reports provider unavailable. OFFLINE MOCK responses run only in isolated integration tests."}
      </p>
      <label className="mt-2 flex items-start gap-2">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>{operatorResults ? "Retrieve the saved explanation for this exact selected evidence. No new Muse request or spending is authorized."
          : "I approve checking explanation availability for this selected evidence. This does not authorize a Muse call or spending."}</span>
      </label>
      <div className="mt-2 flex gap-2">
        <button
          type="button" onClick={explain} disabled={!consent || busy}
          className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-[#06222A] disabled:opacity-50"
          style={{ background: "var(--vf-primary-cyan)" }}
        >
          {busy ? "Requesting…" : operatorResults ? "Load authorized explanation" : "Request explanation"}
        </button>
        {busy && (
          <button type="button" onClick={() => {
              // C005-02: cancel takes the current panel to a terminal
              // canceled state immediately — busy off now, not when the
              // obsolete generation's finally runs (it is generation-gated).
              guardRef.current.invalidate();
              abortRef.current?.abort();
              setBusy(false);
              setResult({ ok: false, code: "CANCELLED", message: "Explanation request was cancelled." });
            }} className="underline">
            Cancel
          </button>
        )}
      </div>
      {result && (!result.ok || "binding" in result && sameBinding(result.binding, binding)) && (
        <div className="mt-2" role="status">
          {result.ok ? (
            <>
              {"mock" in result && result.mock && <p className="font-semibold">OFFLINE MOCK — NO MUSE CALL</p>}
              {"mock" in result && !result.mock && <>
                <p className="font-semibold">REAL MUSE — AUTHORIZED LOCAL RESULT</p>
                <p className="mt-1 opacity-80">Saved provider response · {result.receipt.model} · requested reasoning: medium · generated {result.generatedAt}. Loading this result made no new provider call.</p>
              </>}
              <p className="whitespace-pre-wrap">{result.explanation}</p>
              <p className="mt-1 opacity-80">
                {withholdSourceDetails ? "Exact citation and source hash checked; source identity withheld." : `Verified citations: ${result.citations.map((c) => `${c.path}:${c.line}:${c.column}`).join(", ")}`} · Provider: {result.providerLabel} · This remains a potential finding.
              </p>
            </>
          ) : (
            <p role="alert">{withholdFailureDetails
              ? "Explanation unavailable; the request could not be completed."
              : <>Explanation unavailable ({result.code}): {result.message}</>}</p>
          )}
        </div>
      )}
    </div>
  );
}
