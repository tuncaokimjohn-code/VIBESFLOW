// P4: Real TypeScript AST architecture graph over a validated SourceSnapshot.
// Parses snapshot source bytes with the TypeScript Compiler API and extracts
// module/member structure with precise file:line evidence. Nothing here
// executes repository code, fabricates links, or claims security findings.
// Dynamic imports, external packages and unresolvable specifiers are recorded
// explicitly as unknown/unsupported — never as silent edges.
//
// Evidence rule (Gate 5): every exported member and every resolved edge must
// name an EXISTING snapshot file plus a 1-based line inside that file.
// validateGraphShape enforces node/edge reference integrity structurally;
// validateEvidence additionally checks excerpt bytes and (when a hashFn is
// supplied, as in tests) file SHA-256 consistency. Invalid evidence fails
// closed (ok=false), never partially.

import ts from "typescript";
import { sourceLines } from "@/lib/source-lines";

export const AST_GRAPH_LABEL = "offline-fixture";

export interface MemberProvenance {
  anchorOffset: number;
  anchorLine: number;
  slot: string;
  origin: "local" | "upstream";
  originId: string;
  statementOffset: number;
  bindingOffset: number;
  bindingLine: number;
  declaration: { module: string; name: string; ownerOffset: number; offset: number; line: number } | null;
}

export interface ReferenceProvenance {
  statementOffset: number;
  bindingOffset: number;
  line: number;
  bindingLine: number;
  statement: "import" | "export";
  local: string;
  orig: string;
  originSlot: string;
}

export interface AstGraphNode {
  id: string;
  kind: "module" | "member";
  label: string;
  /** Repository-relative path of the containing file. */
  module: string;
  /** 1-based line of the declaration, when known. */
  line: number | null;
  /** All exported members of this module (member nodes cite these lines). */
  members: Record<string, { name: string; kind: string; line: number }>;
  /** Truthful declaration kind for member nodes (function/class/const/component/re-export). */
  declKind?: string;
  provenance?: MemberProvenance[];
  /** Module nodes only: exported names available to NAMED imports. */
  namedExports?: string[];
  /** Module nodes only: member label of the default export, if any. */
  defaultMember?: string | null;
}

export interface AstGraphEdge {
  statementOffset?: number;
  bindings?: ReferenceProvenance[];
  from: string;
  to: string;
  kind: "imports" | "external" | "unknown" | "unresolvable" | "references";
  /** Static module specifier text, verbatim from source. */
  specifier: string;
  /** 1-based line of the import statement (local edges only). */
  line: number;
}

export interface AstGraph {
  nodes: AstGraphNode[];
  edges: AstGraphEdge[];
  /** Explicit unknown edges: kept in edges for provenance, unsupported for traversal. */
  unresolved: AstGraphEdge[];
  /** Modules whose parse produced diagnostics (still emitted, marked unsupported). */
  unsupportedModules: string[];
  /** Export forms this slice does not extract (explicit, never silently dropped). */
  unsupportedForms: Array<{ module: string; line: number; form: string }>;
  snapshotId: string;
  /** Snapshot binding: evidence validation fails closed on mismatch. */
  canonicalProvenance: string;
  resolvedCommitIfGitHub: string | null;
}

const NODE_ID_PREFIX = "ast-module:";

export function moduleNodeId(path: string): string {
  return NODE_ID_PREFIX + path;
}

interface SnapshotLike {
  snapshotId: string;
  files: Array<{ path: string; language: "ts" | "tsx"; bytes: number; sha256: string }>;
  skipped: Array<{ path: string; reason: string; detail?: string }>;
  canonicalProvenance: string;
  resolvedCommitIfGitHub: string | null;
}

/**
 * Build an AST graph from a validated snapshot + contents map. Files absent
 * from the snapshot are ignored; snapshot files absent from `contents` are
 * omitted from the graph (callers must pass actual source bytes).
 */
