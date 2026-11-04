// P4 offline tests: real TypeScript AST over controlled local fixtures.
// Fixtures are parsed as text only — nothing here executes repository code.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { buildAstGraph, moduleNodeId, excerptAround, numberedExcerpt } from "@/lib/ast-graph";
import { validateGraphShape, validateEvidence, type EvidenceSnapshot } from "@/lib/evidence";
import {
  FIXTURE_SOURCES,
  fixtureContents,
  type FixtureFile,
} from "@/lib/ast-fixtures";
import {
  SourceSnapshotSchema,
  manifestHashFor,
  snapshotIdFor,
  sha256Text,
  defaultPolicy,
  derivedCoverage,
  splitSourceLines,
  type SourceSnapshot,
} from "@/lib/source-snapshot";

function nodeHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildSnapshot(files: FixtureFile[]): SourceSnapshot {
  const enc = new TextEncoder();
  const collected = files.map((f) => {
    const bytes = enc.encode(f.content);
    const geom = splitSourceLines(bytes);
    return {
      path: f.path,
      language: f.language,
      bytes: bytes.length,
      sha256: sha256Text(f.content),
      lineCount: geom.lineCount,
      lineStartOffsets: geom.lineStartOffsets,
    };
  });
  const skipped: Array<{ path: string; reason: "size-limit" }> = [];
  const policy = defaultPolicy();
  const derived = derivedCoverage(collected, skipped);
  const coverage = {
    supportedLanguages: derived.supportedLanguages,
    unsupportedAreas: derived.unsupportedAreas,
    unsupportedAreasTruncated: derived.unsupportedAreasTruncated,
    metadataEntries: null,
    collected: collected.length,
    skippedCount: 0,
    totalBytes: collected.reduce((n, f) => n + f.bytes, 0),
    complete: true,
    collectionPolicy: policy,
  };
  const manifestHash = manifestHashFor(collected, skipped, policy, true, null);
  const snap = {
    contractVersion: "e1-v5" as const,
    sourceKind: "synthetic" as const,
    snapshotId: snapshotIdFor("synthetic", "synthetic:offline-fixtures", null, manifestHash),
    canonicalProvenance: "synthetic:offline-fixtures",
    resolvedCommitIfGitHub: null,
    manifestHash,
    files: collected,
    skipped,
    coverage,
    collectedAt: "2026-10-28T00:00:00.000Z",
  };
  // Frozen contract accepts our fixture snapshot (schema + derived rules).
  return SourceSnapshotSchema.parse(snap);
}

function graphFor(files: FixtureFile[]) {
  const snap = buildSnapshot(files);
  const contents = new Map(files.map((f) => [f.path, f.content] as const));
  const ev: EvidenceSnapshot = {
    snapshotId: snap.snapshotId,
    files: snap.files.map((f) => ({
      path: f.path,
      language: f.language,
      bytes: f.bytes,
      sha256: f.sha256,
      lineCount: f.lineCount,
    })),
    skipped: [],
    canonicalProvenance: snap.canonicalProvenance,
    resolvedCommitIfGitHub: null,
  };
  return { snap, ev, contents, graph: buildAstGraph(ev, contents) };
}

describe("P4 AST graph — fixture snapshot (frozen contract)", () => {
  it("snapshot validates against the frozen SourceSnapshot schema", () => {
    const snap = buildSnapshot(FIXTURE_SOURCES);
    expect(snap.sourceKind).toBe("synthetic");
    expect(snap.files).toHaveLength(9);
    expect(snap.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds module nodes for every fixture file", () => {
    const { graph } = graphFor(FIXTURE_SOURCES);
    const modules = graph.nodes.filter((n) => n.kind === "module");
    expect(modules.map((m) => m.module).sort()).toEqual(
      FIXTURE_SOURCES.map((f) => f.path).sort()
    );
    expect(graph.nodes.length).toBeGreaterThan(modules.length);
  });
});

describe("static import resolution", () => {
  it("resolves relative imports to real nodes with evidence lines", () => {
    const { graph } = graphFor(FIXTURE_SOURCES);
    const edge = (from: string, to: string, kind: string) =>
      graph.edges.find(
        (e) => e.from === moduleNodeId(from) && e.to === moduleNodeId(to) && e.kind === kind
      );
    expect(edge("src/index.ts", "src/router.ts", "imports")).toBeTruthy();
    expect(edge("src/index.ts", "src/api/orders.ts", "imports")).toBeTruthy();
    expect(edge("src/api/orders.ts", "src/lib/session.ts", "imports")).toBeTruthy();
    expect(
      graph.edges.find(
        (e) => e.from === moduleNodeId("src/index.ts") && e.to === moduleNodeId("src/router.ts")
      )?.line
    ).toBe(1);
  });

  it("marks missing modules explicit and unresolved, never resolved", () => {
    const { graph } = graphFor(FIXTURE_SOURCES);
    const miss = graph.edges.find((e) => e.specifier === "./missing-module");
    expect(miss?.kind).toBe("unresolvable");
    expect(graph.edges.some((e) => e.specifier === "./missing-module" && e.kind === "imports")).toBe(false);
  });

  it("external packages are explicit, never in-snapshot edges", () => {
    const { graph } = graphFor(FIXTURE_SOURCES);
    for (const spec of ["@acme/external-client", "date:util", "react"]) {
      const e = graph.edges.find((x) => x.specifier === spec);
      expect(e?.kind).toBe("external");
      expect(graph.nodes.some((n) => n.id === e?.to)).toBe(false);
    }
  });

  it("dynamic imports produce NO static resolved edges", () => {
    const { graph } = graphFor(FIXTURE_SOURCES);
    const lazyEdges = graph.edges.filter((e) => e.from === moduleNodeId("src/lib/lazy.ts"));
    expect(lazyEdges).toEqual([]);
  });
});

describe("exported members and named references", () => {
  it("extracts exported functions, classes, consts and TSX components with lines", () => {
    const { graph } = graphFor(FIXTURE_SOURCES);
    const byLabel = (label: string) => graph.nodes.find((n) => n.kind === "member" && n.label === label);
    expect(byLabel("getOrder")?.module).toBe("src/api/orders.ts");
    expect(byLabel("createRouter")?.module).toBe("src/router.ts");
    expect(byLabel("RouterError")?.module).toBe("src/router.ts");
    expect(byLabel("OrdersTable")?.module).toBe("src/components/OrdersTable.tsx");
    expect(byLabel("computeTotal")?.module).toBe("src/lib/math.ts");
    const txt = FIXTURE_SOURCES.find((f) => f.path === "src/api/orders.ts")!.content.split("\n");
    expect(txt[(byLabel("getOrder")!.line as number) - 1]).toContain("getOrder");
  });

  it("named references point importer -> exporter member", () => {
    const { graph } = graphFor(FIXTURE_SOURCES);
    const ref = graph.edges.find(
      (e) => e.kind === "references" && e.specifier === "./router"
    );
    expect(ref?.from).toBe(moduleNodeId("src/index.ts"));
    expect(ref?.to).toBe(`${moduleNodeId("src/router.ts")}#createRouter`);
  });
});

describe("evidence validation (Gate 5)", () => {
  it("shape and SHA verification pass for genuine fixtures", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    expect(validateGraphShape(graph, ev, contents)).toEqual({ ok: true, issues: [] });
    expect(validateEvidence(graph, ev, contents, nodeHash)).toEqual({ ok: true, issues: [] });
  });

  it("tampered content without rebuild fails SHA verification (fail closed)", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const tampered = new Map(contents);
    tampered.set("src/lib/math.ts", "export function computeTotal(n: number) { return 0; }\n");
    const result = validateEvidence(graph, ev, tampered, nodeHash);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/SHA-256|bytes/);
  });

  it("bad line numbers and fake edges fail shape validation", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const badLine = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === `${moduleNodeId("src/lib/math.ts")}#computeTotal` ? { ...n, line: 999 } : n
      ),
    };
    expect(validateGraphShape(badLine, ev, contents).ok).toBe(false);
    const fakeEdge = {
      ...graph,
      edges: [
        ...graph.edges,
        {
          from: moduleNodeId("src/index.ts"),
          to: moduleNodeId("src/nonexistent.ts"),
          kind: "imports" as const,
          specifier: "./nonexistent",
          line: 2,
        },
      ],
    };
    expect(validateGraphShape(fakeEdge, ev, contents).ok).toBe(false);
  });

  it("unsupported edges never fake resolved targets", () => {
    const { graph } = graphFor(FIXTURE_SOURCES);
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      if (e.kind === "external" || e.kind === "unresolvable") {
        expect(nodeIds.has(e.to)).toBe(false);
      }
      if (e.kind === "imports" || e.kind === "references") {
        expect(nodeIds.has(e.to)).toBe(true);
      }
    }
    expect(graph.unresolved.length).toBeGreaterThan(0);
  });

  it("excerpt is bounded and byte-exact for its file", () => {
    const math = FIXTURE_SOURCES.find((f) => f.path === "src/lib/math.ts")!;
    // computeTotal is declared on line 1; window (2,1,2) covers lines 1..4.
    const ex = excerptAround(math.content, 2, 1, 2);
    expect(ex[0]).toContain("computeTotal");
    expect(ex.length).toBe(4);
    expect(ex.join("\n")).toBe(math.content.split("\n").slice(0, 4).join("\n"));
  });
});

const F = (path: string, content: string): FixtureFile => ({
  path,
  language: path.endsWith(".tsx") ? "tsx" : "ts",
  content,
});

describe("FIX 1: evidence integrity — forged edges fail closed", () => {
  it("rejects a forged imports edge between two legitimate nodes", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const forged = {
      ...graph,
      edges: [
        ...graph.edges,
        // index.ts line 1 imports ./router, NOT src/lib/db.ts.
        { from: moduleNodeId("src/index.ts"), to: moduleNodeId("src/lib/db.ts"), kind: "imports" as const, specifier: "./router", line: 1 },
      ],
    };
    const r = validateGraphShape(forged, ev, contents);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/does not match source resolution/);
  });

  it("rejects a forged references edge with no matching import binding", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const forged = {
      ...graph,
      edges: [
        ...graph.edges,
        { from: moduleNodeId("src/index.ts"), to: `${moduleNodeId("src/router.ts")}#createRouter`, kind: "references" as const, specifier: "./lib/math", line: 1 },
      ],
    };
    expect(validateGraphShape(forged, ev, contents).ok).toBe(false);
  });

  it("rejects edge ownership lies, unknown sources, wrong line and wrong specifier", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const real = graph.edges.find((e) => e.kind === "imports")!;
    const variants = [
      { ...real, from: moduleNodeId("src/ghost.ts") },
      { ...real, from: moduleNodeId("src/api/orders.ts") },
      { ...real, line: real.line + 1 },
      { ...real, specifier: "./does-not-exist" },
      { ...real, line: 9999 },
    ];
    for (const v of variants) {
      const g = { ...graph, edges: [...graph.edges, v] };
      expect(validateGraphShape(g, ev, contents).ok).toBe(false);
    }
  });

  it("rejects provenance/commit mismatch and missing binding fields", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    expect(validateGraphShape(graph, ev, contents, { canonicalProvenance: "other:prov" }).ok).toBe(false);
    expect(validateGraphShape(graph, ev, contents, { resolvedCommitIfGitHub: "a".repeat(40) }).ok).toBe(false);
    const unbound = { ...graph, canonicalProvenance: "tampered" };
    expect(validateGraphShape(unbound, ev, contents).ok).toBe(false);
    const noCommit = { ...graph, resolvedCommitIfGitHub: "b".repeat(40) };
    expect(validateGraphShape(noCommit, ev, contents).ok).toBe(false);
  });

  it("fails closed without a hashFn, and on same-length SHA tampering", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const noHash = validateEvidence(graph, ev, contents);
    expect(noHash.ok).toBe(false);
    expect(noHash.issues.join(" ")).toMatch(/hashFn is required/);
    const tampered = new Map(contents);
    const orig = tampered.get("src/lib/math.ts")!;
    const sameLength = orig.replace("return n * n;", "return n + n;");
    expect(sameLength.length).toBe(orig.length);
    tampered.set("src/lib/math.ts", sameLength);
    const r = validateEvidence(graph, ev, tampered, nodeHash);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/SHA-256/);
  });

  it("fails on missing source bytes and on a moved member anchor", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const missing = new Map(contents);
    missing.delete("src/lib/session.ts");
    expect(validateEvidence(graph, ev, missing, nodeHash).ok).toBe(false);
    const moved = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === `${moduleNodeId("src/lib/math.ts")}#computeTotal` ? { ...n, line: 2 } : n
      ),
    };
    expect(validateGraphShape(moved, ev, contents).ok).toBe(false);
  });
});

