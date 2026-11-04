import { buildDemoSnapshot, fixtureContents } from "@/lib/demo-fixture";
import { detectSecurityFindings } from "@/lib/security-findings";
import { sha256Text } from "@/lib/source-snapshot";
import { bindFinding } from "@/lib/muse-binding";
import { canonicalExplanation } from "@/lib/muse-server";
export async function integrationFixture() {
  const contents = { ...fixtureContents() }, snapshot = buildDemoSnapshot(contents);
  const detection = await detectSecurityFindings(snapshot, new Map(Object.entries(contents)), sha256Text);
  if (!detection.ok || detection.findings.length !== 3) throw new Error("Pinned fixture failed detection");
  return detection.findings.map(finding => ({ finding, contents, snapshot,
    body: { consent: true as const, findingId: finding.id, snapshot, contents, evidence: bindFinding(finding) },
    contract: { text: canonicalExplanation(finding.ruleId), ruleId: finding.ruleId, binding: bindFinding(finding) },
  }));
}