export function buildAstGraph(
  snapshot: SnapshotLike,
  contents: Map<string, string>
): AstGraph {
  const paths = new Set(snapshot.files.map((f) => f.path));
  const unsupportedForms: AstGraph["unsupportedForms"] = [];
  const edges: AstGraphEdge[] = [];
  const DEFAULT = "slot:default";
  const namedSlot = (name: string) => `slot:named:${name}`;
  type Declaration = { name: string; kind: string; line: number; offset: number; ownerOffset: number };
  type Claim = {
    slot: string; label: string; statementOffset: number; bindingOffset: number; line: number; anchorOffset: number; anchorLine: number;
    origin: { kind: "local"; name: string } |
      { kind: "upstream"; spec: string; name: string; slot: string; namespace: boolean } |
      { kind: "anonymous" };
  };
  type Accepted = { claim: Claim; originId: string; declaration?: Declaration; target?: string };
  type Module = {
    path: string; src: string; sf: ts.SourceFile; malformed: boolean;
    declarations: Map<string, Declaration[]>; claims: Claim[]; accepted: Map<string, Accepted>;
    sites: StaticImportSite[];
  };
  const modules: Module[] = [];
  const reject = (m: Module, c: Claim, form: string) => {
    unsupportedForms.push({ module: m.path, line: c.line, form });
  };

  // Collect only SourceFile statement owners. Never recursively collect
  // declarations from functions, blocks, classes or namespace bodies.
  for (const file of snapshot.files) {
    const src = contents.get(file.path);
    if (src === undefined || (file.language !== "ts" && file.language !== "tsx")) continue;
    const sf = ts.createSourceFile(file.path, src, ts.ScriptTarget.ESNext, true,
      file.language === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const malformed = ((sf as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length ?? 0) > 0;
    const m: Module = { path: file.path, src, sf, malformed, declarations: new Map(), claims: [], accepted: new Map(),
      sites: staticImportSites(file.path, src, paths) };
    modules.push(m);
    const claim = (statement: ts.Node, binding: ts.Node, slot: string, label: string, origin: Claim["origin"], anchor: ts.Node = binding) => {
      m.claims.push({ slot, label, origin, statementOffset: statement.getStart(sf),
        bindingOffset: binding.getStart(sf), line: lineOf(sf, src, binding.getStart(sf)),
        anchorOffset: anchor.getStart(sf), anchorLine: lineOf(sf, src, anchor.getStart(sf)) });
    };
    const declare = (owner: ts.Node, node: ts.Node, name: string, kind: string) => {
      const d: Declaration = { name, kind, line: lineOf(sf, src, node.getStart(sf)),
        offset: node.getStart(sf), ownerOffset: owner.getStart(sf) };
      const ds = m.declarations.get(name) ?? []; ds.push(d); m.declarations.set(name, ds);
    };
    for (const node of sf.statements) {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
        if (node.name) {
          declare(node, node, node.name.text, ts.isFunctionDeclaration(node) ? "function" : "class");
          if (hasExport(node)) claim(node, node, isExportDefault(node) ? DEFAULT : namedSlot(node.name.text),
            node.name.text, { kind: "local", name: node.name.text });
        } else if (isExportDefault(node)) {
          claim(node, node, DEFAULT, "", { kind: "anonymous" });
        }
      } else if (ts.isVariableStatement(node)) {
        const kind = node.declarationList.flags & ts.NodeFlags.Const ? "const" :
          node.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) {
            declare(node, d, d.name.text, initializerKind(d.initializer, d.name.text, file.language === "tsx", kind));
            if (hasExport(node)) claim(node, d, namedSlot(d.name.text), d.name.text, { kind: "local", name: d.name.text });
          } else if (hasExport(node)) {
            unsupportedForms.push({ module: m.path, line: lineOf(sf, src, d.getStart(sf)),
              form: "destructured variable export (members not extracted)" });
          }
        }
      } else if (ts.isExportAssignment(node)) {
        if (node.isExportEquals) {
          unsupportedForms.push({ module: m.path, line: lineOf(sf, src, node.getStart(sf)),
            form: `export = ${node.expression.getText(sf)} (export-assignment not modeled as default)` });
        } else {
          const name = ts.isIdentifier(node.expression) ? node.expression.text : "";
          claim(node, node.expression, DEFAULT, name, name ? { kind: "local", name } : { kind: "anonymous" });
        }
      } else if (ts.isExportDeclaration(node)) {
        const spec = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
        const clause = node.exportClause;
        if (!clause) {
          unsupportedForms.push({ module: m.path, line: lineOf(sf, src, node.getStart(sf)),
            form: `export * from "${spec}" member set not extracted (unsupported)` });
        } else if (ts.isNamedExports(clause)) {
          for (const b of clause.elements) {
            if (node.isTypeOnly || b.isTypeOnly) {
              unsupportedForms.push({ module: m.path, line: lineOf(sf, src, b.getStart(sf)), form: "type-only export (no value member)" });
              continue;
            }
            const orig = b.propertyName?.text ?? b.name.text;
            const slot = b.name.text === "default" ? DEFAULT : namedSlot(b.name.text);
            const label = slot === DEFAULT ? (orig === "default" ? "__default__" : orig) : b.name.text;
            claim(node, b, slot, label, spec === null ? { kind: "local", name: orig } :
              { kind: "upstream", spec, name: orig, slot: orig === "default" ? DEFAULT : namedSlot(orig), namespace: false },
              slot === DEFAULT ? (b.propertyName ?? b.name) : b.name);
          }
        } else if (ts.isNamespaceExport(clause) && spec !== null) {
          if (node.isTypeOnly) {
            unsupportedForms.push({ module: m.path, line: lineOf(sf, src, clause.name.getStart(sf)),
              form: "type-only namespace export (no value member)" });
          } else {
            const isDefault = clause.name.text === "default";
            claim(node, clause.name, isDefault ? DEFAULT : namedSlot(clause.name.text),
              isDefault ? "__default__" : clause.name.text,
              { kind: "upstream", spec, name: "*", slot: "namespace", namespace: true });
          }
        }
      } else if (ts.isModuleDeclaration(node)) {
        unsupportedForms.push({ module: m.path, line: lineOf(sf, src, node.getStart(sf)),
          form: "namespace declaration (members not extracted)" });
      } else if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && hasExport(node)) {
        unsupportedForms.push({ module: m.path, line: lineOf(sf, src, node.getStart(sf)), form: "type/enum declaration (members not extracted)" });
      }
    }
  }
  const byPath = new Map(modules.map((m) => [m.path, m]));
  const unsupportedModules = modules.filter((m) => m.malformed).map((m) => m.path);
  const eligible = new Map<Module, Claim[]>();
  for (const m of modules) {
    const groups = new Map<string, Claim[]>();
    for (const c of m.claims) { const cs = groups.get(c.slot) ?? []; cs.push(c); groups.set(c.slot, cs); }
    const cs: Claim[] = []; eligible.set(m, cs);
    if (m.malformed) continue;
    for (const claims of groups.values()) {
      if (claims.length !== 1) {
        for (const c of claims) reject(m, c, `conflicting ${c.origin.kind === "upstream" ? "re-export " : ""}identity ${c.slot} (unsupported duplicate claims)`);
        continue;
      }
      const c = claims[0];
      if (c.origin.kind === "local") {
        const ds = m.declarations.get(c.origin.name) ?? [];
        if (ds.length !== 1) {
          reject(m, c, `local export ${c.origin.name} has ${ds.length ? "ambiguous declarations" : "no supported module-scope declaration"} (unsupported)`);
          continue;
        }
        const d = ds[0];
        m.accepted.set(c.slot, { claim: c, declaration: d,
          originId: JSON.stringify(["local", m.path, d.ownerOffset, d.offset]) });
      } else if (c.origin.kind === "anonymous") {
        reject(m, c, "anonymous default export (unsupported member identity)");
        m.accepted.set(c.slot, { claim: c, originId: JSON.stringify(["anonymous", m.path, c.bindingOffset]) });
      } else cs.push(c);
    }
  }

  // Grounded availability only: every added upstream claim traces to a
  // real accepted local/anonymous/namespace origin. Unseeded cycles stop.
  let changed = true;
  for (let round = 0; changed && round <= modules.length + 1; round++) {
    changed = false;
    for (const m of modules) for (const c of eligible.get(m) ?? []) {
      if (m.accepted.has(c.slot) || c.origin.kind !== "upstream") continue;
      const o = c.origin;
      const target = o.spec.startsWith(".") ? resolveLocal(o.spec, m.path, paths) : null;
      const upstream = target === null ? undefined : byPath.get(target);
      if (!upstream || upstream.malformed || (!o.namespace && !upstream.accepted.has(o.slot))) continue;
      m.accepted.set(c.slot, { claim: c, target: upstream.path,
        originId: JSON.stringify(["upstream", upstream.path, o.slot]) });
      changed = true;
    }
  }
  // The module/label public contract cannot anchor unrelated values at
  // one member. Named slots are retained; conflicting default is explicit.
  // Slot conflicts were already removed as a group, before availability.
  for (const m of modules) {
    const d = m.accepted.get(DEFAULT);
    if (!d || !d.claim.label) continue;
    const n = m.accepted.get(namedSlot(d.claim.label));
    if (n && n.originId !== d.originId) {
      reject(m, d.claim, d.claim.origin.kind === "upstream" ?
        `conflicting re-export identity default ${d.claim.label} (unsupported anchor collision)` :
        `conflicting default identity ${d.claim.label} (unsupported anchor collision)`);
      m.accepted.delete(DEFAULT);
    }
  }
  // Removing a conflicting default can invalidate arbitrary downstream
  // named/default chains. Removal is monotone, bounded by module depth.
  changed = true;
  for (let round = 0; changed && round <= modules.length + 1; round++) {
    changed = false;
    for (const m of modules) for (const [slot, a] of m.accepted) {
      const o = a.claim.origin;
      if (o.kind !== "upstream" || o.namespace) continue;
      if (!byPath.get(a.target!)?.accepted.has(o.slot)) { m.accepted.delete(slot); changed = true; }
    }
  }
  for (const m of modules) for (const c of eligible.get(m) ?? []) {
    if (!m.accepted.has(c.slot)) reject(m, c, `re-export ${c.origin.kind === "upstream" ? c.origin.name : c.label} not verified as a value export or upstream identity invalidated (unsupported)`);
  }

  const nodes: AstGraphNode[] = [];
  const memberNodes: AstGraphNode[] = [];
  const labelFor = (a: Accepted | undefined) => a && a.claim.origin.kind !== "anonymous" ? a.claim.label : null;
  for (const m of modules) {
    const members: AstGraphNode["members"] = Object.create(null);
    const provenance = new Map<string, MemberProvenance[]>();
    const accepted = [...m.accepted.values()].sort((a, b) =>
      Number(a.claim.slot === DEFAULT) - Number(b.claim.slot === DEFAULT) || a.claim.bindingOffset - b.claim.bindingOffset);
    for (const a of accepted) {
      const c = a.claim;
      if (c.origin.kind === "anonymous") continue;
      const d = a.declaration;
      const declarationAnchor = d && (c.slot === DEFAULT || c.label === d.name);
      const anchor = declarationAnchor ? d.line : c.anchorLine;
      if (!members[c.label]) members[c.label] = { name: c.label, kind: d?.kind ?? "re-export", line: anchor };
      const ps = provenance.get(c.label) ?? [];
      ps.push({ anchorOffset: declarationAnchor ? d.offset : c.anchorOffset, anchorLine: anchor, slot: c.slot, origin: c.origin.kind, originId: a.originId,
        statementOffset: c.statementOffset, bindingOffset: c.bindingOffset, bindingLine: c.line,
        declaration: d ? { module: m.path, name: d.name, ownerOffset: d.ownerOffset, offset: d.offset, line: d.line } : null });
      provenance.set(c.label, ps);
    }
    nodes.push({ id: moduleNodeId(m.path), kind: "module", label: m.path.split("/").pop() ?? m.path,
      module: m.path, line: 1, members,
      namedExports: [...m.accepted.keys()].filter((s) => s !== DEFAULT).map((s) => s.slice("slot:named:".length)),
      defaultMember: labelFor(m.accepted.get(DEFAULT)) });
    for (const mem of Object.values(members)) {
      memberNodes.push({ id: `${moduleNodeId(m.path)}#${mem.name}`, kind: "member", label: mem.name,
        module: m.path, line: mem.line, members: {}, declKind: mem.kind, provenance: provenance.get(mem.name) });
    }
  }
  const valueEdges = new Map<string, AstGraphEdge>();
  for (const m of modules) for (const site of m.sites) {
    const upstream = site.to === null ? undefined : byPath.get(site.to);
    const resolved = !!upstream && !m.malformed && !upstream.malformed;
    edges.push({ from: moduleNodeId(m.path), to: moduleNodeId(resolved ? upstream.path : site.spec),
      kind: !site.spec.startsWith(".") ? "external" : resolved ? "imports" : "unresolvable",
      specifier: site.spec, line: site.line, statementOffset: site.statementOffset });
    if (!resolved) continue;
    for (const b of site.bindings) {
      if (b.typeOnly || b.kind === "namespace") continue;
      const slot = b.kind === "default" || b.origKind === "default" ? DEFAULT : namedSlot(b.orig);
      const a = upstream.accepted.get(slot);
      const label = labelFor(a);
      if (!label) continue;
      if (site.statement === "export") {
        const own = m.accepted.get(b.local === "default" ? DEFAULT : namedSlot(b.local));
        if (!own || own.claim.origin.kind !== "upstream" || own.target !== upstream.path ||
          own.claim.origin.slot !== slot || own.claim.statementOffset !== site.statementOffset ||
          own.claim.bindingOffset !== b.offset) continue;
      }
      const to = `${moduleNodeId(upstream.path)}#${label}`;
      const key = JSON.stringify([moduleNodeId(m.path), to, site.spec]);
      const p: ReferenceProvenance = { statementOffset: site.statementOffset, bindingOffset: b.offset,
        line: site.line, bindingLine: b.line, statement: site.statement, local: b.local, orig: b.orig, originSlot: slot };
      const old = valueEdges.get(key);
      if (old) old.bindings!.push(p);
      else valueEdges.set(key, { from: moduleNodeId(m.path), to, kind: "references", specifier: site.spec,
        line: site.line, statementOffset: site.statementOffset, bindings: [p] });
    }
  }
  edges.push(...valueEdges.values());
  return { nodes: [...nodes, ...memberNodes], edges,
    unresolved: edges.filter((e) => e.kind !== "imports" && e.kind !== "references"),
    unsupportedModules, unsupportedForms, snapshotId: snapshot.snapshotId,
    canonicalProvenance: snapshot.canonicalProvenance, resolvedCommitIfGitHub: snapshot.resolvedCommitIfGitHub };
}

