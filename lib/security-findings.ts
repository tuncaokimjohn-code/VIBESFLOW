/**
 * P5 bounded, offline heuristics. SourceSnapshot identity/provenance/policy must
 * already have passed the upstream E1 schema (the real client does this).
 * This boundary independently rechecks exact inventory, paths, language, bytes,
 * every line offset and SHA-256 before parsing. It never executes source.
 * Only three rules are supported; ownership/admin authorization remain unimplemented.
 */
import * as ts from "typescript";
import { bytesForCharIndex, languageForPath, rejectUnsafePathForApi, type SourceSnapshot } from "@/lib/source-snapshot-contract";
import { sourceGeometry, sourceLines } from "@/lib/source-lines";

export interface SourceContextRow { line: number; text: string; target: boolean; startColumn: number }
export interface SecurityFinding {
  id: string;
  ruleId: "VF-SEC-001" | "VF-SEC-002" | "VF-SEC-003";
  title: string;
  severity: "high" | "medium";
  confidence: "medium";
  limitations: string;
  path: string;
  line: number;
  /** 1-based UTF-16 column; char offsets are 0-based UTF-16, byte offsets UTF-8. */
  column: number;
  charOffset: number;
  endCharOffset: number;
  byteOffset: number;
  endByteOffset: number;
  quote: string;
  excerpt: string;
  context: SourceContextRow[];
  snapshotId: string;
  commit: string | null;
  fileSha256: string;
  recommendation: string;
}
export const DETECTION_LIMITS = Object.freeze({
  maxFiles: 100, maxSourceBytes: 512 * 1024, maxFileBytes: 512 * 1024,
  maxLineStarts: 65_536, maxAstNodes: 50_000, maxAstDepth: 256,
  maxFindings: 200, maxFlowHops: 4, maxExpressionNodes: 128, deadlineMs: 2_000,
});
type Limits = { [K in keyof typeof DETECTION_LIMITS]: number };
export interface DetectionOptions { signal?: AbortSignal; limits?: Partial<Limits> }
export type DetectionResult =
  | { ok: true; findings: SecurityFinding[]; filesAnalyzed: number; filesTotal: number;
      malformedFiles: Array<{ path: string; diagnostics: number }>; scanComplete: boolean; findingLimitReached: boolean }
  | { ok: false; code: "EVIDENCE_INVALID" | "DETECTION_LIMIT" | "CANCELLED"; message: string };

