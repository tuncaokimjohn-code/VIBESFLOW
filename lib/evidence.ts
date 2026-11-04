// P4: evidence validation for AST graphs (Gate 5, FIX 1).
// Pure and browser-safe: no node:crypto import. Two levels, honestly named:
//  - validateGraphShape: STRUCTURAL checks only (binding, node/edge
//    references, line bounds, per-statement source verification). Passing
//    this is NOT cryptographic evidence verification.
//  - validateEvidence: structural checks PLUS per-file byte/line checks
//    and SHA-256 recomputation via an injected hashFn. Without a hashFn it
//    FAILS CLOSED — required evidence is never assumed present.
// Every imports/references/external/unresolvable edge is verified against
// the actual import/export statement in the importer's source: specifier,
// resolved target, line and binding ownership must all agree. A forged
// edge between two legitimate nodes is rejected. Nothing here detects
// security findings.

import {
  buildAstGraph,
  moduleNodeId,
  staticImportSites,
  type AstGraph,
} from "@/lib/ast-graph";
import { sourceGeometry } from "@/lib/source-lines";

export interface SnapshotMetaFile {
  path: string;
  language: "ts" | "tsx";
  bytes: number;
  sha256: string;
  lineCount: number;
  lineStartOffsets?: number[];
}

export interface EvidenceSnapshot {
  snapshotId: string;
  sourceKind?: "github" | "synthetic";
  files: SnapshotMetaFile[];
  skipped: Array<{ path: string; reason: string; detail?: string }>;
  canonicalProvenance: string;
  resolvedCommitIfGitHub: string | null;
}

/** Caller-side binding expectation: what this graph MUST belong to. */
export interface ExpectedBinding {
  canonicalProvenance?: string;
  resolvedCommitIfGitHub?: string | null;
}

export interface EvidenceResult {
  ok: boolean;
  issues: string[];
}

const SHA40 = /^[0-9a-f]{40}$/;

function bindingIssues(
  graph: AstGraph,
  snapshot: EvidenceSnapshot,
  expected?: ExpectedBinding
): string[] {
  const issues: string[] = [];
  if (graph.snapshotId !== snapshot.snapshotId) {
    issues.push(`graph snapshotId ${graph.snapshotId} != snapshot ${snapshot.snapshotId}`);
  }
  // Bind graph -> snapshot identity, canonical provenance, resolved commit.
  // Missing graph-side binding fields fail closed (undefined !== value).
  if (graph.canonicalProvenance !== snapshot.canonicalProvenance) {
    issues.push("graph canonicalProvenance does not match snapshot");
  }
  if (graph.resolvedCommitIfGitHub !== snapshot.resolvedCommitIfGitHub) {
    issues.push("graph resolvedCommitIfGitHub does not match snapshot");
  }
  if (!snapshot.canonicalProvenance) {
    issues.push("snapshot canonicalProvenance is missing");
  }
  if (snapshot.sourceKind === "github") {
    if (!snapshot.resolvedCommitIfGitHub || !SHA40.test(snapshot.resolvedCommitIfGitHub)) {
      issues.push("github snapshot requires a resolved 40-hex commit");
    }
  }
  if (expected?.canonicalProvenance !== undefined && expected.canonicalProvenance !== snapshot.canonicalProvenance) {
    issues.push("snapshot provenance does not match expected provenance");
  }
  if (
    expected?.resolvedCommitIfGitHub !== undefined &&
    expected.resolvedCommitIfGitHub !== snapshot.resolvedCommitIfGitHub
  ) {
    issues.push("snapshot commit does not match expected commit");
  }
  return issues;
}

function sameMembers(
  a: Record<string, { name: string; kind: string; line: number }>,
  b: Record<string, { name: string; kind: string; line: number }>
): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => {
    const x = a[k] as { name: string; kind: string; line: number };
    const y = b[k] as { name: string; kind: string; line: number };
    return x.name === y.name && x.kind === y.kind && x.line === y.line;
  });
}

/**
 * Structural integrity ONLY (not cryptographic verification): graph bound
 * to this snapshot's identity/provenance/commit, every node naming an
 * existing file with an in-bounds anchor, and every edge verified against
 * the actual import/export statement in its source file.
 */