/** 1-based source line for a declaration offset. */
export function lineOf(sf: ts.SourceFile, src: string, pos: number): number {
  return sf.getLineAndCharacterOfPosition(Math.max(0, Math.min(pos, src.length))).line + 1;
}

/** Display helpers (URL/fragment-safe ids skip member encoding entirely). */
export function memberSuffix(id: string): string | null {
  const i = id.indexOf("#");
  return i < 0 ? null : id.slice(i + 1);
}

/** Bounded read-only excerpt lines around a 1-based line. */
export function excerptAround(src: string, line: number, before: number, after: number): string[] {
  return numberedExcerpt(src, line, before, after).map((r) => r.text);
}

export interface NumberedLine {
  /** Actual 1-based source line number of this row (never < 1). */
  n: number;
  text: string;
  /** True for the (clamped) selected declaration line. */
  target: boolean;
}

/**
 * Excerpt with TRUE line numbers (FIX 4): the first displayed number is
 * derived from the clamped window start, not from `line - before`, so
 * line 1 and short files never show zero/negative numbers.
 */
export function numberedExcerpt(
  src: string,
  line: number,
  before: number,
  after: number
): NumberedLine[] {
  const lines = sourceLines(src);
  const target = Math.min(Math.max(1, line), lines.length);
  const start = Math.max(1, target - before);
  const end = Math.min(lines.length, target + after);
  const out: NumberedLine[] = [];
  for (let n = start; n <= end; n++) {
    out.push({ n, text: lines[n - 1] as string, target: n === target });
  }
  return out;
}