const RULE_META = {
  "VF-SEC-001": {
    title: "Potential hardcoded credential in source", severity: "high" as const,
    limitations: "Potential finding: credential-name tokens and a non-placeholder literal of at least 8 characters. Synthetic/test values can still match; exposure and validity are unconfirmed.",
    recommendation: "Use an environment variable or secret manager. If this is a real exposed credential, rotate it and remove it from source history.",
  },
  "VF-SEC-002": {
    title: "Potential SQL query built from dynamic string content", severity: "high" as const,
    limitations: "Potential finding: SQL-shaped text with dynamic content reaches a database-named receiver. Suffixed query methods additionally require a lexical parameter or earlier same-block const with an explicit database-associated type name. Types/library identity, input trust and sanitizers are unconfirmed. Only bounded earlier same-block const aliases are followed; no cross-function flow.",
    recommendation: "Use parameterized queries/prepared statements with bound parameters instead of SQL interpolation or concatenation.",
  },
  "VF-SEC-003": {
    title: "Potential dynamic dangerouslySetInnerHTML content", severity: "medium" as const,
    limitations: "Potential finding: the __html value is dynamic. Input trust and sanitizer effectiveness are unconfirmed. Only inline objects and bounded earlier same-block const aliases are inspected.",
    recommendation: "Render escaped React children, or sanitize HTML with a vetted sanitizer before using dangerouslySetInnerHTML.",
  },
};
function nameOf(n: ts.Node): string {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && n.argumentExpression && ts.isStringLiteral(n.argumentExpression)) return n.argumentExpression.text;
  return "";
}
function stringLike(n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
}
function unwrap(n: ts.Expression): ts.Expression {
  // The AST depth limit applies before this runs.
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
  return n;
}
function credentialName(name: string): boolean {
  const tokens = name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  if (tokens.some(t => ["label", "name", "description", "placeholder", "hint", "length"].includes(t))) return false;
  // Credential is a terminal token, independent of application-specific prefixes.
  // Metadata names describe credentials rather than containing the secret itself.
  const credential = tokens.at(-1) === "credential" &&
    !tokens.some(t => ["source", "provider", "file", "path", "type", "kind", "format", "status"].includes(t));
  return credential ||
    tokens.some(t => ["password", "passwd", "secret", "apikey", "accesstoken", "authtoken"].includes(t)) ||
    tokens.some((t, i) => (t === "api" && tokens[i + 1] === "key") || (["access", "auth"].includes(t) && tokens[i + 1] === "token"));
}
function credentialValue(n: ts.Expression): boolean {
  n = unwrap(n);
  if (!stringLike(n)) return false;
  const value = n.text.trim();
  if (value.length < 8) return false;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, "");
  return !/^(?:your.*(?:key|token|secret|password|credential)(?:here)?|notareal(?:key|token|secret|password|credential)|changeme|replaceme|placeholder|example|sample|dummy|todo|password|your(?:api)?key|your(?:access|auth)?token|insert.*here|x+|\*+|0+)(?:\d*)$/.test(normalized) &&
    !/^(?:<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[^%]*%)$/.test(value);
}
interface Scope { aliases: Map<string, ts.Expression> }
interface Work { node: ts.Node; depth: number; scope: Scope }
function scopeStatements(n: ts.Node): readonly ts.Statement[] | null {
  return ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) ? n.statements : null;
}
function makeScope(statements: readonly ts.Statement[]): Scope {
  const aliases = new Map<string, ts.Expression>();
  const seen = new Set<string>();
  for (const s of statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue;
      if (seen.has(d.name.text)) { aliases.delete(d.name.text); continue; }
      seen.add(d.name.text);
      if ((s.declarationList.flags & ts.NodeFlags.Const) && d.initializer) aliases.set(d.name.text, d.initializer);
    }
  }
  return { aliases };
}
/** No outer scope lookup: avoids shadowing, closures, hoisting and mutable flow claims. */
function resolve(n: ts.Expression, scope: Scope, at: number, hops: number, limits: Limits): ts.Expression {
  n = unwrap(n);
  const seen = new Set<string>();
  while (ts.isIdentifier(n) && hops++ < limits.maxFlowHops && !seen.has(n.text)) {
    seen.add(n.text);
    const next = scope.aliases.get(n.text);
    if (!next || next.end >= at) break;
    at = next.getStart(); n = unwrap(next);
  }
  return n;
}
interface StringShape { literal: string; dynamic: boolean; string: boolean; complete: boolean }
/** Flatten bounded string construction; numeric arithmetic is not dynamic SQL. */
function stringShape(input: ts.Expression, scope: Scope, at: number, limits: Limits): StringShape {
  let count = 0;
  const walk = (expr: ts.Expression, hops: number, before: number): StringShape => {
    if (++count > limits.maxExpressionNodes) return { literal: "", dynamic: true, string: false, complete: false };
    const n = unwrap(expr);
    if (stringLike(n)) return { literal: n.text, dynamic: false, string: true, complete: true };
    if (ts.isNumericLiteral(n) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(n.kind)) return { literal: n.getText(), dynamic: false, string: true, complete: true };
    if (ts.isIdentifier(n) && hops < limits.maxFlowHops) {
      const next = scope.aliases.get(n.text);
      if (next && next.end < before) return walk(next, hops + 1, next.getStart());
    }
    if (ts.isTemplateExpression(n)) {
      let literal = n.head.text, dynamic = false, complete = true;
      for (const span of n.templateSpans) {
        const inner = walk(span.expression, hops, before);
        literal += inner.string && !inner.dynamic ? inner.literal : "?";
        literal += span.literal.text; dynamic ||= inner.dynamic || !inner.string; complete &&= inner.complete;
      }
      return { literal, dynamic, string: true, complete };
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = walk(n.left, hops, before), b = walk(n.right, hops, before);
      return { literal: (a.string ? a.literal : "?") + (b.string ? b.literal : "?"),
        dynamic: a.dynamic || b.dynamic || !a.string || !b.string, string: a.string || b.string, complete: a.complete && b.complete };
    }
    return { literal: "", dynamic: true, string: false, complete: true };
  };
  return walk(input, 0, at);
}
function bindsName(n: ts.BindingName, name: string): boolean {
  const stack = [n]; let count = 0;
  while (stack.length) {
    // A complex binding is ambiguous here: fail closed as a possible shadow.
    if (++count > DETECTION_LIMITS.maxExpressionNodes) return true;
    const binding = stack.pop()!;
    if (ts.isIdentifier(binding)) { if (binding.text === name) return true; }
    else for (const e of binding.elements) if (ts.isBindingElement(e)) stack.push(e.name);
  }
  return false;
}
function databaseType(type: ts.TypeNode | undefined): boolean {
  // Explicit simple annotation only: not an assertion, union, any, structural
  // object, constructor name or an arbitrary property named database.
  return !!type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) &&
    /^(?:Database|DB|Connection|Pool|[A-Z][A-Za-z0-9]*(?:Database|DB|Connection|Pool))$/.test(type.typeName.text);
}
/** Conservative stability check for the newly supported method family only.
 * No type checker or execution: ambiguous writes/rebindings or budget exhaustion
 * defer the candidate. Nested scopes are also inspected, conservatively. */