describe("FIX 3: malformed source is downgraded, never resolved", () => {
  const files = [
    F("src/bad.ts", `import { goodFn } from "./good";\nexport function broken( {\n  return goodFn(;\n`),
    F("src/good.ts", `export function goodFn() {\n  return 1;\n}\n`),
  ];

  it("marks the module unsupported, suppresses members and resolved edges", () => {
    const { graph } = graphFor(files);
    expect(graph.unsupportedModules).toContain("src/bad.ts");
    expect(graph.nodes.some((n) => n.kind === "member" && n.module === "src/bad.ts")).toBe(false);
    const fromBad = graph.edges.filter((e) => e.from === moduleNodeId("src/bad.ts"));
    expect(fromBad.length).toBeGreaterThan(0);
    expect(fromBad.every((e) => e.kind === "unresolvable")).toBe(true);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/bad.ts"))).toBe(false);
  });

  it("the downgraded graph still passes structural validation", () => {
    const { graph, ev, contents } = graphFor(files);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
  });
});

describe("FIX 5: import semantics", () => {
  it("resolves imports from a root-level index.ts and into index.ts files", () => {
    const files = [
      F("index.ts", `import { utilFn } from "./util";\nimport { subFn } from "./sub";\nexport function main() {\n  return utilFn() + subFn();\n}\n`),
      F("util.ts", `export function utilFn() {\n  return 1;\n}\n`),
      F("sub/index.ts", `export function subFn() {\n  return 2;\n}\n`),
    ];
    const { graph } = graphFor(files);
    const has = (from: string, to: string, kind: string) =>
      graph.edges.some((e) => e.from === moduleNodeId(from) && e.to === to && e.kind === kind);
    expect(has("index.ts", moduleNodeId("util.ts"), "imports")).toBe(true);
    expect(has("index.ts", moduleNodeId("sub/index.ts"), "imports")).toBe(true);
    expect(has("index.ts", `${moduleNodeId("util.ts")}#utilFn`, "references")).toBe(true);
  });

  it("default imports reference only the default member, never a same-named named export", () => {
    const files = [
      F("src/target.ts", `export function Shared() {\n  return 1;\n}\nexport default function RealDefault() {\n  return 2;\n}\n`),
      F("src/user.ts", `import Shared from "./target";\nexport function useIt() {\n  return Shared();\n}\n`),
    ];
    const { graph } = graphFor(files);
    const refs = graph.edges.filter((e) => e.kind === "references" && e.from === moduleNodeId("src/user.ts"));
    expect(refs.map((r) => r.to)).toEqual([`${moduleNodeId("src/target.ts")}#RealDefault`]);
  });

  it("named aliases reference the original name; namespace imports reference no member", () => {
    const files = [
      F("src/math2.ts", `export function computeTotal(n: number) {\n  return n;\n}\n`),
      F("src/a.ts", `import { computeTotal as total } from "./math2";\nexport function a() {\n  return total(1);\n}\n`),
      F("src/b.ts", `import * as math from "./math2";\nexport function b() {\n  return math.computeTotal(1);\n}\n`),
    ];
    const { graph } = graphFor(files);
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/math2.ts")}#computeTotal` && e.from === moduleNodeId("src/a.ts"))).toBe(true);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/b.ts"))).toBe(false);
    expect(graph.edges.some((e) => e.kind === "imports" && e.from === moduleNodeId("src/b.ts"))).toBe(true);
  });

  it("local export lists and export assignments create truthful members", () => {
    const files = [
      F("src/list.ts", `function helper() {\n  return 1;\n}\nconst val = 2;\nexport { helper, val };\n`),
      F("src/widget.ts", `function Widget() {\n  return 1;\n}\nexport default Widget;\n`),
      F("src/use.ts", `import { helper } from "./list";\nimport Widget from "./widget";\nexport function use() {\n  return helper() + Widget();\n}\n`),
    ];
    const { graph } = graphFor(files);
    const member = (mod: string, label: string) =>
      graph.nodes.find((n) => n.kind === "member" && n.module === mod && n.label === label);
    expect(member("src/list.ts", "helper")?.declKind).toBe("function");
    expect(member("src/list.ts", "val")?.declKind).toBe("const");
    expect(member("src/widget.ts", "Widget")?.declKind).toBe("function");
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/list.ts")}#helper`)).toBe(true);
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/widget.ts")}#Widget`)).toBe(true);
  });

  it("re-exports are members of the re-exporting module and are referenceable", () => {
    const files = [
      F("src/math2.ts", `export function computeTotal(n: number) {\n  return n;\n}\n`),
      F("src/barrel.ts", `export { computeTotal } from "./math2";\n`),
      F("src/use.ts", `import { computeTotal } from "./barrel";\nexport function use() {\n  return computeTotal(1);\n}\n`),
    ];
    const { graph } = graphFor(files);
    const barrelMember = graph.nodes.find((n) => n.kind === "member" && n.module === "src/barrel.ts" && n.label === "computeTotal");
    expect(barrelMember?.declKind).toBe("re-export");
    expect(graph.edges.some((e) => e.kind === "imports" && e.from === moduleNodeId("src/barrel.ts") && e.to === moduleNodeId("src/math2.ts"))).toBe(true);
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/barrel.ts")}#computeTotal`)).toBe(true);
  });

  it("destructured exports are explicitly unsupported, not pseudo-members", () => {
    const files = [F("src/d.ts", `export const { a, b } = { a: 1, b: 2 };\n`)];
    const { graph } = graphFor(files);
    expect(graph.unsupportedForms.some((u) => u.module === "src/d.ts")).toBe(true);
    expect(graph.nodes.some((n) => n.kind === "member" && n.module === "src/d.ts")).toBe(false);
  });
});

describe("FIX 4 + FIX 7: excerpt numbering and declaration kinds", () => {
  it("line-1 excerpts start at 1 and short files never show zero/negative numbers", () => {
    const atOne = numberedExcerpt("a\nb\nc\nd\ne\n", 1, 2, 2);
    expect(atOne.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(atOne[0]?.target).toBe(true);
    const short = numberedExcerpt("only\ntwo", 1, 2, 2);
    expect(short.map((r) => r.n)).toEqual([1, 2]);
    const mid = numberedExcerpt(Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n"), 10, 2, 2);
    expect(mid.map((r) => r.n)).toEqual([8, 9, 10, 11, 12]);
    expect(mid.find((r) => r.target)?.n).toBe(10);
    expect(numberedExcerpt("x\n", 99, 2, 2).every((r) => r.n >= 1)).toBe(true);
  });

  it("constants are const, function-valued bindings are function, only real JSX is component", () => {
    const { graph } = graphFor(FIXTURE_SOURCES);
    const kind = (label: string) => graph.nodes.find((n) => n.kind === "member" && n.label === label)?.declKind;
    expect(kind("PI")).toBe("const");
    expect(kind("OrdersRoute")).toBe("const");
    expect(kind("UsersRoute")).toBe("const");
    expect(kind("lazy")).toBe("function");
    expect(kind("computeTotal")).toBe("function");
    expect(kind("OrdersTable")).toBe("function");
    expect(kind("RouterError")).toBe("class");
    const jsx = graphFor([F("src/W.tsx", `export const Widget = () => <div>hi</div>;\nexport const helper = () => 1;\n`)]);
    const jk = (label: string) => jsx.graph.nodes.find((n) => n.kind === "member" && n.label === label)?.declKind;
    expect(jk("Widget")).toBe("component");
    expect(jk("helper")).toBe("function");
  });

  it("reproducible graph counts are computed from the fixtures", () => {
    const { graph } = graphFor(FIXTURE_SOURCES);
    const counts = {
      modules: graph.nodes.filter((n) => n.kind === "module").length,
      members: graph.nodes.filter((n) => n.kind === "member").length,
      imports: graph.edges.filter((e) => e.kind === "imports").length,
      references: graph.edges.filter((e) => e.kind === "references").length,
      external: graph.edges.filter((e) => e.kind === "external").length,
      unresolvable: graph.edges.filter((e) => e.kind === "unresolvable").length,
    };
    // Values observed by executing this probe (see GRAPH_COUNTS.txt in the
    // C002 evidence). The two unresolvable specifiers are ./missing-module
    // and ./lazy (src/api/lazy.* does not exist; src/lib/lazy.ts is NOT a
    // sibling of src/api/users.ts). No import involves any index.tsx file.
    expect(counts).toEqual({ modules: 9, members: 16, imports: 10, references: 4, external: 3, unresolvable: 2 });
    expect(graph.edges.filter((e) => e.kind === "unresolvable").map((e) => e.specifier).sort()).toEqual(["./lazy", "./missing-module"]);
  });
});

describe("C003 F1: canonical identity and source-derived members", () => {
  it("1. rejects a node ID that disagrees with its module path", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const bad = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.kind === "module" && n.module === "src/lib/math.ts"
          ? { ...n, id: moduleNodeId("src/lib/session.ts") }
          : n
      ),
    };
    const r = validateGraphShape(bad, ev, contents);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/does not match its module path|duplicate node id/);
  });

  it("2. rejects duplicate canonical node IDs", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const dup = { ...graph, nodes: [...graph.nodes, graph.nodes[0]!] };
    const r = validateGraphShape(dup, ev, contents);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/duplicate node id/);
  });

  it("3. rejects forged member tables and forged member nodes", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const forgedTable = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.kind === "module" && n.module === "src/lib/math.ts"
          ? { ...n, members: { ...n.members, evil: { name: "evil", kind: "function", line: 1 } } }
          : n
      ),
    };
    expect(validateGraphShape(forgedTable, ev, contents).ok).toBe(false);
    const forgedNode = {
      ...forgedTable,
      nodes: [
        ...forgedTable.nodes,
        { id: `${moduleNodeId("src/lib/math.ts")}#evil`, kind: "member" as const, label: "evil", module: "src/lib/math.ts", line: 1, members: {}, declKind: "function" },
      ],
    };
    const r = validateGraphShape(forgedNode, ev, contents);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/not derived from parsed source|member table/);
  });
});

