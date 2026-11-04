"use client";
import { comparisonForFinding, type TrustedSourceEvidence } from "@/lib/safer-comparison";
import type { SecurityFinding } from "@/lib/security-findings";

/**
 * P7 C003 side-by-side BEFORE/AFTER panel.
 * The ONLY code text rendered here is the FIXED synthetic sample pair
 * (curated non-secret fixture content; BEFORE display additionally
 * literal-redacted). No untrusted finding excerpt/quote/anchor is rendered
 * anywhere in the list or inspector — only location/provenance metadata.
 * The pair has its OWN sample identity — it is NOT from the selected
 * repository and never inherits the finding's path/line/hash. An
 * associated finding is shown ONLY when its provenance verifies against
 * the caller-provided trusted snapshot evidence; otherwise the panel is
 * labeled example-only with NO finding citation (never invented).
 */
export function SaferComparison({ finding, trustedEvidence }: { finding: SecurityFinding; trustedEvidence?: TrustedSourceEvidence }) {
  const r = comparisonForFinding(finding, trustedEvidence);
  if (!r.ok) {
    return (
      <p role="note" className="mt-2 text-[12px]">
        No safer comparison available for rule {finding.ruleId}. Supported: VF-SEC-001, VF-SEC-002, VF-SEC-003.
        No comparison was fabricated.
      </p>
    );
  }
  const c = r.comparison;
  return (
    <section aria-label={`Safer-code comparison for ${c.ruleId}`} className="mt-3 rounded-[6px] border border-[#BEE3F8] bg-white p-3">
      <h4 className="text-[13px] font-semibold">Safer-code comparison (illustrative synthetic example)</h4>
      <p role="note" className="mt-1 text-[12px] font-semibold">
        Illustrative synthetic example — NOT from the selected repository. Do not treat sample paths or
        hashes as repository evidence.
      </p>
      <p className="mt-1 font-mono text-[11px] opacity-80">
        Sample: {c.sample.sampleId} · sha {c.sample.sampleSha256.slice(0, 12)}…
      </p>
      <p role="note" className="mt-1 text-[12px] opacity-80">
        BEFORE shows the vulnerable synthetic sample (display redacted); AFTER shows an illustrative safer pattern.
        This is NOT an automatic fix and is NOT validated — developer review and testing are required.
      </p>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div>
          <h5 className="font-mono text-[12px] font-semibold">BEFORE · vulnerable synthetic sample</h5>
          <pre aria-label="Before: vulnerable synthetic sample, redacted display" className="mt-1 overflow-x-auto rounded-[6px] bg-[#FFF5F5] p-2 font-mono text-[12px]">{c.beforeDisplay}</pre>
        </div>
        <div>
          <h5 className="font-mono text-[12px] font-semibold">AFTER · illustrative safer pattern</h5>
          <pre aria-label="After: illustrative safer pattern, not a validated fix" className="mt-1 overflow-x-auto rounded-[6px] bg-[#F0FFF4] p-2 font-mono text-[12px]">{c.after}</pre>
        </div>
      </div>
      {c.associatedFinding ? (
        <p className="mt-2 font-mono text-[11px] opacity-80">
          Associated selected finding (NOT the source of this example): {c.associatedFinding.path}:
          {c.associatedFinding.line}:{c.associatedFinding.column} · sha{" "}
          {c.associatedFinding.fileSha256.slice(0, 12)}…
        </p>
      ) : (
        <p role="note" className="mt-2 text-[12px] opacity-80">
          Example only: no validated finding is associated with this illustration.
        </p>
      )}
      <p className="mt-2 text-[12px] opacity-80">{c.limitations}</p>
    </section>
  );
}