function stableDatabaseBinding(binding: ts.ParameterDeclaration | ts.VariableDeclaration, callee: ts.Node): boolean {
  if (!ts.isIdentifier(binding.name)) return false;
  const name = binding.name.text;
  let root: ts.Node = callee;
  while (root.parent && !ts.isFunctionLike(root) && !ts.isSourceFile(root)) root = root.parent;
  const stack = [root]; let count = 0;
  const containsName = (node: ts.Node): boolean => {
    const work = [node];
    while (work.length) {
      if (++count > DETECTION_LIMITS.maxExpressionNodes) return true;
      const n = work.pop()!;
      if (ts.isIdentifier(n) && n.text === name) return true;
      ts.forEachChild(n, child => { work.push(child); });
    }
    return false;
  };
  while (stack.length) {
    if (++count > DETECTION_LIMITS.maxExpressionNodes) return false;
    const n = stack.pop()!;
    if (n !== binding && (ts.isVariableDeclaration(n) || ts.isParameter(n)) && bindsName(n.name, name)) return false;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && containsName(n.left)) return false;
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && containsName(n.operand)) return false;
    ts.forEachChild(n, child => { stack.push(child); });
  }
  return true;
}
function typedDatabaseReceiver(callee: ts.PropertyAccessExpression): boolean {
  if (!ts.isIdentifier(callee.expression)) return false;
  const name = callee.expression.text;
  let inspected = 0, blocks = 0;
  // Walk only to the nearest function. Every intervening block checks lexical
  // shadowing, including declarations after the call (TDZ), destructuring,
  // function/class declarations and catch bindings. No closure/type resolution.
  for (let parent = callee.parent; parent; parent = parent.parent) {
    if (++inspected > DETECTION_LIMITS.maxExpressionNodes) return false;
    const statements = scopeStatements(parent);
    if (statements) {
      blocks++;
      const matches: ts.VariableDeclaration[] = [];
      for (const s of statements) {
        if (++inspected > DETECTION_LIMITS.maxExpressionNodes) return false;
        if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations) {
            if (++inspected > DETECTION_LIMITS.maxExpressionNodes) return false;
            if (bindsName(d.name, name)) matches.push(d);
          }
        } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === name) return false;
      }
      if (matches.length) {
        const d = matches[0];
        return blocks === 1 && matches.length === 1 && ts.isIdentifier(d.name) &&
          !!(d.parent.flags & ts.NodeFlags.Const) && !!d.initializer && d.end < callee.getStart() && databaseType(d.type) && stableDatabaseBinding(d, callee);
      }
    }
    if (ts.isCatchClause(parent) && parent.variableDeclaration && bindsName(parent.variableDeclaration.name, name)) return false;
    if (ts.isForStatement(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent) || ts.isSwitchStatement(parent) || ts.isWithStatement(parent)) return false;
    if (ts.isFunctionLike(parent)) {
      const matches = parent.parameters.filter(p => bindsName(p.name, name));
      return matches.length === 1 && ts.isIdentifier(matches[0].name) && !matches[0].dotDotDotToken && databaseType(matches[0].type) && stableDatabaseBinding(matches[0], callee);
    }
    if (ts.isClassLike(parent)) return false;
  }
  return false;
}
function sqlSink(callee: ts.LeftHandSideExpression): boolean {
  // Heuristic receiver allowlist; no bare query(), search.query(), shell.execute(),
  // generic .raw() or tagged templates. This does not resolve library types.
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!/^(?:db|database|pool|connection|conn|client|sql|prisma|knex)(?:\d+)?$/i.test(nameOf(callee.expression))) return false;
  return /^(?:query|execute|raw)$/i.test(callee.name.text) ||
    (/^query[A-Z][A-Za-z0-9]{0,47}$/.test(callee.name.text) && typedDatabaseReceiver(callee));
}
function sqlText(s: string): boolean {
  return /^\s*(?:SELECT\b[\s\S]*\bFROM\b|INSERT\s+INTO\b|UPDATE\b[\s\S]*\bSET\b|DELETE\s+FROM\b|WITH\b[\s\S]*\bSELECT\b)/i.test(s);
}
class DetectionStop extends Error {
  constructor(readonly code: "DETECTION_LIMIT" | "CANCELLED", message: string) { super(message); }
}

