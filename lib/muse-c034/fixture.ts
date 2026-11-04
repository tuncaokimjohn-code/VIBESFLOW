import "server-only";
import { z } from "zod";
import { buildDemoSnapshot, fixtureContents } from "@/lib/demo-fixture";
import { detectSecurityFindings } from "@/lib/security-findings";
import { SourceSnapshotSchema, sha256Text } from "@/lib/source-snapshot";
import { bindFinding, sameBinding, EvidenceBindingSchema } from "@/lib/muse-binding";
import { validateCitations } from "@/lib/muse-server";
export const BrowserEvidenceSchema = z.strictObject({ consent: z.literal(true), findingId: z.string().min(1).max(512),
  snapshot: SourceSnapshotSchema, contents: z.record(z.string(), z.string()), evidence: EvidenceBindingSchema });
const stable = (v: unknown): string => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
export async function preparedFindings(signal?: AbortSignal) {
  const contents = { ...fixtureContents() }, snapshot = SourceSnapshotSchema.parse(buildDemoSnapshot(contents));
  const map = new Map(Object.entries(contents));
  const detected = await detectSecurityFindings(snapshot, map, sha256Text, { signal });
  if (!detected.ok || !detected.scanComplete) throw new Error("Synthetic evidence unavailable");
  return detected.findings.map(finding => {
    const binding = Object.freeze(bindFinding(finding));
    const { findingId, path, line, column, quote } = binding;
    if (!validateCitations([{ findingId, path, line, column, quote }], finding, map)) throw new Error("Citation mismatch");
    return Object.freeze({ finding, binding, snapshot, contents });
  });
}
export type PreparedFinding = Awaited<ReturnType<typeof preparedFindings>>[number];
export async function prepareBrowserEvidence(body: unknown, signal?: AbortSignal) {
  const b = BrowserEvidenceSchema.parse(body);
  const prepared = (await preparedFindings(signal)).find(p => p.finding.id === b.findingId);
  if (!prepared || !sameBinding(b.evidence, prepared.binding) || stable(b.contents) !== stable(prepared.contents)
    || stable(b.snapshot) !== stable(prepared.snapshot)) throw new Error("Unverified synthetic evidence");
  return prepared;
}
