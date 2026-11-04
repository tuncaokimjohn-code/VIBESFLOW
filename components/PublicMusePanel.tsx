"use client";
import { useEffect, useRef, useState } from "react";
import { evidenceId, type PublicMuseBinding } from "@/lib/public-muse-contract";
import { META_MODEL } from "@/lib/meta-direct-contract";
import { createMetaController, initialMetaState } from "@/lib/meta-direct-client";
/** Keyed by immutable import + exact selected finding in the parent. */
export function PublicMusePanel({ binding }: { binding: PublicMuseBinding }) {
  const [state, setState] = useState(initialMetaState);
  const controller = useRef<ReturnType<typeof createMetaController> | null>(null);
  useEffect(() => {
    const next = createMetaController(binding, setState);
    controller.current = next;
    setState(initialMetaState());
    return () => { next.dispose(); if (controller.current === next) controller.current = null; };
  }, [binding]);
  return <section aria-label="Public Muse explanation consent" className="mt-4 rounded-lg border p-3 text-sm" style={{ borderColor: "var(--vf-border)" }}>
    <h3 className="font-semibold">Muse explanation · Meta Direct</h3>
    <p>Import a public GitHub TS/TSX repository, select a supported potential finding, then verify it here. Verification checks public availability without inference. A successful preparation enables one consented explanation; shared quota is limited and does not renew.</p>
    <details className="my-2" open><summary>Privacy and provider data use — read before consent</summary>
      <p>A consented explanation sends the same small sanitized source context from this public immutable TS/TSX finding to Meta for input token counting and one inference request. Comments, literal values and arbitrary identifiers are redacted; line numbers, syntax, selected static observations and an opaque evidence digest remain. No full repository or private upload is sent.</p>
      <p>Meta Contributor may use inputs and outputs to improve models. Do not submit confidential or personal data. No zero-retention or training opt-out is promised. The request sets store false; browser/server no-store cannot control provider retention.</p>
      <p>Requested model: {META_MODEL}; reasoning: medium requested, execution unverified. Findings remain potential. Ownership/IDOR, admin authorization and other languages are unsupported. Cancel cannot guarantee a dispatched request avoids charges.</p>
    </details>
    <button className="underline" type="button" disabled={state.busy} onClick={() => void controller.current?.prepare()}>Verify this finding for Muse (no inference)</button>
    {state.prepared && <div className="mt-2">
      <label className="flex gap-2"><input type="checkbox" checked={state.consent} onChange={e => controller.current?.consent(e.target.checked)} />I consent to input token counting and one inference request sending the sanitized public source evidence to Meta Contributor, which may use inputs and outputs to improve models.</label>
      <button className="mt-2 underline" type="button" disabled={!state.consent || state.busy} onClick={() => void controller.current?.explain()}>Explain with Muse</button>
    </div>}
    <button className="ml-3 underline" type="button" onClick={() => controller.current?.cancel()}>Cancel and clear</button>
    <p className="mt-2" role="status" aria-live="polite">{state.message}</p>
    {state.result && <div className="mt-3 space-y-2">
      <strong>{state.result.provenance.transport === "offline-mock" ? "OFFLINE MOCK · not a real Muse response" : "Meta Muse Spark · provider-generated analysis"}</strong>
      <p>{state.result.analysis.summary}</p><p>{state.result.analysis.reasoning}</p>
      <ul>{state.result.analysis.review.map((item, i) => <li key={i}>{item}</li>)}</ul>
      <p>{state.result.analysis.limitations}</p>
      <p>Deterministic source checks: E1 belongs to the selected immutable commit, file hash, line, quote hash and anchor offsets. This verifies the static pattern; provider analysis and exploitability are unconfirmed. Repository security coverage is partial.</p>
      <a className="underline" href="#public-evidence">E1 · exact selected source evidence, line {binding.line}</a>
      <details><summary>Sanitized E1 context sent to Meta</summary><pre className="overflow-x-auto whitespace-pre-wrap">{state.result.context.text}</pre>
        <p className="break-all">Evidence ID: {evidenceId(state.result.binding)}</p><p className="break-all">File SHA-256: {state.result.binding.fileSha256}</p>
        <p className="break-all">Context SHA-256: {state.result.context.sha256}</p></details>
      <p>{state.result.provenance.provider} · {state.result.provenance.model} · {state.result.provenance.status} · {state.result.provenance.inputTokens} input / {state.result.provenance.outputTokens} output tokens. Medium reasoning was requested, not independently verified.</p>
    </div>}
  </section>;
}