describe("C003 F5/F3/F7: exact export identity, malformed targets, labels", () => {
  it("4. default-only Foo is not a named export; default import references it exactly", () => {
    const files = [
      F("src/target.ts", `export default function Foo() {\n  return 1;\n}\n`),
      F("src/named.ts", `import { Foo } from "./target";\nexport function useNamed() {\n  return Foo();\n}\n`),
      F("src/def.ts", `import Foo from "./target";\nexport function useDef() {\n  return Foo();\n}\n`),
    ];
    const { graph } = graphFor(files);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/named.ts"))).toBe(false);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/def.ts") && e.to === `${moduleNodeId("src/target.ts")}#Foo`)).toBe(true);
    const mod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/target.ts");
    expect(mod?.namedExports).toEqual([]);
    expect(mod?.defaultMember).toBe("Foo");
  });

  it("5. Foo vs FooBar: no prefix/substring identity for named or default references", () => {
    const files = [
      F("src/target.ts", `export default function FooBar() {\n  return 1;\n}\n`),
      F("src/named.ts", `import { Foo } from "./target";\nexport function useNamed() {\n  return Foo;\n}\n`),
      F("src/def.ts", `import Foo from "./target";\nexport function useDef() {\n  return Foo();\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/named.ts"))).toBe(false);
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/target.ts")}#FooBar`)).toBe(true);
    // Forged reference to a non-existent #Foo member is rejected.
    const forged = {
      ...graph,
      nodes: [...graph.nodes, { id: `${moduleNodeId("src/target.ts")}#Foo`, kind: "member" as const, label: "Foo", module: "src/target.ts", line: 1, members: {}, declKind: "function" }],
      edges: [...graph.edges, { from: moduleNodeId("src/named.ts"), to: `${moduleNodeId("src/target.ts")}#Foo`, kind: "references" as const, specifier: "./target", line: 1 }],
    };
    expect(validateGraphShape(forged, ev, contents).ok).toBe(false);
  });

  it("6. type-only imports create no value references, and forged ones are rejected", () => {
    const files = [
      F("src/target.ts", `export function compute() {\n  return 1;\n}\n`),
      F("src/user.ts", `import type { compute } from "./target";\nexport function useIt() {\n  return 1;\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/user.ts"))).toBe(false);
    const forged = {
      ...graph,
      edges: [...graph.edges, { from: moduleNodeId("src/user.ts"), to: `${moduleNodeId("src/target.ts")}#compute`, kind: "references" as const, specifier: "./target", line: 1 }],
    };
    expect(validateGraphShape(forged, ev, contents).ok).toBe(false);
  });

  it("7. type-only re-exports create no value members or references", () => {
    const files = [
      F("src/target.ts", `export function compute() {\n  return 1;\n}\n`),
      F("src/barrel.ts", `export type { compute } from "./target";\n`),
      F("src/user.ts", `import { compute } from "./barrel";\nexport function useIt() {\n  return compute();\n}\n`),
    ];
    const { graph } = graphFor(files);
    expect(graph.nodes.some((n) => n.kind === "member" && n.module === "src/barrel.ts")).toBe(false);
    expect(graph.edges.some((e) => e.kind === "references")).toBe(false);
    const barrel = graph.nodes.find((n) => n.kind === "module" && n.module === "src/barrel.ts");
    expect(barrel?.namedExports).toEqual([]);
  });

  it("8. valid importer into a malformed target is downgraded, never resolved", () => {
    const files = [
      F("src/good.ts", `import { thing } from "./bad";\nexport function useIt() {\n  return thing;\n}\n`),
      F("src/bad.ts", `export function thing( {\n  return 1;\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    expect(graph.unsupportedModules).toContain("src/bad.ts");
    const edge = graph.edges.find((e) => e.from === moduleNodeId("src/good.ts"));
    expect(edge?.kind).toBe("unresolvable");
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/good.ts"))).toBe(false);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
    const forged = {
      ...graph,
      edges: [...graph.edges, { from: moduleNodeId("src/good.ts"), to: moduleNodeId("src/bad.ts"), kind: "imports" as const, specifier: "./bad", line: 1 }],
    };
    expect(validateGraphShape(forged, ev, contents).ok).toBe(false);
  });

  it("9. local export { Foo as default } makes Foo the default only", () => {
    const files = [
      F("src/mod.ts", `function Foo() {\n  return 1;\n}\nexport { Foo as default };\n`),
      F("src/def.ts", `import Foo from "./mod";\nexport function useDef() {\n  return Foo();\n}\n`),
      F("src/named.ts", `import { Foo } from "./mod";\nexport function useNamed() {\n  return Foo;\n}\n`),
    ];
    const { graph } = graphFor(files);
    const mod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/mod.ts");
    expect(mod?.defaultMember).toBe("Foo");
    expect(mod?.namedExports).toEqual([]);
    expect(graph.nodes.some((n) => n.kind === "member" && n.label === "default")).toBe(false);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/def.ts") && e.to === `${moduleNodeId("src/mod.ts")}#Foo`)).toBe(true);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/named.ts"))).toBe(false);
  });

  it("10. export = Foo is explicitly unsupported, never a default identity", () => {
    const files = [
      F("src/mod.ts", `function Foo() {\n  return 1;\n}\nexport = Foo;\n`),
      F("src/def.ts", `import Foo from "./mod";\nexport function useDef() {\n  return Foo;\n}\n`),
    ];
    const { graph } = graphFor(files);
    expect(graph.unsupportedForms.some((u) => u.module === "src/mod.ts" && u.form.includes("export ="))).toBe(true);
    const mod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/mod.ts");
    expect(mod?.defaultMember).toBeNull();
    expect(graph.edges.some((e) => e.kind === "references")).toBe(false);
  });

  it("11. const/let/var labels are distinguished; function labels preserved", () => {
    const files = [
      F("src/vars.ts", `export let count = 0;\nexport var legacy = "x";\nexport const fixed = 1;\nexport let fn = () => 1;\n`),
    ];
    const { graph } = graphFor(files);
    const kind = (label: string) => graph.nodes.find((n) => n.kind === "member" && n.label === label)?.declKind;
    expect(kind("count")).toBe("let");
    expect(kind("legacy")).toBe("var");
    expect(kind("fixed")).toBe("const");
    expect(kind("fn")).toBe("function");
  });
});

describe("C004 F1/F3: source-derived unsupported metadata cannot be forged", () => {
  const targetFiles = [
    F("src/good.ts", `import { thing } from "./bad";\nexport function useIt() {\n  return thing;\n}\n`),
    F("src/bad.ts", `export function thing( {\n  return 1;\n`),
  ];
  const importerFiles = [
    F("src/bad.ts", `import { goodFn } from "./good";\nexport function broken( {\n  return goodFn(;\n`),
    F("src/good.ts", `export function goodFn() {\n  return 1;\n}\n`),
  ];

  it("1. forged unsupportedModules = [] is rejected against source-derived state", () => {
    const { graph, ev, contents } = graphFor(targetFiles);
    expect(graph.unsupportedModules).toEqual(["src/bad.ts"]);
    const forged = { ...graph, unsupportedModules: [] as string[] };
    const r = validateGraphShape(forged, ev, contents);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/unsupportedModules metadata does not match/);
  });

  it("2. a downgraded edge promoted to imports (metadata cleared) is rejected", () => {
    const { graph, ev, contents } = graphFor(targetFiles);
    const forged = {
      ...graph,
      unsupportedModules: [] as string[],
      unresolved: [] as typeof graph.unresolved,
      edges: graph.edges.map((e) =>
        e.kind === "unresolvable"
          ? { ...e, kind: "imports" as const, to: moduleNodeId("src/bad.ts") }
          : e
      ),
    };
    const r = validateGraphShape(forged, ev, contents);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/unsupported|edges do not match/);
  });

  it("3. forged/cleared unresolved metadata is rejected", () => {
    const { graph, ev, contents } = graphFor(targetFiles);
    const forged = { ...graph, unresolved: [] as typeof graph.unresolved };
    const r = validateGraphShape(forged, ev, contents);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/unresolved metadata does not match/);
  });

  it("4. forged resolved edge FROM malformed source is rejected", () => {
    const { graph, ev, contents } = graphFor(importerFiles);
    const forged = {
      ...graph,
      edges: [
        ...graph.edges,
        { from: moduleNodeId("src/bad.ts"), to: moduleNodeId("src/good.ts"), kind: "imports" as const, specifier: "./good", line: 1 },
      ],
    };
    const r = validateGraphShape(forged, ev, contents);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/from unsupported module|edges do not match/);
  });

  it("5. forged resolved edge INTO malformed source is rejected", () => {
    const { graph, ev, contents } = graphFor(targetFiles);
    const forged = {
      ...graph,
      edges: [
        ...graph.edges,
        { from: moduleNodeId("src/good.ts"), to: moduleNodeId("src/bad.ts"), kind: "imports" as const, specifier: "./bad", line: 1 },
      ],
    };
    const r = validateGraphShape(forged, ev, contents);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/into unsupported module|edges do not match/);
  });

  it("6. valid importer + malformed target: downgraded only, genuine graph validates", () => {
    const { graph, ev, contents } = graphFor(targetFiles);
    const edge = graph.edges.find((e) => e.from === moduleNodeId("src/good.ts"));
    expect(edge?.kind).toBe("unresolvable");
    expect(edge?.specifier).toBe("./bad");
    expect(graph.edges.some((e) => e.kind === "imports" && e.to === moduleNodeId("src/bad.ts"))).toBe(false);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
  });

  it("7. malformed importer + valid target: no resolved edges from the importer", () => {
    const { graph, ev, contents } = graphFor(importerFiles);
    const fromBad = graph.edges.filter((e) => e.from === moduleNodeId("src/bad.ts"));
    expect(fromBad.length).toBeGreaterThan(0);
    expect(fromBad.every((e) => e.kind === "unresolvable")).toBe(true);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
  });
});

describe("C004 F5/F7: transitive type-only chains and nested JSX", () => {
  it("8+9. transitive type-only re-export chain never promotes Foo to a value", () => {
    const files = [
      F("src/a.ts", `export function Foo() {\n  return 1;\n}\n`),
      F("src/t.ts", `export type { Foo } from "./a";\n`),
      F("src/b.ts", `export { Foo } from "./t";\n`),
      F("src/consumer.ts", `import { Foo } from "./b";\nexport function useIt() {\n  return Foo();\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    const bMod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts");
    expect(bMod?.namedExports).toEqual([]);
    expect(graph.nodes.some((n) => n.kind === "member" && n.module === "src/b.ts")).toBe(false);
    expect(graph.edges.some((e) => e.kind === "references")).toBe(false);
    expect(graph.unsupportedForms.some((u) => u.module === "src/b.ts" && u.form.includes("not verified as a value export"))).toBe(true);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
    // Forging the value reference anyway is rejected.
    const forged = {
      ...graph,
      nodes: [...graph.nodes, { id: `${moduleNodeId("src/b.ts")}#Foo`, kind: "member" as const, label: "Foo", module: "src/b.ts", line: 1, members: {}, declKind: "re-export" }],
      edges: [...graph.edges, { from: moduleNodeId("src/consumer.ts"), to: `${moduleNodeId("src/b.ts")}#Foo`, kind: "references" as const, specifier: "./b", line: 1 }],
    };
    expect(validateGraphShape(forged, ev, contents).ok).toBe(false);
  });

  it("10. valid value re-export chain remains valid, in any file order", () => {
    const files = [
      F("src/consumer.ts", `import { Foo } from "./b2";\nexport function useIt() {\n  return Foo();\n}\n`),
      F("src/b2.ts", `export { Foo } from "./b1";\n`),
      F("src/b1.ts", `export { Foo } from "./a";\n`),
      F("src/a.ts", `export function Foo() {\n  return 1;\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    expect(graph.nodes.find((n) => n.kind === "module" && n.module === "src/b1.ts")?.namedExports).toEqual(["Foo"]);
    expect(graph.nodes.find((n) => n.kind === "module" && n.module === "src/b2.ts")?.namedExports).toEqual(["Foo"]);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/consumer.ts") && e.to === `${moduleNodeId("src/b2.ts")}#Foo`)).toBe(true);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
  });

  it("11. Factory returning an object with nested JSX is a function, not a component", () => {
    const files = [
      F("src/W.tsx", `export const Factory = () => ({ render: () => <div /> });\nexport const Holder = () => ({ el: <div /> });\n`),
    ];
    const { graph } = graphFor(files);
    const kind = (label: string) => graph.nodes.find((n) => n.kind === "member" && n.label === label)?.declKind;
    expect(kind("Factory")).toBe("function");
    expect(kind("Holder")).toBe("function");
  });

  it("12. direct JSX components are still detected (expression and block returns)", () => {
    const files = [
      F("src/W.tsx", `export const Widget = () => <div>hi</div>;\nexport const Panel = () => {\n  return <section />;\n};\nexport const helper = () => 1;\n`),
    ];
    const { graph } = graphFor(files);
    const kind = (label: string) => graph.nodes.find((n) => n.kind === "member" && n.label === label)?.declKind;
    expect(kind("Widget")).toBe("component");
    expect(kind("Panel")).toBe("component");
    expect(kind("helper")).toBe("function");
  });
});

describe("C005 F1: node completeness (missing nodes fail closed)", () => {
  it("1. entire node list omitted fails structural AND full evidence validation", () => {
    const files = [F("src/one.ts", `export const x = 1;\n`)];
    const { graph, ev, contents } = graphFor(files);
    const empty = { ...graph, nodes: [] };
    const shape = validateGraphShape(empty, ev, contents);
    expect(shape.ok).toBe(false);
    expect(shape.issues.join(" ")).toMatch(/expected node missing/);
    expect(validateEvidence(empty, ev, contents, nodeHash).ok).toBe(false);
  });

  it("2. an isolated module with no edges cannot be omitted", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const missing = {
      ...graph,
      nodes: graph.nodes.filter((n) => n.id !== moduleNodeId("src/lib/math.ts")),
    };
    expect(validateGraphShape(missing, ev, contents).ok).toBe(false);
  });

  it("3. an isolated exported member cannot be omitted", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const missing = {
      ...graph,
      nodes: graph.nodes.filter((n) => n.id !== `${moduleNodeId("src/lib/math.ts")}#PI`),
    };
    const r = validateGraphShape(missing, ev, contents);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/expected node missing/);
  });

  it("4. extra and duplicate canonical nodes are rejected", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const dup = { ...graph, nodes: [...graph.nodes, graph.nodes[0]!] };
    expect(validateGraphShape(dup, ev, contents).ok).toBe(false);
    const extra = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: `${moduleNodeId("src/lib/math.ts")}#nope`, kind: "member" as const, label: "nope", module: "src/lib/math.ts", line: 1, members: {}, declKind: "const" },
      ],
    };
    expect(validateGraphShape(extra, ev, contents).ok).toBe(false);
  });

  it("5. a SHA-valid genuine snapshot still fails when nodes are missing", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    // ev carries real per-file SHA-256 (graphFor builds a real snapshot).
    expect(validateEvidence(graph, ev, contents, nodeHash).ok).toBe(true);
    const missing = { ...graph, nodes: graph.nodes.slice(1) };
    expect(validateEvidence(missing, ev, contents, nodeHash).ok).toBe(false);
  });
});

