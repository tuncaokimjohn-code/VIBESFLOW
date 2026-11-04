/** STATIC: P4 real-AST wiring — mounted/browser NOT RUN. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SPECIFIER_WITHHELD_NOTICE, UnsupportedImports } from "@/components/AstGraph";

describe("P4 AstGraph wiring", () => {
  const src = readFileSync("components/AstGraph.tsx", "utf8");
  const securityUi = readFileSync("components/SecurityFindings.tsx", "utf8");
  const dash = readFileSync("components/Dashboard.tsx", "utf8");

  it("is mounted in the analysis dashboard after the synthetic section", () => {
    expect(dash).toMatch(/import \{ AstGraph \} from "@\/components\/AstGraph"/);
    expect(dash).toMatch(/<AstGraph \/>/);
  });

  it("renders a React Flow architecture canvas (application role, zoom controls)", () => {
    expect(src).toMatch(/ReactFlow/);
    expect(src).toMatch(/role="application" aria-label="Real AST architecture graph"/);
    expect(src).toMatch(/aria-label="AST graph zoom controls"/);
  });

  it("is explicitly labeled as offline fixtures, never as real scan data", () => {
    expect(src).toMatch(/AST_FIXTURE_LABEL/);
    expect(src).toMatch(/Offline fixtures/);
    expect(src).not.toMatch(/live GitHub|real scan complete|verified secure/i);
  });

  it("shows exact source location with the source view withheld on selection", () => {
    expect(src).toMatch(/\{aliases\.get\(selNode\.module\)\}:\{selLine\}/);
    expect(src).toMatch(/aria-label="Source excerpt withheld"/);
    expect(src).toMatch(/WITHHELD_NOTICE/);
    expect(src).toMatch(/repository code is never executed/);
    expect(src).not.toMatch(/aria-label="Read-only source excerpt"/);
  });

  it("shows potential P5 findings, never confirmed vulnerabilities", () => {
    // P5 candidate: detection now lives here; wording must stay potential.
    expect(securityUi).toMatch(/Potential security findings \(P5\)/);
    expect(src).toMatch(/not confirmed vulnerabilities/);
    expect(src).not.toMatch(/GRAPH_NODES|FINDINGS/);
  });

  it("selection is controlled like ArchGraph and evidence panel is live", () => {
    expect(src).toMatch(/applyNodeSelectChanges/);
    expect(src).toMatch(/role="complementary"\s+aria-label="AST evidence inspector"\s+aria-live="polite"/);
    expect(src).toMatch(/aria-label="Exported members"/);
    expect(src).toMatch(/aria-label="Unsupported imports"/);
  });

  it("has explicit empty/error states and no fixture node fabrication in UI", () => {
    expect(src).toMatch(/No parsed modules in this fixture snapshot/);
    expect(src).toMatch(/AST graph unavailable/);
  });

  it("FIX 2: invalid evidence hides the graph (fail closed), never just warns", () => {
    expect(src).toMatch(/!shape\.ok/);
    expect(src).toMatch(/Evidence unavailable/);
    expect(src).toMatch(/No source evidence is shown for an unverified graph/);
    // The old warn-alongside-evidence pattern is gone.
    expect(src).not.toMatch(/Evidence shape check failed/);
  });

  it("FIX 2: browser evidence is labeled PARTIAL, SHA never claimed in browser", () => {
    expect(src).toMatch(/Evidence status: PARTIAL/);
    expect(src).toMatch(/SHA-256\s+verification runs only in the offline tests/);
  });

  it("C004 HIGH: node source view never renders untrusted source text", () => {
    // No source rows, quote, anchor, or adjacent preview — including the
    // multiline-credential leak path (numberedExcerpt + target-line text).
    expect(src).not.toMatch(/numberedExcerpt/);
    expect(src).not.toMatch(/selLineText/);
    expect(src).not.toMatch(/selLine - 2/);
    expect(src).not.toMatch(/\.excerpt/);
    expect(src).not.toMatch(/\.quote/);
    expect(src).not.toMatch(/\.context/);
    expect(src).not.toMatch(/sourceLines\(/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src).toMatch(/WITHHELD_NOTICE/);
    expect(src).toMatch(/aria-label="Source excerpt withheld"/);
    // Safe metadata is retained: module path + line.
    expect(src).toMatch(/\{aliases\.get\(selNode\.module\)\}:\{selLine\}/);
  });

  it("C004 HIGH: no dangerous markup in graph/list/inspector/app sources", () => {
    for (const rel of [
      "components/AstGraph.tsx",
      "components/SecurityFindings.tsx",
      "components/SaferComparison.tsx",
      "app/analysis/[id]/page.tsx",
      "app/compare/[id]/page.tsx",
    ]) {
      const text = readFileSync(rel, "utf8");
      expect(text).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });

  it("FIX 3+7: unsupported modules are shown; member kinds are truthful, not hardcoded", () => {
    expect(src).toMatch(/Unsupported module: parse diagnostics/);
    expect(src).toMatch(/declKind/);
    expect(src).not.toMatch(/\(exported function\)/);
  });
});

describe("P7 C005 graph HIGH (Codex C004 QA HIGH)", () => {
  it("never threads source-derived specifier text into graph rendering", () => {
    const src = readFileSync("components/AstGraph.tsx", "utf8");
    // No specifier value ever reaches markup: not in canvas edge labels,
    // not in the unsupported-imports list, not in any aria detail.
    expect(src).not.toMatch(/e\.specifier/);
    expect(src).not.toMatch(/\? e\.specifier/);
    expect(src).not.toMatch(/\.specifier \|\|/);
    expect(src).not.toMatch(/label: isRef \? /);
    expect(src).toMatch(/label: undefined/);
    // The withheld notice is the only specifier-related UI string.
    expect(src).toContain("SPECIFIER_WITHHELD_NOTICE");
    expect(SPECIFIER_WITHHELD_NOTICE).not.toMatch(/https?|password|secret|token/i);
  });

  it("withholds credential-bearing URLs from the unsupported-imports list", () => {
    const secrets = [
      "https://AKIA-C005-GRAPH-1@internal.example.com/token?secret=hunter2-c005-1",
      "https://user:s3cr3t-p4ss-c005-2@registry.example.com/pkg",
      "postgres://admin:hunter2-c005-3@db.internal:5432/main",
    ];
    const edges = secrets.map((specifier, i) => ({ kind: "external", line: i + 1, specifier }));
    const html = renderToStaticMarkup(createElement(UnsupportedImports, { edges, mod: "src/app.ts" }));
    for (const s of secrets) expect(html).not.toContain(s);
    expect(html).not.toContain("s3cr3t-p4ss-c005-2");
    expect(html).not.toContain("hunter2-c005-3");
    expect(html).toContain(SPECIFIER_WITHHELD_NOTICE);
    // Trusted-safe shape only: edge kind + 1-based line + opaque index.
    expect(html).toContain("external import #1 (line 1;");
    expect(html).toContain("Unsupported / external imports (3)");
  });

  it("withholds multiline and odd-encoding source strings from graph node/edge content", () => {
    const adversarial = [
      "line-one-AKIA-C005-ML-4\nline-two-hunter2-c005-4",
      "https://tok-c005-unicode-5\u2028split@example.com/x",
      "side-effect\u0000payload-c005-6",
    ];
    const edges = [
      ...adversarial.map((specifier, i) => ({ kind: "unresolvable", line: i + 10, specifier })),
      // Resolved kinds are filtered out of this list (shown as plain edges).
      { kind: "imports", line: 1, specifier: "./local-safe" },
      { kind: "references", line: 2, specifier: "myFunc" },
    ];
    const html = renderToStaticMarkup(createElement(UnsupportedImports, { edges, mod: "src/app.ts" }));
    for (const s of adversarial) expect(html).not.toContain(s);
    expect(html).not.toContain("./local-safe");
    expect(html).toContain("unresolvable import #1 (line 10;");
    expect(html).toContain("Unsupported / external imports (3)");
    // Provenance cites trusted path metadata only, never specifier bytes.
    expect(html).not.toContain("src/app.ts");
    expect(html).toContain("source module withheld");
  });

  it("renders no edge canvas labels from source text", () => {
    const src = readFileSync("components/AstGraph.tsx", "utf8");
    // The edge mapper sets no per-edge label at all (opaque selection
    // highlight only); the old specifier-fed label is gone.
    expect(src).not.toMatch(/label: isRef/);
    expect(src).not.toMatch(/label: e\./);
    expect(src).not.toMatch(/label: [a-zA-Z_$][\w$]*\.specifier/);
  });
});
