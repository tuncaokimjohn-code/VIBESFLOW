import "server-only";
import ts from "typescript";
import { sha256SyncHex } from "@/lib/sha256-sync";
import { sourceLines } from "@/lib/source-lines";
import { META_LIMITS } from "@/lib/meta-direct-contract";
import { isVerifiedPublicMuseEvidence, type VerifiedPublicMuseEvidence } from "@/lib/public-muse-source-server";

const identifiers = new Set(["db", "database", "pool", "connection", "conn", "client", "sql", "prisma", "knex",
  "query", "execute", "$queryRawUnsafe", "$executeRawUnsafe", "dangerouslySetInnerHTML", "__html",
  "req", "request", "body", "params", "input", "content", "html", "apiKey", "api_key", "password", "secret", "accessToken", "authToken"]);
const sqlWords = new Set(["SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "AND", "OR", "ORDER", "BY", "LIMIT", "JOIN", "ON"]);
function literal(text: string) {
  // Preserve SQL structure only. No table/column/value, URL, PII or free prose.
  if (/\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(text)) {
    const tokens = text.match(/[A-Za-z_][A-Za-z_0-9]*|[=*,()?]/g) ?? [];
    return JSON.stringify(tokens.map(t => sqlWords.has(t.toUpperCase()) ? t.toUpperCase() : /^[=*,()?]$/.test(t) ? t : "value").join(" "));
  }
  return '"[REDACTED_LITERAL]"';
}
/** Token reconstruction drops ALL comments/gaps except whitespace. Arbitrary
 * identifiers are stable aliases; every literal/JSX text is redacted. Original
 * line numbers survive. No regex-based secret allowlist or raw source fallback. */
export function sanitizedMetaContext(evidence: VerifiedPublicMuseEvidence) {
  if (!isVerifiedPublicMuseEvidence(evidence)) throw new Error("SOURCE_REJECTED");
  const { source, binding: b } = evidence;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(source)) throw new Error("SOURCE_REJECTED");
  const file = ts.createSourceFile("evidence.tsx", source, ts.ScriptTarget.Latest, true,
    b.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const aliases = new Map<string, string>(); let cursor = 0, sanitized = "";
  const whitespace = (s: string) => s.replace(/[^\s]/g, " ");
  function walk(node: ts.Node) {
    const children = node.getChildren(file);
    if (children.length) { children.forEach(walk); return; }
    const start = node.getStart(file), end = node.end;
    if (end <= start) return;
    sanitized += whitespace(source.slice(cursor, start));
    const text = source.slice(start, end);
    let safe: string;
    if (node.kind === ts.SyntaxKind.Identifier || node.kind === ts.SyntaxKind.PrivateIdentifier) {
      if (!aliases.has(text)) aliases.set(text, `local_${aliases.size + 1}`);
      safe = identifiers.has(text) ? text : aliases.get(text)!;
    } else if (ts.isTemplateLiteralToken(node)) {
      const fragment: string = JSON.parse(literal(text));
      if (node.kind === ts.SyntaxKind.TemplateHead) safe = "`" + fragment + "${";
      else if (node.kind === ts.SyntaxKind.TemplateMiddle) safe = "}" + fragment + "${";
      else if (node.kind === ts.SyntaxKind.TemplateTail) safe = "}" + fragment + "`";
      else safe = "`" + fragment + "`";
    } else if (ts.isStringLiteralLike(node)) safe = literal(text);
    else if (node.kind === ts.SyntaxKind.NumericLiteral || node.kind === ts.SyntaxKind.BigIntLiteral ||
      node.kind === ts.SyntaxKind.RegularExpressionLiteral || node.kind === ts.SyntaxKind.JsxText) safe = '"[REDACTED_LITERAL]"';
    else if (node.kind >= ts.SyntaxKind.FirstPunctuation && node.kind <= ts.SyntaxKind.LastPunctuation ||
      node.kind >= ts.SyntaxKind.FirstKeyword && node.kind <= ts.SyntaxKind.LastKeyword) safe = ts.tokenToString(node.kind) ?? "";
    else throw new Error("SOURCE_REJECTED");
    const breaks = sourceLines(text).length - 1;
    sanitized += safe + "\n".repeat(breaks); cursor = end;
  }
  walk(file);
  sanitized += whitespace(source.slice(cursor));
  const lines = sourceLines(sanitized), startLine = Math.max(1, b.line - 3), endLine = Math.min(lines.length, b.line + 3);
  const text = lines.slice(startLine - 1, endLine).map((line, i) => `${startLine + i}: ${line.trim()}`).join("\n");
  if (!text.trim() || Buffer.byteLength(text) > META_LIMITS.contextBytes || /[^\x09\x0a\x0d\x20-\x7e]/.test(text)) throw new Error("SOURCE_REJECTED");
  return Object.freeze({ startLine, endLine, text, sha256: sha256SyncHex(text) });
}