// ---- internal helpers ----

function hasExport(node: ts.Node): boolean {
  return (
    !!(node as { modifiers?: readonly ts.Modifier[] }).modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword
    )
  );
}
function isExportDefault(node: ts.Node): boolean {
  const mods = (node as { modifiers?: readonly ts.Modifier[] }).modifiers;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
    !!mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

/**
 * Truthful declaration kinds (FIX 7): only an uppercase .tsx binding whose
 * initializer actually contains JSX is a "component"; function-valued
 * bindings are "function"; everything else (numbers, objects, calls) is
 * "const". Constants are never labeled components or functions.
 */
function initializerKind(
  init: ts.Expression | undefined,
  name: string,
  isTsx: boolean,
  declKind: "const" | "let" | "var" = "const"
): string {
  if (!init) return declKind;
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    return isTsx && /^[A-Z]/.test(name) && ownJsxReturn(init) ? "component" : "function";
  }
  // F7: non-function bindings keep their real declaration kind
  // (const/let/var are distinct; none is labeled "const" by default).
  return declKind;
}

function isJsxNode(node: ts.Node): boolean {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

/** JSX in an expression position the function itself returns. */
function ownJsxExpr(expr: ts.Expression): boolean {
  if (isJsxNode(expr)) return true;
  if (ts.isParenthesizedExpression(expr)) return ownJsxExpr(expr.expression);
  if (ts.isConditionalExpression(expr)) {
    // BOTH branches must be suitable: JSX versus object/number is a
    // mixed return path, not a reliable component (F7, C006).
    return ownJsxExpr(expr.whenTrue) && ownJsxExpr(expr.whenFalse);
  }
  // Binary/logical, objects, calls, identifiers etc. are not reliably
  // the function's own JSX return (F7).
  return false;
}

function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * F7: true only when the CLASSIFIED function itself returns JSX.
 * Nested functions, methods and object properties are boundaries:
 * `() => ({ render: () => <div/> })` returns an object, so it is a
 * function, not a component. Ambiguous cases stay "function".
 */
function ownJsxReturn(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
    (ts.isFunctionExpression(fn) && !!fn.asteriskToken)) return false;
  const body = fn.body;
  if (!ts.isBlock(body)) return ownJsxExpr(body);
  // This bounded subset requires a syntactically complete return path.
  // It deliberately does not solve loops, switches, throws or async flow.
  const coversReturn = (n: ts.Node): boolean => {
    if (ts.isReturnStatement(n)) return true;
    if (ts.isBlock(n)) return n.statements.some(coversReturn);
    if (ts.isIfStatement(n)) return !!n.elseStatement && coversReturn(n.thenStatement) && coversReturn(n.elseStatement);
    if (ts.isTryStatement(n)) return !!n.finallyBlock && coversReturn(n.finallyBlock) ||
      coversReturn(n.tryBlock) && (!n.catchClause || coversReturn(n.catchClause.block));
    return false;
  };
  if (!coversReturn(body)) return false;
  let uncertainFlow = false;
  // Collect the function's OWN returns, tracking finally blocks. A
  // return inside `finally` overrides try/catch returns, so overridden
  // or mixed return flow is ambiguous => NOT a component (F7, C005).
  // This is a narrow heuristic, not general control-flow analysis.
  const returns: Array<{
    finallyLevel: number;
    jsx: boolean;
    conditional: boolean;
    /** Ids of try statements enclosing this return. */
    tryIds: number[];
    /** Id of the try whose finally encloses this return, or -1. */
    finallyTryId: number;
  }> = [];
  let nextTryId = 0;
  const isConditionalContext = (node: ts.Node): boolean =>
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node);
  // finallyLevel: 0 = not in a finally; otherwise the nesting depth of
  // the enclosing try (outermost finally = 1). Only the OUTERMOST
  // finally can reliably override; an inner finally's return is still
  // subject to every outer finally (F7, C007).
  const walk = (
    node: ts.Node,
    finallyLevel: number,
    tryDepth: number,
    conditional: boolean,
    isRoot: boolean,
    tryIds: number[],
    finallyTryId: number
  ): void => {
    if (!isRoot && isFunctionBoundary(node)) return;
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node) ||
      ts.isThrowStatement(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node)) uncertainFlow = true;
    if (ts.isReturnStatement(node)) {
      returns.push({
        finallyLevel,
        jsx: node.expression ? ownJsxExpr(node.expression) : false,
        conditional,
        tryIds: [...tryIds],
        finallyTryId,
      });
      return;
    }
    if (ts.isTryStatement(node)) {
      const depth = tryDepth + 1;
      const id = nextTryId++;
      const inner = [...tryIds, id];
      walk(node.tryBlock, finallyLevel, depth, conditional, false, inner, finallyTryId);
      if (node.catchClause) walk(node.catchClause, finallyLevel, depth, conditional, false, inner, finallyTryId);
      if (node.finallyBlock) walk(node.finallyBlock, depth, depth, conditional, false, inner, id);
      return;
    }
    const nextConditional = conditional || isConditionalContext(node);
    ts.forEachChild(node, (c) => walk(c, finallyLevel, tryDepth, nextConditional, false, tryIds, finallyTryId));
  };
  walk(body, 0, 0, false, true, [], -1);
  if (uncertainFlow || returns.length === 0) return false;
  const finallyReturns = returns.filter((r) => r.finallyLevel > 0);
  // Dominance is NOT inferred from minimum finally depth (F7, C008):
  // returns living in MORE THAN ONE finally level interact (an inner
  // finally is itself subject to outer finally blocks), so the whole
  // return set must then be uniformly JSX. With a single finally
  // level, only its unconditional returns reliably override.
  const finallyLevels = new Set(finallyReturns.map((r) => r.finallyLevel));
  if (finallyLevels.size > 1) {
    return returns.every((r) => r.jsx);
  }
  const unconditionalFinally = finallyReturns.filter((r) => !r.conditional);
  // F7 scope (C009): a finally return only overrides returns inside
  // ITS OWN try/catch. Returns before or after that try are unrelated
  // paths; if any exist, every return path must be JSX.
  let effective = returns;
  if (unconditionalFinally.length > 0) {
    const decisive = new Set(unconditionalFinally.map((r) => r.finallyTryId));
    const allCovered = returns.every(
      (r) => decisive.has(r.finallyTryId) || r.tryIds.some((id) => decisive.has(id))
    );
    if (allCovered) effective = returns.filter((r) =>
      decisive.has(r.finallyTryId) || !r.tryIds.some((id) => decisive.has(id))
    );
  }
  return effective.every((r) => r.jsx);
}