describe("C005 F5: re-export identity conflicts are unsupported, never adopted", () => {
  it("6+7. local Foo + re-exported default Foo: default import cannot reference the wrong Foo", () => {
    const files = [
      F("src/a.ts", `export const Foo = 1;\n`),
      F("src/b.ts", `export const Foo = 2;\nexport { Foo as default } from "./a";\n`),
      F("src/consumer.ts", `import Foo from "./b";\nexport function useIt() {\n  return Foo;\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    const bMod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts");
    expect(bMod?.defaultMember).toBeNull();
    // The local Foo keeps its own named identity.
    expect(bMod?.namedExports).toEqual(["Foo"]);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/consumer.ts"))).toBe(false);
    expect(graph.unsupportedForms.some((u) => u.module === "src/b.ts" && u.form.includes("conflicting re-export identity"))).toBe(true);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
  });

  it("8. conflicting same-name re-exports from different origins are unsupported", () => {
    const files = [
      F("src/a.ts", `export const Foo = 1;\n`),
      F("src/c.ts", `export const Foo = 3;\n`),
      F("src/b.ts", `export { Foo } from "./a";\nexport { Foo } from "./c";\n`),
      F("src/consumer.ts", `import { Foo } from "./b";\nexport function useIt() {\n  return Foo;\n}\n`),
    ];
    const { graph } = graphFor(files);
    const bMod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts");
    expect(bMod?.namedExports).toEqual([]);
    expect(graph.nodes.some((n) => n.kind === "member" && n.module === "src/b.ts")).toBe(false);
    expect(graph.edges.some((e) => e.kind === "references")).toBe(false);
    expect(graph.unsupportedForms.some((u) => u.module === "src/b.ts" && u.form.includes("conflicting re-export identity"))).toBe(true);
  });

  it("9. bare export * member set is explicitly unsupported", () => {
    const files = [
      F("src/a.ts", `export const Foo = 1;\n`),
      F("src/b.ts", `export * from "./a";\n`),
      F("src/consumer.ts", `import { Foo } from "./b";\nexport function useIt() {\n  return Foo;\n}\n`),
    ];
    const { graph } = graphFor(files);
    expect(graph.unsupportedForms.some((u) => u.module === "src/b.ts" && u.form.includes("export *"))).toBe(true);
    expect(graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts")?.namedExports).toEqual([]);
    expect(graph.edges.some((e) => e.kind === "references")).toBe(false);
  });

  it("10. valid named and default value re-exports still work", () => {
    const files = [
      F("src/a.ts", `export const Foo = 1;\n`),
      F("src/named.ts", `export { Foo } from "./a";\n`),
      F("src/def.ts", `export { Foo as default } from "./a";\n`),
      F("src/cn.ts", `import { Foo } from "./named";\nexport function useN() {\n  return Foo;\n}\n`),
      F("src/cd.ts", `import Foo from "./def";\nexport function useD() {\n  return Foo;\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/named.ts")}#Foo`)).toBe(true);
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/def.ts")}#Foo`)).toBe(true);
    expect(graph.nodes.find((n) => n.kind === "module" && n.module === "src/def.ts")?.defaultMember).toBe("Foo");
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
  });

  it("11. transitive type-only re-export remains blocked", () => {
    const files = [
      F("src/a.ts", `export function Foo() {\n  return 1;\n}\n`),
      F("src/t.ts", `export type { Foo } from "./a";\n`),
      F("src/b.ts", `export { Foo } from "./t";\n`),
      F("src/consumer.ts", `import { Foo } from "./b";\nexport function useIt() {\n  return Foo();\n}\n`),
    ];
    const { graph } = graphFor(files);
    expect(graph.edges.some((e) => e.kind === "references")).toBe(false);
    expect(graph.nodes.some((n) => n.kind === "member" && n.module === "src/b.ts")).toBe(false);
  });
});

describe("C005 F7: overridden JSX returns are not components", () => {
  it("12. try/finally overridden JSX return classifies as function", () => {
    const files = [
      F("src/W.tsx", `export const Factory = () => {\n  try {\n    return <div />;\n  } finally {\n    return { render: () => <span /> };\n  }\n};\n`),
    ];
    const { graph } = graphFor(files);
    expect(graph.nodes.find((n) => n.kind === "member" && n.label === "Factory")?.declKind).toBe("function");
  });

  it("13+14. genuine direct, block and conditional JSX returns stay components", () => {
    const files = [
      F("src/W.tsx", `export const Widget = () => <div>hi</div>;\nexport const Panel = () => {\n  return <section />;\n};\nexport const Cond = (p: { ok: boolean }) => (p.ok ? <div /> : <span />);\nexport const helper = () => 1;\n`),
    ];
    const { graph } = graphFor(files);
    const kind = (label: string) => graph.nodes.find((n) => n.kind === "member" && n.label === label)?.declKind;
    expect(kind("Widget")).toBe("component");
    expect(kind("Panel")).toBe("component");
    expect(kind("Cond")).toBe("component");
    expect(kind("helper")).toBe("function");
  });
});

describe("C006 F1: source completeness (missing bytes fail closed)", () => {
  it("1. nonempty snapshot + empty contents FAILs structural validation", () => {
    const { graph, ev } = graphFor([F("src/one.ts", `export const x = 1;\n`)]);
    const forged = { ...graph, nodes: [], edges: [], unresolved: [], unsupportedModules: [] as string[], unsupportedForms: [] };
    const r = validateGraphShape(forged, ev, new Map());
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/no content bytes/);
    // Even the genuine graph cannot validate without source bytes.
    expect(validateGraphShape(graph, ev, new Map()).ok).toBe(false);
  });

  it("2. one missing file among many FAILs", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const partial = new Map(contents);
    partial.delete("src/lib/db.ts");
    const r = validateGraphShape(graph, ev, partial);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/no content bytes|no expected module coverage/);
  });

  it("3+4. empty forged graph fails; complete valid source/graph PASSes", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    expect(validateGraphShape(graph, ev, contents)).toEqual({ ok: true, issues: [] });
    const forged = { ...graph, nodes: [], edges: [], unresolved: [], unsupportedModules: [] as string[], unsupportedForms: [] };
    expect(validateGraphShape(forged, ev, contents).ok).toBe(false);
  });

  it("5. full evidence validation rejects missing source, accepts valid hashed input", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    expect(validateEvidence(graph, ev, contents, nodeHash).ok).toBe(true);
    expect(validateEvidence(graph, ev, new Map(), nodeHash).ok).toBe(false);
  });

  it("6. missing isolated module/member still FAILs", () => {
    const { graph, ev, contents } = graphFor(FIXTURE_SOURCES);
    const noModule = { ...graph, nodes: graph.nodes.filter((n) => n.id !== moduleNodeId("src/lib/lazy.ts")) };
    expect(validateGraphShape(noModule, ev, contents).ok).toBe(false);
    const noMember = { ...graph, nodes: graph.nodes.filter((n) => n.id !== `${moduleNodeId("src/lib/math.ts")}#PI`) };
    expect(validateGraphShape(noMember, ev, contents).ok).toBe(false);
  });
});