function validateGraphShapeInternal(
  graph: AstGraph,
  snapshot: EvidenceSnapshot,
  contents: Map<string, string>,
  expected?: ExpectedBinding
): EvidenceResult {
  const issues: string[] = [...bindingIssues(graph, snapshot, expected)];
  const fileByPath = new Map(snapshot.files.map((f) => [f.path, f]));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const pathSet = new Set(snapshot.files.map((f) => f.path));

  // F1 (C006): SOURCE completeness comes first. Content bytes are
  // required for EVERY snapshot file before any rebuild: an empty or
  // partial contents map fails closed even for an empty graph, and the
  // expected module coverage must match the snapshot inventory. This
  // structural check never depends on the SHA hashFn.
  for (const f of snapshot.files) {
    if (contents.get(f.path) === undefined) {
      issues.push(`snapshot file ${f.path} has no content bytes`);
    }
  }

  // F1: the source-derived expectation. Members, identities and node
  // bindings are verified against a graph rebuilt from the actual parsed
  // source — never against graph-supplied claims alone.
  let expectedGraph: AstGraph | null = null;
  try {
    expectedGraph = buildAstGraph(snapshot, contents);
  } catch {
    issues.push("source-derived graph rebuild failed (fail closed)");
  }
  const expById = new Map((expectedGraph?.nodes ?? []).map((n) => [n.id, n]));

  // F1 (C005): node COMPLETENESS. The supplied node-ID set must cover
  // every source-derived node — missing modules, missing members and
  // isolated nodes without edges are rejected, not just extra nodes.
  if (expectedGraph) {
    const suppliedIds = new Set(graph.nodes.map((n) => n.id));
    for (const exp of expectedGraph.nodes) {
      if (!suppliedIds.has(exp.id)) {
        issues.push(`expected node missing from graph: ${exp.id}`);
      }
    }
    // Expected module coverage must equal the snapshot inventory.
    const expectedModules = new Set(
      expectedGraph.nodes.filter((n) => n.kind === "module").map((n) => n.module)
    );
    for (const f of snapshot.files) {
      if (!expectedModules.has(f.path)) {
        issues.push(`snapshot file ${f.path} has no expected module coverage`);
      }
    }
  }

  // F1/F3: parse status and relationship metadata are derived from the
  // SOURCE, never trusted from the graph. Supplied unsupportedModules,
  // unresolved lists, unsupportedForms and the edge set itself must match
  // the source-derived state; clearing or fabricating them fails closed.
  const expUnsupported = new Set(expectedGraph?.unsupportedModules ?? []);
  if (expectedGraph) {
    const supplied = graph.unsupportedModules;
    if (
      new Set(supplied).size !== supplied.length ||
      supplied.length !== expUnsupported.size ||
      supplied.some((m) => !expUnsupported.has(m))
    ) {
      issues.push("graph unsupportedModules metadata does not match source-derived parse state");
    }
    const multiset = (items: string[]) => {
      const m = new Map<string, number>();
      for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
      return m;
    };
    const sameMultiset = (a: string[], b: string[]) => {
      const ma = multiset(a);
      const mb = multiset(b);
      if (ma.size !== mb.size) return false;
      for (const [k, v] of ma) if (mb.get(k) !== v) return false;
      return true;
    };
    const edgeKey = (e: AstGraph["edges"][number]) =>
      JSON.stringify([e.from, e.to, e.kind, e.specifier, e.line, e.statementOffset, e.bindings]);
    if (!sameMultiset(graph.edges.map(edgeKey), expectedGraph.edges.map(edgeKey))) {
      issues.push("graph edges do not match source-derived edges");
    }
    if (!sameMultiset(graph.unresolved.map(edgeKey), expectedGraph.unresolved.map(edgeKey))) {
      issues.push("graph unresolved metadata does not match source-derived state");
    }
    const formKey = (f: AstGraph["unsupportedForms"][number]) => `${f.module}|${f.line}|${f.form}`;
    if (!sameMultiset(graph.unsupportedForms.map(formKey), expectedGraph.unsupportedForms.map(formKey))) {
      issues.push("graph unsupportedForms metadata does not match source-derived state");
    }
  }

  // F1: unique canonical node IDs, bound to actual module paths.
  const idCounts = new Map<string, number>();
  for (const n of graph.nodes) idCounts.set(n.id, (idCounts.get(n.id) ?? 0) + 1);
  for (const [id, count] of idCounts) {
    if (count > 1) issues.push(`duplicate node id: ${id}`);
  }
  for (const n of graph.nodes) {
    const canonical =
      n.kind === "module"
        ? moduleNodeId(n.module)
        : `${moduleNodeId(n.module)}#${n.label}`;
    if (n.id !== canonical) {
      issues.push(`node id ${n.id} does not match its module path ${n.module}`);
    }
    const exp = expById.get(n.id);
    if (!exp) {
      issues.push(`node ${n.id} is not derived from parsed source`);
      continue;
    }
    if (n.kind !== exp.kind || n.label !== exp.label || n.module !== exp.module || n.line !== exp.line) {
      issues.push(`node ${n.id} does not match parsed source declaration`);
    }
    if (JSON.stringify(n.provenance) !== JSON.stringify(exp.provenance)) {
      issues.push(`node ${n.id} provenance does not match parsed source`);
    }
    if (n.kind === "member" && n.declKind !== exp.declKind) {
      issues.push(`member ${n.id} kind does not match parsed source`);
    }
    if (n.kind === "module") {
      if (!sameMembers(n.members, exp.members)) {
        issues.push(`module ${n.id} member table does not match parsed source`);
      }
      const expNamed = [...(exp.namedExports ?? [])].sort();
      const gotNamed = [...(n.namedExports ?? [])].sort();
      if (
        n.namedExports === undefined ||
        expNamed.length !== gotNamed.length ||
        expNamed.some((x, i) => x !== gotNamed[i])
      ) {
        issues.push(`module ${n.id} namedExports do not match parsed source`);
      }
      if (n.defaultMember !== exp.defaultMember) {
        issues.push(`module ${n.id} default identity does not match parsed source`);
      }
    }
  }

  for (const n of graph.nodes) {
    const f = fileByPath.get(n.module);
    if (!f) {
      issues.push(`node ${n.id} references missing file ${n.module}`);
      continue;
    }
    if (n.line !== null && (n.line < 1 || n.line > f.lineCount)) {
      issues.push(`node ${n.id} line ${n.line} outside ${n.module} (1..${f.lineCount})`);
    }
    if (n.kind === "member" && expUnsupported.has(n.module)) {
      issues.push(`member ${n.id} claimed from unsupported module ${n.module}`);
    }
    // Exact parsed node/provenance matching above establishes the anchor.
    // Text substring checks cannot validate multiline aliases or synthetic
    // default labels and must never replace AST binding identity.

  }

  // Per-file static statements, parsed once, keyed for edge verification.
  const sitesByModule = new Map<string, ReturnType<typeof staticImportSites>>();
  for (const f of snapshot.files) {
    const src = contents.get(f.path);
    if (src !== undefined) sitesByModule.set(f.path, staticImportSites(f.path, src, pathSet));
  }

  for (const e of graph.edges) {
    const fromNode = nodeById.get(e.from);
    if (!fromNode || fromNode.kind !== "module") {
      issues.push(`edge source is not an actual module node: ${e.from}`);
      continue;
    }
    const fromFile = fileByPath.get(fromNode.module);
    if (fromFile && (e.line < 1 || e.line > fromFile.lineCount)) {
      issues.push(`edge line ${e.line} outside ${fromNode.module} (1..${fromFile.lineCount})`);
    }
    // The edge must correspond to a real statement in the importer's own
    // source, at the same line, with the same specifier (ownership).
    const sites = sitesByModule.get(fromNode.module) ?? [];
    const site = sites.find((s) => s.spec === e.specifier && s.line === e.line && s.statementOffset === e.statementOffset);
    if (!site) {
      issues.push(
        `edge ${e.kind} ${e.specifier} at ${fromNode.module}:${e.line} has no matching import/export statement; target does not match source resolution or statement identity`
      );
      continue;
    }
    // F3: source-derived parse status governs BOTH endpoints, regardless
    // of any graph-supplied unsupportedModules metadata.
    if (
      (e.kind === "imports" || e.kind === "references") &&
      expUnsupported.has(fromNode.module)
    ) {
      issues.push(`resolved ${e.kind} edge from unsupported module ${fromNode.module}`);
    }
    if (e.kind === "imports") {
      if (site.to === null || moduleNodeId(site.to) !== e.to) {
        issues.push(`imports edge target does not match source resolution: ${e.to}`);
      } else if (!nodeById.has(e.to)) {
        issues.push(`imports edge to missing node ${e.to}`);
      } else if (expUnsupported.has(site.to)) {
        // F3: a resolved edge into a malformed target is never verified.
        issues.push(`imports edge resolves into unsupported module ${site.to}`);
      }
    } else if (e.kind === "references") {
      const toNode = nodeById.get(e.to);
      if (!toNode || toNode.kind !== "member") {
        issues.push(`references edge to missing member node ${e.to}`);
        continue;
      }
      if (site.to === null || moduleNodeId(site.to) !== moduleNodeId(toNode.module)) {
        issues.push(`references edge target module does not match source: ${e.to}`);
        continue;
      }
      if (expUnsupported.has(toNode.module)) {
        issues.push(`references edge resolves into unsupported module ${toNode.module}`);
        continue;
      }
      // F1/F5: exact AST identity against the source-derived expectation.
      // Named requires a non-type-only named binding AND true named-export
      // status; default requires a non-type-only default binding AND the
      // target's exact default member. No substring matching.
      const expMod = expById.get(moduleNodeId(toNode.module));
      const named =
        site.bindings.some(
          (b) => b.kind === "named" && b.origKind === "named" && !b.typeOnly && b.orig === toNode.label
        ) &&
        (expMod?.namedExports ?? []).includes(toNode.label);
      const byDefault =
        site.bindings.some(
          (b) => (b.kind === "default" || b.origKind === "default") && !b.typeOnly
        ) &&
        expMod?.defaultMember != null &&
        expMod.defaultMember === toNode.label;
      if (!named && !byDefault) {
        issues.push(
          `references edge has no matching import binding for ${toNode.label} in ${fromNode.module}:${e.line}`
        );
      }
    } else if (e.kind === "external") {
      if (!e.specifier || e.specifier.startsWith(".") || site.to !== null) {
        issues.push(`external edge specifier invalid: ${e.specifier}`);
      }
      if (nodeById.has(e.to)) issues.push(`external edge fakes a resolved target: ${e.to}`);
    } else if (e.kind === "unresolvable") {
      // Downgraded edges involving malformed importers OR targets are
      // the one legal case where the specifier would otherwise resolve.
      const downgraded =
        expUnsupported.has(fromNode.module) ||
        (site.to !== null && expUnsupported.has(site.to));
      if (!e.specifier.startsWith(".") || (site.to !== null && !downgraded)) {
        issues.push(`unresolvable edge actually resolves in source: ${e.specifier}`);
      }
      if (nodeById.has(e.to)) issues.push(`unresolvable edge fakes a resolved target: ${e.to}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Full evidence verification: structural checks + per-file evidence —
 * actual bytes and line counts must equal the recorded snapshot values,
 * member anchors must agree with their module's member table, and each
 * file's SHA-256 (via the injected hashFn, node:crypto in tests) must
 * equal the recorded hash. No hashFn => FAIL CLOSED.
 */
function validateEvidenceInternal(
  graph: AstGraph,
  snapshot: EvidenceSnapshot,
  contents: Map<string, string>,
  hashFn?: (text: string) => string,
  expected?: ExpectedBinding
): EvidenceResult {
  const shape = validateGraphShape(graph, snapshot, contents, expected);
  const issues = [...shape.issues];
  if (!hashFn) {
    issues.push("SHA-256 verification not performed: hashFn is required (fail closed)");
  }
  for (const f of snapshot.files) {
    const src = contents.get(f.path);
    if (src === undefined) {
      issues.push(`snapshot file ${f.path} has no content bytes`);
      continue;
    }
    const bytes = new TextEncoder().encode(src).length;
    if (bytes !== f.bytes) {
      issues.push(`file ${f.path} bytes ${f.bytes} != actual ${bytes}`);
    }
    const geometry = sourceGeometry(src);
    if (geometry.lineCount !== f.lineCount) {
      issues.push(`file ${f.path} lineCount ${f.lineCount} != actual ${geometry.lineCount}`);
    }
    if (f.lineStartOffsets && JSON.stringify(f.lineStartOffsets) !== JSON.stringify(geometry.lineStartOffsets)) {
      issues.push(`file ${f.path} lineStartOffsets do not match exact source bytes`);
    }
    if (hashFn) {
      if (!/^[0-9a-f]{64}$/.test(f.sha256)) {
        issues.push(`file ${f.path} recorded SHA is malformed`);
      } else if (hashFn(src) !== f.sha256) {
        issues.push(`file ${f.path} SHA-256 does not match recorded hash`);
      }
    }
  }
  // Member anchors re-verified against the member table of their module node.
  for (const n of graph.nodes) {
    if (n.kind !== "member") continue;
    const modNode = graph.nodes.find((x) => x.id === moduleNodeId(n.module));
    if (!modNode) {
      issues.push(`member ${n.id} has no module node`);
      continue;
    }
    const mem = modNode.members[n.label];
    if (!mem) {
      issues.push(`member ${n.id} not exported by ${n.module}`);
    } else if (mem.line !== n.line) {
      issues.push(`member ${n.id} line ${n.line} != module record ${mem.line}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

/** Malformed runtime payloads must fail closed, including malformed provenance. */
export function validateGraphShape(
  graph: AstGraph, snapshot: EvidenceSnapshot, contents: Map<string, string>, expected?: ExpectedBinding
): EvidenceResult {
  try { return validateGraphShapeInternal(graph, snapshot, contents, expected); }
  catch { return { ok: false, issues: ["malformed graph or source evidence (fail closed)"] }; }
}

export function validateEvidence(
  graph: AstGraph, snapshot: EvidenceSnapshot, contents: Map<string, string>,
  hashFn?: (text: string) => string, expected?: ExpectedBinding
): EvidenceResult {
  try { return validateEvidenceInternal(graph, snapshot, contents, hashFn, expected); }
  catch { return { ok: false, issues: ["malformed graph, source evidence or hash result (fail closed)"] }; }
}
