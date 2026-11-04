import { Shell } from "@/components/Shell";

export default function EvaluationPage() {
  return (
    <Shell>
      <section className="rounded-[10px] border p-5" style={{ background: "var(--vf-panel-bg)", borderColor: "var(--vf-border)" }}>
        <h1 className="text-[28px] font-semibold">Evaluation</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--vf-muted-text)" }}>
          Actual scored outcomes, limitations, and coverage for this preview. No precision/recall scores are
          claimed — no model ran and no repository was scanned.
        </p>
        <ul className="mt-3 list-disc pl-5 text-[13px]" style={{ color: "var(--vf-muted-text)" }}>
          <li>Coverage: fictional src/ only; node_modules/, dist/, .github/, test/, scripts/, examples/ unscanned.</li>
          <li>Findings are POSSIBLE/REVIEW labels, not confirmed vulnerabilities.</li>
          <li>Muse: unavailable in this preview (no API/model calls).</li>
        </ul>
      </section>
    </Shell>
  );
}