export async function detectSecurityFindings(snapshot: SourceSnapshot, contents: Map<string, string>,
  hashText: (text: string) => Promise<string> | string, options: DetectionOptions = {}): Promise<DetectionResult> {
  const limits: Limits = { ...DETECTION_LIMITS, ...options.limits };
  if (Object.keys(limits).some(k => { const key = k as keyof Limits; return !Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > DETECTION_LIMITS[key]; }))
    return { ok: false, code: "DETECTION_LIMIT", message: "Invalid detection limits; only reductions of fixed ceilings are permitted." };
  const started = performance.now();
  const check = () => {
    if (options.signal?.aborted) throw new DetectionStop("CANCELLED", "Security detection cancelled at a cooperative checkpoint.");
    if (performance.now() - started > limits.deadlineMs) throw new DetectionStop("DETECTION_LIMIT", "Security detection exceeded its cooperative time budget.");
  };
  const invalid = (message: string): DetectionResult => ({ ok: false, code: "EVIDENCE_INVALID", message });
  try {
    check();
    if (snapshot.files.length > limits.maxFiles || contents.size > limits.maxFiles) throw new DetectionStop("DETECTION_LIMIT", "Security detection file cap exceeded.");
    const paths = new Set(snapshot.files.map(f => f.path));
    if (paths.size !== snapshot.files.length || contents.size !== paths.size || [...contents.keys()].some(p => !paths.has(p))) return invalid("Source inventory mismatch.");
    const verified: Array<{ file: SourceSnapshot["files"][number]; text: string; lines: string[] }> = [];
    let bytes = 0, lineStarts = 0;
    for (const file of snapshot.files) {
      check();
      if (rejectUnsafePathForApi(file.path) || languageForPath(file.path) !== file.language) return invalid("Unsafe source path or unsupported language.");
      const text = contents.get(file.path);
      if (typeof text !== "string") return invalid(`Missing source contents for ${file.path}`);
      // Check UTF-16 length before allocating UTF-8. UTF-8 is never shorter.
      if (text.length > limits.maxFileBytes || bytes + text.length > limits.maxSourceBytes) throw new DetectionStop("DETECTION_LIMIT", "Actual security source byte cap exceeded.");
      const actualBytes = new TextEncoder().encode(text).length; bytes += actualBytes;
      if (actualBytes > limits.maxFileBytes || bytes > limits.maxSourceBytes) throw new DetectionStop("DETECTION_LIMIT", "Actual security source byte cap exceeded.");
      if (actualBytes !== file.bytes) return invalid(`Source byte length mismatch for ${file.path}`);
      const geometry = sourceGeometry(text); lineStarts += geometry.lineCount;
      if (lineStarts > limits.maxLineStarts) throw new DetectionStop("DETECTION_LIMIT", "Security source line cap exceeded.");
      if (geometry.lineCount !== file.lineCount || geometry.lineStartOffsets.length !== file.lineStartOffsets.length ||
          geometry.lineStartOffsets.some((offset, i) => offset !== file.lineStartOffsets[i])) return invalid(`Source line geometry mismatch for ${file.path}`);
      if (await hashText(text) !== file.sha256) return invalid(`Source hash mismatch for ${file.path}`);
      check(); verified.push({ file, text, lines: sourceLines(text) });
    }
    const findings: SecurityFinding[] = [];
    const malformedFiles: Array<{ path: string; diagnostics: number }> = [];
    let filesAnalyzed = 0, nodes = 0, findingLimitReached = false;
    for (const { file, text, lines } of verified) {
      // Delivers cancellation between files; synchronous parsing/traversal cannot
      // be interrupted by same-thread events. The deadline is cooperative only.
      await new Promise<void>(done => setTimeout(done, 0)); check();
      const sf = ts.createSourceFile(file.path, text, ts.ScriptTarget.ESNext, true, file.language === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      check();
      const diagnostics = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
      if (diagnostics.length) { malformedFiles.push({ path: file.path, diagnostics: diagnostics.length }); continue; }
      const add = (ruleId: SecurityFinding["ruleId"], anchor: ts.Node) => {
        if (findings.length >= limits.maxFindings) { findingLimitReached = true; return; }
        const token = anchor.getFirstToken(sf) ?? anchor;
        const start = token.getStart(sf), end = token.end;
        const { line: zeroLine, character } = sf.getLineAndCharacterOfPosition(start);
        const line = zeroLine + 1;
        const context = lines.slice(Math.max(0, zeroLine - 2), zeroLine + 3).map((source, i) => {
          const n = Math.max(0, zeroLine - 2) + i;
          const from = n === zeroLine ? Math.max(0, character - 100) : 0;
          return { line: n + 1, text: source.slice(from, from + 320), target: n === zeroLine, startColumn: from + 1 };
        });
        findings.push({ id: `${ruleId}:${file.path}:${start}`, ruleId, ...RULE_META[ruleId], confidence: "medium",
          path: file.path, line, column: character + 1, charOffset: start, endCharOffset: end,
          byteOffset: bytesForCharIndex(text, start), endByteOffset: bytesForCharIndex(text, end), quote: text.slice(start, end),
          excerpt: context.map(r => `${r.target ? "→" : " "} ${r.line}: ${r.startColumn > 1 ? "…" : ""}${r.text}`).join("\n"), context,
          snapshotId: snapshot.snapshotId, commit: snapshot.resolvedCommitIfGitHub, fileSha256: file.sha256, recommendation: RULE_META[ruleId].recommendation });
      };
      // Iterative traversal prevents a malicious deep AST exhausting the JS stack.
      const stack: Work[] = [{ node: sf, depth: 0, scope: { aliases: new Map() } }];
      while (stack.length && !findingLimitReached) {
        check(); const { node, depth, scope: outer } = stack.pop()!;
        if (++nodes > limits.maxAstNodes || depth > limits.maxAstDepth) throw new DetectionStop("DETECTION_LIMIT", "Security AST node/depth cap exceeded.");
        const statements = scopeStatements(node);
        const scope = statements ? makeScope(statements) : ts.isFunctionLike(node) ? { aliases: new Map<string, ts.Expression>() } : outer;
        if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && node.initializer && credentialName(nameOf(node.name)) && credentialValue(node.initializer)) add("VF-SEC-001", node.name);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && credentialName(nameOf(node.left)) && credentialValue(node.right)) add("VF-SEC-001", node.left);
        if (ts.isCallExpression(node) && node.arguments[0] && sqlSink(node.expression)) {
          const shape = stringShape(node.arguments[0], scope, node.getStart(sf), limits);
          if (shape.complete && shape.string && shape.dynamic && sqlText(shape.literal)) add("VF-SEC-002", node.expression);
        }
        if (ts.isJsxAttribute(node) && nameOf(node.name) === "dangerouslySetInnerHTML" && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          const object = resolve(node.initializer.expression, scope, node.getStart(sf), 0, limits);
          if (ts.isObjectLiteralExpression(object) && !object.properties.some(ts.isSpreadAssignment)) {
            const html = object.properties.filter(p => "name" in p && p.name && nameOf(p.name) === "__html");
            if (html.length === 1) {
              const property = html[0];
              const value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : null;
              if (value) { const shape = stringShape(value, scope, node.getStart(sf), limits); if (shape.complete && shape.dynamic) add("VF-SEC-003", value); }
            }
          }
        }
        const children: ts.Node[] = []; ts.forEachChild(node, child => { children.push(child); });
        for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: depth + 1, scope });
      }
      if (findingLimitReached) break;
      filesAnalyzed++;
    }
    check();
    findings.sort((a, b) => a.path.localeCompare(b.path) || a.charOffset - b.charOffset || a.ruleId.localeCompare(b.ruleId));
    return { ok: true, findings, filesAnalyzed, filesTotal: verified.length, malformedFiles,
      scanComplete: !findingLimitReached && malformedFiles.length === 0, findingLimitReached };
  } catch (error) {
    if (error instanceof DetectionStop) return { ok: false, code: error.code, message: error.message };
    // Hash rejection or parser exceptions never become a clean scan result.
    return invalid("Security detection failed; no findings are available.");
  }
}