export function resolveLocal(spec: string, fromPath: string, paths: Set<string>): string | null {
  // Root-level files have no "/": slicing to lastIndexOf("/") would chop
  // the last filename character (FIX 5).
  const slash = fromPath.lastIndexOf("/");
  const dir = slash >= 0 ? fromPath.slice(0, slash) : "";
  const base = normalize(join(dir, spec));
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}.js`,
    `${base}.jsx`,
  ];
  for (const c of candidates) if (paths.has(c)) return c;
  return paths.has(base) ? base : null;
}

function join(a: string, b: string): string {
  if (!a) return b;
  return `${a}/${b}`;
}

export function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

export interface ImportBinding {
  /** Exact AST binding position, independent of names and line collisions. */
  offset: number;
  line: number;
  kind: "default" | "named" | "namespace";
  /** Exported name in the target module ("__default__" for default bindings). */
  orig: string;
  /** Tagged origin kind: the upstream DEFAULT slot vs a named export. */
  origKind: "named" | "default";
  /** Local name in the importing module. */
  local: string;
  typeOnly: boolean;
}

export interface StaticImportSite {
  statementOffset: number;
  spec: string;
  line: number;
  /** Locally resolved target path, or null (external/unresolvable). */
  to: string | null;
  bindings: ImportBinding[];
  /** Whether this site is an import or a re-export statement. */
  statement: "import" | "export";
}

/**
 * Every static import / re-export statement in one file, with binding
 * identity preserved. Shared by the graph builder and evidence validation
 * so both sides agree on what a statement actually says (FIX 1/5).
 * Dynamic imports are deliberately absent.
 */
export function staticImportSites(
  path: string,
  src: string,
  paths: Set<string>
): StaticImportSite[] {
  const sf = ts.createSourceFile(
    path,
    src,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ false,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const sites: StaticImportSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier.getText(sf).slice(1, -1);
      const bindings: ImportBinding[] = [];
      const clause = node.importClause;
      if (clause) {
        const clauseTypeOnly = !!clause.isTypeOnly;
        if (clause.name) {
          bindings.push({ offset: clause.name.getStart(sf), line: lineOf(sf, src, clause.name.getStart(sf)), kind: "default", orig: "__default__", origKind: "default", local: clause.name.text, typeOnly: clauseTypeOnly });
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            bindings.push({ offset: clause.namedBindings.getStart(sf), line: lineOf(sf, src, clause.namedBindings.getStart(sf)), kind: "namespace", orig: "*", origKind: "named", local: clause.namedBindings.name.text, typeOnly: clauseTypeOnly });
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              bindings.push({
                offset: el.getStart(sf), line: lineOf(sf, src, el.getStart(sf)),
                kind: "named",
                orig: el.propertyName ? el.propertyName.text : el.name.text,
                origKind:
                  (el.propertyName?.text ?? el.name.text) === "default"
                    ? "default"
                    : "named",
                local: el.name.text,
                typeOnly: clauseTypeOnly || !!(el as { isTypeOnly?: boolean }).isTypeOnly,
              });
            }
          }
        }
      }
      sites.push({
        statementOffset: node.getStart(sf),
        spec,
        line: lineOf(sf, src, node.getStart(sf)),
        to: spec.startsWith(".") ? resolveLocal(spec, path, paths) : null,
        bindings,
        statement: "import",
      });
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = node.moduleSpecifier.getText(sf).slice(1, -1);
      const bindings: ImportBinding[] = [];
      const declTypeOnly = !!(node as { isTypeOnly?: boolean }).isTypeOnly;
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          bindings.push({
                offset: el.getStart(sf), line: lineOf(sf, src, el.getStart(sf)),
            kind: "named",
            orig: el.propertyName ? el.propertyName.text : el.name.text,
            origKind:
              (el.propertyName?.text ?? el.name.text) === "default"
                ? "default"
                : "named",
            local: el.name.text,
            // F5: specifier/declaration-level type-only is preserved.
            typeOnly: declTypeOnly || !!(el as { isTypeOnly?: boolean }).isTypeOnly,
          });
        }
      }
      sites.push({
        statementOffset: node.getStart(sf),
        spec,
        line: lineOf(sf, src, node.getStart(sf)),
        to: spec.startsWith(".") ? resolveLocal(spec, path, paths) : null,
        bindings,
        statement: "export",
      });
      return;
    }
  };
  for (const statement of sf.statements) visit(statement);
  return sites;
}
