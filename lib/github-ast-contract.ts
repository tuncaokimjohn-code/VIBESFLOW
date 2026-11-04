/** Shared bounded real-source wire contract. No Node or provider imports. */
import { z } from "zod";
import { isCanonicalRef, isValidName } from "@/lib/github-url";
import type { createSourceSnapshotSchema, SourceSnapshot } from "@/lib/source-snapshot-contract";
import type { AstGraph } from "@/lib/ast-graph";
import { sourceGeometry } from "@/lib/source-lines";

export const AST_LIMITS = Object.freeze({
  maxSourceBytes: 512 * 1024,
  maxFiles: 100,
  maxLineStarts: 65_536,
  maxNodes: 4_000,
  maxEdges: 8_000,
  maxResponseBytes: 4 * 1024 * 1024,
  analysisDeadlineMs: 2_000,
  responseReadDeadlineMs: 30_000,
});

const text = z.string().max(2048);
const offset = z.number().int().nonnegative();
const line = z.number().int().positive();
const member = z.strictObject({ name: text, kind: text, line });
const provenance = z.strictObject({
  anchorOffset: offset, anchorLine: line, slot: text,
  origin: z.enum(["local", "upstream"]), originId: text,
  statementOffset: offset, bindingOffset: offset, bindingLine: line,
  declaration: z.strictObject({ module: text, name: text, ownerOffset: offset, offset, line }).nullable(),
});
const binding = z.strictObject({
  statementOffset: offset, bindingOffset: offset, line, bindingLine: line,
  statement: z.enum(["import", "export"]), local: text, orig: text, originSlot: text,
});
const edge = z.strictObject({
  statementOffset: offset.optional(), bindings: z.array(binding).max(AST_LIMITS.maxEdges).optional(),
  from: text, to: text, kind: z.enum(["imports", "external", "unknown", "unresolvable", "references"]),
  specifier: text, line,
});
export const AstGraphSchema = z.strictObject({
  nodes: z.array(z.strictObject({
    id: text, kind: z.enum(["module", "member"]), label: text, module: text, line: line.nullable(),
    members: z.record(text, member), declKind: text.optional(),
    provenance: z.array(provenance).max(AST_LIMITS.maxNodes).optional(),
    namedExports: z.array(text).max(AST_LIMITS.maxNodes).optional(), defaultMember: text.nullable().optional(),
  })).max(AST_LIMITS.maxNodes),
  edges: z.array(edge).max(AST_LIMITS.maxEdges), unresolved: z.array(edge).max(AST_LIMITS.maxEdges),
  unsupportedModules: z.array(text).max(AST_LIMITS.maxFiles),
  unsupportedForms: z.array(z.strictObject({ module: text, line, form: text })).max(AST_LIMITS.maxNodes),
  snapshotId: z.string().min(1).max(128), canonicalProvenance: z.string().min(1).max(512),
  resolvedCommitIfGitHub: z.string().regex(/^[0-9a-f]{40}$/),
});
export const RequestedRepoSchema = z.strictObject({
  owner: z.string().refine(isValidName), repo: z.string().refine(isValidName),
  ref: z.string().nullable().refine(isCanonicalRef),
});
export type RequestedRepo = z.infer<typeof RequestedRepoSchema>;

export function assertAnalysisBudget(snapshot: SourceSnapshot): void {
  const lines = snapshot.files.reduce((n, file) => n + file.lineStartOffsets.length, 0);
  if (snapshot.files.length > AST_LIMITS.maxFiles ||
      snapshot.coverage.totalBytes > AST_LIMITS.maxSourceBytes || lines > AST_LIMITS.maxLineStarts) {
    throw Object.assign(new Error("Source exceeds the AST analysis budget; intake coverage was not silently reduced."), { code: "ANALYSIS_LIMIT" });
  }
}

export function analysisStatus(snapshot: SourceSnapshot, graph: AstGraph): "complete" | "partial" {
  return !snapshot.coverage.complete || snapshot.skipped.length > 0 || graph.unresolved.length > 0 ||
    graph.unsupportedModules.length > 0 || graph.unsupportedForms.length > 0 ? "partial" : "complete";
}

export function createGitHubAstResponseSchema(snapshotSchema: ReturnType<typeof createSourceSnapshotSchema>) {
  const snapshot = snapshotSchema.strict();
  const success = z.strictObject({
    ok: z.literal(true), synthetic: z.literal(false), requested: RequestedRepoSchema, snapshot,
    contents: z.record(z.string().min(1).max(512), z.string().max(AST_LIMITS.maxSourceBytes)),
    graph: AstGraphSchema, shapeOk: z.literal(true), evidenceVerified: z.literal(true),
    undecoded: z.array(z.never()).length(0), analysisStatus: z.enum(["complete", "partial"]),
    note: z.string().max(512),
  }).superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    const s = value.snapshot;
    if (s.sourceKind !== "github" || s.canonicalProvenance !== `https://github.com/${value.requested.owner}/${value.requested.repo}`) issue("repository/provenance mismatch");
    if (value.graph.snapshotId !== s.snapshotId || value.graph.canonicalProvenance !== s.canonicalProvenance ||
        value.graph.resolvedCommitIfGitHub !== s.resolvedCommitIfGitHub) issue("graph/snapshot binding mismatch");
    const paths = new Set(s.files.map(file => file.path));
    if (Object.keys(value.contents).length !== paths.size || Object.keys(value.contents).some(path => !paths.has(path))) issue("content inventory mismatch");
    if (s.files.some(file => typeof value.contents[file.path] !== "string")) issue("missing source content");
    // Check ACTUAL bytes before hashing or rebuilding any AST. A forged policy
    // or a self-consistently rehashed manifest cannot increase this wire budget.
    let actualBytes = 0;
    let actualLines = 0;
    for (const file of s.files) {
      const src = value.contents[file.path];
      if (typeof src !== "string") continue;
      const bytes = new TextEncoder().encode(src).length;
      actualBytes += bytes;
      if (bytes !== file.bytes) issue("source byte length mismatch");
      if (actualBytes > AST_LIMITS.maxSourceBytes) { issue("actual source byte budget exceeded"); break; }
      const geometry = sourceGeometry(src);
      actualLines += geometry.lineCount;
      if (geometry.lineCount !== file.lineCount || JSON.stringify(geometry.lineStartOffsets) !== JSON.stringify(file.lineStartOffsets)) issue("source line geometry mismatch");
      if (actualLines > AST_LIMITS.maxLineStarts) { issue("actual line geometry budget exceeded"); break; }
    }
    if (value.analysisStatus !== analysisStatus(s, value.graph)) issue("coverage status mismatch");
    try { assertAnalysisBudget(s); } catch { issue("AST analysis budget exceeded"); }
  });
  const failure = z.strictObject({ ok: z.literal(false), code: z.string().min(1).max(64), message: z.string().min(1).max(512), partial: snapshot.nullable().optional() });
  return z.union([success, failure]);
}

export type GitHubAstResponse = z.infer<ReturnType<typeof createGitHubAstResponseSchema>>;
export type GitHubAstSuccess = Extract<GitHubAstResponse, { ok: true }>;
export const invalidAstResponse = () => ({ ok: false, code: "EVIDENCE_INVALID", message: "Real analysis response failed evidence validation." } as const);
