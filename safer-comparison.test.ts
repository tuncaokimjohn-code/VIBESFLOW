/** P7 C003 safer-comparison tests: synthetic fixtures only, offline. */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { SecurityFindingInspector, SecurityFindings } from "@/components/SecurityFindings";
import {
  comparisonForFinding,
  comparisonForRule,
  isSupportedComparisonRule,
  isValidFindingRef,
  redactFindingText,
  redactLiteralsForDisplay,
  verifyFindingMembership,
  WITHHELD_NOTICE,
  SUPPORTED_COMPARISON_RULES,
  type TrustedSourceEvidence,
} from "@/lib/safer-comparison";
import { sha256SyncHex } from "@/lib/sha256-sync";
import { detectSecurityFindings, type SecurityFinding } from "@/lib/security-findings";
import { sha256Text } from "@/lib/source-snapshot";
import { securityFixture as snap } from "@/security-test-fixture";

const contents = (files: Record<string, string>) => new Map(Object.entries(files));
const run = (files: Record<string, string>) => detectSecurityFindings(snap(files), contents(files), sha256Text);

/** Trusted evidence built from the SAME validated snapshot+contents handed to detection. */
const trustedFor = (files: Record<string, string>): { evidence: TrustedSourceEvidence; snapshotId: string } => {
  const snapshot = snap(files);
  const map = contents(files);
  return {
    snapshotId: snapshot.snapshotId,
    evidence: {
      snapshotId: snapshot.snapshotId,
      commit: snapshot.resolvedCommitIfGitHub,
      files: snapshot.files.map((f) => ({ path: f.path, sha256: f.sha256, lineCount: f.lineCount })),
      contents: map,
      verified: true,
      sha256Text: (t: string) => sha256Text(t),
    },
  };
};

const PATH_FOR: Record<string, string> = {
  "VF-SEC-001": "src/config.ts",
  "VF-SEC-002": "src/db.ts",
  "VF-SEC-003": "src/View.tsx",
};

