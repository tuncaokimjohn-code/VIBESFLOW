import { Shell } from "@/components/Shell";

export default function ComparePage() {
  return (
    <Shell>
      <section className="rounded-[10px] border p-5" style={{ background: "var(--vf-panel-bg)", borderColor: "var(--vf-border)" }}>
        <h1 className="text-[28px] font-semibold">Compare snapshots</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--vf-muted-text)" }}>
          Display-only side-by-side of two labeled fictional snapshots. No hashing, no scanning, no source patching. Preview data only.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {(["Snapshot A · fictional-001", "Snapshot B · fictional-002"] as const).map((s) => (
            <div key={s} className="rounded-lg border p-4" style={{ borderColor: "var(--vf-border)" }}>
              <p className="font-mono text-[13px]">{s}</p>
              <p className="mt-1 text-[13px]" style={{ color: "var(--vf-muted-text)" }}>2 fictional findings each; no verification claimed.</p>
            </div>
          ))}
        </div>
      </section>
    </Shell>
  );
}