describe("C006 F5: origin identity across slots, propagation, upstream default", () => {
  it("7+8. named/default different origins cannot share one member anchor", () => {
    const files = [
      F("src/a.ts", `export const Foo = 1;\n`),
      F("src/c.ts", `export const Foo = 3;\n`),
      F("src/b.ts", `export { Foo } from "./a";\nexport { Foo as default } from "./c";\n`),
      F("src/cn.ts", `import { Foo } from "./b";\nexport function useN() {\n  return Foo;\n}\n`),
      F("src/cd.ts", `import Foo from "./b";\nexport function useD() {\n  return Foo;\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    const bMod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts");
    expect(bMod?.namedExports).toEqual(["Foo"]);
    expect(bMod?.defaultMember).toBeNull();
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/cn.ts") && e.to === `${moduleNodeId("src/b.ts")}#Foo`)).toBe(true);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/cd.ts"))).toBe(false);
    expect(graph.unsupportedForms.some((u) => u.module === "src/b.ts" && u.form.includes("conflicting"))).toBe(true);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
  });

  const chainFiles = () => [
    F("src/down.ts", `export { Foo } from "./mid";\n`),
    F("src/mid.ts", `export { Foo } from "./chain";\nexport { Foo } from "./a";\n`),
    F("src/a.ts", `export const Foo = 1;\n`),
    F("src/chain.ts", `export { Foo } from "./base";\n`),
    F("src/base.ts", `export const Foo = 5;\n`),
    F("src/consumer.ts", `import { Foo } from "./down";\nexport function useIt() {\n  return Foo;\n}\n`),
  ];

  it("9+10. upstream invalidation propagates downstream, order-independent", () => {
    for (const files of [chainFiles(), [...chainFiles()].reverse()]) {
      const { graph, ev, contents } = graphFor(files);
      expect(graph.nodes.find((n) => n.kind === "module" && n.module === "src/down.ts")?.namedExports).toEqual([]);
      expect(graph.nodes.some((n) => n.kind === "member" && n.module === "src/down.ts")).toBe(false);
      expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/consumer.ts"))).toBe(false);
      expect(graph.unsupportedForms.some((u) => u.module === "src/down.ts")).toBe(true);
      expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
    }
  });

  it("11. export { default as Foo } resolves the upstream default truthfully", () => {
    const files = [
      F("src/a.ts", `export default function Foo() {\n  return 1;\n}\n`),
      F("src/b.ts", `export { default as Foo } from "./a";\n`),
      F("src/consumer.ts", `import { Foo } from "./b";\nexport function useIt() {\n  return Foo();\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    expect(graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts")?.namedExports).toEqual(["Foo"]);
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/b.ts")}#Foo`)).toBe(true);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
  });

  it("12. valid named and default exports survive together", () => {
    const files = [
      F("src/a.ts", `export const Foo = 1;\nexport default function Bar() {\n  return 2;\n}\n`),
      F("src/cn.ts", `import { Foo } from "./a";\nexport function useN() {\n  return Foo;\n}\n`),
      F("src/cd.ts", `import Bar from "./a";\nexport function useD() {\n  return Bar();\n}\n`),
    ];
    const { graph } = graphFor(files);
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/a.ts")}#Foo`)).toBe(true);
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/a.ts")}#Bar`)).toBe(true);
  });

  it("13+14. transitive type-only stays blocked; export * and export = stay unsupported", () => {
    const typeChain = graphFor([
      F("src/a.ts", `export function Foo() {\n  return 1;\n}\n`),
      F("src/t.ts", `export type { Foo } from "./a";\n`),
      F("src/b.ts", `export { Foo } from "./t";\n`),
      F("src/consumer.ts", `import { Foo } from "./b";\nexport function useIt() {\n  return Foo();\n}\n`),
    ]);
    expect(typeChain.graph.edges.some((e) => e.kind === "references")).toBe(false);
    const star = graphFor([F("src/a.ts", `export const Foo = 1;\n`), F("src/b.ts", `export * from "./a";\n`)]);
    expect(star.graph.unsupportedForms.some((u) => u.form.includes("export *"))).toBe(true);
    const eq = graphFor([F("src/m.ts", `function Foo() {\n  return 1;\n}\nexport = Foo;\n`)]);
    expect(eq.graph.unsupportedForms.some((u) => u.form.includes("export ="))).toBe(true);
  });

  it("15. re-export cycles terminate honestly as unsupported", () => {
    const files = [
      F("src/a.ts", `export { Foo } from "./b";\n`),
      F("src/b.ts", `export { Foo } from "./a";\n`),
      F("src/consumer.ts", `import { Foo } from "./a";\nexport function useIt() {\n  return Foo;\n}\n`),
    ];
    const { graph } = graphFor(files);
    expect(graph.edges.some((e) => e.kind === "references")).toBe(false);
    expect(graph.nodes.some((n) => n.kind === "member" && (n.module === "src/a.ts" || n.module === "src/b.ts"))).toBe(false);
    expect(graph.unsupportedForms.length).toBeGreaterThan(0);
  });
});

describe("C006 F7: mixed return flow is never a reliable component", () => {
  const kindOf = (content: string, label: string) =>
    graphFor([F("src/W.tsx", content)]).graph.nodes.find((n) => n.kind === "member" && n.label === label)?.declKind;

  it("16. conditional finally JSX + numeric try return => function", () => {
    expect(kindOf(`export const Factory = (flag: boolean) => {\n  try {\n    return 123;\n  } finally {\n    if (flag) return <div />;\n  }\n};\n`, "Factory")).toBe("function");
  });

  it("17. JSX versus object conditional expression => function", () => {
    expect(kindOf(`export const Mixed = (flag: boolean) => (flag ? <div /> : { el: 1 });\n`, "Mixed")).toBe("function");
  });

  it("18. unconditional finally object override of JSX => function", () => {
    expect(kindOf(`export const Factory = () => {\n  try {\n    return <div />;\n  } finally {\n    return { render: () => <span /> };\n  }\n};\n`, "Factory")).toBe("function");
  });

  it("19+20. direct JSX and both-branches-JSX conditional => component", () => {
    expect(kindOf(`export const Widget = () => <div>hi</div>;\n`, "Widget")).toBe("component");
    expect(kindOf(`export const Cond = (p: { ok: boolean }) => (p.ok ? <div /> : <span />);\n`, "Cond")).toBe("component");
    expect(kindOf(`export const Panel = () => {\n  return <section />;\n};\n`, "Panel")).toBe("component");
  });

  it("21. nested JSX only => function", () => {
    expect(kindOf(`export const Factory = () => ({ render: () => <div /> });\n`, "Factory")).toBe("function");
  });
});

describe("C007 F5: slot-exact, order-independent, tagged re-export identity", () => {
  const conflictFiles = () => [
    F("src/a.ts", `export const Foo = 1;\n`),
    F("src/c.ts", `export const Foo = 3;\n`),
    F("src/b.ts", `export { Foo } from "./a";\nexport { Foo as default } from "./a";\nexport { Foo as default } from "./c";\n`),
    F("src/cn.ts", `import { Foo } from "./b";\nexport function useN() {\n  return Foo;\n}\n`),
    F("src/cd.ts", `import Foo from "./b";\nexport function useD() {\n  return Foo;\n}\n`),
  ];

  it("1+2+3. three-statement same-slot default conflict, either statement order, admits no false reference", () => {
    const variants = [
      conflictFiles(),
      conflictFiles().map((f) =>
        f.path === "src/b.ts"
          ? F("src/b.ts", `export { Foo } from "./a";\nexport { Foo as default } from "./c";\nexport { Foo as default } from "./a";\n`)
          : f
      ),
    ];
    for (const files of variants) {
      const { graph, ev, contents } = graphFor(files);
      const bMod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts");
      expect(bMod?.namedExports).toEqual(["Foo"]);
      expect(bMod?.defaultMember).toBeNull();
      expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/cn.ts"))).toBe(true);
      expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/cd.ts"))).toBe(false);
      expect(graph.unsupportedForms.some((u) => u.module === "src/b.ts" && u.form.includes("conflicting"))).toBe(true);
      expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
    }
  });

  it("4+5. named/default conflicting origins are equivalent in both file orders", () => {
    const mk = () => [
      F("src/z.ts", `export const Foo = 1;\n`),
      F("src/chain.ts", `export { Foo } from "./z";\n`),
      F("src/d.ts", `export const Foo = 9;\n`),
      F("src/b.ts", `export { Foo } from "./chain";\nexport { Foo as default } from "./d";\n`),
      F("src/cn.ts", `import { Foo } from "./b";\nexport function useN() {\n  return Foo;\n}\n`),
      F("src/cd.ts", `import Foo from "./b";\nexport function useD() {\n  return Foo;\n}\n`),
    ];
    const summarize = (files: FixtureFile[]) => {
      const { graph } = graphFor(files);
      const bMod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts");
      return {
        named: [...(bMod?.namedExports ?? [])].sort(),
        def: bMod?.defaultMember ?? null,
        refs: graph.edges.filter((e) => e.kind === "references").map((e) => `${e.from}->${e.to}`).sort(),
      };
    };
    const forward = summarize(mk());
    expect(summarize([...mk()].reverse())).toEqual(forward);
    expect(forward.named).toEqual(["Foo"]);
    expect(forward.def).toBeNull();
    expect(forward.refs.some((r) => r.startsWith(moduleNodeId("src/cn.ts")))).toBe(true);
    expect(forward.refs.some((r) => r.startsWith(moduleNodeId("src/cd.ts")))).toBe(false);
  });

  it("6. late upstream invalidation propagates across three or more modules, both orders", () => {
    const mk = () => [
      F("src/down.ts", `export { Foo } from "./mid";\n`),
      F("src/mid.ts", `export { Foo } from "./chain";\nexport { Foo } from "./a";\n`),
      F("src/a.ts", `export const Foo = 1;\n`),
      F("src/chain.ts", `export { Foo } from "./base";\n`),
      F("src/base.ts", `export const Foo = 5;\n`),
      F("src/consumer.ts", `import { Foo } from "./down";\nexport function useIt() {\n  return Foo;\n}\n`),
    ];
    for (const files of [mk(), [...mk()].reverse()]) {
      const { graph } = graphFor(files);
      expect(graph.nodes.find((n) => n.kind === "module" && n.module === "src/down.ts")?.namedExports).toEqual([]);
      expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/consumer.ts"))).toBe(false);
    }
  });

  it("7. legal named __default__ with no corresponding value export stays unsupported", () => {
    const files = [
      F("src/a.ts", `export default 1;\n`),
      F("src/b.ts", `export { __default__ as Foo } from "./a";\n`),
      F("src/consumer.ts", `import { Foo } from "./b";\nexport function useIt() {\n  return Foo;\n}\n`),
    ];
    const { graph } = graphFor(files);
    expect(graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts")?.namedExports).toEqual([]);
    expect(graph.edges.some((e) => e.kind === "references")).toBe(false);
    expect(graph.unsupportedForms.some((u) => u.module === "src/b.ts")).toBe(true);
  });

  it("8+9. genuine named __default__ is distinct from the actual default export", () => {
    const files = [
      F("src/a.ts", `export const __default__ = 7;\nexport default 1;\n`),
      F("src/b.ts", `export { __default__ as Foo } from "./a";\nexport { default as Bar } from "./a";\n`),
      F("src/consumer.ts", `import { Foo, Bar } from "./b";\nexport function useIt() {\n  return Foo + Bar;\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    const bMod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts");
    expect([...(bMod?.namedExports ?? [])].sort()).toEqual(["Bar", "Foo"]);
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/b.ts")}#Foo`)).toBe(true);
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/b.ts")}#Bar`)).toBe(true);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
  });

  it("10. valid named and alias re-exports still work", () => {
    const files = [
      F("src/a.ts", `export const Foo = 1;\n`),
      F("src/b.ts", `export { Foo, Foo as Renamed } from "./a";\n`),
      F("src/consumer.ts", `import { Foo, Renamed } from "./b";\nexport function useIt() {\n  return Foo + Renamed;\n}\n`),
    ];
    const { graph } = graphFor(files);
    expect([...(graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts")?.namedExports ?? [])].sort()).toEqual(["Foo", "Renamed"]);
    expect(graph.edges.filter((e) => e.kind === "references" && e.from === moduleNodeId("src/consumer.ts")).length).toBe(2);
  });

  it("11+12. transitive type-only blocked; cycles bounded and unsupported", () => {
    const typeChain = graphFor([
      F("src/a.ts", `export function Foo() {\n  return 1;\n}\n`),
      F("src/t.ts", `export type { Foo } from "./a";\n`),
      F("src/b.ts", `export { Foo } from "./t";\n`),
      F("src/consumer.ts", `import { Foo } from "./b";\nexport function useIt() {\n  return Foo();\n}\n`),
    ]);
    expect(typeChain.graph.edges.some((e) => e.kind === "references")).toBe(false);
    const cycle = graphFor([
      F("src/a.ts", `export { Foo } from "./b";\n`),
      F("src/b.ts", `export { Foo } from "./a";\n`),
      F("src/consumer.ts", `import { Foo } from "./a";\nexport function useIt() {\n  return Foo;\n}\n`),
    ]);
    expect(cycle.graph.edges.some((e) => e.kind === "references")).toBe(false);
    expect(cycle.graph.unsupportedForms.length).toBeGreaterThan(0);
  });
});

describe("C007 F7: nested finally override scope", () => {
  const kindOf = (content: string, label: string) =>
    graphFor([F("src/W.tsx", content)]).graph.nodes.find((n) => n.kind === "member" && n.label === label)?.declKind;

  it("13+14. exact nested-finally counterexample and outer conditional override => function", () => {
    expect(kindOf(`export const W = (flag: boolean) => {\n  try {\n    try {\n      return 123;\n    } finally {\n      return <div />;\n    }\n  } finally {\n    if (flag) return 0;\n  }\n};\n`, "W")).toBe("function");
    expect(kindOf(`export const W = (flag: boolean) => {\n  try {\n    return <div />;\n  } finally {\n    if (flag) return 0;\n  }\n};\n`, "W")).toBe("function");
  });

  it("15. mixed JSX/non-JSX conditional returns => function", () => {
    expect(kindOf(`export const Mixed = (flag: boolean) => (flag ? <div /> : { el: 1 });\n`, "Mixed")).toBe("function");
    expect(kindOf(`export const Mixed2 = (flag: boolean) => {\n  if (flag) return <div />;\n  return 0;\n};\n`, "Mixed2")).toBe("function");
  });

  it("16. unconditional finally override decides: object => function, JSX => component", () => {
    expect(kindOf(`export const A = () => {\n  try {\n    return <div />;\n  } finally {\n    return { x: 1 };\n  }\n};\n`, "A")).toBe("function");
    expect(kindOf(`export const B = () => {\n  try {\n    return 0;\n  } finally {\n    return <div />;\n  }\n};\n`, "B")).toBe("component");
  });

  it("17+18. direct/block JSX and both-branch JSX remain components", () => {
    expect(kindOf(`export const Widget = () => <div>hi</div>;\n`, "Widget")).toBe("component");
    expect(kindOf(`export const Panel = () => {\n  return <section />;\n};\n`, "Panel")).toBe("component");
    expect(kindOf(`export const Cond = (p: { ok: boolean }) => (p.ok ? <div /> : <span />);\n`, "Cond")).toBe("component");
  });

  it("19. nested object/callback JSX stays an ordinary function", () => {
    expect(kindOf(`export const Factory = () => ({ render: () => <div /> });\n`, "Factory")).toBe("function");
    expect(kindOf(`export const helper = () => 1;\n`, "helper")).toBe("function");
  });
});

describe("C008 F5: exact admission, typed slots, scope, default origins", () => {
  it("A. rejected named X statements emit no edges; the valid default X statement does", () => {
    const files = [
      F("src/a.ts", `export const Foo = 1;\n`),
      F("src/c.ts", `export const Foo = 3;\n`),
      F("src/d.ts", `export const X = 9;\n`),
      F("src/b.ts", `export { Foo as X } from "./a";\nexport { Foo as X } from "./c";\nexport { X as default } from "./d";\n`),
      F("src/cd.ts", `import D from "./b";\nexport function useD() {\n  return D;\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    const bMod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts");
    expect(bMod?.namedExports).toEqual([]);
    expect(bMod?.defaultMember).toBe("X");
    const bRefs = graph.edges.filter((e) => e.kind === "references" && e.from === moduleNodeId("src/b.ts"));
    expect(bRefs.map((e) => e.to)).toEqual([`${moduleNodeId("src/d.ts")}#X`]);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/cd.ts") && e.to === `${moduleNodeId("src/b.ts")}#X`)).toBe(true);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
  });

  it("A2. statement/file permutations keep the same admitted edges", () => {
    const mk = (bContent: string) => [
      F("src/a.ts", `export const Foo = 1;\n`),
      F("src/c.ts", `export const Foo = 3;\n`),
      F("src/d.ts", `export const X = 9;\n`),
      F("src/b.ts", bContent),
      F("src/cd.ts", `import D from "./b";\nexport function useD() {\n  return D;\n}\n`),
    ];
    const summarize = (files: FixtureFile[]) => {
      const { graph } = graphFor(files);
      return graph.edges.filter((e) => e.kind === "references").map((e) => `${e.from}->${e.to}`).sort();
    };
    const b1 = `export { Foo as X } from "./a";\nexport { Foo as X } from "./c";\nexport { X as default } from "./d";\n`;
    const b2 = `export { X as default } from "./d";\nexport { Foo as X } from "./c";\nexport { Foo as X } from "./a";\n`;
    expect(summarize(mk(b2))).toEqual(summarize(mk(b1)));
    expect(summarize([...mk(b1)].reverse())).toEqual(summarize(mk(b1)));
  });

  it("B. named alias __default__ is a named slot, never the default slot", () => {
    const files = [
      F("src/a.ts", `export const Foo = 1;\n`),
      F("src/b.ts", `export { Foo as __default__ } from "./a";\n`),
      F("src/consumer.ts", `import D from "./b";\nexport function useIt() {\n  return D;\n}\n`),
      F("src/named.ts", `import { __default__ } from "./b";\nexport function useN() {\n  return __default__;\n}\n`),
    ];
    const { graph } = graphFor(files);
    const bMod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts");
    expect(bMod?.namedExports).toEqual(["__default__"]);
    expect(bMod?.defaultMember).toBeNull();
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/consumer.ts"))).toBe(false);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/named.ts") && e.to === `${moduleNodeId("src/b.ts")}#__default__`)).toBe(true);
  });

  it("B2. named __default__ and anonymous default never share an anchor", () => {
    const files = [
      F("src/a.ts", `export const __default__ = 7;\nexport default 1;\n`),
      F("src/consumer.ts", `import D from "./a";\nexport function useIt() {\n  return D;\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    const aMod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/a.ts");
    expect(aMod?.namedExports).toEqual(["__default__"]);
    expect(aMod?.defaultMember).toBeNull();
    const member = graph.nodes.find((n) => n.kind === "member" && n.module === "src/a.ts" && n.label === "__default__");
    expect(member?.line).toBe(1);
    expect(graph.unsupportedForms.some((u) => u.module === "src/a.ts" && u.form.includes("anonymous default"))).toBe(true);
    expect(graph.edges.some((e) => e.kind === "references")).toBe(false);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
  });

  it("C. namespace children stay inside the namespace; top-level exports survive", () => {
    const files = [
      F("src/a.ts", `export namespace N {\n  export const Foo = 1;\n}\nexport const Real = 2;\n`),
      F("src/consumer.ts", `import { Foo, Real } from "./a";\nexport function useIt() {\n  return Real;\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    expect(graph.nodes.some((n) => n.kind === "member" && n.module === "src/a.ts" && n.label === "Foo")).toBe(false);
    expect(graph.nodes.some((n) => n.kind === "member" && n.module === "src/a.ts" && n.label === "Real")).toBe(true);
    expect(graph.edges.filter((e) => e.kind === "references").map((e) => e.to)).toEqual([`${moduleNodeId("src/a.ts")}#Real`]);
    expect(graph.unsupportedForms.some((u) => u.module === "src/a.ts" && u.form.includes("namespace"))).toBe(true);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
  });

  it("D. valid default-origin references link to the named default declaration only", () => {
    const files = [
      F("src/a.ts", `export default function Foo() {\n  return 1;\n}\n`),
      F("src/b.ts", `export { default as Foo } from "./a";\n`),
      F("src/consumer.ts", `import { Foo } from "./b";\nexport function useIt() {\n  return Foo();\n}\n`),
      F("src/direct.ts", `import Foo from "./a";\nexport function useD() {\n  return Foo();\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/b.ts") && e.to === `${moduleNodeId("src/a.ts")}#Foo`)).toBe(true);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/direct.ts") && e.to === `${moduleNodeId("src/a.ts")}#Foo`)).toBe(true);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
    // Anonymous upstream default: no fabricated b->a edge.
    const anon = graphFor([
      F("src/a.ts", `export default 1;\n`),
      F("src/b.ts", `export { default as Bar } from "./a";\n`),
    ]);
    expect(anon.graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/b.ts"))).toBe(false);
    expect(anon.graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts")?.namedExports).toEqual(["Bar"]);
  });

  it("preserves transitive type-only blocking and cycles under exact admission", () => {
    const typeChain = graphFor([
      F("src/a.ts", `export function Foo() {\n  return 1;\n}\n`),
      F("src/t.ts", `export type { Foo } from "./a";\n`),
      F("src/b.ts", `export { Foo } from "./t";\n`),
      F("src/consumer.ts", `import { Foo } from "./b";\nexport function useIt() {\n  return Foo();\n}\n`),
    ]);
    expect(typeChain.graph.edges.some((e) => e.kind === "references")).toBe(false);
    const cycle = graphFor([
      F("src/a.ts", `export { Foo } from "./b";\n`),
      F("src/b.ts", `export { Foo } from "./a";\n`),
      F("src/consumer.ts", `import { Foo } from "./a";\nexport function useIt() {\n  return Foo;\n}\n`),
    ]);
    expect(cycle.graph.edges.some((e) => e.kind === "references")).toBe(false);
  });
});

describe("C008 F7: finally depth is not dominance", () => {
  const kindOf = (content: string, label: string) =>
    graphFor([F("src/W.tsx", content)]).graph.nodes.find((n) => n.kind === "member" && n.label === label)?.declKind;

  it("exact counterexample: finally containing nested try/finally with conditional return => function", () => {
    expect(kindOf(`export const W = (flag: boolean) => {\n  try {\n    return 0;\n  } finally {\n    try {\n      return <div />;\n    } finally {\n      if (flag) return 0;\n    }\n  }\n};\n`, "W")).toBe("function");
  });

  it("both nesting orders with mixed paths => function", () => {
    expect(kindOf(`export const W = (flag: boolean) => {\n  try {\n    try {\n      return 123;\n    } finally {\n      return <div />;\n    }\n  } finally {\n    if (flag) return 0;\n  }\n};\n`, "W")).toBe("function");
    expect(kindOf(`export const W = (flag: boolean) => {\n  try {\n    return <div />;\n  } finally {\n    if (flag) return 0;\n  }\n};\n`, "W")).toBe("function");
  });

  it("unambiguous paths preserved: simple finally overrides and direct/block/conditional JSX", () => {
    expect(kindOf(`export const A = () => {\n  try {\n    return 0;\n  } finally {\n    return <div />;\n  }\n};\n`, "A")).toBe("component");
    expect(kindOf(`export const B = () => {\n  try {\n    return <div />;\n  } finally {\n    return { x: 1 };\n  }\n};\n`, "B")).toBe("function");
    expect(kindOf(`export const Widget = () => <div>hi</div>;\n`, "Widget")).toBe("component");
    expect(kindOf(`export const Panel = () => {\n  return <section />;\n};\n`, "Panel")).toBe("component");
    expect(kindOf(`export const Cond = (p: { ok: boolean }) => (p.ok ? <div /> : <span />);\n`, "Cond")).toBe("component");
    expect(kindOf(`export const Factory = () => ({ render: () => <div /> });\n`, "Factory")).toBe("function");
  });
});

describe("C009 F5: duplicate statements, local anchors, anonymous occupancy", () => {
  it("1-4. exact duplicate re-exports (any layout/order) are unsupported with no references", () => {
    const variants = [
      `export { Foo as X } from "./a";\nexport { Foo as X } from "./a";\n`,
      `export { Foo as X } from "./a"; export { Foo as X } from "./a";\n`,
      `export { Foo as X, Foo as X } from "./a";\n`,
    ];
    for (const bContent of variants) {
      const files = [
        F("src/a.ts", `export const Foo = 1;\n`),
        F("src/b.ts", bContent),
        F("src/consumer.ts", `import { X } from "./b";\nexport function useIt() {\n  return X;\n}\n`),
      ];
      const { graph, ev, contents } = graphFor(files);
      expect(graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts")?.namedExports).toEqual([]);
      expect(graph.edges.some((e) => e.kind === "references")).toBe(false);
      expect(graph.unsupportedForms.some((u) => u.module === "src/b.ts" && u.form.includes("conflicting"))).toBe(true);
      expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
      // Forging the duplicate references anyway is rejected by the validator.
      const forged = {
        ...graph,
        nodes: [...graph.nodes, { id: `${moduleNodeId("src/b.ts")}#X`, kind: "member" as const, label: "X", module: "src/b.ts", line: 1, members: {}, declKind: "re-export" }],
        edges: [...graph.edges, { from: moduleNodeId("src/consumer.ts"), to: `${moduleNodeId("src/b.ts")}#X`, kind: "references" as const, specifier: "./b", line: 1 }],
      };
      expect(validateGraphShape(forged, ev, contents).ok).toBe(false);
    }
    // Distinct bindings in ONE statement keep distinct slots (index distinction).
    const distinct = graphFor([
      F("src/a.ts", `export const Foo = 1;\nexport const Bar = 2;\n`),
      F("src/b.ts", `export { Foo as X, Bar as Y } from "./a";\n`),
      F("src/consumer.ts", `import { X, Y } from "./b";\nexport function useIt() {\n  return X + Y;\n}\n`),
    ]);
    expect(distinct.graph.edges.filter((e) => e.kind === "references" && e.from === moduleNodeId("src/consumer.ts")).length).toBe(2);
  });

  it("5. a valid single re-export still works", () => {
    const { graph } = graphFor([
      F("src/a.ts", `export const Foo = 1;\n`),
      F("src/b.ts", `export { Foo as X } from "./a";\n`),
      F("src/consumer.ts", `import { X } from "./b";\nexport function useIt() {\n  return X;\n}\n`),
    ]);
    expect(graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/b.ts")}#X`)).toBe(true);
  });

  it("6-8. local alias B / default B collision: default suppressed, alias anchor truthful", () => {
    const files = [
      F("src/b.ts", `const A = 1;\nconst B = 2;\nexport { A as B };\nexport default B;\n`),
      F("src/consumer.ts", `import D from "./b";\nexport function useIt() {\n  return D;\n}\n`),
      F("src/named.ts", `import { B } from "./b";\nexport function useN() {\n  return B;\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    const bMod = graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts");
    expect(bMod?.namedExports).toEqual(["B"]);
    expect(bMod?.defaultMember).toBeNull();
    const memberB = graph.nodes.find((n) => n.kind === "member" && n.module === "src/b.ts" && n.label === "B");
    expect(memberB?.line).toBe(3); // the export statement, not A's or B's declaration
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/consumer.ts"))).toBe(false);
    expect(graph.edges.some((e) => e.kind === "references" && e.from === moduleNodeId("src/named.ts") && e.to === `${moduleNodeId("src/b.ts")}#B`)).toBe(true);
    expect(graph.unsupportedForms.some((u) => u.module === "src/b.ts" && u.form.includes("conflicting default"))).toBe(true);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
    // Unambiguous local named/default identities still work.
    const clean = graphFor([
      F("src/b.ts", `const A = 1;\nexport { A as Renamed };\nexport default function Main() {\n  return A;\n}\n`),
      F("src/consumer.ts", `import Main, { Renamed } from "./b";\nexport function useIt() {\n  return Main() + Renamed;\n}\n`),
    ]);
    expect(clean.graph.edges.filter((e) => e.kind === "references").length).toBe(2);
  });

  it("9-11. anonymous default occupancy blocks competing re-exports; clean defaults survive", () => {
    const files = [
      F("src/a.ts", `export const Foo = 1;\n`),
      F("src/b.ts", `export default 1;\nexport { Foo as default } from "./a";\n`),
      F("src/consumer.ts", `import D from "./b";\nexport function useIt() {\n  return D;\n}\n`),
    ];
    const { graph, ev, contents } = graphFor(files);
    expect(graph.nodes.find((n) => n.kind === "module" && n.module === "src/b.ts")?.defaultMember).toBeNull();
    expect(graph.edges.some((e) => e.kind === "references")).toBe(false);
    expect(graph.unsupportedForms.some((u) => u.module === "src/b.ts")).toBe(true);
    expect(validateGraphShape(graph, ev, contents).ok).toBe(true);
    // Anonymous alone: no competitor, still unsupported with no anchor.
    const alone = graphFor([F("src/a.ts", `export default 1;\n`)]);
    expect(alone.graph.nodes.some((n) => n.kind === "member")).toBe(false);
    expect(alone.graph.unsupportedForms.some((u) => u.form.includes("anonymous default"))).toBe(true);
    // Clean named default-origin reference still links.
    const clean = graphFor([
      F("src/a.ts", `export default function Foo() {\n  return 1;\n}\n`),
      F("src/b.ts", `export { default as Foo } from "./a";\n`),
    ]);
    expect(clean.graph.edges.some((e) => e.kind === "references" && e.to === `${moduleNodeId("src/a.ts")}#Foo`)).toBe(true);
  });
});

describe("C009 F7: finally scope is limited to its own try", () => {
  const kindOf = (content: string, label: string) =>
    graphFor([F("src/W.tsx", content)]).graph.nodes.find((n) => n.kind === "member" && n.label === label)?.declKind;

  it("12. return before try/finally => function", () => {
    expect(kindOf(`export const W = (flag: boolean) => {\n  if (flag) return 0;\n  try {} finally { return <div />; }\n};\n`, "W")).toBe("function");
  });

  it("13. return after try/finally => function", () => {
    expect(kindOf(`export const W = () => {\n  try {} finally { return <div />; }\n  return 0;\n};\n`, "W")).toBe("function");
  });

  it("14. mixed nested finally returns => function (both orders)", () => {
    expect(kindOf(`export const W = (flag: boolean) => {\n  try {\n    return 0;\n  } finally {\n    try {\n      return <div />;\n    } finally {\n      if (flag) return 0;\n    }\n  }\n};\n`, "W")).toBe("function");
    expect(kindOf(`export const W = (flag: boolean) => {\n  try {\n    try {\n      return 123;\n    } finally {\n      return <div />;\n    }\n  } finally {\n    if (flag) return 0;\n  }\n};\n`, "W")).toBe("function");
  });

  it("15+16. valid unconditional finally JSX and simple JSX positives preserved", () => {
    expect(kindOf(`export const A = () => {\n  try {\n    return 0;\n  } finally {\n    return <div />;\n  }\n};\n`, "A")).toBe("component");
    expect(kindOf(`export const Widget = () => <div>hi</div>;\n`, "Widget")).toBe("component");
    expect(kindOf(`export const Panel = () => {\n  return <section />;\n};\n`, "Panel")).toBe("component");
    expect(kindOf(`export const Cond = (p: { ok: boolean }) => (p.ok ? <div /> : <span />);\n`, "Cond")).toBe("component");
  });
});

describe("safety: no execution, no findings, no fabrication", () => {
  it("ast-graph.ts only parses (TypeScript Compiler API)", () => {
    const src = readFileSync("lib/ast-graph.ts", "utf8");
    expect(src).toMatch(/from "typescript"/);
    expect(src).not.toMatch(/\beval\s*\(|\bFunction\s*\(|execSync|child_process|vm\./);
  });

  it("graph JSON carries no security-finding vocabulary", () => {
    const { graph } = graphFor(FIXTURE_SOURCES);
    const json = JSON.stringify(graph).toLowerCase();
    expect(json).not.toContain("severity");
    expect(json).not.toContain("vulnerab");
    expect(json).not.toContain("finding");
  });

  it("compiles the same graph twice deterministically", () => {
    const a = graphFor(FIXTURE_SOURCES).graph;
    const b = graphFor(FIXTURE_SOURCES).graph;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// C010 builder regressions. The complete C009 tests above are preserved byte-for-byte.
describe("C010 F5: declaration owners and accepted claims", () => {
  const moduleOf = (g: ReturnType<typeof graphFor>["graph"], path: string) => g.nodes.find(n => n.id === moduleNodeId(path))!;
  const refs = (g: ReturnType<typeof graphFor>["graph"]) => g.edges.filter(e => e.kind === "references");
  const genuine = (f: ReturnType<typeof graphFor>) => {
    expect(validateGraphShape(f.graph, f.ev, f.contents)).toEqual({ ok: true, issues: [] });
    expect(validateEvidence(f.graph, f.ev, f.contents, nodeHash)).toEqual({ ok: true, issues: [] });
  };
  it.each([false, true])("F5-1 list/default alias collision is truthful in either order (%s)", reverse => {
    const src = `const A=1;\nconst B=2;\n${reverse ? "export {B as default};\nexport {A as B};" : "export {A as B};\nexport {B as default};"}\n`;
    const f = graphFor([F("b.ts", src), F("use.ts", 'import D, {B} from "./b";')]);
    const b = moduleOf(f.graph, "b.ts");
    expect(b.namedExports).toEqual(["B"]); expect(b.defaultMember).toBeNull();
    expect(f.graph.nodes.map(n=>n.id)).toEqual(["ast-module:b.ts", "ast-module:use.ts", "ast-module:b.ts#B"]);
    const member = f.graph.nodes.find(n=>n.kind==="member")!;
    expect(member.line).toBe(reverse ? 4 : 3);
    expect(member.provenance).toEqual([{
      anchorOffset:src.indexOf("A as B")+5,anchorLine:reverse ? 4 : 3,
      slot:"slot:named:B",origin:"local",originId:JSON.stringify(["local","b.ts",0,6]),
      statementOffset:src.indexOf("export {A"),bindingOffset:src.indexOf("A as B"),bindingLine:reverse ? 4 : 3,
      declaration:{module:"b.ts",name:"A",ownerOffset:0,offset:6,line:1},
    }]);
    expect(refs(f.graph).map(e=>[e.from,e.to])).toEqual([["ast-module:use.ts","ast-module:b.ts#B"]]);
    expect(f.graph.edges.map(e=>e.kind)).toEqual(["imports","references"]);
    expect(f.graph.unsupportedForms.some(u=>u.form.includes("conflicting default"))).toBe(true);
    genuine(f);
    const forged=structuredClone(f.graph);forged.nodes.find(n=>n.kind==="member")!.provenance![0].declaration!.offset=17;
    expect(validateEvidence(forged,f.ev,f.contents,nodeHash).ok).toBe(false);
  });
  it.each([
    'export default 1;\nexport default A;', 'export default A;\nexport default 1;',
    'export default A;\nexport default A;', 'export {A as default,A as default};',
    'export {A as X,A as X};', 'export {A as X};\nexport {A as X};',
    'export const X=1;\nexport {A as X};', 'export {A as X};\nexport const X=1;',
  ])("F5-2 duplicate slots reject every claim: %s", claims => {
    const f=graphFor([F("b.ts",`const A=1;\n${claims}`),F("mid.ts",'export {default as D,X} from "./b";'),F("use.ts",'import {D,X} from "./mid";')]);
    expect(f.graph.nodes.filter(n=>n.kind==="member")).toEqual([]);
    expect(refs(f.graph)).toEqual([]);
    expect(f.graph.nodes.filter(n=>n.kind==="module").map(n=>[n.namedExports,n.defaultMember])).toEqual([[[],null],[[],null],[[],null]]);
    expect(f.graph.edges.map(e=>e.kind)).toEqual(["imports","imports"]);
    expect(f.graph.unsupportedForms.filter(u=>u.module==="b.ts"&&u.form.includes("conflicting"))).toHaveLength(2);
    expect(f.graph.unsupportedForms.some(u=>u.module==="mid.ts")).toBe(true);
    genuine(f);
  });
  it("duplicate default claims suppress downstream anonymous-default availability in either file order",()=>{
    const files=[F("a.ts",'export default 1; export default 2;'),F("b.ts",'export {default as B} from "./a";'),F("c.ts",'export {B as C} from "./b";')];
    for(const order of [files,[...files].reverse()]){
      const f=graphFor(order);expect(f.graph.nodes.filter(n=>n.kind==="member")).toEqual([]);expect(refs(f.graph)).toEqual([]);genuine(f);
    }
  });
  it.each([
    'function f(){const A=2;}', 'function f(){function A(){return 2;}}',
    'class C {m(){const A=2;}}', '{const A=2;}', 'namespace N {export const A=2;}',
  ])("F5-3 nested declarations cannot overwrite module ownership: %s", nested=>{
    const src=`const A=1;\n${nested}\nexport {A};`;
    const f=graphFor([F("a.ts",src),F("use.ts",'import {A} from "./a";')]);
    expect(moduleOf(f.graph,"a.ts").members).toEqual({A:{name:"A",kind:"const",line:1}});
    expect(f.graph.nodes.filter(n=>n.kind==="member").map(n=>[n.label,n.line])).toEqual([["A",1]]);
    expect(f.graph.nodes.find(n=>n.kind==="member")?.provenance?.[0].declaration).toEqual({module:"a.ts",name:"A",ownerOffset:0,offset:6,line:1});
    expect(refs(f.graph).map(e=>e.to)).toEqual(["ast-module:a.ts#A"]);genuine(f);
  });
  it("nested-only names and ambiguous module declarations are explicitly unsupported",()=>{
    for(const src of ['function f(){const A=2;}\nexport {A};','const A=1; const A=2; export {A};']){
      const f=graphFor([F("a.ts",src)]);expect(f.graph.nodes.map(n=>n.id)).toEqual(["ast-module:a.ts"]);
      expect(f.graph.edges).toEqual([]);expect(f.graph.unsupportedForms.length).toBeGreaterThan(0);genuine(f);
    }
  });
  it("clean local named/default claims retain exact owners and both binding provenances",()=>{
    const src='const A=1;\nexport {A};\nexport {A as default};';
    const f=graphFor([F("a.ts",src),F("use.ts",'import D,{A} from "./a";')]);
    expect(moduleOf(f.graph,"a.ts").namedExports).toEqual(["A"]);expect(moduleOf(f.graph,"a.ts").defaultMember).toBe("A");
    expect(f.graph.nodes.find(n=>n.kind==="member")?.provenance?.map(p=>[p.slot,p.statementOffset,p.bindingOffset,p.declaration?.offset])).toEqual([
      ["slot:named:A",src.indexOf("export {A};"),src.indexOf("A};"),6],
      ["slot:default",src.lastIndexOf("export"),src.indexOf("A as default"),6],
    ]);
    expect(refs(f.graph)).toHaveLength(1);expect(refs(f.graph)[0].bindings?.map(b=>b.originSlot)).toEqual(["slot:default","slot:named:A"]);
    expect(f.graph.unsupportedForms).toEqual([]);genuine(f);
  });
  it("local and upstream same-slot conflicts invalidate both, even if upstream is unsupported",()=>{
    for(const exports of ['export const X=1; export {Foo as X} from "./a";', 'export {Missing as X} from "./a"; export const X=1;']){
      const f=graphFor([F("a.ts",'export const Foo=1;'),F("b.ts",exports),F("c.ts",'export {X} from "./b";')]);
      expect(moduleOf(f.graph,"b.ts").namedExports).toEqual([]);expect(moduleOf(f.graph,"c.ts").namedExports).toEqual([]);
      expect(refs(f.graph)).toEqual([]);expect(f.graph.unsupportedForms.some(u=>u.form.includes("conflicting"))).toBe(true);genuine(f);
    }
  });
});

describe("C010 F5-4: exact bindings, canonical values and validator parity",()=>{
  it.each([
    'export {Foo as X} from "./a"; export {Bar as Y} from "./a";',
    'export {\nFoo as X\n} from "./a";\nexport {\nBar as Y\n} from "./a";',
  ])("distinct re-export bindings validate at their actual offsets: %s",src=>{
    const f=graphFor([F("a.ts",'export const Foo=1; export const Bar=2;'),F("b.ts",src)]);
    const refs=f.graph.edges.filter(e=>e.kind==="references");
    expect(f.graph.nodes.map(n=>n.id)).toEqual(["ast-module:a.ts","ast-module:b.ts","ast-module:a.ts#Foo","ast-module:a.ts#Bar","ast-module:b.ts#X","ast-module:b.ts#Y"]);
    expect(f.graph.edges.map(e=>[e.kind,e.to])).toEqual([["imports","ast-module:a.ts"],["imports","ast-module:a.ts"],["references","ast-module:a.ts#Foo"],["references","ast-module:a.ts#Bar"]]);
    expect(refs.map(e=>e.bindings?.[0].bindingOffset)).toEqual([src.indexOf("Foo as X"),src.indexOf("Bar as Y")]);
    expect(refs.map(e=>e.statementOffset)).toEqual([0,src.lastIndexOf("export")]);
    expect(f.graph.nodes.filter(n=>n.module==="b.ts"&&n.kind==="member").map(n=>n.line)).toEqual(src.includes("\n")?[2,5]:[1,1]);
    expect(f.graph.unsupportedForms).toEqual([]);
    expect(validateEvidence(f.graph,f.ev,f.contents,nodeHash)).toEqual({ok:true,issues:[]});
    const forged=structuredClone(f.graph);forged.edges.find(e=>e.to==="ast-module:a.ts#Bar")!.statementOffset=0;
    expect(validateEvidence(forged,f.ev,f.contents,nodeHash).ok).toBe(false);
  });
  it.each([
    'export {Foo as X,Foo as Y} from "./a";',
    'export {Foo as X} from "./a"; export {Foo as Y} from "./a";',
    'export {Foo as X} from "./a";\nexport {Foo as Y} from "./a";',
  ])("aliases preserve both provenances and one canonical upstream value: %s",src=>{
    const f=graphFor([F("a.ts",'export const Foo=1;'),F("b.ts",src),F("use.ts",'import {X,Y} from "./b";')]);
    const refs=f.graph.edges.filter(e=>e.kind==="references");
    expect(refs.map(e=>[e.from,e.to])).toEqual([["ast-module:b.ts","ast-module:a.ts#Foo"],["ast-module:use.ts","ast-module:b.ts#X"],["ast-module:use.ts","ast-module:b.ts#Y"]]);
    expect(refs[0].bindings?.map(b=>[b.local,b.bindingOffset])).toEqual([["X",src.indexOf("Foo as X")],["Y",src.indexOf("Foo as Y")]]);
    expect(f.graph.nodes.filter(n=>n.kind==="member"&&n.module==="b.ts").map(n=>n.label)).toEqual(["X","Y"]);
    expect(f.graph.unsupportedForms).toEqual([]);expect(validateEvidence(f.graph,f.ev,f.contents,nodeHash).ok).toBe(true);
    const duplicate={...f.graph,edges:[...f.graph.edges,refs[0]]};expect(validateEvidence(duplicate,f.ev,f.contents,nodeHash).ok).toBe(false);
    const lost=structuredClone(f.graph);lost.edges.find(e=>e.kind==="references")!.bindings!.pop();expect(validateGraphShape(lost,f.ev,f.contents).ok).toBe(false);
    const lie=structuredClone(f.graph);lie.edges.find(e=>e.kind==="references")!.bindings![1].local="Z";expect(validateGraphShape(lie,f.ev,f.contents).ok).toBe(false);
  });
  it("same-line imports, and default re-export chains preserve exact named/default slot tags",()=>{
    const f=graphFor([F("a.ts",'export default function Main(){}; export const Foo=1;'),F("b.ts",'export {default} from "./a"; export {Foo as X} from "./a";'),F("use.ts",'import D from "./b"; import {X} from "./b";')]);
    expect(f.graph.edges.filter(e=>e.kind==="references").map(e=>e.to)).toEqual(["ast-module:a.ts#Main","ast-module:a.ts#Foo","ast-module:b.ts#__default__","ast-module:b.ts#X"]);
    expect(f.graph.nodes.find(n=>n.id==="ast-module:b.ts")?.defaultMember).toBe("__default__");
    expect(validateEvidence(f.graph,f.ev,f.contents,nodeHash)).toEqual({ok:true,issues:[]});
  });
  it("malformed runtime graph/source/provenance/hash inputs fail closed",()=>{
    const f=graphFor([F("a.ts",'export const A=1;')]);
    for(const graph of [null,{...f.graph,nodes:null},{...f.graph,edges:[null]}, {...f.graph,nodes:[{...f.graph.nodes[1],provenance:[null]}]}]){
      expect(validateEvidence(graph as unknown as typeof f.graph,f.ev,f.contents,nodeHash).ok).toBe(false);
    }
    expect(validateEvidence(f.graph,{...f.ev,files:null} as unknown as EvidenceSnapshot,f.contents,nodeHash).ok).toBe(false);
    expect(validateEvidence(f.graph,f.ev,f.contents,()=>{throw Error("hash unavailable");}).ok).toBe(false);
    expect(validateEvidence(f.graph,f.ev,f.contents,()=>"bad").ok).toBe(false);
    expect(validateEvidence(f.graph,{...f.ev,files:f.ev.files.map(x=>({...x,sha256:"bad"}))},f.contents,nodeHash).ok).toBe(false);
  });
});

describe("C010 F7: finally competitors, scope and conservative uncertainty",()=>{
  const kind=(body:string)=>graphFor([F("W.tsx",`export const W=(flag:boolean)=>{${body}};`)]).graph.nodes.find(n=>n.label==="W")?.declKind;
  it.each([
    'try{}finally{if(flag)return 0; return <div/>;}',
    'try{return 1;}finally{if(flag)return 0; {return <div/>;}}',
    'try{}catch(e){return <div/>;}finally{if(flag)return {}; return <div/>;}',
    'try{}finally{if(flag)return <div/>; return 0;}',
    'if(flag)return 0; try{}finally{return <div/>;}',
    'try{}finally{return <div/>;} return 0;',
    'try{if(flag)return 0;}finally{if(flag)return <div/>;} return <div/>;',
    'try{}finally{if(flag)return 0;} try{}finally{return <div/>;}',
    'try{try{return 0;}finally{return <div/>;}}finally{if(flag)return 0;}',
  ])("mixed return paths remain functions: %s",body=>expect(kind(body)).toBe("function"));
  it.each([
    'try{return 0;}finally{return <div/>;}',
    'try{return 0;}catch(e){return 1;}finally{return <div/>;}',
    'try{}finally{if(flag)return <div/>; return <span/>;}',
    'return <div/>;', 'if(flag)return <div/>; else return <span/>;',
  ])("reliable own JSX remains component: %s",body=>expect(kind(body)).toBe("component"));
  it.each([
    'while(flag){return <div/>;} return <span/>;',
    'switch(flag){case true:return <div/>; default:return <span/>;}',
    'if(flag)throw Error();return <div/>;',
    'if(flag)return <div/>;',
    'return {render:()=> <div/>};',
  ])("uncertain flow is ordinary function: %s",body=>expect(kind(body)).toBe("function"));
  it("expression JSX positives survive and async flow stays ordinary",()=>{
    const f=graphFor([F("W.tsx",'export const Direct=()=> <div/>; export const Cond=(f:boolean)=>f?<div/>:<span/>; export const Async=async()=> <div/>;')]);
    expect(f.graph.nodes.filter(n=>n.kind==="member").map(n=>[n.label,n.declKind])).toEqual([["Direct","component"],["Cond","component"],["Async","function"]]);
    expect(validateEvidence(f.graph,f.ev,f.contents,nodeHash).ok).toBe(true);
  });
});


describe("C010 F5: binding anchors do not depend on substring heuristics",()=>{
  it("split aliases, namespace names and default bindings use actual AST anchors",()=>{
    const src='export {Foo as\n X} from "./a";\nexport {default as\n Y} from "./a";\nexport {\n default\n} from "./a";\nexport * as\n NS from "./a";';
    const f=graphFor([F("a.ts",'export const Foo=1; export default function Main(){}'),F("b.ts",src)]);
    expect(f.graph.nodes.filter(n=>n.kind==="member"&&n.module==="b.ts").map(n=>[n.label,n.line])).toEqual([["X",2],["Y",4],["NS",9],["__default__",6]]);
    for(const n of f.graph.nodes.filter(n=>n.kind==="member"&&n.module==="b.ts")){
      const p=n.provenance![0];expect(p.anchorLine).toBe(n.line);
      expect(src.slice(0,p.anchorOffset).split("\n").length).toBe(n.line);
    }
    expect(f.graph.edges.filter(e=>e.kind==="references").map(e=>[e.to,e.bindings?.length])).toEqual([["ast-module:a.ts#Foo",1],["ast-module:a.ts#Main",2]]);
    expect(validateEvidence(f.graph,f.ev,f.contents,nodeHash)).toEqual({ok:true,issues:[]});
  });
  it("forged module labels and anchor offsets fail source validation",()=>{
    const f=graphFor([F("a.ts",'export const A=1;')]);
    const label=structuredClone(f.graph);label.nodes[0].label="forged.ts";expect(validateGraphShape(label,f.ev,f.contents).ok).toBe(false);
    const anchor=structuredClone(f.graph);anchor.nodes[1].provenance![0].anchorOffset=0;expect(validateGraphShape(anchor,f.ev,f.contents).ok).toBe(false);
  });
});

describe("C010 resume F5: namespace claims use typed destination slots", () => {
  it("namespace default is a default slot, with an exact namespace binding anchor", () => {
    const src = 'export * as\n default from "./a";';
    const f = graphFor([F("a.ts", "export const A=1;"), F("b.ts", src), F("use.ts", 'import D,{default as E} from "./b";')]);
    const mod = f.graph.nodes.find(n => n.id === moduleNodeId("b.ts"))!;
    expect(mod.namedExports).toEqual([]);
    expect(mod.defaultMember).toBe("__default__");
    const member = f.graph.nodes.find(n => n.id === "ast-module:b.ts#__default__")!;
    expect(member.line).toBe(2);
    expect(member.provenance?.[0]).toMatchObject({slot:"slot:default",anchorOffset:src.indexOf("default"),bindingOffset:src.indexOf("default")});
    const refs = f.graph.edges.filter(e => e.kind === "references");
    expect(refs.map(e => e.to)).toEqual(["ast-module:b.ts#__default__"]);
    expect(refs[0].bindings?.map(b => b.originSlot)).toEqual(["slot:default", "slot:default"]);
    expect(validateEvidence(f.graph, f.ev, f.contents, nodeHash)).toEqual({ok:true,issues:[]});
  });
  it.each([false, true])("namespace and identifier default claims conflict in either order (%s)", reverse => {
    const claims = ['export * as default from "./a";', 'export default A;'];
    const f = graphFor([F("a.ts", "export const A=1;"), F("b.ts", `const A=1; ${ (reverse ? claims.reverse() : claims).join(" ") }`), F("use.ts", 'import D from "./b";')]);
    expect(f.graph.nodes.filter(n => n.kind === "member" && n.module === "b.ts")).toEqual([]);
    expect(f.graph.edges.filter(e => e.kind === "references")).toEqual([]);
    expect(f.graph.unsupportedForms.filter(u => u.module === "b.ts" && u.form.includes("duplicate claims"))).toHaveLength(2);
    expect(validateEvidence(f.graph, f.ev, f.contents, nodeHash)).toEqual({ok:true,issues:[]});
  });
  it("type-only namespace claims are explicitly unsupported without occupying a value slot", () => {
    const f = graphFor([F("a.ts", "export const A=1;"), F("b.ts", 'export type * as NS from "./a"; export const NS=1;'), F("use.ts", 'import {NS} from "./b";')]);
    expect(f.graph.nodes.find(n => n.id === "ast-module:b.ts#NS")?.declKind).toBe("const");
    expect(f.graph.unsupportedForms).toEqual([{module:"b.ts",line:1,form:"type-only namespace export (no value member)"}]);
    expect(f.graph.edges.filter(e => e.kind === "references").map(e => e.to)).toEqual(["ast-module:b.ts#NS"]);
    expect(validateEvidence(f.graph, f.ev, f.contents, nodeHash)).toEqual({ok:true,issues:[]});
  });
});

it("C010 resume F7: a generator returning JSX remains an ordinary function", () => {
  const f = graphFor([F("W.tsx", 'export const Generator=function*(){return <div/>;}; export const Direct=function(){return <div/>;};')]);
  expect(f.graph.nodes.filter(n => n.kind === "member").map(n => [n.label,n.declKind])).toEqual([["Generator","function"],["Direct","component"]]);
  expect(validateEvidence(f.graph, f.ev, f.contents, nodeHash)).toEqual({ok:true,issues:[]});
});