describe("P7 safer comparison mapping", () => {
  it("supports exactly the three P5 rules", () => {
    expect([...SUPPORTED_COMPARISON_RULES]).toEqual(["VF-SEC-001", "VF-SEC-002", "VF-SEC-003"]);
    for (const rule of SUPPORTED_COMPARISON_RULES) {
      expect(isSupportedComparisonRule(rule)).toBe(true);
      const r = comparisonForRule(rule);
      expect(r.ok).toBe(true);
    }
  });

  it("fails closed for unsupported rules without fabricating a comparison", () => {
    for (const bad of ["VF-SEC-999", "BOLA", "", "VF-SEC-001 "]) {
      expect(isSupportedComparisonRule(bad)).toBe(false);
      const r = comparisonForRule(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("UNSUPPORTED_RULE");
    }
  });

  it("BEFORE content is exact and consistent with its finding rule; AFTER clears that rule", async () => {
    for (const rule of SUPPORTED_COMPARISON_RULES) {
      const r = comparisonForRule(rule);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const path = PATH_FOR[rule];
      const before = await run({ [path]: r.comparison.beforeExact });
      expect(before.ok).toBe(true);
      if (!before.ok) continue;
      expect(before.findings.map((f: SecurityFinding) => f.ruleId)).toContain(rule);
      const after = await run({ [path]: r.comparison.after });
      expect(after.ok).toBe(true);
      if (!after.ok) continue;
      expect(after.findings.map((f: SecurityFinding) => f.ruleId)).not.toContain(rule);
    }
  });

  it("never inherits finding provenance: sample carries only independent sample identity", async () => {
    const input = { "src/db.ts": "export const f = (id: string) => db.query(`SELECT * FROM t WHERE id = ${id}`);\n" };
    const before = await run(input);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const finding = before.findings.find((f) => f.ruleId === "VF-SEC-002");
    expect(finding).toBeDefined();
    if (!finding) return;
    const { evidence } = trustedFor(input);
    const r = comparisonForFinding(finding, evidence);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The synthetic sample's ONLY provenance is its independent sample identity.
    expect(r.comparison.sample.sampleId).toBe("SYNTH-SAMPLE-VF-SEC-002");
    expect(r.comparison.sample.sampleSha256).toBe(createHash("sha256").update(r.comparison.beforeExact, "utf8").digest("hex"));
    expect(r.comparison.sample.note).toMatch(/NOT from the selected/i);
    const asRecord = r.comparison.sample as unknown as Record<string, unknown>;
    expect(asRecord["path"]).toBeUndefined();
    expect(asRecord["line"]).toBeUndefined();
    expect(asRecord["fileSha256"]).toBeUndefined();
    // The membership-verified finding is cited distinctly, never as sample provenance.
    expect(r.comparison.associatedFinding).toMatchObject({
      path: finding.path,
      line: finding.line,
      column: finding.column,
      fileSha256: finding.fileSha256,
      snapshotId: finding.snapshotId,
    });
    // Example-only rules carry no finding citation at all.
    const ruleOnly = comparisonForRule("VF-SEC-002");
    expect(ruleOnly.ok).toBe(true);
    if (ruleOnly.ok) expect(ruleOnly.comparison.associatedFinding).toBeNull();
    // Unsupported finding rules fail closed (withheld, never fabricated).
    const bad = comparisonForFinding({ ...finding, ruleId: "VF-SEC-999" } as unknown as SecurityFinding, evidence);
    expect(bad.ok).toBe(false);
  });

  it("redacts fixed synthetic fixture literals for the BEFORE display only", () => {
    for (const rule of SUPPORTED_COMPARISON_RULES) {
      const r = comparisonForRule(rule);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      // No P7 display text may carry the synthetic secret.
      expect(r.comparison.beforeDisplay).not.toContain("AKIA-EXAMPLE-SYNTHETIC-12345");
      expect(r.comparison.after).not.toContain("AKIA-EXAMPLE-SYNTHETIC-12345");
    }
    // The credential rule's BEFORE display is redacted; template-literal
    // SQL/JSX shapes (no secrets inside) stay intact for evidence shape.
    const c001 = comparisonForRule("VF-SEC-001");
    expect(c001.ok).toBe(true);
    if (c001.ok) {
      expect(c001.comparison.beforeDisplay).toContain("[REDACTED]");
      expect(c001.comparison.beforeDisplay).not.toContain("AKIA-EXAMPLE-SYNTHETIC-12345");
    }
    expect(redactLiteralsForDisplay('const a = "x";')).toBe('const a = "[REDACTED]";');
  });

  it("labels AFTER as illustrative, not a validated fix", () => {
    for (const rule of SUPPORTED_COMPARISON_RULES) {
      const r = comparisonForRule(rule);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.comparison.afterLabel).toMatch(/NOT a validated fix/);
      expect(r.comparison.limitations).toMatch(/Not a validated fix/);
    }
  });

  it("withholds untrusted excerpts from the inspector display (no raw secrets)", async () => {
    const before = await run({ "src/config.ts": 'const apiKey = "AKIA-EXAMPLE-SYNTHETIC-99999";\n' });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const finding = before.findings.find((f) => f.ruleId === "VF-SEC-001");
    expect(finding).toBeDefined();
    if (!finding) return;
    const html = renderToStaticMarkup(createElement(SecurityFindingInspector, { finding }));
    // The synthetic secret is absent from the FULL rendered display:
    // no excerpt/quote/anchor content is rendered at all.
    expect(html).not.toContain("AKIA-EXAMPLE-SYNTHETIC-99999");
    expect(html).toContain(WITHHELD_NOTICE);
    // Location + provenance metadata are retained separately.
    expect(html).toContain(finding.path);
    expect(html).toContain(finding.fileSha256);
    expect(html).toContain("AFTER");
    expect(html).toMatch(/NOT.*from the selected repository|NOT from the selected repo/i);
    expect(html).toMatch(/NOT.*validated|illustrative/i);
    // Comparison renders as text, never raw HTML: the P7 component
    // source itself contains no dangerouslySetInnerHTML usage.
    expect(readFileSync("components/SaferComparison.tsx", "utf8")).not.toContain("dangerouslySetInnerHTML");
    expect(readFileSync("components/SecurityFindings.tsx", "utf8")).not.toContain("dangerouslySetInnerHTML");
  });

  it("does not execute inspected source or use network/provider", async () => {
    const witness = "__p7_side_effect_42__";
    const r = comparisonForRule("VF-SEC-001");
    expect(r.ok).toBe(true);
    expect((globalThis as Record<string, unknown>)[witness]).toBeUndefined();
    expect(() => (globalThis as typeof globalThis).fetch("/probe")).toThrow();
  });
});

describe("P7 C003 fail-closed excerpt withholding", () => {
  it("withholds every untrusted input without inspecting it", () => {
    const adversarial = [
      'const apiKey = "AKIA-ADVERSARIAL-1";',
      "const secret = 'adv-secret-2';",
      "// password: hunter2-adv-3",
      "const secretRe = /hunter2-adv-4/;",
      "const apiKey = `prefix-${hunter2Adv5}`;",
      // Multiline lexical spans: secret opens on one line, continues on the next.
      "const token = `multiline-start-AKIA-ADV-6\ncontinuation-hunter2-adv-6`;",
      "/* block comment open AKIA-ADV-7\nstill-comment hunter2-adv-7 */",
      "const re = /start-AKIA-ADV-8\nend-hunter2-8/;",
      // Encoded / split tokens reassembled across lines.
      'const enc = "QUtJQS1BRFZBTkNFQ0lBTC05";',
      'const partA = "AKIA-ADV"; const apiKey = partA + "ERSARIAL-10";',
      "export const x = 1;",
      "",
    ];
    for (const input of adversarial) {
      expect(redactFindingText(input)).toBe(WITHHELD_NOTICE);
    }
    // The notice itself carries no source content.
    expect(WITHHELD_NOTICE).not.toMatch(/apiKey|secret|password|AKIA|hunter2/i);
  });

  it("proves adversarial synthetic secrets absent from the full inspector display", async () => {
    const secrets = [
      "AKIA-ADVERSARIAL-INSPECTOR-1",
      "hunter2-adversarial-2",
      "tok-adversarial-003",
      "QUtJQS1BRFZBTkNFQ0lBTC05",
      "multiline-start-AKIA-ADV-6",
      "continuation-hunter2-adv-6",
    ];
    // Continuation secrets sit on comment/block-comment lines adjacent to
    // flagged credential lines, so the detector's ±2-line context rows
    // WOULD carry them — the C002 line redactor's exact leak path.
    const source = [
      `const apiKey = "${secrets[0]}";`,
      `// password: ${secrets[1]}`,
      `const mySecret = '${secrets[2]}';`,
      `const authToken = "${secrets[3]}";`,
      `/* block ${secrets[4]}`,
      `${secrets[5]} still-comment */`,
      "const ok = 1;",
    ].join("\n") + "\n";
    const r = await run({ "src/config.ts": source });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.length).toBeGreaterThan(0);
    for (const finding of r.findings) {
      const html = renderToStaticMarkup(createElement(SecurityFindingInspector, { finding }));
      for (const s of secrets) expect(html).not.toContain(s);
      expect(html).toContain(WITHHELD_NOTICE);
      // Provenance metadata is retained alongside withholding.
      expect(html).toContain(finding.path);
      expect(html).toContain(finding.fileSha256);
    }
  });

  it("proves adversarial synthetic secrets absent from the full findings list display", async () => {
    const secret = "AKIA-ADVERSARIAL-LIST-9";
    const input = { "src/config.ts": `const apiKey = "${secret}";\n` };
    const r = await run(input);
    expect(r.ok).toBe(true);
    if (!r.ok || r.findings.length === 0) return;
    const html = renderToStaticMarkup(
      createElement(SecurityFindings, { state: { snapshotId: "test", status: "done", result: r }, selected: null, onSelect: () => {} }),
    );
    expect(html).not.toContain(secret);
    expect(html).toContain(WITHHELD_NOTICE);
    expect(html).toContain(r.findings[0].path);
  });

  it("renders no excerpt, quote, or anchor markup in list or inspector sources", () => {
    const listSrc = readFileSync("components/SecurityFindings.tsx", "utf8");
    expect(listSrc).not.toMatch(/f\.excerpt/);
    expect(listSrc).not.toMatch(/f\.quote/);
    expect(listSrc).not.toMatch(/finding\.context/);
    expect(listSrc).not.toMatch(/\.excerpt/);
  });
});

describe("P7 C003 snapshot-membership citation verification", () => {
  it("cites a finding only against exact trusted membership", async () => {
    const input = { "src/config.ts": 'const apiKey = "AKIA-MEMBERSHIP-1";\n' };
    const r = await run(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const finding = r.findings.find((f) => f.ruleId === "VF-SEC-001");
    expect(finding).toBeDefined();
    if (!finding) return;
    const { evidence } = trustedFor(input);
    // Exact membership -> cited.
    expect(verifyFindingMembership(finding, evidence)).toEqual({ ok: true });
    const cited = comparisonForFinding(finding, evidence);
    expect(cited.ok).toBe(true);
    if (cited.ok) expect(cited.comparison.associatedFinding).not.toBeNull();
    // No evidence at all -> example only, no citation, no invention.
    const bare = comparisonForFinding(finding);
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.comparison.associatedFinding).toBeNull();
  });

  it("rejects fabricated valid-shaped provenance that is not a snapshot member", async () => {
    const input = { "src/config.ts": 'const apiKey = "AKIA-MEMBER-REAL-2";\n' };
    const r = await run(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const finding = r.findings.find((f) => f.ruleId === "VF-SEC-001");
    expect(finding).toBeDefined();
    if (!finding) return;
    const { evidence } = trustedFor(input);
    // Fabricated: valid shape, but a different snapshot + unknown file.
    const forged = {
      ...finding,
      snapshotId: "github-" + "f".repeat(64),
      fileSha256: "e".repeat(64),
      path: "src/other.ts",
    } as unknown as SecurityFinding;
    expect(isValidFindingRef(forged)).toBe(true); // shape alone cannot save it
    expect(verifyFindingMembership(forged, evidence).ok).toBe(false);
    const out = comparisonForFinding(forged, evidence);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.comparison.associatedFinding).toBeNull();
  });

  it("names each membership failure and omits the citation", async () => {
    const input = { "src/config.ts": 'const apiKey = "AKIA-MEMBER-REAL-3";\nconst ok = 1;\n' };
    const r = await run(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const finding = r.findings.find((f) => f.ruleId === "VF-SEC-001");
    expect(finding).toBeDefined();
    if (!finding) return;
    const { evidence } = trustedFor(input);
    const mutate = (patch: Partial<TrustedSourceEvidence>): TrustedSourceEvidence => ({ ...evidence, ...patch });
    // Commit mismatch (immutable commit binding).
    expect(verifyFindingMembership(finding, mutate({ commit: "b".repeat(40) }))).toEqual({ ok: false, reason: "COMMIT_MISMATCH" });
    // Unknown path.
    expect(verifyFindingMembership({ ...finding, path: "src/missing.ts" }, evidence)).toEqual({ ok: false, reason: "PATH_NOT_IN_SNAPSHOT" });
    // Hash mismatch.
    expect(verifyFindingMembership({ ...finding, fileSha256: "d".repeat(64) }, evidence)).toEqual({ ok: false, reason: "HASH_MISMATCH" });
    // Line out of range.
    expect(verifyFindingMembership({ ...finding, line: 99 }, evidence)).toEqual({ ok: false, reason: "LOCATION_OUT_OF_RANGE" });
    // Column out of range.
    const longCol = verifyFindingMembership({ ...finding, column: 10000 }, evidence);
    expect(longCol).toEqual({ ok: false, reason: "LOCATION_OUT_OF_RANGE" });
    expect(longCol.ok).toBe(false);
    // Missing evidence entirely.
    expect(verifyFindingMembership(finding, undefined)).toEqual({ ok: false, reason: "NO_TRUSTED_EVIDENCE" });
    // Every failure omits the citation.
    for (const verdict of [
      verifyFindingMembership(finding, mutate({ commit: "b".repeat(40) })),
      verifyFindingMembership({ ...finding, path: "src/missing.ts" }, evidence),
      verifyFindingMembership({ ...finding, line: 99 }, evidence),
    ]) {
      expect(verdict.ok).toBe(false);
    }
    const out = comparisonForFinding({ ...finding, line: 99 }, evidence);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.comparison.associatedFinding).toBeNull();
  });

  it("re-verifies content bytes when a sync hasher is supplied", async () => {
    const input = { "src/config.ts": 'const apiKey = "AKIA-MEMBER-REAL-4";\n' };
    const r = await run(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const finding = r.findings.find((f) => f.ruleId === "VF-SEC-001");
    expect(finding).toBeDefined();
    if (!finding) return;
    const { evidence } = trustedFor(input);
    // Tampered contents under a valid membership claim -> content hash mismatch.
    const tampered = new Map(Object.entries(input));
    tampered.set("src/config.ts", 'const apiKey = "TAMPERED-DIFFERENT-VALUE";\n');
    const tamperedEvidence: TrustedSourceEvidence = { ...evidence, contents: tampered };
    expect(verifyFindingMembership(finding, tamperedEvidence)).toEqual({ ok: false, reason: "CONTENT_HASH_MISMATCH" });
    const out = comparisonForFinding(finding, tamperedEvidence);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.comparison.associatedFinding).toBeNull();
  });

  it("labels unverified output as synthetic example only in the rendered panel", async () => {
    const input = { "src/config.ts": 'const apiKey = "AKIA-MEMBER-REAL-5";\n' };
    const r = await run(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const finding = r.findings.find((f) => f.ruleId === "VF-SEC-001");
    expect(finding).toBeDefined();
    if (!finding) return;
    // No trusted evidence threaded -> example-only rendering.
    const html = renderToStaticMarkup(createElement(SecurityFindingInspector, { finding }));
    expect(html).toContain("Example only");
    expect(html).not.toContain("Associated selected finding");
    expect(html).not.toContain("AKIA-MEMBER-REAL-5");
  });
});

describe("P7 C004 hardened citation (Codex C003 QA MEDIUM)", () => {
  it("requires an independently verified snapshot", async () => {
    const input = { "src/config.ts": 'const apiKey = "AKIA-C004-VERIFY-1";\n' };
    const r = await run(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const finding = r.findings.find((f) => f.ruleId === "VF-SEC-001");
    expect(finding).toBeDefined();
    if (!finding) return;
    const { evidence } = trustedFor(input);
    // Verified + hash binding -> cited.
    expect(verifyFindingMembership(finding, evidence)).toEqual({ ok: true });
    // Missing flag -> fail closed, no citation.
    const { verified: _drop, ...unverified } = evidence;
    expect(verifyFindingMembership(finding, unverified)).toEqual({ ok: false, reason: "UNVERIFIED_SNAPSHOT" });
    expect(verifyFindingMembership(finding, { ...evidence, verified: false })).toEqual({ ok: false, reason: "UNVERIFIED_SNAPSHOT" });
    for (const bad of [unverified, { ...evidence, verified: false }]) {
      const out = comparisonForFinding(finding, bad as TrustedSourceEvidence);
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.comparison.associatedFinding).toBeNull();
    }
  });

  it("C005: changed same-geometry bytes fail via the internally computed content SHA", async () => {
    const input = { "src/config.ts": 'const apiKey = "AKIA-C004-GEOMETRY-2";\n' };
    const r = await run(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const finding = r.findings.find((f) => f.ruleId === "VF-SEC-001");
    expect(finding).toBeDefined();
    if (!finding) return;
    const { evidence } = trustedFor(input);
    // Same line count, different bytes, no hasher and no flag at all: C005
    // always hashes the actual bytes itself, so this fails closed with a
    // content mismatch (never a pass on geometry alone, never a hash-less
    // bypass code).
    const sameGeometry = new Map(Object.entries(input));
    sameGeometry.set("src/config.ts", 'const apiKey = "AAAAAAAAAAAAAAAAAAAAAAAA";\n');
    const noBinding: TrustedSourceEvidence = {
      snapshotId: evidence.snapshotId,
      commit: evidence.commit,
      files: evidence.files,
      contents: sameGeometry,
      verified: true,
    };
    expect(verifyFindingMembership(finding, noBinding)).toEqual({ ok: false, reason: "CONTENT_HASH_MISMATCH" });
    const out = comparisonForFinding(finding, noBinding);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.comparison.associatedFinding).toBeNull();
  });

  it("C005: ignores any caller-supplied contentHashVerified flag and verifies actual bytes", async () => {
    const input = { "src/config.ts": 'const apiKey = "AKIA-C004-PREVAL-3";\n' };
    const r = await run(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const finding = r.findings.find((f) => f.ruleId === "VF-SEC-001");
    expect(finding).toBeDefined();
    if (!finding) return;
    const { evidence } = trustedFor(input);
    const { sha256Text: _hash, ...rest } = evidence;
    // Browser path: verified snapshot with the exact records handed to
    // detection. C005 cites it because the INTERNAL re-hash matches — no
    // caller flag is consulted (none is even settable on the interface).
    const browserEvidence: TrustedSourceEvidence = { ...rest };
    expect(verifyFindingMembership(finding, browserEvidence)).toEqual({ ok: true });
    const cited = comparisonForFinding(finding, browserEvidence);
    expect(cited.ok).toBe(true);
    if (cited.ok) expect(cited.comparison.associatedFinding).not.toBeNull();
    // Same line count but DIFFERENT bytes with a forged caller flag: the
    // flag is not part of the interface and is ignored, so the swap still
    // fails closed (content mismatch — the detector anchor is the
    // credential NAME token, so the rename would also break the anchor).
    const swapped = new Map(Object.entries(input));
    swapped.set("src/config.ts", 'const renamed = "BBBBBBBBBBBBBBBBBBBBBBBB";\n');
    const swappedEvidence = { ...rest, contents: swapped, contentHashVerified: true as never };
    const verdict = verifyFindingMembership(finding, swappedEvidence as TrustedSourceEvidence);
    expect(verdict.ok).toBe(false);
    expect(verdict).toEqual({ ok: false, reason: "CONTENT_HASH_MISMATCH" });
    const swappedOut = comparisonForFinding(finding, swappedEvidence as TrustedSourceEvidence);
    expect(swappedOut.ok).toBe(true);
    if (swappedOut.ok) expect(swappedOut.comparison.associatedFinding).toBeNull();
  });

  it("rejects a fabricated in-range anchor that equals no source bytes", async () => {
    const input = { "src/config.ts": 'const apiKey = "AKIA-C004-ANCHOR-4";\nconst ok = 1;\n' };
    const r = await run(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const finding = r.findings.find((f) => f.ruleId === "VF-SEC-001");
    expect(finding).toBeDefined();
    if (!finding) return;
    const { evidence } = trustedFor(input);
    expect(verifyFindingMembership(finding, evidence)).toEqual({ ok: true });
    // Fabricated: valid shape, valid membership, in-range line/column — but
    // the quote/offset binding is invented (points at "ok = 1" or wrong bytes).
    const forgedQuote = { ...finding, quote: "ok", charOffset: finding.charOffset + 5 } as SecurityFinding;
    expect(verifyFindingMembership(forgedQuote, evidence)).toEqual({ ok: false, reason: "ANCHOR_MISMATCH" });
    const forgedLine = { ...finding, line: 2, column: 7 } as SecurityFinding;
    expect(verifyFindingMembership(forgedLine, evidence).ok).toBe(false);
    for (const forged of [forgedQuote, forgedLine]) {
      const out = comparisonForFinding(forged, evidence);
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.comparison.associatedFinding).toBeNull();
    }
    // No automatic code fixes: the example carries only illustrative text
    // with its own sample identity — never the finding's bytes as a fix.
    const cited = comparisonForFinding(finding, evidence);
    expect(cited.ok).toBe(true);
    if (cited.ok) {
      expect(cited.comparison.sample.sampleId).toBe("SYNTH-SAMPLE-VF-SEC-001");
      expect(cited.comparison.after).not.toContain(finding.fileSha256);
      expect(cited.comparison.after).not.toContain(finding.path);
      expect(cited.comparison.limitations).toMatch(/NOT a validated fix|Not a validated fix/);
    }
  });

  it("withholds adversarial synthetic secrets across list/inspector/graph surfaces", async () => {
    const secrets = [
      "AKIA-C004-SURFACE-1",
      "hunter2-c004-surface-2",
      "tok-c004-surface-003",
      "multiline-start-C004-SURF-4",
      "continuation-c004-surf-4",
    ];
    const source = [
      `const apiKey = "${secrets[0]}";`,
      `// password: ${secrets[1]}`,
      `const mySecret = '${secrets[2]}';`,
      `/* block ${secrets[3]}`,
      `${secrets[4]} still-comment */`,
      "const ok = 1;",
    ].join("\n") + "\n";
    const r = await run({ "src/config.ts": source });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.length).toBeGreaterThan(0);
    for (const finding of r.findings) {
      const inspectorHtml = renderToStaticMarkup(createElement(SecurityFindingInspector, { finding }));
      for (const s of secrets) expect(inspectorHtml).not.toContain(s);
      expect(inspectorHtml).toContain(WITHHELD_NOTICE);
    }
    const listHtml = renderToStaticMarkup(
      createElement(SecurityFindings, { state: { snapshotId: "test", status: "done", result: r }, selected: null, onSelect: () => {} }),
    );
    for (const s of secrets) expect(listHtml).not.toContain(s);
    // Graph surface: static source-view withholding (never renders rows).
    // The file threads the WITHHELD_NOTICE identifier (its value lives in
    // lib/safer-comparison.ts and is rendered, never the source text).
    const graphSrc = readFileSync("components/AstGraph.tsx", "utf8");
    expect(graphSrc).toContain("WITHHELD_NOTICE");
    expect(graphSrc).not.toMatch(/numberedExcerpt/);
    expect(graphSrc).not.toMatch(/\.excerpt/);
    for (const s of secrets) expect(graphSrc).not.toContain(s);
    // No dangerous markup on any P7 UI surface.
    for (const rel of ["components/AstGraph.tsx", "components/SecurityFindings.tsx", "components/SaferComparison.tsx"]) {
      expect(readFileSync(rel, "utf8")).not.toContain("dangerouslySetInnerHTML");
    }
  });
});

describe("P7 C005 bundled sync SHA-256 (Codex C004 QA MEDIUM)", () => {
  it("matches FIPS-180-4 vectors and Node crypto on adversarial inputs", () => {
    expect(sha256SyncHex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256SyncHex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const adversarial = [
      'const apiKey = "AKIA-C005-HASH-1";\n',
      "multiline-start-AKIA-C005-HASH-2\ncontinuation-hunter2-c005-2\n",
      "https://user:s3cr3t-c005-3@registry.example.com/pkg\n",
      "unicode-\u2028split-tok-c005-4-\u00e9\0",
      "x".repeat(100000),
    ];
    for (const v of adversarial) {
      expect(sha256SyncHex(v)).toBe(createHash("sha256").update(v, "utf8").digest("hex"));
    }
  });

  it("rejects a fabricated same-geometry changed secret even with a matching anchor", async () => {
    const original = { "src/config.ts": 'const apiKey = "AKIA-C005-MATCH-1";\n' };
    const tampered = { "src/config.ts": 'const apiKey = "AKIA-C005-CHANGED-9";\n' };
    const rTamp = await run(tampered);
    expect(rTamp.ok).toBe(true);
    if (!rTamp.ok) return;
    const tamperedFinding = rTamp.findings.find((f) => f.ruleId === "VF-SEC-001");
    expect(tamperedFinding).toBeDefined();
    if (!tamperedFinding) return;
    const { evidence } = trustedFor(original);
    const originalEntry = evidence.files.find((f) => f.path === "src/config.ts");
    expect(originalEntry).toBeDefined();
    // Forged citation: original snapshot identity + original digest, but the
    // anchor (quote/offsets) is genuinely consistent with the CHANGED bytes
    // and the handed-in contents are the changed bytes (same line count).
    const forged = {
      ...tamperedFinding,
      snapshotId: evidence.snapshotId,
      commit: evidence.commit,
      path: "src/config.ts",
      fileSha256: originalEntry!.sha256,
    };
    const forgedEvidence: TrustedSourceEvidence = {
      snapshotId: evidence.snapshotId,
      commit: evidence.commit,
      files: evidence.files,
      contents: new Map(Object.entries(tampered)),
      verified: true,
    };
    // The anchor genuinely matches the changed bytes — so the anchor gate
    // alone would pass; the internally computed content SHA does the work.
    const ttext = tampered["src/config.ts"];
    expect(ttext.slice(forged.charOffset, forged.endCharOffset)).toBe(forged.quote);
    expect(verifyFindingMembership(forged, forgedEvidence)).toEqual({ ok: false, reason: "CONTENT_HASH_MISMATCH" });
    const out = comparisonForFinding(forged, forgedEvidence);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.comparison.associatedFinding).toBeNull();
  });

  it("cites genuine bytes with no caller hasher at all and keeps anchor/quote/line bound", async () => {
    const input = { "src/config.ts": 'const apiKey = "AKIA-C005-NOHASH-5";\nconst ok = 1;\n' };
    const r = await run(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const finding = r.findings.find((f) => f.ruleId === "VF-SEC-001");
    expect(finding).toBeDefined();
    if (!finding) return;
    const { evidence } = trustedFor(input);
    // Strip the legacy caller hasher entirely: C005 still cites genuine
    // bytes because it hashes internally every time.
    const { sha256Text: _drop, ...noHasher } = evidence;
    expect(verifyFindingMembership(finding, noHasher)).toEqual({ ok: true });
    // Anchor/quote/line remain bound to the actual bytes: a forged line on
    // the same geometry still fails (anchor mismatch, not a citation).
    const forgedLine = { ...finding, line: 2, column: 7 };
    expect(verifyFindingMembership(forgedLine, noHasher).ok).toBe(false);
  });
});
